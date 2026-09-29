"""
Слой базы данных: SQLite (WAL) + тонкая асинхронная обёртка.
Сервер хранит ТОЛЬКО шифротекст. Ни одно поле с контентом не читается сервером.
"""
from __future__ import annotations

import json
import time
from typing import Any, Iterable

import aiosqlite

from .config import DB_PATH

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA synchronous=NORMAL;

-- ── Пользователи ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    display_name    TEXT    NOT NULL DEFAULT '',
    about           TEXT    NOT NULL DEFAULT '',
    avatar_id       TEXT,                       -- id медиа-файла аватара
    -- Аутентификация: клиент присылает PBKDF2(password) — пароль в открытом виде не уходит,
    -- сервер дополнительно хеширует Argon2id.
    auth_hash       TEXT    NOT NULL,
    -- E2E-ключи (публичные) ─────────────────────────────────────────────────
    ik_dh_pub       TEXT    NOT NULL,           -- ECDH P-256 identity (для конвертов)
    ik_sign_pub     TEXT    NOT NULL,           -- ECDSA P-256 identity (подписи)
    rsa_pub         TEXT    NOT NULL,           -- RSA-4096-OAEP — второй слой шифрования
    spk_pub         TEXT    NOT NULL,           -- signed prekey (ECDH)
    spk_sig         TEXT    NOT NULL,           -- подпись spk
    one_time_keys   TEXT    NOT NULL DEFAULT '[]',
    -- Бэкап зашифрованного приватного ключа (сервер не может его расшифровать)
    key_backup      TEXT,                       -- {ct, salt, iv, kdf, params}
    recovery_wrap   TEXT,                       -- обёртка IK ключом из 24-словной фразы
    recovery_hash   TEXT,                       -- Argon2id(фраза) для подтверждения
    recovery_hint   TEXT,
    created_at      INTEGER NOT NULL,
    last_seen       INTEGER NOT NULL DEFAULT 0,
    is_banned       INTEGER NOT NULL DEFAULT 0,
    flags           TEXT    NOT NULL DEFAULT '{}'
);

