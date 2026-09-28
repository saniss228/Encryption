#!/usr/bin/env python3
"""
Упаковка архивов Encryption с правильными именами файлов.

Зачем свой упаковщик: обычный `zip` в Linux не ставит флаг UTF-8 в именах,
и Windows показывает русские имена как «╨₧╨ó╨ƒ…». Здесь имена всегда
записываются в UTF-8 с флагом — Проводник и 7-Zip открывают архив корректно.

Примеры:
    # всё содержимое каталога stage (пути внутри архива — относительные)
    python3 tools/make_zip.py release/encryption-3.1.0-all.zip /tmp/stage

    # только нужные части проекта
    python3 tools/make_zip.py release/encryption-3.1.0-server-web.zip . \
        server web deploy tools docs README.md --exclude '**/__pycache__/**' --exclude '*.pyc'
"""
from __future__ import annotations

import argparse
import fnmatch
import os
import sys
import zipfile

# Уже сжатое — не тратим время на deflate
STORE_EXT = {".exe", ".apk", ".zip", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".woff", ".woff2",
             ".mp3", ".mp4", ".keystore", ".bundle"}


def match_any(rel: str, patterns: list[str]) -> bool:
    for p in patterns:
        if fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(rel, p.rstrip("/") + "/*"):
            return True
        # «**/имя» должно ловить и имя в корне
        if p.startswith("**/") and fnmatch.fnmatch(rel, p[3:]):
            return True
    return False


def walk(root: str, paths: list[str], excludes: list[str]):
    """Пара (абсолютный путь, путь внутри архива)."""
    if not paths:
        paths = ["."]
    for p in paths:
        start = os.path.join(root, p)
        if os.path.isfile(start):
            rel = os.path.relpath(start, root).replace(os.sep, "/")
            if not match_any(rel, excludes):
                yield start, rel
            continue
        for base, dirs, names in os.walk(start):
            dirs[:] = sorted(d for d in dirs if not match_any(
                os.path.relpath(os.path.join(base, d), root).replace(os.sep, "/") + "/", excludes))
            for n in sorted(names):
                full = os.path.join(base, n)
                rel = os.path.relpath(full, root).replace(os.sep, "/")
                if match_any(rel, excludes):
                    continue
                yield full, rel


def main() -> int:
    ap = argparse.ArgumentParser(description="ZIP с именами в UTF-8")
    ap.add_argument("output", help="куда писать архив")
    ap.add_argument("root", help="каталог-основа (пути внутри архива считаются от него)")
    ap.add_argument("paths", nargs="*", help="что включить (по умолчанию — всё в root)")
    ap.add_argument("--exclude", action="append", default=[], help="шаблон исключения (можно повторять)")
    ap.add_argument("--level", type=int, default=9, help="уровень сжатия (по умолчанию 9)")
    ap.add_argument("--no-symlinks-follow", action="store_true", help="не разыменовывать ссылки")
    args = ap.parse_args()

    if not os.path.isdir(args.root):
        print(f"✗ Нет каталога: {args.root}")
        return 2

    os.makedirs(os.path.dirname(os.path.abspath(args.output)) or ".", exist_ok=True)
    files = 0
    stored = 0
    total_in = total_out = 0

    with zipfile.ZipFile(args.output, "w", allowZip64=True) as z:
        for full, rel in walk(args.root, args.paths, args.exclude):
            ext = os.path.splitext(rel)[1].lower()
            compress = zipfile.ZIP_STORED if ext in STORE_EXT else zipfile.ZIP_DEFLATED
            if compress == zipfile.ZIP_STORED:
                stored += 1
            info = zipfile.ZipInfo.from_file(full, arcname=rel)
            info.compress_type = compress
            info.flag_bits |= 0x800                   # ← имена в UTF-8 (для Windows)
            if os.name != "nt":
                st = os.stat(full)
                info.external_attr = (0o755 if st.st_mode & 0o111 else 0o644) << 16
            with open(full, "rb") as src, z.open(info, "w") as dst:
                while True:
                    chunk = src.read(1 << 20)
                    if not chunk:
                        break
                    total_in += len(chunk)
                    dst.write(chunk)
            files += 1

    size = os.path.getsize(args.output)
    print(f"✓ {args.output}: файлов {files} (из них без сжатия {stored}), "
          f"исходно {total_in / 1048576:.1f} МБ → архив {size / 1048576:.1f} МБ")
    return 0


if __name__ == "__main__":
    sys.exit(main())
