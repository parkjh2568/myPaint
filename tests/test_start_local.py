"""Isolated HTTP/process checks; never opens a browser or recovery database."""

import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request


REPO = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


@unittest.skipUnless(NODE, "Node is required for the local launcher")
class LocalStartTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mypaint local test ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "tools").mkdir()
        shutil.copyfile(REPO / "web-app/tools/start-local.mjs", self.root / "tools/start-local.mjs")
        self.env = {key: os.environ[key] for key in ("PATH", "SystemRoot", "WINDIR") if key in os.environ}
        self.env["HOME"] = str(self.root)
        self.env["USERPROFILE"] = str(self.root)

    def run_launcher(self, *args):
        return subprocess.run(
            [NODE, str(self.root / "tools/start-local.mjs"), *args],
            cwd=self.root, env=self.env, text=True, capture_output=True, timeout=20,
        )

    def prepare_vite(self):
        dependencies = REPO / "web-app/node_modules"
        if not (dependencies / "vite").exists():
            self.skipTest("Run npm ci --prefix web-app for HTTP integration checks")
        try:
            (self.root / "node_modules").symlink_to(dependencies, target_is_directory=True)
        except OSError:
            self.skipTest("This host cannot create the isolated dependency symlink")
        (self.root / "vite.config.ts").write_text("export default {};\n", encoding="utf-8")
        (self.root / "package.json").write_text('{"type":"module"}\n', encoding="utf-8")
        (self.root / "index.html").write_text("<title>isolated myPaint launcher</title>", encoding="utf-8")

    def test_rejects_public_host_and_invalid_ports(self):
        for args in [("--host", "0.0.0.0"), ("--port", "0"), ("--port", "65536"), ("--port", "oops")]:
            with self.subTest(args=args):
                self.assertNotEqual(self.run_launcher(*args).returncode, 0)

    def test_missing_dependencies_has_preparation_command(self):
        result = self.run_launcher()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("npm ci --prefix web-app", result.stderr)

    def test_busy_port_fails_without_disturbing_owner(self):
        self.prepare_vite()
        with socket.socket() as owner:
            owner.bind(("127.0.0.1", 0))
            owner.listen()
            port = owner.getsockname()[1]
            result = self.run_launcher("--port", str(port))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("already in use", result.stderr)
            self.assertEqual(owner.getsockname()[1], port)

    @unittest.skipIf(os.name == "nt", "POSIX signal check; manually verify Windows Ctrl+C")
    def test_space_path_http_and_graceful_shutdown(self):
        self.prepare_vite()
        for sig in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal=sig):
                with socket.socket() as reserve:
                    reserve.bind(("127.0.0.1", 0))
                    port = reserve.getsockname()[1]
                proc = subprocess.Popen(
                    [NODE, str(self.root / "tools/start-local.mjs"), "--port", str(port)],
                    cwd=self.root, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                )
                try:
                    deadline = time.monotonic() + 20
                    while True:
                        try:
                            with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1) as response:
                                self.assertIn(b"isolated myPaint launcher", response.read())
                            break
                        except OSError:
                            if proc.poll() is not None or time.monotonic() > deadline:
                                self.fail("Local HTTP server did not become ready")
                            time.sleep(0.1)
                    proc.send_signal(sig)
                    output, _ = proc.communicate(timeout=15)
                    self.assertEqual(proc.returncode, 0 if sig == signal.SIGINT else 143, output)
                    if sig == signal.SIGINT:
                        self.assertIn("server stopped", output)
                    with socket.socket() as probe:
                        self.assertNotEqual(probe.connect_ex(("127.0.0.1", port)), 0)
                finally:
                    if proc.poll() is None:
                        proc.terminate()
                        proc.communicate(timeout=15)
                    elif proc.stdout:
                        proc.stdout.close()


if __name__ == "__main__":
    unittest.main()
