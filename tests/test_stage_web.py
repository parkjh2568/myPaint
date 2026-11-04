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


if __name__ == "__main__":
    unittest.main()
