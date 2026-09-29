"""
Encryption — сервер мессенджера (FastAPI).
Один процесс = сайт + REST API + WebSocket на порту 3000.

Запуск:
    python -m server.app            # из корня проекта
    uvicorn server.app:app --host 0.0.0.0 --port 3000
"""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .config import (ALLOWED_ORIGINS, ALLOWED_ORIGIN_REGEX, APP_NAME, DATA_DIR, FILE_TTL_HOURS,
                     FILES_DIR, LOG_DIR, PURGE_INTERVAL, RATE_LIMIT_PER_MIN, VERSION, WEB_DIR)
from .realtime import router as ws_router
from .routes.admin import client_router as announcements_router
from .routes.admin import router as admin_router
from .routes.auth import router as auth_router
from .routes.chats import router as chats_router
from .routes.files import router as files_router
from .routes.messages import router as messages_router
from .routes.users import router as users_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    handlers=[logging.FileHandler(LOG_DIR / "server.log", encoding="utf-8"),
              logging.StreamHandler()],
)
log = logging.getLogger("encryption")

# ── Фоновая уборка: сообщения с TTL и файлы, прожившие 24 часа ─────────────
async def purge_loop() -> None:
    while True:
        try:
            now = db.now()
            # 1. Медиа-файлы (вложения) с истёкшим сроком — 24 часа и ни минутой больше
            rows = await db.fetchall("SELECT id FROM files WHERE expires_at<=?", (now,))
            for r in rows:
                d = FILES_DIR / r["id"]
                if d.exists():
                    shutil.rmtree(d, ignore_errors=True)
                await db.execute("DELETE FROM files WHERE id=?", (r["id"],))
            if rows:
                log.info("Удалено просроченных файлов: %d", len(rows))

            # 2. Сообщения с истекающим сроком (самоуничтожение / TTL чата)
            exp = await db.fetchall("SELECT id, chat_id FROM messages WHERE expires_at IS NOT NULL AND expires_at<=?", (now,))
            for r in exp:
                await db.execute("DELETE FROM messages WHERE id=?", (r["id"],))
            if exp:
                from .realtime import hub
                for r in exp:
                    members = await db.fetchall("SELECT user_id FROM chat_members WHERE chat_id=?", (r["chat_id"],))
                    await hub.send_to_users({int(m["user_id"]) for m in members},
                                            {"t": "message.deleted", "chat_id": r["chat_id"],
                                             "message_id": r["id"], "reason": "ttl"})
                log.info("Самоуничтожение: удалено сообщений %d", len(exp))

            # 2b. «Надгробия» файлов, скачанных получателем (local only) — 7 дней истории
            tombstones = await db.fetchall(
                "SELECT id FROM files WHERE local_only=1 AND consumed_at IS NOT NULL AND consumed_at<?",
                (now - 7 * 86400,))
            for r in tombstones:
                await db.execute("DELETE FROM files WHERE id=?", (r["id"],))

            # 3. Просроченные пары устройств и старые rate-limit записи
            await db.execute("DELETE FROM pairs WHERE expires_at<?", (now - 3600,))
            await db.execute("DELETE FROM rate_limits WHERE window_start<?", (now - 7200,))
            # 4. Чистим историю звонков старше 30 суток
            await db.execute("DELETE FROM calls WHERE started_at<?", (now - 30 * 86400,))
        except Exception as exc:  # noqa: BLE001
            log.warning("purge_loop: %s", exc)
        await asyncio.sleep(PURGE_INTERVAL)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.connect()
    task = asyncio.create_task(purge_loop())
    log.info("%s v%s запущен. Данные: %s | Сайт: %s", APP_NAME, VERSION, DATA_DIR, WEB_DIR)
    yield
    task.cancel()
    await db.close()


