"""Build Qt Wasm, package matching sources, and update the sibling homepage locally."""
import argparse
import gzip
import hashlib
import html
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
from stage_web import MAX_FILE, readManifest, stageBundle


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--qt", type=Path, default=root / "build-tools/qt-wasm")
    parser.add_argument("--emsdk", type=Path, default=root / "build-tools/emsdk")
    parser.add_argument("--qt-source", type=Path, default=root / "build-tools/qtbase")
    parser.add_argument("--host-qt", type=Path)
    parser.add_argument("--homepage", type=Path, default=root.parent / "parkjh2568.github.io")
    parser.add_argument("--bundle-qt-source", action="store_true", help="Include the full Qt archive instead of its pinned official download link")
    parser.add_argument("--prune", action="store_true", help="Remove older releases and unused shared files from the homepage after validation")
    parser.add_argument("--no-stage", action="store_true", help="Build dist/web without updating the homepage")
    args = parser.parse_args()
    try:
        if args.homepage.resolve() == root:
            raise RuntimeError("The homepage must be a separate repository")
        qt, sdk, qtSource = args.qt.resolve(), args.emsdk.resolve(), args.qt_source.resolve()
        qtCmake = qt / "bin" / ("qt-cmake.bat" if os.name == "nt" else "qt-cmake")
        if not qtCmake.is_file() or not (sdk / ".emscripten").is_file():
            raise RuntimeError("Prepare the exception-enabled Qt Wasm SDK first; see docs/WEB_BUILD.md")
        env = dict(os.environ, GIT_OPTIONAL_LOCKS="0")
        env["PATH"] = os.pathsep.join((str(sdk / "upstream/emscripten"), str(sdk), env.get("PATH", "")))
        env["EM_CONFIG"] = str(sdk / ".emscripten")
        env["EMSDK"] = str(sdk)
        compilerVersion = subprocess.check_output([str(sdk / "upstream/emscripten/em++"), "--version"], env=env, text=True)
        qtVersion = (qt / "lib/cmake/Qt6Core/Qt6CoreConfigVersionImpl.cmake").read_text()
        if not re.search(r"\b5\.0\.5\b", compilerVersion) or 'set(PACKAGE_VERSION "6.12.0")' not in qtVersion:
            raise RuntimeError("This build recipe requires the verified Qt 6.12.0 / Emscripten 5.0.5 pair")
        command = [str(qtCmake), "-S", str(root), "-B", str(root / "build-web"), "-G", "Ninja",
                   "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_TESTING=OFF"]
        if args.host_qt:
            command.append("-DQT_HOST_PATH=" + str(args.host_qt.resolve()))
        sourceFiles = []
        for directory in ("src", "web", "tools", "assets", "tests", "licenses"):
            for file in sorted((root / directory).rglob("*")):
                if file.is_symlink():
                    raise RuntimeError("Symbolic source file is not supported")
                if file.is_file() and file.suffix in {".cpp", ".h", ".py", ".mjs", ".js", ".html", ".txt", ".ttf", ".md", ".cmake", ".svg"}:
                    sourceFiles.append(file)
        sourceFiles.append(root / "docs/WEB_BUILD.md")
        sourceFiles += [root / name for name in ("CMakeLists.txt", "LICENSE", "NOTICE.md", "README.md", "AGENTS.md", ".clang-format", ".editorconfig")]
        before = {str(file.relative_to(root)): hashlib.sha256(file.read_bytes()).hexdigest() for file in sourceFiles}
        subprocess.run(command, cwd=root, env=env, check=True)
        subprocess.run(["cmake", "--build", str(root / "build-web"), "--parallel", "2"], cwd=root, env=env, check=True)
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, env=env, text=True).strip()
        dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=root, env=env))
        qtCommit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=qtSource, env=env, text=True).strip()
        if subprocess.check_output(["git", "status", "--porcelain"], cwd=qtSource, env=env):
            raise RuntimeError("Qt sources must match their recorded commit")
        work = root / "build-web-work"
        work.mkdir(exist_ok=True)
        qtSourceUrl = "https://codeload.github.com/qt/qtbase/tar.gz/" + qtCommit
        if not args.bundle_qt_source and qtCommit != "025bdad181de241e81bf853c8a2d7bf3d19261a9":
            raise RuntimeError("The external source offer is verified only for the pinned unmodified Qt commit; use --bundle-qt-source")
        if args.bundle_qt_source:
            qtArchive = work / ("qtbase-" + qtCommit + ".tar.gz")
            checksumFile = qtArchive.with_suffix(".sha256")
            if qtArchive.exists() and qtArchive.stat().st_size > MAX_FILE:
                raise RuntimeError("Qt source archive exceeds the file budget")
            if not qtArchive.exists() or not checksumFile.exists() or checksumFile.read_text().strip() != hashlib.sha256(qtArchive.read_bytes()).hexdigest():
                temporary = qtArchive.with_suffix(".tmp")
                try:
                    with temporary.open("wb") as output, gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0) as compressed:
                        with subprocess.Popen(["git", "archive", "--format=tar", qtCommit], cwd=qtSource, env=env, stdout=subprocess.PIPE) as process:
                            shutil.copyfileobj(process.stdout, compressed)
                            if process.wait():
                                raise RuntimeError("Qt source archive failed")
                    os.replace(temporary, qtArchive)
                    checksumFile.write_text(hashlib.sha256(qtArchive.read_bytes()).hexdigest() + "\n")
                finally:
                    temporary.unlink(missing_ok=True)
        dist = root / "dist"
        if dist.is_symlink():
            raise RuntimeError("The dist directory must not be symbolic")
        dist.mkdir(exist_ok=True)
        candidate = Path(tempfile.mkdtemp(prefix=".web-", dir=dist))
        try:
            for name in ("retropaint.js", "retropaint.wasm", "qtloader.js"):
                shutil.copyfile(root / "build-web" / name, candidate / name)
            shutil.copyfile(root / "web/index.html", candidate / "index.html")
            appArchive = work / "myPaint-source.tar.gz"
            with appArchive.open("wb") as output, gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode="w") as archive:
                    for file in sourceFiles:
                        info = archive.gettarinfo(str(file), "myPaint/" + str(file.relative_to(root)))
                        info.mtime, info.uid, info.gid, info.uname, info.gname = 0, 0, 0, "", ""
                        with file.open("rb") as data:
                            archive.addfile(info, data)
            if before != {str(file.relative_to(root)): hashlib.sha256(file.read_bytes()).hexdigest() for file in sourceFiles}:
                raise RuntimeError("Source changed during packaging; rebuild")
            shared = candidate / "shared"
            links = []
            noticeFiles = [root / "LICENSE", root / "NOTICE.md", root / "assets/fonts/OFL.txt"]
            noticeFiles += list((qtSource / "LICENSES").glob("*.txt"))
            emLicense = sdk / "upstream/emscripten/LICENSE"
            if emLicense.is_file(): noticeFiles.append(emLicense)
            runtimeLicenses = {"libcxx": "system/lib/libcxx/LICENSE.TXT",
                               "libcxxabi": "system/lib/libcxxabi/LICENSE.TXT",
                               "libunwind": "system/lib/libunwind/LICENSE.TXT",
                               "compiler-rt": "system/lib/compiler-rt/LICENSE.TXT",
                               "musl": "system/lib/libc/musl/COPYRIGHT"}
            runtimeNames = {}
            for component, relative in runtimeLicenses.items():
                licenseFile = sdk / "upstream/emscripten" / relative
                if not licenseFile.is_file():
                    raise RuntimeError("Missing runtime license: " + relative)
                noticeFiles.append(licenseFile)
                runtimeNames[licenseFile] = component + "-LICENSE.txt"
            archives = [(appArchive, "Application sources and build tools")]
            if args.bundle_qt_source:
                archives.insert(0, (qtArchive, "Qt corresponding sources"))
            else:
                links.append((qtSourceUrl, "Qt 6.12.0 corresponding sources — exact unmodified commit (official download)"))
            for file, label in archives:
                if file.stat().st_size > MAX_FILE:
                    raise RuntimeError("An archive exceeds the GitHub file limit")
                digest = hashlib.sha256(file.read_bytes()).hexdigest()
                target = shared / digest / file.name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(file, target)
                links.append((target.relative_to(candidate).as_posix(), label))
            for file in noticeFiles:
                if file.stat().st_size > MAX_FILE:
                    raise RuntimeError("An archive exceeds the GitHub file limit")
                digest = hashlib.sha256(file.read_bytes()).hexdigest()
                name = runtimeNames.get(file, "Emscripten-LICENSE" if file == emLicense else file.name)
                target = shared / digest / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(file, target)
                links.append((target.relative_to(candidate).as_posix(), name))
            buildInfo = "Qt source commit: " + qtCommit + "\nEmscripten: 5.0.5\nQt: 6.12.0\nQt configure: -release -static -no-feature-thread -feature-wasm-exceptions -nomake tests -nomake examples -no-feature-network -no-feature-dbus -no-feature-sql -no-feature-testlib -no-feature-printsupport -no-openssl -platform wasm-emscripten -qt-host-path <host-Qt> -prefix <Wasm-Qt>\nApp rebuild from the source archive (no Git metadata needed): source <Emscripten-SDK>/emsdk_env.sh; <Wasm-Qt>/bin/qt-cmake -S myPaint -B app-build -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF -DQT_HOST_PATH=<host-Qt>; cmake --build app-build --parallel 2; copy myPaint/web/index.html to app-build/index.html for the browser shell.\n"
            (candidate / "BUILDING.txt").write_text(buildInfo, encoding="utf-8")
            (candidate / "licenses.html").write_text("<!doctype html><html lang=ko><head><meta charset=utf-8><title>라이선스와 소스</title></head><body><h1>라이선스와 소스</h1><ul>" + "".join('<li><a href="' + html.escape(url, quote=True) + '">' + html.escape(label) + '</a></li>' for url, label in links) + "</ul><pre>" + html.escape((root / "NOTICE.md").read_text()) + "</pre><h2>Build and relink</h2><pre>" + html.escape(buildInfo) + "</pre></body></html>", encoding="utf-8")
            hashes = {str(file.relative_to(candidate)): hashlib.sha256(file.read_bytes()).hexdigest() for file in sorted(candidate.rglob("*")) if file.is_file()}
            manifest = {"schema": 1, "owner": "myPaint-web-bundle", "source": {"commit": commit, "dirty": dirty,
                        "sourceFiles": before, "qtCommit": qtCommit, "qtSourceUrl": qtSourceUrl,
                        "qtSourceBundled": args.bundle_qt_source}, "files": hashes}
            (candidate / "bundle.json").write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n", encoding="utf-8")
            destination = dist / "web"
            if destination.exists() or destination.is_symlink():
                readManifest(destination, "bundle.json", "myPaint-web-bundle")
            previous = dist / ".web-previous"
            if previous.exists():
                raise RuntimeError("Review retained dist/.web-previous before rebuilding")
            if destination.exists(): os.replace(destination, previous)
            try: os.replace(candidate, destination)
            except BaseException:
                if previous.exists(): os.replace(previous, destination)
                raise
            if previous.exists(): shutil.rmtree(previous)
            if not args.no_stage:
                print(json.dumps(stageBundle(destination, args.homepage, prune=args.prune), indent=2))
            print("Local web output ready. Commit and push separately in the homepage directory.")
        finally:
            if candidate.exists(): shutil.rmtree(candidate)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    main()
