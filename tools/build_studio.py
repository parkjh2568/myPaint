"""Build a small Studio bundle; optionally copy it to a separate local homepage repository."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from stage_web import MAX_FILE, MAX_SITE, readBundle, stageBundle


def sourceManifest(root):
    paths = []
    for relative in ("web-app/src", "web-app/public", "web-app/tests", "web-app/tools"):
        directory = root / relative
        if directory.is_symlink() or not directory.is_dir():
            raise RuntimeError("Source directories must be ordinary directories: " + relative)
        for item in sorted(directory.rglob("*")):
            if item.is_symlink():
                raise RuntimeError("Symbolic source paths are not supported")
            if item.is_file():
                paths.append(item)
    paths += [root / name for name in ("LICENSE", "NOTICE.md", "tools/build_studio.py", "tools/stage_web.py",
                                      "web-app/package.json", "web-app/package-lock.json", "web-app/tsconfig.json",
                                      "web-app/vite.config.ts", "web-app/index.html")]
    if any(item.is_symlink() or not item.is_file() for item in paths):
        raise RuntimeError("Missing or symbolic build input")
    return {item.relative_to(root).as_posix(): hashlib.sha256(item.read_bytes()).hexdigest() for item in paths}


def buildStudio(root):
    root = Path(root).resolve()
    dist = root / "dist"
    if dist.is_symlink():
        raise RuntimeError("The dist directory must not be symbolic")
    dist.mkdir(exist_ok=True)
    destination = dist / "studio"
    previous = readBundle(destination) if destination.exists() or destination.is_symlink() else None
    if previous and previous.get("target") != "studio":
        raise RuntimeError("The Studio output belongs to another build target")
    backup = dist / ".studio-previous"
    if backup.exists() or backup.is_symlink():
        raise RuntimeError("Review retained dist/.studio-previous before rebuilding")
    node = shutil.which("node")
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not node or not npm:
        raise RuntimeError("Install Node/npm and run npm --prefix web-app ci first")
    npmPath = Path(npm).resolve()
    npmCli = npmPath if npmPath.name == "npm-cli.js" else npmPath.parent / "node_modules/npm/bin/npm-cli.js"
    if npmCli.is_file():
        command = [node, str(npmCli)]
    elif os.name != "nt":
        command = [npm]
    else:
        raise RuntimeError("Cannot locate npm-cli.js beside npm; use a standard Node/npm installation")
    command += ["--prefix", str(root / "web-app"), "run", "build"]
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0")
    lock = dist / ".studio-build-lock"
    lock.mkdir()
    candidate = None
    try:
        before = sourceManifest(root)
        candidate = Path(tempfile.mkdtemp(prefix=".studio-", dir=dist))
        subprocess.run(command + ["--", "--outDir", str(candidate), "--emptyOutDir"], cwd=root, env=env, check=True)
        if sourceManifest(root) != before:
            raise RuntimeError("Source changed during the build; rebuild before packaging")
        if candidate.is_symlink() or not candidate.is_dir():
            raise RuntimeError("The Vite output must be an ordinary directory")
        try:
            with (candidate / "LICENSE").open("xb") as output, (root / "LICENSE").open("rb") as licenseFile:
                shutil.copyfileobj(licenseFile, output)
        except FileExistsError as error:
            raise RuntimeError("The build output contains the reserved LICENSE path") from error
        total = 0
        for item in sorted(candidate.rglob("*")):
            if item.is_symlink():
                raise RuntimeError("Symbolic Vite output paths are not supported")
            if item.is_file():
                size = item.stat().st_size
                total += size
                if size > MAX_FILE or total > MAX_SITE:
                    raise RuntimeError("Studio output exceeds the local bundle budget")
        files = {item.relative_to(candidate).as_posix(): hashlib.sha256(item.read_bytes()).hexdigest()
                 for item in sorted(candidate.rglob("*")) if item.is_file()}
        if sourceManifest(root) != before:
            raise RuntimeError("Source changed during packaging; rebuild")
        source = {
            "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, env=env, text=True).strip(),
            "dirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=root, env=env)),
            "sourceFiles": before,
            "node": subprocess.check_output([node, "--version"], cwd=root, text=True).strip(),
        }
        manifest = {"schema": 1, "owner": "myPaint-web-bundle", "target": "studio", "source": source, "files": files}
        (candidate / "bundle.json").write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        readBundle(candidate)
        if previous:
            if readBundle(destination) != previous:
                raise RuntimeError("Studio output changed during preparation")
        elif destination.exists() or destination.is_symlink():
            raise RuntimeError("Studio output appeared during preparation")
        if destination.exists():
            os.replace(destination, backup)
        try:
            os.replace(candidate, destination)
        except BaseException:
            if backup.exists():
                try:
                    os.replace(backup, destination)
                except OSError as error:
                    raise RuntimeError("Install failed; previous bundle is preserved at " + str(backup)) from error
            raise
        if backup.exists():
            try:
                shutil.rmtree(backup)
            except OSError:
                print("Local bundle updated; retained backup requires review:", backup)
        return {"output": str(destination), "files": len(files), "bytes": sum((destination / name).stat().st_size for name in files)}
    finally:
        if candidate and candidate.exists():
            shutil.rmtree(candidate)
        lock.rmdir()


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--homepage", type=Path, help="Optionally copy into this separate local homepage repository; never commit or push")
    parser.add_argument("--prune", action="store_true", help="With --homepage, remove validated old releases; old open tabs may stop loading assets")
    args = parser.parse_args()
    try:
        if args.prune and not args.homepage:
            raise RuntimeError("--prune requires --homepage; preview separately with stage_web.py --check --prune")
        if args.homepage and args.homepage.resolve() == root:
            raise RuntimeError("The homepage must be a separate repository")
        result = buildStudio(root)
        print(json.dumps(result, indent=2))
        # Local output remains available if the independent homepage stage fails.
        if args.homepage:
            print(json.dumps(stageBundle(Path(result["output"]), args.homepage, prune=args.prune), indent=2))
        print("Local Studio bundle ready. Review, commit and push separately in the homepage directory.")
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    main()