app = FastAPI(
    title=f"{APP_NAME} Server",
    version=VERSION,
    description="Мессенджер с двойным E2E-шифрованием. Сервер хранит только шифротекст.",
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=ALLOWED_ORIGIN_REGEX,
    allow_credentials=False,   # авторизация — Bearer-токенами, cookie не используются
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-File-Id", "Content-Encrypted", "X-Expires-At"],
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    # Грубый, но полезный ограничитель частоты на уровне процесса
    from .security import client_ip, rate_limit
    path = request.url.path
    if path.startswith("/api/") and not path.startswith("/api/v1/files"):
        if not rate_limit(f"http:{client_ip(request)}", RATE_LIMIT_PER_MIN):
            return JSONResponse({"detail": {"code": "RATE_LIMITED",
                                            "message": "Слишком много запросов"}}, status_code=429)
    t0 = time.time()
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "geolocation=(), microphone=(self), camera=(self)"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
        "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; "
        "frame-ancestors 'self'")
    response.headers["Server-Timing"] = f"app;dur={(time.time() - t0) * 1000:.1f}"
    return response


# ── Роуты API ──────────────────────────────────────────────────────────────
app.include_router(auth_router)
app.include_router(users_router)
app.include_router(chats_router)
app.include_router(messages_router)
app.include_router(files_router)
app.include_router(admin_router)
app.include_router(announcements_router)
app.include_router(ws_router)


@app.get("/api/v1/health")
async def health():
    return {"status": "ok", "app": APP_NAME, "version": VERSION, "time": db.now(),
            "file_ttl_hours": FILE_TTL_HOURS}


@app.get("/api/v1/security/policy")
async def security_policy():
    """Публичное описание модели шифрования — чтобы пользователь видел, что и как защищено."""
    return {
        "double_encryption": {
            "layer_1": {
                "alg": "AES-256-GCM",
                "what": "Текст/файл шифруется случайным ключом сообщения (message key) прямо на устройстве",
                "where": "на устройстве отправителя, до сети",
            },
            "layer_2": {
                "alg": "RSA-4096-OAEP-SHA256",
                "what": "Тот же ключ сообщения заворачивается в RSA-конверт для каждого получателя",
                "where": "на устройстве; приватный RSA-ключ не покидает устройство",
            },
            "layer_3_forward_secrecy": {
                "alg": "ECDH P-256 + HKDF-SHA256 + AES-256-GCM",
                "what": "Дополнительный канал доставки ключа по схеме Диффи-Хеллмана с эфемерным ключом",
                "where": "на устройстве",
            },
            "signatures": {"alg": "ECDSA P-256", "what": "Подпись конверта — защита от подмены и MITM"},
        },
        "storage": {
            "server_sees": ["шифротекст", "метаданные маршрутизации", "время"],
            "server_never_sees": ["текст сообщений", "файлы", "ключи", "имена файлов"],
            "file_retention": "24 часа, затем безвозвратное удаление",
        },
        "accounts": {
            "one_account_per_device": True,
            "password": "PBKDF2-SHA512 на устройстве + Argon2id на сервере; пароль не передаётся",
            "recovery": "24 слова + вход с доверенного устройства (см. /api/v1/security/recovery-guide)",
        },
    }


@app.get("/api/v1/site/info")
async def site_info():
    """Отдаётся на главную страницу сайта."""
    users = await db.fetchone("SELECT COUNT(*) AS c FROM users")
    msgs = await db.fetchone("SELECT COUNT(*) AS c FROM messages WHERE deleted_at IS NULL")
    files = await db.fetchone("SELECT COUNT(*) AS c FROM files WHERE expires_at>?", (db.now(),))
    return {
        "app": APP_NAME, "version": VERSION,
        "stats": {"users": int(users["c"]), "messages": int(msgs["c"]),
                  "files_in_cloud": int(files["c"])},
        "features": FEATURE_LIST,
    }


