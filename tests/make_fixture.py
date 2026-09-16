#!/usr/bin/env python3
"""
Creates a fake update package that mimics what `fbt updater_package` produces.

It uses the same settings as the real build (scripts/flipper/assets/tarball.py):
    tarfile.USTAR_FORMAT + gzip level 9

Usage:
    python tests/make_fixture.py [output.tgz]
"""

import io
import os
import sys
import tarfile
import tempfile
from pathlib import Path

SUFFIX = "slowed-001"
TARGET = "f7"
BUNDLE = f"{TARGET}-update-slowed"

FILES = {
    "update.fuf": (
        "Filetype: Flipper firmware upgrade configuration\n"
        "Version: 2\n"
        f"Info: {SUFFIX}\n"
        f"Target: {TARGET[1:]}\n"
        "Loader: updater.bin\n"
        "# little-endian hex!\n"
        "Loader CRC: 12 34 56 78\n"
        "Firmware: firmware.dfu\n"
        "Radio: radio.bin\n"
        "Radio address: 00 00 40 08\n"
        "Resources: resources.ths\n"
    ),
    "updater.bin": "stage-2 loader".ljust(1024, "."),
    "firmware.dfu": "DfuSe" + "\x01" + "fake firmware image".ljust(4096, " "),
    "radio.bin": "BLE stack".ljust(512, "-"),
    "resources.ths": "heatshrink resources".ljust(2048, "*"),
}


def sanitize(tarinfo: tarfile.TarInfo) -> tarfile.TarInfo:
    """Same normalisation the firmware build applies (furippa / epoch 0)."""
    tarinfo.gid = tarinfo.uid = 0
    tarinfo.mtime = 0
    tarinfo.uname = tarinfo.gname = "furippa"
    return tarinfo


def build(output: Path) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        bundle = Path(tmp) / BUNDLE
        bundle.mkdir()
        for name, content in FILES.items():
            (bundle / name).write_bytes(content.encode())

        raw = io.BytesIO()
        with tarfile.open(
            fileobj=raw,
            mode="w:",
            format=tarfile.USTAR_FORMAT,
        ) as tar:
            tar.add(bundle, arcname=BUNDLE, filter=sanitize)

        with tarfile.open(output, "w:gz", compresslevel=9, format=tarfile.USTAR_FORMAT) as tar:
            tar.add(bundle, arcname=BUNDLE, filter=sanitize)

    return output


def main() -> int:
    default = Path(__file__).resolve().parent / "fixtures" / "sample-update.tgz"
    output = Path(sys.argv[1]) if len(sys.argv) > 1 else default
    build(output)
    print(f"Wrote {output} ({os.path.getsize(output)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