-- ── Устройства (1 аккаунт на устройство) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS devices (
    id              TEXT    PRIMARY KEY,        -- device_id, генерируется на устройстве
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT    NOT NULL DEFAULT '',
    platform        TEXT    NOT NULL DEFAULT '',   -- web | windows | android | linux | macos
    app_version     TEXT    NOT NULL DEFAULT '',
    fingerprint     TEXT    NOT NULL DEFAULT '',
    pubkey          TEXT    NOT NULL DEFAULT '',   -- ключ устройства (подпись сессий)
    created_at      INTEGER NOT NULL,
    last_seen       INTEGER NOT NULL DEFAULT 0,
    revoked_at      INTEGER,
    push_token      TEXT,
    ip_first        TEXT,
    ip_last         TEXT
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
-- Жёсткая привязка: device_id -> один аккаунт (исторически, навсегда)
CREATE TABLE IF NOT EXISTS device_bindings (
    device_id       TEXT PRIMARY KEY,
    user_id         INTEGER NOT NULL,
    bound_at        INTEGER NOT NULL,
    released_at     INTEGER
);

-- ── Сессии (refresh-токены, хранятся хешированными) ─────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
    id              TEXT PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id       TEXT NOT NULL,
    refresh_hash    TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    revoked_at      INTEGER,
    ip              TEXT,
    user_agent      TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ── Чаты (личные и группы) ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chats (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL,              -- direct | group | saved
    title           TEXT NOT NULL DEFAULT '',   -- группы: заголовок открыт (метаданные)
    avatar_id       TEXT,
    owner_id        INTEGER,
    -- Настройки приватности/самоуничтожения (в секундах; 0 = выключено)
    ttl_seconds     INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    meta            TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS chat_members (
    chat_id         TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'member',   -- owner | admin | member
    joined_at       INTEGER NOT NULL,
    muted_until     INTEGER NOT NULL DEFAULT 0,
    last_read_at    INTEGER NOT NULL DEFAULT 0,
    pinned          INTEGER NOT NULL DEFAULT 0,
    archived        INTEGER NOT NULL DEFAULT 0,
    draft           TEXT NOT NULL DEFAULT '',
    wallpaper       TEXT,
    custom_ttl      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON chat_members(user_id);

-- ── Сообщения: сервер видит только конверт ─────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    chat_id         TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id       INTEGER NOT NULL,
    sender_device   TEXT NOT NULL DEFAULT '',
    -- Двойное шифрование: 
    --  l1: AES-256-GCM(plaintext) случайным ключом сообщения  -> payload.l1
    --  l2: RSA-4096-OAEP(mk) для получателя + ECDH-обёртки    -> payload.wrap
    payload         TEXT NOT NULL,              -- JSON-конверт (шифротекст)
    type            TEXT NOT NULL DEFAULT 'text',  -- text|image|file|voice|video|system|call
    -- Метаданные, нужные серверу и клиенту; контент внутри payload
    reply_to        TEXT,
    thread_root     TEXT,
    forward_from    TEXT,
    created_at      INTEGER NOT NULL,
    edited_at       INTEGER,
    deleted_at      INTEGER,
    expires_at      INTEGER,                    -- самоуничтожение
    burn_after_read INTEGER NOT NULL DEFAULT 0,
    pinned          INTEGER NOT NULL DEFAULT 0,
    attachment_id   TEXT,                       -- id зашифрованного файла (24ч)
    attachment_meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_chat ON messages(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_expire ON messages(expires_at);

-- ── Реакции ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reactions (
    message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL,
    emoji           TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
);

-- ── Квитанции доставки/прочтения ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS receipts (
    message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL,
    state           TEXT NOT NULL,              -- delivered | read
    at              INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, state)
);

-- ── Файлы: живут РОВНО 24 часа, хранятся зашифрованными ────────────────────
CREATE TABLE IF NOT EXISTS files (
    id              TEXT PRIMARY KEY,
    owner_id        INTEGER NOT NULL,
    chat_id         TEXT,
    size            INTEGER NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'file',
    mime            TEXT NOT NULL DEFAULT '',
    name_enc        TEXT NOT NULL DEFAULT '',   -- имя файла зашифровано
    key_wrap        TEXT NOT NULL DEFAULT '',   -- ключ файла, завёрнутый для получателей
    sha256          TEXT NOT NULL DEFAULT '',
    chunk_size      INTEGER NOT NULL DEFAULT 0,
    chunks          INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,           -- created_at + 24ч, жёстко
    downloads       INTEGER NOT NULL DEFAULT 0,
    max_downloads   INTEGER NOT NULL DEFAULT 0,
    -- «только локально»: файл скачан получателем и удалён с сервера
    served          TEXT    NOT NULL DEFAULT '{}',  -- {user_id: [индексы отданных чанков]}
    consumed_at     INTEGER,
    consumed_by     INTEGER,                        -- кто скачал (кто «сжёг» файл)
    local_only      INTEGER NOT NULL DEFAULT 0      -- 1 = на сервере уже нет, есть только у получателя
);
CREATE INDEX IF NOT EXISTS idx_files_expire ON files(expires_at);

-- ── Контакты / блокировки ──────────────────────────────────────────────────
-- ── Заявки в друзья (написать можно только после принятой заявки) ──────────
CREATE TABLE IF NOT EXISTS friend_requests (
    id          TEXT PRIMARY KEY,
    from_id     INTEGER NOT NULL,
    to_id       INTEGER NOT NULL,
    message     TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  INTEGER NOT NULL,
    answered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_freq_to ON friend_requests(to_id, status);
CREATE INDEX IF NOT EXISTS idx_freq_from ON friend_requests(from_id, status);

CREATE TABLE IF NOT EXISTS contacts (
    owner_id        INTEGER NOT NULL,
    peer_id         INTEGER NOT NULL,
    alias           TEXT NOT NULL DEFAULT '',
    verified        INTEGER NOT NULL DEFAULT 0,
    blocked         INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (owner_id, peer_id)
);

-- ── Звонки (журнал + сигнализация идёт через WebSocket) ────────────────────
CREATE TABLE IF NOT EXISTS calls (
    id              TEXT PRIMARY KEY,
    chat_id         TEXT NOT NULL,
    caller_id       INTEGER NOT NULL,
    kind            TEXT NOT NULL,             -- audio | video | group
    state           TEXT NOT NULL,             -- ring|active|ended|missed|declined
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    participants    TEXT NOT NULL DEFAULT '[]'
);

-- ── Пригласительные ссылки в группы ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invite_links (
    token           TEXT PRIMARY KEY,
    chat_id         TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    created_by      INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER,
    max_uses        INTEGER NOT NULL DEFAULT 0,
    uses            INTEGER NOT NULL DEFAULT 0
);

-- ── Связывание нового устройства по коду/QR (вход без пароля) ──────────────
CREATE TABLE IF NOT EXISTS pairs (
    id              TEXT PRIMARY KEY,
    code            TEXT NOT NULL,
    user_id         INTEGER,                  -- заполняется при одобрении
    device_id       TEXT NOT NULL,            -- устройство, которое просит доступ
    device_name     TEXT NOT NULL DEFAULT '',
    platform        TEXT NOT NULL DEFAULT '',
    key_bundle      TEXT,                     -- завёрнутый приватный ключ для нового устройства
    status          TEXT NOT NULL DEFAULT 'pending', -- pending|approved|claimed|cancelled
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    claimed_at      INTEGER
);

-- ── Аудит безопасности ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    at              INTEGER NOT NULL,
    user_id         INTEGER,
    device_id       TEXT,
    ip              TEXT,
    event           TEXT NOT NULL,
    detail          TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, at DESC);

-- ── Настройки сервера (управляются из админ-панели) ────────────────────────
CREATE TABLE IF NOT EXISTS settings (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL,
    updated_at      INTEGER NOT NULL,
    updated_by      INTEGER
);

-- ── Объявления администратора (видны всем пользователям) ───────────────────
CREATE TABLE IF NOT EXISTS announcements (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    at              INTEGER NOT NULL,
    by_user_id      INTEGER,
    text            TEXT NOT NULL,
    level           TEXT NOT NULL DEFAULT 'info',   -- info | warning | critical
    active          INTEGER NOT NULL DEFAULT 1,
    expires_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ann_active ON announcements(active, at DESC);

-- ── Rate limit ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rate_limits (
    bucket          TEXT PRIMARY KEY,
    window_start    INTEGER NOT NULL,
    count           INTEGER NOT NULL DEFAULT 0
);
"""

_conn: aiosqlite.Connection | None = None


# Лёгкие миграции: добавляем недостающие поля в существующие базы
MIGRATIONS: list[tuple[str, str, str]] = [
    ("files", "served", "TEXT NOT NULL DEFAULT '{}'"),
    ("files", "consumed_at", "INTEGER"),
    ("files", "consumed_by", "INTEGER"),
    ("files", "local_only", "INTEGER NOT NULL DEFAULT 0"),
    ("messages", "local_only", "INTEGER NOT NULL DEFAULT 0"),
    # ── Администрирование ───────────────────────────────────────────────────
    ("users", "role", "TEXT NOT NULL DEFAULT 'user'"),          # user | admin
    ("users", "blocked_reason", "TEXT"),
    ("users", "blocked_at", "INTEGER"),
    ("users", "blocked_by", "INTEGER"),
    # Контакты: блокировка собеседника (v3.4.0). Таблица есть и в старых базах —
    # колонка добавляется миграцией, данные не теряются.
    ("contacts", "blocked", "INTEGER NOT NULL DEFAULT 0"),
]


async def _migrate(conn: aiosqlite.Connection) -> None:
    for table, column, decl in MIGRATIONS:
        async with conn.execute(f"PRAGMA table_info({table})") as cur:
            cols = {r["name"] for r in await cur.fetchall()}
        if column not in cols:
            await conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
    await conn.commit()


async def connect() -> aiosqlite.Connection:
    global _conn
    if _conn is None:
        _conn = await aiosqlite.connect(DB_PATH)
        _conn.row_factory = aiosqlite.Row
        await _conn.executescript(SCHEMA)
        await _migrate(_conn)
        await _conn.commit()
    return _conn


async def close() -> None:
    global _conn
    if _conn is not None:
        await _conn.close()
        _conn = None


def db() -> aiosqlite.Connection:
    assert _conn is not None, "БД не инициализирована"
    return _conn


# ── Хелперы ─────────────────────────────────────────────────────────────────
async def fetchone(sql: str, params: Iterable[Any] = ()) -> aiosqlite.Row | None:
    async with db().execute(sql, tuple(params)) as cur:
        return await cur.fetchone()


async def fetchall(sql: str, params: Iterable[Any] = ()) -> list[aiosqlite.Row]:
    async with db().execute(sql, tuple(params)) as cur:
        return list(await cur.fetchall())


async def execute(sql: str, params: Iterable[Any] = ()) -> None:
    await db().execute(sql, tuple(params))
    await db().commit()


async def insert(sql: str, params: Iterable[Any] = ()) -> int:
    cur = await db().execute(sql, tuple(params))
    await db().commit()
    rid = cur.lastrowid
    await cur.close()
    return rid or 0


def now() -> int:
    return int(time.time())


def jload(value: str | None, default: Any = None) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except Exception:
        return default


async def audit(event: str, *, user_id: int | None = None, device_id: str | None = None,
                ip: str | None = None, **detail: Any) -> None:
    await execute(
        "INSERT INTO audit_log(at,user_id,device_id,ip,event,detail) VALUES(?,?,?,?,?,?)",
        (now(), user_id, device_id, ip, event, json.dumps(detail, ensure_ascii=False)),
    )