FEATURE_LIST = [
    "Личные и групповые чаты (до 200 участников)",
    "Двойное шифрование: AES-256-GCM + RSA-4096-OAEP (+ ECDH для forward secrecy)",
    "Цифровая подпись каждого конверта (ECDSA P-256)",
    "Файлы, фото, видео и голосовые — шифруются на устройстве и живут ровно 24 часа",
    "Самоуничтожающиеся сообщения и таймер в чате",
    "Редактирование (48 ч), удаление у всех, ответы, треды, пересылка",
    "Реакции, закрепления, черновики, архив, папки",
    "Аудио- и видеозвонки (WebRTC, DTLS-SRTP), групповые звонки",
    "Онлайн-статусы, «печатает…», квитанции доставки/прочтения",
    "Шифрованный бэкап ключей, восстановление по 24 словам",
    "Вход по коду с доверенного устройства (QR), список устройств и сессий",
    "Один аккаунт на устройство, журнал безопасности, «тревожная кнопка»",
    "Полнотекстовый поиск выполняется локально на устройстве",
    "Тёмная/светлая тема, десктоп и Android-приложение",
]


# ── Раздача сайта ─────────────────────────────────────────────────────────
if (WEB_DIR / "assets").exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIR / "assets"), name="assets")
if (WEB_DIR / "css").exists():
    app.mount("/css", StaticFiles(directory=WEB_DIR / "css"), name="css")
if (WEB_DIR / "js").exists():
    app.mount("/js", StaticFiles(directory=WEB_DIR / "js"), name="js")


@app.get("/", response_class=HTMLResponse)
async def index():
    p = WEB_DIR / "index.html"
    if not p.exists():
        return HTMLResponse("<h1>Encryption</h1><p>Файлы сайта не найдены.</p>", status_code=200)
    return HTMLResponse(p.read_text(encoding="utf-8"))


@app.get("/join/{token}", response_class=HTMLResponse)
async def join_page(token: str):
    """Страница приглашения в группу — открывается по ссылке."""
    p = WEB_DIR / "index.html"
    html = p.read_text(encoding="utf-8") if p.exists() else "<h1>Encryption</h1>"
    return HTMLResponse(html)


@app.get("/manifest.webmanifest")
async def manifest():
    return JSONResponse({
        "name": "Encryption", "short_name": "Encryption", "start_url": "/",
        "display": "standalone", "background_color": "#0b1020", "theme_color": "#0b1020",
        "description": "Мессенджер с двойным шифрованием",
        "icons": [{"src": "/assets/icon-192.png", "sizes": "192x192", "type": "image/png"},
                  {"src": "/assets/icon-512.png", "sizes": "512x512", "type": "png"}],
    })


@app.get("/sw.js")
async def service_worker():
    p = WEB_DIR / "sw.js"
    if p.exists():
        return FileResponse(p, media_type="application/javascript")
    return JSONResponse({"error": "no sw"}, status_code=404)


@app.exception_handler(HTTPException)
async def http_exc(request: Request, exc: HTTPException):
    detail = exc.detail
    if isinstance(detail, dict):
        return JSONResponse({"error": detail}, status_code=exc.status_code)
    return JSONResponse({"error": {"code": f"HTTP_{exc.status_code}", "message": str(detail)}},
                        status_code=exc.status_code)


def main() -> None:
    import uvicorn
    from .config import HOST, PORT, TLS_CERT, TLS_KEY

    kwargs = {}
    if TLS_CERT and TLS_KEY:
        kwargs.update(ssl_certfile=TLS_CERT, ssl_keyfile=TLS_KEY)
        log.info("Запуск с TLS (HTTPS/WSS)")

    # Один порт (по умолчанию 3000) — сайт, API и WebSocket. Порт 3000 браузеры
    # не блокируют, поэтому отдельный «порт для браузера» больше не нужен:
    # и приложения, и сайт ходят на один и тот же адрес.
    uvicorn.run("server.app:app", host=HOST, port=PORT, log_level="info", **kwargs)


if __name__ == "__main__":
    main()
