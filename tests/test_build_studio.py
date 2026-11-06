import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "tools"))
import build_studio as builder


class BuildStudioTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve() / "source with spaces"
        for name in ("web-app/src", "web-app/public", "web-app/tests", "web-app/tools", "tools", "bin"):
            (self.root / name).mkdir(parents=True, exist_ok=True)
        for name in ("LICENSE", "NOTICE.md", "tools/build_studio.py", "tools/stage_web.py", "web-app/package.json",
                     "web-app/package-lock.json", "web-app/tsconfig.json", "web-app/vite.config.ts", "web-app/index.html",
                     "web-app/src/main.ts", "web-app/public/THIRD_PARTY_NOTICES.txt"):
            (self.root / name).write_text("fixture " + name)
        self.node = self.root / "bin/node"
        self.node.write_text("fixture tool")
        self.npm = self.root / "bin/npm-cli.js"
        self.npm.write_text("fixture tool")
        self.version = "one"
        self.commit = "f" * 40
        self.calls = []
        self.afterBuild = None
        self.patchers = [
            patch.object(shutil, "which", side_effect=lambda name: str(self.node if name == "node" else self.npm)),
            patch.object(subprocess, "run", side_effect=self.emitBuild),
            patch.object(subprocess, "check_output", side_effect=self.commandOutput),
        ]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    def commandOutput(self, args, **options):
        if args[0] == "git" and args[1:3] == ["rev-parse", "HEAD"]:
            return self.commit + "\n"
        if args[0] == "git" and args[1:3] == ["status", "--porcelain"]:
            return b" M web-app/src/main.ts\n"
        if args == [str(self.node), "--version"]:
            return "v24.22.1\n"
        raise AssertionError("Unexpected command: " + str(args))

    def emitBuild(self, args, **options):
        self.calls.append(args)
        self.assertEqual(args[:2], [str(self.node), str(self.npm)])
        self.assertEqual(args[args.index("--prefix") + 1], str(self.root / "web-app"))
        output = Path(args[args.index("--outDir") + 1])
        self.assertEqual(output.parent, self.root / "dist")
        files = {
            "index.html": f'<html><head><script type="module" src="./assets/main-{self.version}.js"></script><link rel="stylesheet" href="./assets/style.css"></head><body></body></html>'.encode(),
            "THIRD_PARTY_NOTICES.txt": b"Runtime dependency notices",
            f"assets/main-{self.version}.js": f'import("./lazy-{self.version}.js");'.encode(),
            f"assets/lazy-{self.version}.js": b"export const value = 1;",
            f"assets/worker-{self.version}.js": b"self.onmessage = () => postMessage(1);",
            "assets/style.css": b"body { color: black; }",
        }
        for name, data in files.items():
            item = output / name
            item.parent.mkdir(parents=True, exist_ok=True)
            item.write_bytes(data)
        if self.afterBuild:
            self.afterBuild(output)
        return subprocess.CompletedProcess(args, 0)

    def test_builds_owned_manifest_only_and_preserves_canonical_vite_output(self):
        canonical = self.root / "web-app/dist"
        canonical.mkdir()
        (canonical / "keep.txt").write_text("separate existing build")
        result = builder.buildStudio(self.root)
        target = Path(result["output"])
        bundle = builder.readBundle(target)
        self.assertEqual(bundle["target"], "studio")
        self.assertEqual(len(bundle["files"]), 7)
        self.assertEqual(bundle["source"]["commit"], self.commit)
        self.assertTrue(bundle["source"]["dirty"])
        self.assertIn("web-app/src/main.ts", bundle["source"]["sourceFiles"])
        self.assertEqual((target / "LICENSE").read_bytes(), (self.root / "LICENSE").read_bytes())
        for name, digest in bundle["files"].items():
            self.assertEqual(hashlib.sha256((target / name).read_bytes()).hexdigest(), digest)
        self.assertEqual((canonical / "keep.txt").read_text(), "separate existing build")
        self.assertFalse((self.root / "dist/.studio-build-lock").exists())
        self.assertFalse((self.root / "dist/.studio-previous").exists())

    def test_metadata_only_rebuild_keeps_payload_hashes(self):
        first = builder.buildStudio(self.root)
        before = builder.readBundle(Path(first["output"]))
        self.commit = "a" * 40
        second = builder.buildStudio(self.root)
        after = builder.readBundle(Path(second["output"]))
        self.assertEqual(before["files"], after["files"])
        self.assertNotEqual(before["source"]["commit"], after["source"]["commit"])
        self.assertFalse((self.root / "dist/.studio-previous").exists())

    def test_failed_build_preserves_previous_bundle(self):
        target = Path(builder.buildStudio(self.root)["output"])
        before = (target / "bundle.json").read_bytes()
        with patch.object(subprocess, "run", side_effect=subprocess.CalledProcessError(1, ["fixture npm"])):
            with self.assertRaises(subprocess.CalledProcessError):
                builder.buildStudio(self.root)
        self.assertEqual((target / "bundle.json").read_bytes(), before)
        self.assertFalse((self.root / "dist/.studio-build-lock").exists())

    def test_source_edit_during_build_preserves_previous_output_and_user_edit(self):
        target = Path(builder.buildStudio(self.root)["output"])
        before = (target / "bundle.json").read_bytes()
        self.afterBuild = lambda output: (self.root / "web-app/src/main.ts").write_text("user edited during build")
        with self.assertRaisesRegex(RuntimeError, "Source changed"):
            builder.buildStudio(self.root)
        self.assertEqual((target / "bundle.json").read_bytes(), before)
        self.assertEqual((self.root / "web-app/src/main.ts").read_text(), "user edited during build")

    def test_source_addition_during_build_is_detected(self):
        self.afterBuild = lambda output: (self.root / "web-app/src/new.ts").write_text("new source")
        with self.assertRaisesRegex(RuntimeError, "Source changed"):
            builder.buildStudio(self.root)
        self.assertFalse((self.root / "dist/studio").exists())

    def test_unknown_output_layout_is_rejected(self):
        self.afterBuild = lambda output: (output / "source.tar.gz").write_bytes(b"unnecessary archive")
        with self.assertRaisesRegex(RuntimeError, "Unknown Studio bundle layout"):
            builder.buildStudio(self.root)
        self.assertFalse((self.root / "dist/studio").exists())

    def test_symbolic_source_is_rejected_before_build(self):
        outside = Path(self.temporary.name) / "keep.txt"
        outside.write_text("private fixture")
        try:
            (self.root / "web-app/public/link.txt").symlink_to(outside)
        except OSError as error:
            self.skipTest(str(error))
        with self.assertRaisesRegex(RuntimeError, "Symbolic source"):
            builder.buildStudio(self.root)
        self.assertFalse(self.calls)
        self.assertEqual(outside.read_text(), "private fixture")

    def test_symbolic_generated_asset_is_rejected(self):
        outside = Path(self.temporary.name) / "keep.txt"
        outside.write_text("private fixture")
        def linkOutput(output):
            path = output / "assets/unmanaged.js"
            path.symlink_to(outside)
        self.afterBuild = linkOutput
        try:
            with self.assertRaisesRegex(RuntimeError, "Symbolic Vite output"):
                builder.buildStudio(self.root)
        except OSError as error:
            self.skipTest(str(error))
        self.assertEqual(outside.read_text(), "private fixture")
        self.assertFalse((self.root / "dist/studio").exists())

    def test_reserved_license_rejects_existing_files_and_links_without_overwrite(self):
        target = Path(builder.buildStudio(self.root)["output"])
        original = (target / "bundle.json").read_bytes()
        outside = Path(self.temporary.name) / "user-license.txt"
        outside.write_text("USER ORIGINAL MUST SURVIVE")
        for kind in ("file", "symlink", "hardlink"):
            with self.subTest(kind=kind):
                def createReserved(output):
                    path = output / "LICENSE"
                    if kind == "file":
                        path.write_text("unexpected generated license")
                    elif kind == "symlink":
                        path.symlink_to(outside)
                    else:
                        os.link(outside, path)
                self.afterBuild = createReserved
                try:
                    with self.assertRaisesRegex(RuntimeError, "reserved LICENSE path"):
                        builder.buildStudio(self.root)
                except OSError as error:
                    self.skipTest(str(error))
                self.assertEqual(outside.read_text(), "USER ORIGINAL MUST SURVIVE")
                self.assertEqual((target / "bundle.json").read_bytes(), original)
                self.assertFalse((self.root / "dist/.studio-build-lock").exists())

    def test_unmanaged_destination_is_not_deleted(self):
        target = self.root / "dist/studio"
        target.mkdir(parents=True)
        (target / "notes.txt").write_text("user content")
        with self.assertRaises((OSError, RuntimeError)):
            builder.buildStudio(self.root)
        self.assertFalse(self.calls)
        self.assertEqual((target / "notes.txt").read_text(), "user content")

    def test_destination_edit_during_build_is_not_overwritten(self):
        target = Path(builder.buildStudio(self.root)["output"])
        self.afterBuild = lambda output: (target / "index.html").write_text("user content")
        with self.assertRaises(RuntimeError):
            builder.buildStudio(self.root)
        self.assertEqual((target / "index.html").read_text(), "user content")

    def test_install_failure_restores_previous_bundle(self):
        target = Path(builder.buildStudio(self.root)["output"])
        before = (target / "bundle.json").read_bytes()
        replace = os.replace
        failed = []
        def failOnce(source, destination):
            if Path(destination) == target and not failed:
                failed.append(True)
                raise OSError("injected install failure")
            return replace(source, destination)
        with patch.object(os, "replace", side_effect=failOnce):
            with self.assertRaises(OSError):
                builder.buildStudio(self.root)
        self.assertEqual((target / "bundle.json").read_bytes(), before)
        self.assertFalse((self.root / "dist/.studio-previous").exists())
        self.assertFalse((self.root / "dist/.studio-build-lock").exists())

    def test_failed_rollback_preserves_and_reports_previous_bundle(self):
        target = Path(builder.buildStudio(self.root)["output"])
        before = (target / "bundle.json").read_bytes()
        replace = os.replace
        def failInstallAndRollback(source, destination):
            if Path(destination) == target:
                raise OSError("injected double failure")
            return replace(source, destination)
        with patch.object(os, "replace", side_effect=failInstallAndRollback):
            with self.assertRaisesRegex(RuntimeError, "previous bundle is preserved at"):
                builder.buildStudio(self.root)
        self.assertEqual((self.root / "dist/.studio-previous/bundle.json").read_bytes(), before)
        with self.assertRaisesRegex(RuntimeError, "Review retained"):
            builder.buildStudio(self.root)

    def test_payload_budget_rejects_before_publishing(self):
        with patch.object(builder, "MAX_FILE", 16):
            with self.assertRaisesRegex(RuntimeError, "bundle budget"):
                builder.buildStudio(self.root)
        self.assertFalse((self.root / "dist/studio").exists())

    def test_existing_build_lock_is_preserved(self):
        lock = self.root / "dist/.studio-build-lock"
        lock.mkdir(parents=True)
        (lock / "owner.txt").write_text("other build")
        with self.assertRaises(FileExistsError):
            builder.buildStudio(self.root)
        self.assertEqual((lock / "owner.txt").read_text(), "other build")
        self.assertFalse(self.calls)

    def test_default_cli_does_not_stage_and_stage_failure_keeps_local_bundle(self):
        output = io.StringIO()
        with patch.object(builder, "__file__", str(self.root / "tools/build_studio.py")), patch.object(sys, "argv", ["build_studio.py"]), patch.object(builder, "stageBundle", side_effect=AssertionError("Unexpected homepage write")), contextlib.redirect_stdout(output):
            builder.main()
        target = self.root / "dist/studio"
        builder.readBundle(target)
        site = Path(self.temporary.name) / "homepage"
        site.mkdir()
        (site / "index.html").write_text("unrelated homepage")
        with patch.object(builder, "__file__", str(self.root / "tools/build_studio.py")), patch.object(sys, "argv", ["build_studio.py", "--homepage", str(site)]), patch.object(builder, "stageBundle", side_effect=RuntimeError("fixture homepage refusal")), contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as error:
                builder.main()
        self.assertEqual(error.exception.code, 1)
        builder.readBundle(target)
        self.assertIn(str(target), output.getvalue())
        self.assertEqual((site / "index.html").read_text(), "unrelated homepage")


if __name__ == "__main__":
    unittest.main()
