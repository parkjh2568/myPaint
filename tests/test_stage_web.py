import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("stage_web", Path(__file__).parents[1] / "tools/stage_web.py")
stage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)


class StageWebTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "bundle"
        self.source.mkdir()
        self.site = self.root / "site"
        self.site.mkdir()
        subprocess.run(["git", "init", "--quiet"], cwd=self.site, check=True)
        (self.site / "index.html").write_text("existing homepage")
        (self.site / "other.txt").write_text("staged unrelated work")
        subprocess.run(["git", "add", "other.txt"], cwd=self.site, check=True)
        self.index = (self.site / ".git/index").read_bytes()
        self.writeBundle()

    def writeBundle(self, version="one"):
        files = {"index.html": b"<html><head><title>Paint</title></head><body></body></html>",
                 "licenses.html": b"<html><head><title>License</title></head><body></body></html>",
                 "retropaint.js": version.encode(), "retropaint.wasm": b"\0asm\x01\0\0\0",
                 "qtloader.js": b"loader"}
        for name, data in files.items():
            (self.source / name).write_bytes(data)
        manifest = {"schema": 1, "owner": "myPaint-web-bundle", "source": {"commit": "fixture"},
                    "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
        (self.source / "bundle.json").write_text(json.dumps(manifest))

    def test_preserves_homepage_index_and_retains_old_release(self):
        first = stage.stageBundle(self.source, self.site)
        self.writeBundle("two")
        second = stage.stageBundle(self.source, self.site)
        self.assertNotEqual(first["release"], second["release"])
        target = self.site / "mypaint"
        self.assertTrue((target / "releases" / first["release"] / "retropaint.js").exists())
        self.assertIn(second["release"], (target / "index.html").read_text())
        self.assertEqual((self.site / "index.html").read_text(), "existing homepage")
        self.assertEqual((self.site / ".git/index").read_bytes(), self.index)
        self.assertEqual((self.site / "other.txt").read_text(), "staged unrelated work")

    def test_commit_metadata_does_not_duplicate_runtime(self):
        first = stage.stageBundle(self.source, self.site)
        path = self.source / "bundle.json"
        manifest = json.loads(path.read_text())
        manifest["source"] = {"commit": "committed", "dirty": False}
        path.write_text(json.dumps(manifest))
        second = stage.stageBundle(self.source, self.site)
        self.assertEqual(first["release"], second["release"])
        self.assertEqual(len(list((self.site / "mypaint").rglob("*.wasm"))), 1)

    def test_license_change_reuses_current_runtime_path(self):
        first = stage.stageBundle(self.source, self.site)
        licenseFile = self.source / "licenses.html"
        licenseFile.write_text("<html><head></head><body>Updated source offer</body></html>")
        path = self.source / "bundle.json"
        manifest = json.loads(path.read_text())
        manifest["files"]["licenses.html"] = hashlib.sha256(licenseFile.read_bytes()).hexdigest()
        path.write_text(json.dumps(manifest))
        second = stage.stageBundle(self.source, self.site)
        self.assertEqual(first["release"], second["release"])
        self.assertIn("Updated source offer", (self.site / "mypaint/releases" / second["release"] / "licenses.html").read_text())

    def test_prune_removes_only_validated_old_output(self):
        first = stage.stageBundle(self.source, self.site)
        target = self.site / "mypaint"
        self.writeBundle("two")
        second = stage.stageBundle(self.source, self.site)
        dryRun = stage.stageBundle(self.source, self.site, check=True, prune=True)
        self.assertGreater(dryRun["removedFiles"], 0)
        self.assertTrue((target / "releases" / first["release"]).is_dir())
        stage.stageBundle(self.source, self.site, prune=True)
        self.assertFalse((target / "releases" / first["release"]).exists())
        self.assertTrue((target / "releases" / second["release"] / "retropaint.wasm").is_file())
        self.assertEqual((self.site / ".git/index").read_bytes(), self.index)
        self.assertEqual((self.site / "index.html").read_text(), "existing homepage")

    def test_prune_preserves_manual_changes(self):
        stage.stageBundle(self.source, self.site)
        file = self.site / "mypaint/index.html"
        file.write_text("user work")
        with self.assertRaises(RuntimeError):
            stage.stageBundle(self.source, self.site, prune=True)
        self.assertEqual(file.read_text(), "user work")

    def test_duplicate_and_check_do_not_replace_output(self):
        stage.stageBundle(self.source, self.site)
        before = (self.site / "mypaint/index.html").stat().st_mtime_ns
        self.assertFalse(stage.stageBundle(self.source, self.site)["changed"])
        self.assertFalse(stage.stageBundle(self.source, self.site, True)["changed"])
        self.assertEqual((self.site / "mypaint/index.html").stat().st_mtime_ns, before)

    def test_manual_change_is_preserved(self):
        stage.stageBundle(self.source, self.site)
        target = self.site / "mypaint/index.html"
        target.write_text("manual work")
        with self.assertRaises(RuntimeError):
            stage.stageBundle(self.source, self.site)
        self.assertEqual(target.read_text(), "manual work")

    def test_unmanaged_files_are_not_deleted(self):
        stage.stageBundle(self.source, self.site)
        file = self.site / "mypaint/notes.txt"
        file.write_text("user content")
        with self.assertRaises(RuntimeError):
            stage.stageBundle(self.source, self.site)
        self.assertEqual(file.read_text(), "user content")

    def test_unknown_empty_directory_is_preserved(self):
        stage.stageBundle(self.source, self.site)
        directory = self.site / "mypaint/user-folder"
        directory.mkdir()
        with self.assertRaises(RuntimeError):
            stage.stageBundle(self.source, self.site)
        self.assertTrue(directory.is_dir())

    def test_non_object_manifest_is_rejected(self):
        (self.source / "bundle.json").write_text("[]")
        with self.assertRaises(RuntimeError):
            stage.stageBundle(self.source, self.site)
        self.assertFalse((self.site / "mypaint").exists())

    def test_staged_mypaint_is_preserved(self):
        stage.stageBundle(self.source, self.site)
        subprocess.run(["git", "add", "mypaint"], cwd=self.site, check=True)
        before = (self.site / ".git/index").read_bytes()
        self.writeBundle("two")
        with self.assertRaises(RuntimeError):
            stage.stageBundle(self.source, self.site)
        self.assertEqual((self.site / ".git/index").read_bytes(), before)

    def test_symlink_destination_is_rejected(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "keep.txt").write_text("keep")
        (self.site / "mypaint").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(RuntimeError):
            stage.stageBundle(self.source, self.site)
        self.assertEqual((outside / "keep.txt").read_text(), "keep")

    def test_manifest_traversal_is_rejected(self):
        p = self.source / "bundle.json"
        data = json.loads(p.read_text())
        data["files"]["../escape.txt"] = "0" * 64
        p.write_text(json.dumps(data))
        with self.assertRaises(RuntimeError):
            stage.stageBundle(self.source, self.site)
        self.assertFalse((self.site / "mypaint").exists())

    def test_copy_failure_keeps_previous_output(self):
        stage.stageBundle(self.source, self.site)
        target = self.site / "mypaint/index.html"
        before = target.read_bytes()
        self.writeBundle("two")
        with patch.object(shutil, "copyfile", side_effect=OSError("injected copy failure")):
            with self.assertRaises(OSError):
                stage.stageBundle(self.source, self.site)
        self.assertEqual(target.read_bytes(), before)
        self.assertFalse((self.site / ".mypaint-build-lock").exists())

    def test_failed_install_restores_previous_directory(self):
        stage.stageBundle(self.source, self.site)
        target = self.site / "mypaint"
        before = (target / "manifest.json").read_bytes()
        self.writeBundle("two")
        replace = os.replace
        def failInstall(source, destination):
            if Path(source).name.startswith(".mypaint-stage-") and Path(destination) == target:
                raise OSError("injected install failure")
            return replace(source, destination)
        with patch.object(os, "replace", side_effect=failInstall):
            with self.assertRaises(OSError):
                stage.stageBundle(self.source, self.site)
        self.assertEqual((target / "manifest.json").read_bytes(), before)
        self.assertEqual((self.site / ".git/index").read_bytes(), self.index)
        self.assertFalse((self.site / ".mypaint-build-lock").exists())


    def writeStudioBundle(self, version="one", index=None):
        shutil.rmtree(self.source)
        self.source.mkdir()
        files = {
            "index.html": index or (f'<html><head><script type="module" src="./assets/main-{version}.js"></script>'
                                    f'<link rel="stylesheet" href="./assets/style-{version}.css"></head><body></body></html>').encode(),
            "LICENSE": b"Application license",
            "THIRD_PARTY_NOTICES.txt": b"Third party notices",
            f"assets/main-{version}.js": f'import("./lazy-{version}.js");'.encode(),
            f"assets/lazy-{version}.js": b"export const value = 1;",
            f"assets/worker-{version}.js": b"self.onmessage = () => postMessage(1);",
            f"assets/style-{version}.css": b"body { color: black; }",
        }
        for name, data in files.items():
            item = self.source / name
            item.parent.mkdir(parents=True, exist_ok=True)
            item.write_bytes(data)
        manifest = {"schema": 1, "owner": "myPaint-web-bundle", "target": "studio",
                    "source": {"commit": "fixture"},
                    "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
        (self.source / "bundle.json").write_text(json.dumps(manifest))

    def test_studio_relative_entry_notices_and_homepage_are_preserved(self):
        self.writeStudioBundle()
        result = stage.stageBundle(self.source, self.site)
        target = self.site / "mypaint"
        release = target / "releases" / result["release"]
        self.assertIn(f'<base href="./releases/{result["release"]}/">', (target / "index.html").read_text())
        self.assertIn('./assets/main-one.js', (release / "index.html").read_text())
        self.assertEqual((release / "LICENSE").read_bytes(), b"Application license")
        self.assertEqual((release / "THIRD_PARTY_NOTICES.txt").read_bytes(), b"Third party notices")
        self.assertEqual(json.loads((target / "manifest.json").read_text())["target"], "studio")
        self.assertEqual((self.site / "index.html").read_text(), "existing homepage")
        self.assertEqual((self.site / ".git/index").read_bytes(), self.index)

    def test_mixed_qt_studio_releases_and_qt_rollback_keep_old_assets(self):
        qt = stage.stageBundle(self.source, self.site)
        self.writeStudioBundle()
        first = stage.stageBundle(self.source, self.site)
        self.writeStudioBundle("two")
        second = stage.stageBundle(self.source, self.site)
        shutil.rmtree(self.source)
        self.source.mkdir()
        self.writeBundle()
        restored = stage.stageBundle(self.source, self.site)
        self.assertEqual(restored["release"], qt["release"])
        target = self.site / "mypaint/releases"
        self.assertTrue((target / qt["release"] / "retropaint.wasm").is_file())
        for result, version in [(first, "one"), (second, "two")]:
            for name in ["main", "lazy", "worker"]:
                self.assertTrue((target / result["release"] / f"assets/{name}-{version}.js").is_file())
        self.assertEqual((self.site / ".git/index").read_bytes(), self.index)

    def test_studio_metadata_change_reuses_immutable_release(self):
        self.writeStudioBundle()
        first = stage.stageBundle(self.source, self.site)
        path = self.source / "bundle.json"
        manifest = json.loads(path.read_text())
        manifest["source"] = {"commit": "new metadata only", "dirty": False}
        path.write_text(json.dumps(manifest))
        second = stage.stageBundle(self.source, self.site)
        self.assertEqual(first["release"], second["release"])
        self.assertEqual(len(list((self.site / "mypaint/releases").iterdir())), 1)

    def test_studio_retains_qt_shared_until_explicit_checked_prune(self):
        shared = self.source / "shared/hash/license.txt"
        shared.parent.mkdir(parents=True)
        shared.write_bytes(b"Qt source and license offer")
        path = self.source / "bundle.json"
        manifest = json.loads(path.read_text())
        manifest["files"]["shared/hash/license.txt"] = hashlib.sha256(shared.read_bytes()).hexdigest()
        path.write_text(json.dumps(manifest))
        first = stage.stageBundle(self.source, self.site)
        self.writeStudioBundle()
        studio = stage.stageBundle(self.source, self.site)
        target = self.site / "mypaint"
        self.assertTrue((target / "shared/hash/license.txt").is_file())
        plan = stage.stageBundle(self.source, self.site, check=True, prune=True)
        self.assertGreater(plan["removedFiles"], 0)
        self.assertGreater(plan["removedBytes"], 0)
        self.assertTrue((target / "releases" / first["release"]).is_dir())
        stage.stageBundle(self.source, self.site, prune=True)
        self.assertFalse((target / "shared").exists())
        self.assertFalse((target / "releases" / first["release"]).exists())
        self.assertTrue((target / "releases" / studio["release"] / "assets/lazy-one.js").is_file())

    def test_studio_rejects_external_absolute_and_missing_entry_resources(self):
        for url in ["/assets/main-one.js", "https://example.invalid/main.js", "//example.invalid/main.js", "./assets/missing.js", "./assets/%2e%2e/main-one.js"]:
            with self.subTest(url=url):
                self.writeStudioBundle(index=f'<html><head><script type="module" src="{url}"></script></head></html>'.encode())
                with self.assertRaises(RuntimeError):
                    stage.stageBundle(self.source, self.site)
                self.assertFalse((self.site / "mypaint").exists())

    def test_studio_accepts_only_the_empty_data_favicon(self):
        self.writeStudioBundle(index=b'<html><head><link rel="icon" href="data:,"><script type="module" src="./assets/main-one.js"></script></head></html>')
        stage.stageBundle(self.source, self.site)
        original = (self.site / "mypaint/manifest.json").read_bytes()
        for rel, url in [("icon", "data:image/svg+xml,anything"), ("stylesheet", "data:,"), ("icon stylesheet", "data:,")]:
            with self.subTest(rel=rel, url=url):
                self.writeStudioBundle(index=f'<html><head><link rel="{rel}" href="{url}"><script type="module" src="./assets/main-one.js"></script></head></html>'.encode())
                with self.assertRaises(RuntimeError):
                    stage.stageBundle(self.source, self.site)
                self.assertEqual((self.site / "mypaint/manifest.json").read_bytes(), original)

    def test_studio_rejects_duplicate_module_resource_attributes(self):
        self.writeStudioBundle(index=b'<html><head><script type="module" src="https://example.invalid/remote.js" src="./assets/main-one.js"></script></head></html>')
        with self.assertRaisesRegex(RuntimeError, "Duplicate resource attribute"):
            stage.stageBundle(self.source, self.site)
        self.assertFalse((self.site / "mypaint").exists())

    def test_studio_rejects_unknown_target_and_missing_notice(self):
        self.writeStudioBundle()
        path = self.source / "bundle.json"
        manifest = json.loads(path.read_text())
        manifest["target"] = "other"
        path.write_text(json.dumps(manifest))
        with self.assertRaises(RuntimeError):
            stage.stageBundle(self.source, self.site)
        self.writeStudioBundle()
        manifest = json.loads(path.read_text())
        del manifest["files"]["LICENSE"]
        (self.source / "LICENSE").unlink()
        path.write_text(json.dumps(manifest))
        with self.assertRaises(RuntimeError):
            stage.stageBundle(self.source, self.site)
        self.assertFalse((self.site / "mypaint").exists())

    def test_studio_copy_failure_preserves_previous_qt_output(self):
        stage.stageBundle(self.source, self.site)
        before = (self.site / "mypaint/manifest.json").read_bytes()
        self.writeStudioBundle()
        with patch.object(shutil, "copyfile", side_effect=OSError("injected copy failure")):
            with self.assertRaises(OSError):
                stage.stageBundle(self.source, self.site)
        self.assertEqual((self.site / "mypaint/manifest.json").read_bytes(), before)
        self.assertFalse((self.site / ".mypaint-build-lock").exists())

    def test_studio_install_failure_restores_previous_qt_output(self):
        stage.stageBundle(self.source, self.site)
        target = self.site / "mypaint"
        before = (target / "manifest.json").read_bytes()
        self.writeStudioBundle()
        replace = os.replace
        def failInstall(source, destination):
            if Path(source).name.startswith(".mypaint-stage-") and Path(destination) == target:
                raise OSError("injected install failure")
            return replace(source, destination)
        with patch.object(os, "replace", side_effect=failInstall):
            with self.assertRaises(OSError):
                stage.stageBundle(self.source, self.site)
        self.assertEqual((target / "manifest.json").read_bytes(), before)
        self.assertEqual((self.site / ".git/index").read_bytes(), self.index)

    def test_failed_rollback_reports_preserved_backup(self):
        stage.stageBundle(self.source, self.site)
        target = self.site / "mypaint"
        before = (target / "manifest.json").read_bytes()
        self.writeStudioBundle()
        replace = os.replace
        def failInstallAndRollback(source, destination):
            if Path(destination) == target:
                raise OSError("injected install and rollback failure")
            return replace(source, destination)
        with patch.object(os, "replace", side_effect=failInstallAndRollback):
            with self.assertRaisesRegex(RuntimeError, "previous output is preserved at"):
                stage.stageBundle(self.source, self.site)
        backups = list(self.site.glob(".mypaint-backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / "manifest.json").read_bytes(), before)
        self.assertFalse((self.site / ".mypaint-build-lock").exists())

    def test_new_staged_changes_during_copy_are_preserved(self):
        stage.stageBundle(self.source, self.site)
        before = (self.site / "mypaint/manifest.json").read_bytes()
        self.writeStudioBundle()
        copy = shutil.copyfile
        stagedIndex = []
        def stageDuringCopy(source, destination):
            result = copy(source, destination)
            if not stagedIndex:
                subprocess.run(["git", "add", "mypaint"], cwd=self.site, check=True)
                stagedIndex.append((self.site / ".git/index").read_bytes())
            return result
        with patch.object(shutil, "copyfile", side_effect=stageDuringCopy):
            with self.assertRaisesRegex(RuntimeError, "Staged mypaint changes appeared"):
                stage.stageBundle(self.source, self.site)
        self.assertEqual((self.site / "mypaint/manifest.json").read_bytes(), before)
        self.assertEqual((self.site / ".git/index").read_bytes(), stagedIndex[0])
        self.assertFalse((self.site / ".mypaint-build-lock").exists())


if __name__ == "__main__":
    unittest.main()
