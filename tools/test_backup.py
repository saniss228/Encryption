#!/usr/bin/env python3
"""
Приёмочный тест резервной копии и переноса данных сервера.

Проверяет ровно то, что обещано пользователю:
  • копия снимается и полностью восстанавливается на «другом сервере»;
  • содержимое восстанавливается байт в байт;
  • журналы в копию не попадают (они не нужны при переносе);
  • без пароля файл не открывается: неверный пароль, обрезка и подмена
    байтов обнаруживаются;
  • на непустой каталог данных перенос без --force не идёт (защита от затирания);
  • утилита командной строки работает целиком (export → verify → import).

Запуск:  python3 tools/test_backup.py
"""
from __future__ import annotations

import hashlib
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server import backup  # noqa: E402

OK: list[str] = []
FAIL: list[str] = []
PASSWORD = "тестовый-пароль-2026"


def check(name: str, ok: bool, note: str = "") -> None:
    print(f"  {'✅' if ok else '❌'} {name}" + (f"   {note}" if note else ""))
    (OK if ok else FAIL).append(name)


def tree(path: Path) -> dict[str, str]:
    out = {}
    for f in sorted(Path(path).rglob("*")):
        if f.is_file():
            out[str(f.relative_to(path))] = hashlib.sha256(f.read_bytes()).hexdigest()
    return out


