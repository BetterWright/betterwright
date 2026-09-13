#!/usr/bin/env python3
"""Package GN's browser runtime dependencies, excluding build intermediates."""
import argparse
import hashlib
from pathlib import Path
import shutil
import tempfile
import zipfile


def package_runtime(platform, out, destination, manifest):
    out = Path(out).resolve()
    destination = Path(destination).resolve()
    dependencies = (out / "betterchromium.runtime_deps").read_text().splitlines()
    if not dependencies:
        raise ValueError("The browser runtime dependency list is empty")
    layout = "win-x64" if platform == "win" else "linux-x64"
    with tempfile.TemporaryDirectory(prefix="bw-package-") as temporary:
        root = Path(temporary)
        stage = root / layout
        stage.mkdir()
        for entry in dependencies:
            relative = Path(entry.strip())
            if not entry.strip() or relative.is_absolute() or ".." in relative.parts or not relative.parts:
                raise ValueError(f"Invalid browser runtime dependency: {entry!r}")
            source = out / relative
            # Also reject symlinks that would copy files outside the build output.
            source.resolve(strict=True).relative_to(out)
            target = stage / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                for child in source.rglob("*"):
                    child.resolve(strict=True).relative_to(out)
                shutil.copytree(source, target, dirs_exist_ok=True)
            else:
                shutil.copy2(source, target)

        required = ["resources.pak", "icudtl.dat", "locales/en-US.pak", "chrome_100_percent.pak"]
        if platform == "win":
            required += ["chrome.exe", "chrome.dll", "chrome_elf.dll", "libEGL.dll", "libGLESv2.dll"]
        else:
            required += ["chrome", "chrome-wrapper", "chrome_sandbox", "product_logo_48.png", "libEGL.so", "libGLESv2.so", "libvk_swiftshader.so", "vk_swiftshader_icd.json"]
        for name in required:
            if not (stage / name).is_file():
                raise ValueError(f"Browser runtime dependency missing: {name}")
        if platform == "win":
            if not manifest:
                raise ValueError("Windows packaging requires a version assembly manifest")
            shutil.copy2(manifest, stage / Path(manifest).name)
            (stage / "chrome.exe").rename(stage / "betterchromium.exe")
        else:
            (stage / "chrome").rename(stage / "betterchromium")
            wrapper = stage / "chrome-wrapper"
            wrapper.write_text(wrapper.read_text(encoding="utf-8").replace('"$HERE/chrome"', '"$HERE/betterchromium"'), encoding="utf-8", newline="\n")
            if (stage / "chrome_sandbox").exists():
                (stage / "chrome_sandbox").rename(stage / "chrome-sandbox")

        destination.parent.mkdir(parents=True, exist_ok=True)
        # Write beside the destination and replace only after the zip closes.
        with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=".bw-archive-", delete=False) as handle:
            archive_path = Path(handle.name)
        try:
            with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
                for file in sorted(stage.rglob("*")):
                    if file.is_file():
                        archive.write(file, file.relative_to(root).as_posix())
            archive_path.replace(destination)
        finally:
            archive_path.unlink(missing_ok=True)
    with destination.open("rb") as archive:
        digest = hashlib.file_digest(archive, "sha256").hexdigest()
    print(f"{digest}  {destination}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("platform", choices=["linux", "win"])
    parser.add_argument("out")
    parser.add_argument("destination")
    parser.add_argument("--manifest")
    args = parser.parse_args()
    package_runtime(args.platform, args.out, args.destination, args.manifest)
