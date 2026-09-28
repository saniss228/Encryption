#!/usr/bin/env python3
"""
Перенос данных сервера Encryption на другой сервер.

Один файл копии содержит всё: аккаунты, чаты, сообщения (шифротексты),
файлы, медиа и ключи сервера. Файл закрыт паролем (AES-256-GCM,
ключ из пароля через PBKDF2-HMAC-SHA512, 300 000 итераций).

    # снять копию с текущего сервера
    python3 tools/migrate_server.py export --out encryption-backup.encbak

    # посмотреть, что внутри копии (ничего не записывая)
    python3 tools/migrate_server.py verify encryption-backup.encbak

    # развернуть на новом сервере (сервер должен быть остановлен)
    python3 tools/migrate_server.py import encryption-backup.encbak --force

Каталог данных берётся из ENC_DATA_DIR, по умолчанию — ./data.
Пароль спрашивается скрытно и нигде не сохраняется.
"""
from __future__ import annotations

import argparse
import getpass
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server import backup  # noqa: E402


def _password(confirm: bool = False) -> str:
    if os.environ.get("ENC_BACKUP_PASSWORD"):
        return os.environ["ENC_BACKUP_PASSWORD"]
    if not sys.stdin.isatty():
        print("✗ Нужен пароль. Задайте ENC_BACKUP_PASSWORD или запустите в терминале.",
              file=sys.stderr)
        raise SystemExit(2)
    pwd = getpass.getpass("Пароль к копии: ").strip()
    if confirm:
        again = getpass.getpass("Повторите пароль: ").strip()
        if pwd != again:
            print("✗ Пароли не совпали.", file=sys.stderr)
            raise SystemExit(2)
    return pwd


def _data_dir(arg: str | None) -> Path:
    return Path(arg or os.getenv("ENC_DATA_DIR", "data")).resolve()


def cmd_export(args: argparse.Namespace) -> int:
    data_dir = _data_dir(args.data)
    out = Path(args.out).resolve()
    pwd = _password(confirm=True)
    print(f"→ Каталог данных: {data_dir}")
    print(f"→ Копия:          {out}")
    try:
        summary = backup.export_to_file(
            data_dir, out, pwd, include_logs=args.logs,
            extra={"server_version": _version(), "host": os.uname().nodename})
    except backup.BackupError as exc:
        print(f"✗ {exc}", file=sys.stderr)
        return 1
    mb = summary["archive_bytes"] / 1024 / 1024
    print(f"✓ Готово: файлов {summary['files']}, открытых данных "
          f"{summary['bytes'] / 1024 / 1024:.1f} МБ, архив {mb:.1f} МБ")
    print("  Перенесите файл на новый сервер и выполните:")
    print(f"     python3 tools/migrate_server.py import {out.name} --force")
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    path = Path(args.file).resolve()
    info = backup.archive_info(path)
    if not info["is_backup"]:
        print("✗ Это не файл резервной копии Encryption.", file=sys.stderr)
        return 1
    pwd = _password()
    try:
        res = backup.peek(path, pwd)
    except backup.BackupError as exc:
        print(f"✗ {exc}", file=sys.stderr)
        return 1
    print(f"✓ Копия цела: {res['files']} файлов, {res['restored_bytes'] / 1024 / 1024:.1f} МБ данных")
    created = res.get("created_at")
    if created:
        import datetime
        print("  Снята:", datetime.datetime.fromtimestamp(created).strftime("%d.%m.%Y %H:%M"))
    if res.get("server_version"):
        print("  Версия сервера в копии:", res["server_version"])
    return 0


def cmd_import(args: argparse.Namespace) -> int:
    path = Path(args.file).resolve()
    data_dir = _data_dir(args.data)
    pwd = _password()
    try:
        res = backup.import_from_file(path, data_dir, pwd, force=args.force)
    except backup.BackupError as exc:
        print(f"✗ {exc}", file=sys.stderr)
        return 1
    print(f"✓ Данные развёрнуты в {data_dir}: файлов {res['files']}, "
          f"{res['restored_bytes'] / 1024 / 1024:.1f} МБ")
    print("  Теперь запустите сервер обычным способом:")
    print("     bash tools/start-server.sh          (Linux/macOS)")
    print("     ЗАПУСТИТЬ-МЕССЕНДЖЕР-WINDOWS.cmd   (Windows)")
    return 0


def cmd_info(args: argparse.Namespace) -> int:
    path = Path(args.file).resolve()
    info = backup.archive_info(path)
    if not info["is_backup"]:
        print("✗ Это не файл резервной копии Encryption.", file=sys.stderr)
        return 1
    print(f"Файл:      {info['file']}")
    print(f"Размер:    {info['bytes'] / 1024 / 1024:.1f} МБ")
    print(f"Формат:    Encryption backup, PBKDF2-SHA512 ×{info['iterations']}")
    return 0


def _version() -> str:
    try:
        from server.config import VERSION
        return VERSION
    except Exception:      # pragma: no cover
        return "неизвестно"


def main() -> int:
    ap = argparse.ArgumentParser(description="Перенос данных сервера Encryption")
    sub = ap.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("export", help="снять шифрованную копию каталога данных")
    e.add_argument("--out", default="encryption-backup.encbak", help="имя файла копии")
    e.add_argument("--data", default=None, help="каталог данных (по умолчанию ENC_DATA_DIR)")
    e.add_argument("--logs", action="store_true", help="включить журналы в копию")
    e.set_defaults(func=cmd_export)

    v = sub.add_parser("verify", help="проверить копию и посмотреть содержимое")
    v.add_argument("file")
    v.set_defaults(func=cmd_verify)

    i = sub.add_parser("import", help="развернуть копию на этом сервере")
    i.add_argument("file")
    i.add_argument("--data", default=None, help="каталог данных (по умолчанию ENC_DATA_DIR)")
    i.add_argument("--force", action="store_true", help="заменить существующие данные")
    i.set_defaults(func=cmd_import)

    n = sub.add_parser("info", help="сведения о файле копии (без пароля)")
    n.add_argument("file")
    n.set_defaults(func=cmd_info)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