def make_server_data(root: Path) -> Path:
    """Имитация каталога данных сервера: база, файлы, медиа, ключи, журналы."""
    d = root / "serverA"
    (d / "files").mkdir(parents=True)
    (d / "media").mkdir()
    (d / "logs").mkdir()
    # настоящая база SQLite: так проверяется и сброс журнала WAL
    con = sqlite3.connect(d / "encryption.db")
    con.execute("CREATE TABLE messages(id TEXT PRIMARY KEY, cipher TEXT)")
    con.executemany("INSERT INTO messages VALUES(?,?)",
                    [(f"m{i}", os.urandom(60).hex()) for i in range(300)])
    con.commit()
    con.close()
    (d / ".jwt.key").write_text("секрет-сервера")
    (d / "files" / "aaaaaaaa-1111.blob").write_bytes(os.urandom(2_500_000))
    (d / "files" / "bbbbbbbb-2222.blob").write_bytes(b"\x00" * 1000 + os.urandom(500))
    (d / "media" / "avatar.png").write_bytes(b"\x89PNG\r\n\x1a\n" + os.urandom(2048))
    (d / "logs" / "server.log").write_text("служебный журнал — в копию не нужен\n")
    return d


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="enc-backup-test-"))
    try:
        print("══════ Резервная копия и перенос данных ══════")
        src = make_server_data(tmp)
        archive = tmp / "backup.encbak"

        # ── 0. Свежие записи не должны оставаться в журнале SQLite ────────
        db = src / "encryption.db"
        con = sqlite3.connect(db)
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("CREATE TABLE IF NOT EXISTS t(x)")
        con.execute("INSERT INTO t VALUES ('после переноса должно быть на месте')")
        con.commit()
        con.close()
        check("журнал SQLite сбрасывается в базу (wal_checkpoint)",
              backup.checkpoint_database(src))
        size_after = db.stat().st_size
        check("записи из журнала попали в саму базу", size_after > 20_000, f"база {size_after} Б")
        con = sqlite3.connect(db)
        rows = con.execute("SELECT COUNT(*) FROM t").fetchone()[0]
        con.close()
        check("новая таблица читается после сброса журнала", rows == 1)

        # ── 1. Снятие копии ───────────────────────────────────────────────
        summary = backup.export_to_file(src, archive, PASSWORD,
                                        extra={"server_version": "test"})
        check("копия создана", archive.exists() and archive.stat().st_size > 0,
              f"{archive.stat().st_size / 1024 / 1024:.1f} МБ")
        check("в копии 5 файлов (без журнала)", summary["files"] == 5,
              f"файлов {summary['files']}")

        # ── 2. Восстановление «на другом сервере» ─────────────────────────
        dst_dir = tmp / "serverB"
        res = backup.import_from_file(archive, dst_dir, PASSWORD)
        check("данные развёрнуты", res["files"] == 5, f"файлов {res['files']}")
        a = tree(src)
        b = tree(dst_dir)
        a.pop("logs/server.log", None)          # журнал в копию не кладём
        check("содержимое совпало байт в байт", a == b,
              f"{len(b)} файлов" if a == b else f"различия: {sorted(set(a) ^ set(b))}")
        check("журнал в копию не попал", "logs/server.log" not in b)

        # ── 3. Без пароля копия не читается ───────────────────────────────
        for label, path, pwd in (
            ("неверный пароль", archive, "чужой-пароль-999"),
            ("короткий пароль", archive, "123"),
        ):
            try:
                backup.import_from_file(path, tmp / "nope", pwd)
                check(f"{label}: доступ закрыт", False, "файл открылся!")
            except backup.BackupError as exc:
                check(f"{label}: доступ закрыт", True, str(exc)[:42])

        truncated = tmp / "truncated.encbak"
        truncated.write_bytes(archive.read_bytes()[: archive.stat().st_size // 2])
        try:
            backup.import_from_file(truncated, tmp / "nope2", PASSWORD)
            check("обрезанный файл: обнаружен", False, "прошёл как целый")
        except backup.BackupError as exc:
            check("обрезанный файл: обнаружен", True, str(exc)[:42])

        tampered = tmp / "tampered.encbak"
        raw = bytearray(archive.read_bytes())
        raw[-64] ^= 0x01
        tampered.write_bytes(bytes(raw))
        try:
            backup.import_from_file(tampered, tmp / "nope3", PASSWORD)
            check("подмена байтов: обнаружена", False, "прошла незамеченной")
        except backup.BackupError as exc:
            check("подмена байтов: обнаружена", True, str(exc)[:42])

        # ── 4. Защита от затирания живого сервера ─────────────────────────
        try:
            backup.import_from_file(archive, src, PASSWORD)      # src уже с данными
            check("непустой каталог: защита без --force", False, "данные заменились!")
        except backup.BackupError:
            check("непустой каталог: защита без --force", True)
        check("данные на месте после отказа", tree(src)["encryption.db"] == a["encryption.db"])

        # ── 5. Проверка копии без записи на диск ──────────────────────────
        peek = backup.peek(archive, PASSWORD)
        check("проверка копии (verify)", peek["files"] == 5 and peek["restored_bytes"] > 0,
              f"{peek['restored_bytes'] / 1024 / 1024:.1f} МБ данных")
        info = backup.archive_info(archive)
        check("сведения о файле без пароля", info["is_backup"] and info["iterations"] >= 100_000,
              f"PBKDF2 ×{info['iterations']}")

        # ── 6. Утилита командной строки ───────────────────────────────────
        cli = tmp / "cli.encbak"
        env = {**os.environ, "ENC_BACKUP_PASSWORD": PASSWORD, "ENC_DATA_DIR": str(src)}
        r1 = subprocess.run([sys.executable, str(ROOT / "tools" / "migrate_server.py"),
                             "export", "--out", str(cli)], env=env,
                            capture_output=True, text=True)
        check("CLI: export", r1.returncode == 0 and cli.exists(),
              (r1.stdout.strip().splitlines() or [""])[-1][:60])
        r2 = subprocess.run([sys.executable, str(ROOT / "tools" / "migrate_server.py"),
                             "verify", str(cli)], env=env, capture_output=True, text=True)
        check("CLI: verify", r2.returncode == 0 and "цела" in r2.stdout, r2.stdout.strip()[:60])
        target = tmp / "cli-restore"
        r3 = subprocess.run([sys.executable, str(ROOT / "tools" / "migrate_server.py"),
                             "import", str(cli), "--data", str(target)],
                            env=env, capture_output=True, text=True)
        check("CLI: import", r3.returncode == 0 and tree(target) == b,
              (r3.stdout.strip().splitlines() or [""])[-1][:60])

        print(f"\n{'=' * 62}\nПройдено: {len(OK)}   Провалено: {len(FAIL)}")
        if FAIL:
            print("Провалены: " + ", ".join(FAIL))
        return 0 if not FAIL else 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
