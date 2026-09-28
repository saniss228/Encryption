"""
Резервная копия сервера Encryption и перенос данных на другой сервер.

Что это. Один файл (`*.encbak`), внутри — весь каталог данных сервера:
база (аккаунты, чаты, сообщения-шифротексты, метаданные файлов), сами файлы,
медиа и ключи сервера. Файл зашифрован паролем, который знает только владелец.

Почему архив шифруется отдельно. Содержимое сообщений и файлов и так
зашифровано ключами, которые лежат только на устройствах пользователей —
сервер их не знает и прочитать переписку не может. Но в базе остаются
метаданные (логины, время, кто с кем переписывался, размеры файлов).
Чтобы они тоже не утекли при переносе, архив целиком закрывается своим
паролем: AES-256-GCM, ключ = PBKDF2-HMAC-SHA512(пароль, соль, 300 000).

Формат файла (все числа — big-endian):
    "ENCBK1\n"            заголовок, 7 байт
    salt                  16 байт
    iterations            uint32
    записи (повторяются):
        nonce             12 байт
        длина              uint32   (длина шифротекста вместе с тегом)
        шифротекст        AES-256-GCM
    последняя запись — «итог» (JSON): sha256 всего содержимого, число файлов,
    объём, версия сервера, дата.

Каждая запись аутентифицируется отдельно (AAD = заголовок + номер записи +
признак), поэтому подмена, перестановка или обрыв файла обнаруживаются.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import secrets
import tarfile
import time
from pathlib import Path
from typing import Callable, Iterator

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA512
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

MAGIC = b"ENCBK1\n"
SALT_LEN = 16
NONCE_LEN = 12
TAG_LEN = 16
DEFAULT_ITERATIONS = 300_000
CHUNK = 1 << 20          # 1 МиБ открытого текста на запись
FLAG_DATA = 0
FLAG_SUMMARY = 1
MIN_PASSWORD = 8

# Что кладём в архив: весь каталог данных, кроме журналов (они не нужны при переносе)
SKIP_DIRS = ("logs",)
SKIP_SUFFIXES = (".log", ".pyc", ".tmp")


class BackupError(Exception):
    """Пароль не подошёл, файл повреждён или обрезан."""


# ── Криптография ────────────────────────────────────────────────────────────
def _derive(password: str, salt: bytes, iterations: int) -> bytes:
    kdf = PBKDF2HMAC(algorithm=SHA512(), length=32, salt=salt, iterations=iterations)
    return kdf.derive(password.encode("utf-8"))


def _aad(index: int, flag: int) -> bytes:
    return MAGIC + index.to_bytes(8, "big") + bytes([flag])


def check_password(password: str) -> None:
    if len(password or "") < MIN_PASSWORD:
        raise BackupError(f"Пароль короче {MIN_PASSWORD} символов — подберите надёжнее.")


# ── Запись ──────────────────────────────────────────────────────────────────
class BackupWriter(io.RawIOBase):
    """Поток, в который пишется tar; на диск ложится шифрованный контейнер."""

    def __init__(self, fh, password: str, *, iterations: int = DEFAULT_ITERATIONS,
                 progress: Callable[[int], None] | None = None):
        check_password(password)
        self._fh = fh
        self._salt = secrets.token_bytes(SALT_LEN)
        key = _derive(password, self._salt, iterations)
        self._aead = AESGCM(key)
        self._buf = bytearray()
        self._index = 0
        self._plain_bytes = 0
        self._digest = hashlib.sha256()
        self._progress = progress
        fh.write(MAGIC)
        fh.write(self._salt)
        fh.write(iterations.to_bytes(4, "big"))

    # io.RawIOBase
    def writable(self) -> bool:      # pragma: no cover
        return True

    def write(self, data) -> int:
        if isinstance(data, memoryview):
            data = data.tobytes()
        self._buf += data
        self._digest.update(data)
        self._plain_bytes += len(data)
        while len(self._buf) >= CHUNK:
            self._flush_chunk(bytes(self._buf[:CHUNK]))
            del self._buf[:CHUNK]
        if self._progress and self._plain_bytes % (16 * CHUNK) < len(data):
            self._progress(self._plain_bytes)
        return len(data)

    def _flush_chunk(self, chunk: bytes) -> None:
        nonce = secrets.token_bytes(NONCE_LEN)
        ct = self._aead.encrypt(nonce, chunk, _aad(self._index, FLAG_DATA))
        self._fh.write(nonce)
        self._fh.write(len(ct).to_bytes(4, "big"))
        self._fh.write(ct)
        self._index += 1

    def finish(self, summary: dict) -> dict:
        if self._buf:
            self._flush_chunk(bytes(self._buf))
            self._buf.clear()
        summary = dict(summary)
        summary["sha256"] = self._digest.hexdigest()
        summary["bytes"] = self._plain_bytes
        summary["chunks"] = self._index
        summary["created_at"] = int(time.time())
        payload = json.dumps(summary, ensure_ascii=False).encode("utf-8")
        nonce = secrets.token_bytes(NONCE_LEN)
        ct = self._aead.encrypt(nonce, payload, _aad(self._index, FLAG_SUMMARY))
        self._fh.write(nonce)
        self._fh.write(len(ct).to_bytes(4, "big"))
        self._fh.write(ct)
        self._fh.flush()
        return summary


class _WriterAdapter(io.RawIOBase):
    """tarfile хочет обычный файловый объект — оборачиваем BackupWriter."""

    def __init__(self, writer: BackupWriter):
        self._w = writer

    def writable(self) -> bool:
        return True

    def write(self, data) -> int:
        return self._w.write(data)


# ── Чтение ──────────────────────────────────────────────────────────────────
class BackupReader(io.RawIOBase):
    """Расшифровывает контейнер и отдаёт открытый tar-поток."""

    def __init__(self, fh, password: str):
        self._fh = fh
        magic = fh.read(len(MAGIC))
        if magic != MAGIC:
            raise BackupError("Это не файл резервной копии Encryption.")
        salt = fh.read(SALT_LEN)
        iterations = int.from_bytes(fh.read(4), "big")
        if not salt or not iterations:
            raise BackupError("Файл повреждён: нет соли или параметров шифрования.")
        self._aead = AESGCM(_derive(password, salt, iterations))
        self._index = 0
        self._buf = b""
        self._done = False
        self._digest = hashlib.sha256()
        self._plain_bytes = 0
        self.summary: dict | None = None

    def readable(self) -> bool:
        return True

    def _read_record(self) -> tuple[bytes, int]:
        raw = self._fh.read(NONCE_LEN)
        if len(raw) < NONCE_LEN:
            raise BackupError("Файл обрезан: архив не дописан до конца.")
        length = int.from_bytes(self._fh.read(4), "big")
        if length <= TAG_LEN:
            raise BackupError("Файл повреждён: некорректная длина блока.")
        ct = self._fh.read(length)
        if len(ct) < length:
            raise BackupError("Файл обрезан: не хватает данных блока.")
        return raw, length  # nonce и длина; расшифровка — в вызывающем коде

    def _decrypt(self, nonce: bytes, length: int, flag: int) -> bytes:
        ct = self._fh.read(length)
        try:
            return self._aead.decrypt(nonce, ct, _aad(self._index, flag))
        except InvalidTag as exc:
            raise BackupError("Неверный пароль или файл повреждён.") from exc

    def read(self, size: int = -1) -> bytes:
        if self._done:
            return b""
        out = bytearray()
        while size < 0 or len(out) < size:
            if not self._buf:
                nonce = self._fh.read(NONCE_LEN)
                if len(nonce) < NONCE_LEN:
                    raise BackupError("Файл обрезан: нет завершающей записи.")
                length = int.from_bytes(self._fh.read(4), "big")
                if length <= TAG_LEN:
                    raise BackupError("Файл повреждён: некорректная длина блока.")
                # признак записи зашит в AAD: пробуем данные, при неудаче — итог
                try:
                    block = self._decrypt(nonce, length, FLAG_DATA)
                    self._index += 1
                except BackupError:
                    self._fh.seek(-length, os.SEEK_CUR)
                    block = self._decrypt(nonce, length, FLAG_SUMMARY)
                    self.summary = json.loads(block.decode("utf-8"))
                    self._finish()
                    break
                self._digest.update(block)
                self._plain_bytes += len(block)
                self._buf = block
            if size >= 0:
                take = size - len(out)
                out += self._buf[:take]
                self._buf = self._buf[take:]
            else:
                out += self._buf
                self._buf = b""
        return bytes(out)

    def drain(self) -> dict:
        """Дочитывает контейнер до конца и проверяет целостность архива."""
        while self.read(CHUNK):
            pass
        if not self._done:
            raise BackupError("В архиве нет завершающей записи — файл обрезан.")
        return self.summary or {}

    def _finish(self) -> None:
        self._done = True
        if self.summary is None:
            raise BackupError("В архиве нет завершающей записи — файл обрезан.")
        if self.summary.get("sha256") != self._digest.hexdigest():
            raise BackupError("Содержимое архива не совпало с контрольной суммой.")
        if self.summary.get("bytes") != self._plain_bytes:
            raise BackupError("Размер содержимого архива не совпал с записанным.")

    def readinto(self, b) -> int:      # pragma: no cover
        data = self.read(len(b))
        b[:len(data)] = data
        return len(data)


# ── Каталог данных ⇄ архив ──────────────────────────────────────────────────
def _iter_members(data_dir: Path) -> Iterator[Path]:
    for root, dirs, files in os.walk(data_dir):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            if name.endswith(SKIP_SUFFIXES):
                continue
            yield Path(root) / name


def export_to_file(data_dir: Path, out_path: Path, password: str, *,
                   extra: dict | None = None, include_logs: bool = False,
                   progress: Callable[[int], None] | None = None) -> dict:
    """Упаковывает каталог данных в шифрованный файл. Возвращает итоговые данные."""
    data_dir = Path(data_dir)
    if not data_dir.exists():
        raise BackupError(f"Каталог данных не найден: {data_dir}")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    files = 0
    file_bytes = 0
    with open(out_path, "wb") as fh:
        writer = BackupWriter(fh, password, progress=progress)
        with tarfile.open(fileobj=_WriterAdapter(writer), mode="w|",
                          format=tarfile.GNU_FORMAT) as tar:
            for path in _iter_members(data_dir):
                rel = path.relative_to(data_dir)
                if not include_logs and (rel.parts and rel.parts[0] in SKIP_DIRS):
                    continue
                tar.add(path, arcname=str(rel), recursive=False)
                files += 1
                file_bytes += path.stat().st_size
        summary = writer.finish({"files": files, "file_bytes": file_bytes,
                                 "kind": "encryption-server-backup", **(extra or {})})
    summary["file"] = str(out_path)
    summary["archive_bytes"] = out_path.stat().st_size
    return summary


def import_from_file(in_path: Path, data_dir: Path, password: str, *,
                     force: bool = False, dry_run: bool = False) -> dict:
    """Распаковывает архив в каталог данных. Без force не трогает непустой каталог."""
    in_path = Path(in_path)
    data_dir = Path(data_dir)
    if not in_path.exists():
        raise BackupError(f"Файл копии не найден: {in_path}")
    existing = [p for p in data_dir.iterdir()] if data_dir.exists() else []
    keep = {".jwt.key", ".session.key", ".vapid.key"}     # ключи сервера не считаем данными
    meaningful = [p for p in existing if p.name not in keep]
    if meaningful and not force and not dry_run:
        raise BackupError(
            f"Каталог {data_dir} не пуст. Остановите сервер и запустите с --force, "
            "чтобы заменить данные копией.")

    restored = 0
    total = 0
    names: list[str] = []
    if not dry_run:
        data_dir.mkdir(parents=True, exist_ok=True)
    with open(in_path, "rb") as fh:
        reader = BackupReader(fh, password)
        with tarfile.open(fileobj=reader, mode="r|") as tar:
            for member in tar:
                names.append(member.name)
                if member.isfile():
                    restored += 1
                    total += member.size
                    if dry_run:
                        fileobj = tar.extractfile(member)
                        while fileobj and fileobj.read(CHUNK):
                            pass
                        continue
                    target = (data_dir / member.name).resolve()
                    if not str(target).startswith(str(data_dir.resolve())):
                        raise BackupError(f"В архиве недопустимый путь: {member.name}")
                    tar.extract(member, path=data_dir, set_attrs=True)
        # читаем контейнер до конца: так проверяются контрольная сумма и полнота файла
        summary = reader.drain()
    summary.pop("sha256", None)          # сама сумма секретна? нет — но в ответе не нужна
    summary["stream_bytes"] = summary.pop("bytes", 0)   # размер tar-потока
    return {"files": restored, "restored_bytes": total, "dry_run": dry_run,
            "first_names": names[:5], **summary}


def peek(in_path: Path, password: str) -> dict:
    """Проверяет архив: читает его насквозь, ничего не записывая."""
    return import_from_file(in_path, Path("/nonexistent"), password, dry_run=True)


def archive_info(in_path: Path) -> dict:
    """Сведения о файле без пароля: размер и зашифрованный заголовок."""
    size = in_path.stat().st_size if in_path.exists() else 0
    with open(in_path, "rb") as fh:
        ok = fh.read(len(MAGIC)) == MAGIC
        if ok:
            fh.read(SALT_LEN)
            iters = int.from_bytes(fh.read(4), "big")
        else:
            iters = 0
    return {"file": str(in_path), "bytes": size, "is_backup": ok, "iterations": iters}
