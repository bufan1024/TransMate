from argparse import ArgumentParser
from json import loads
from pathlib import Path
from subprocess import check_output
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[1]
RUNTIME_DIRECTORIES = {"lib", "icons", "_locales", "vendor"}
ENTRY_EXTENSIONS = {".js", ".mjs", ".css", ".html"}


def is_runtime_file(path):
    return path.as_posix() == "manifest.json" or (
        len(path.parts) == 1 and path.suffix in ENTRY_EXTENSIONS
    ) or (len(path.parts) > 1 and path.parts[0] in RUNTIME_DIRECTORIES)


def main():
    manifest = loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    package = loads((ROOT / "package.json").read_text(encoding="utf-8"))
    lockfile = loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
    if any(value != version for value in (package["version"], lockfile["version"], lockfile["packages"][""]["version"])):
        raise SystemExit("The manifest, package and package lock must declare the same version.")

    parser = ArgumentParser(description="Package tracked TransMate runtime files for Chrome Web Store.")
    parser.add_argument("--output", type=Path, default=ROOT / "dist" / f"TransMate-{version}.zip")
    output = parser.parse_args().output.resolve()
    if output.suffix != ".zip":
        parser.error("--output must have a .zip extension")

    tracked = check_output(["git", "ls-files", "-z"], cwd=ROOT).decode("utf-8").split("\0")
    files = sorted(Path(name) for name in tracked if name and is_runtime_file(Path(name)))
    if Path("manifest.json") not in files:
        raise SystemExit("The checkout has no tracked extension manifest.")
    output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=output.parent) as directory:
        temporary = Path(directory) / "extension.zip"
        with ZipFile(temporary, "w", compression=ZIP_DEFLATED) as archive:
            for relative in files:
                source = ROOT / relative
                if not source.is_file() or source.resolve() != source:
                    raise SystemExit(f"Missing or linked runtime resource: {relative}")
                entry = ZipInfo(relative.as_posix())
                archive.writestr(entry, source.read_bytes(), compress_type=ZIP_DEFLATED)
        temporary.replace(output)
    print(f"{output} ({len(files)} runtime files)")


if __name__ == "__main__":
    main()
