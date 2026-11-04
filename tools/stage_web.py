"""Validate a local web bundle and replace only a homepage's mypaint directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tempfile
import uuid

MAX_FILE = 100 * 1024 * 1024 - 1
MAX_SITE = 900 * 1024 * 1024


def readManifest(folder, filename, owner):
    if folder.is_symlink() or not folder.is_dir():
        raise RuntimeError("Bundle path must be an ordinary directory")
    path = folder / filename
    if path.is_symlink() or path.stat().st_size > 4 * 1024 * 1024:
        raise RuntimeError("Invalid manifest")
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise RuntimeError("Manifest must be an object")
    files = manifest.get("files")
    if manifest.get("owner") != owner or manifest.get("schema") != 1 or not isinstance(files, dict) or len(files) > 8192:
        raise RuntimeError("Unknown bundle ownership or manifest schema")
    for rel, digest in files.items():
        if not isinstance(rel, str) or not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise RuntimeError("Invalid manifest hash entry")
        name = PurePosixPath(rel)
        if not rel or name.is_absolute() or str(name) != rel or ".." in name.parts or "\\" in rel or ":" in rel or "\0" in rel:
            raise RuntimeError("Unsafe manifest path")
        item = folder / rel
        if any((folder.joinpath(*name.parts[:index])).is_symlink() for index in range(1, len(name.parts) + 1)):
            raise RuntimeError("Symbolic links are not supported")
        if not item.is_file() or item.stat().st_size > MAX_FILE:
            raise RuntimeError("Missing or oversized bundle file: " + rel)
        if hashlib.sha256(item.read_bytes()).hexdigest() != digest:
            raise RuntimeError("A generated file was changed manually: " + rel)
    directories = {str(parent) for rel in files for parent in PurePosixPath(rel).parents if str(parent) != "."}
    actual = set()
    for item in folder.rglob("*"):
        if item.is_symlink():
            raise RuntimeError("Symbolic link in bundle")
        if item.is_dir() and item.relative_to(folder).as_posix() not in directories:
            raise RuntimeError("Unmanaged directory exists in the output")
        if item.is_file():
            actual.add(item.relative_to(folder).as_posix())
    if actual != set(files) | {filename}:
        raise RuntimeError("Unmanaged files exist in the output directory")
    return manifest


def stageBundle(source, homepage, check=False):
    source, homepage = Path(source).absolute(), Path(homepage).absolute()
    if homepage.is_symlink() or not homepage.is_dir():
        raise RuntimeError("Homepage directory is missing or symbolic")
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0")
    top = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], cwd=homepage, env=env, text=True).strip()
    if Path(top).resolve() != homepage.resolve():
        raise RuntimeError("Use the homepage repository root")
    target = homepage / "mypaint"
    if source.resolve().is_relative_to(target.resolve()) or target.resolve().is_relative_to(source.resolve()):
        raise RuntimeError("Source and destination overlap")
    if target.is_symlink():
        raise RuntimeError("Symbolic destination is not supported")
    staged = subprocess.run(["git", "diff", "--cached", "--quiet", "--", "mypaint"], cwd=homepage, env=env)
    if staged.returncode:
        raise RuntimeError("Commit or review staged mypaint changes before rebuilding")
    bundle = readManifest(source, "bundle.json", "myPaint-web-bundle")
    allowed = {"index.html", "retropaint.js", "retropaint.wasm", "qtloader.js", "licenses.html", "BUILDING.txt"}
    if any(rel not in allowed and not rel.startswith("shared/") for rel in bundle["files"]):
        raise RuntimeError("Unknown web bundle layout")
    if any(any(part.startswith(".") for part in PurePosixPath(rel).parts) for rel in bundle["files"]):
        raise RuntimeError("Hidden bundle paths are not supported")
    if not {"index.html", "retropaint.js", "retropaint.wasm", "qtloader.js", "licenses.html"}.issubset(bundle["files"]):
        raise RuntimeError("Incomplete web bundle")
    if (source / "retropaint.wasm").read_bytes()[:8] != b"\0asm\x01\0\0\0":
        raise RuntimeError("Invalid WebAssembly module")
    original = readManifest(target, "manifest.json", "myPaint-web-output") if target.exists() else None
    if original and any(rel != "index.html" and not rel.startswith(("shared/", "releases/")) for rel in original["files"]):
        raise RuntimeError("Unknown previous output layout")
    release = hashlib.sha256(json.dumps(bundle, sort_keys=True).encode()).hexdigest()[:24]
    files = dict(original["files"]) if original else {}
    payload = {}
    for rel in bundle["files"]:
        destination = rel if rel.startswith("shared/") else f"releases/{release}/{rel}"
        payload[destination] = source / rel
        files[destination] = bundle["files"][rel]
    html = (source / "index.html").read_text(encoding="utf-8")
    if html.count("<head>") != 1 or "<base" in html.lower():
        raise RuntimeError("The application shell must have one head and no base element")
    index = html.replace("<head>", f'<head>\n<base href="./releases/{release}/">', 1).encode()
    files["index.html"] = hashlib.sha256(index).hexdigest()
    licensePath = f"releases/{release}/licenses.html"
    licenseHtml = (source / "licenses.html").read_text(encoding="utf-8")
    if licenseHtml.count("<head>") != 1 or "<base" in licenseHtml.lower():
        raise RuntimeError("Invalid license page")
    licenseBytes = licenseHtml.replace("<head>", '<head>\n<base href="../../">', 1).encode()
    files[licensePath] = hashlib.sha256(licenseBytes).hexdigest()
    total = len(index)
    for rel in files:
        if rel == "index.html":
            continue
        total += len(licenseBytes) if rel == licensePath else (payload.get(rel) or target / rel).stat().st_size
    if total > MAX_SITE or len(files) > 8192:
        raise RuntimeError("Retained releases exceed the local site budget; review old releases manually")
    manifest = {"schema": 1, "owner": "myPaint-web-output", "release": release,
                "source": bundle.get("source", {}), "files": files}
    metadata = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()
    if check:
        return {"release": release, "bytes": total, "changed": original != manifest}
    if original == manifest:
        return {"release": release, "bytes": total, "changed": False}
    lock = homepage / ".mypaint-build-lock"
    lock.mkdir()
    staging = None
    backup = homepage / (".mypaint-backup-" + uuid.uuid4().hex)
    try:
        staging = Path(tempfile.mkdtemp(prefix=".mypaint-stage-", dir=homepage))
        for rel in files:
            out = staging / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            if rel == "index.html":
                out.write_bytes(index)
            elif rel == licensePath:
                out.write_bytes(licenseBytes)
            else:
                shutil.copyfile(payload.get(rel) or target / rel, out)
        (staging / "manifest.json").write_bytes(metadata)
        readManifest(staging, "manifest.json", "myPaint-web-output")
        if original:
            if readManifest(target, "manifest.json", "myPaint-web-output") != original:
                raise RuntimeError("Destination changed during preparation")
        elif target.exists():
            raise RuntimeError("Destination appeared during preparation")
        if target.exists():
            os.replace(target, backup)
        try:
            os.replace(staging, target)
        except BaseException:
            if backup.exists():
                os.replace(backup, target)
            raise
        if backup.exists():
            try:
                shutil.rmtree(backup)
            except OSError:
                print("Output updated; retained backup requires review:", backup)
        return {"release": release, "bytes": total, "changed": True}
    finally:
        if staging and staging.exists():
            shutil.rmtree(staging)
        lock.rmdir()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("homepage", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(stageBundle(args.source, args.homepage, args.check), indent=2))
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    main()
