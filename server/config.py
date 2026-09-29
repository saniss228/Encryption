"""
Конфигурация сервера мессенджера "Encryption".
Все параметры читаются из переменных окружения / файла .env
"""
from __future__ import annotations

import os
import secrets
from pathlib import Path

# ── Пути ────────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent.parent          # корень проекта
DATA_DIR = Path(os.getenv("ENC_DATA_DIR", BASE_DIR / "data"))
WEB_DIR = Path(os.getenv("ENC_WEB_DIR", BASE_DIR / "web"))
DB_PATH = Path(os.getenv("ENC_DB_PATH", DATA_DIR / "encryption.db"))
FILES_DIR = Path(os.getenv("ENC_FILES_DIR", DATA_DIR / "files"))
MEDIA_DIR = Path(os.getenv("ENC_MEDIA_DIR", DATA_DIR / "media"))   # аватары, обложки
LOG_DIR = Path(os.getenv("ENC_LOG_DIR", DATA_DIR / "logs"))

for _d in (DATA_DIR, FILES_DIR, MEDIA_DIR, LOG_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# ── Сеть ────────────────────────────────────────────────────────────────────
# Белый IP пользователя. Порт 3000 — сайт + API + WebSocket на одном порту:
# к нему подключаются приложения (ПК и Android), сайт в браузере и nginx.
# Порт 3000 браузеры не блокируют, поэтому отдельный «безопасный» порт не нужен.
HOST = os.getenv("ENC_HOST", "0.0.0.0")
PORT = int(os.getenv("ENC_PORT", "3000"))
PUBLIC_IP = os.getenv("ENC_PUBLIC_IP", "45.90.45.92")
PUBLIC_ORIGIN = os.getenv("ENC_PUBLIC_ORIGIN", f"http://{PUBLIC_IP}:{PORT}")

# TLS: если заданы оба файла — uvicorn поднимается в HTTPS.
TLS_CERT = os.getenv("ENC_TLS_CERT", "")      # /etc/letsencrypt/live/.../fullchain.pem
TLS_KEY = os.getenv("ENC_TLS_KEY", "")        # /etc/letsencrypt/live/.../privkey.pem

# За HTTPS обычно стоит nginx; прямой доступ к uvicorn ограничиваем.
TRUSTED_PROXY_IPS = set(filter(None, os.getenv("ENC_TRUSTED_PROXIES", "").split(",")))
# Нативные оболочки (Android/десктоп) грузят UI из локальных файлов:
# их Origin = "null" или file://, поэтому такие источники тоже разрешены.
ALLOWED_ORIGINS = [o for o in os.getenv("ENC_ALLOWED_ORIGINS", "").split(",") if o] or [
    PUBLIC_ORIGIN,
    f"https://{PUBLIC_IP}:{PORT}",
    # Сайт, отданный через nginx (порт 80/443) — тот же сервер, другой источник
    f"http://{PUBLIC_IP}",
    f"https://{PUBLIC_IP}",
    f"http://localhost:{PORT}",
    f"http://127.0.0.1:{PORT}",
    "null",
]
# Разрешаем локальные адреса и локальные оболочки приложений (Origin как у file:///WebView)
ALLOWED_ORIGIN_REGEX = os.getenv(
    "ENC_ALLOWED_ORIGIN_REGEX",
    r"^(https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?|file://.*|https?://appassets\.androidplatform\.net)$")

# ── Безопасность / токены ───────────────────────────────────────────────────
def _load_or_create_key(name: str) -> str:
    """Секрет генерируется один раз и переживает перезапуски сервера."""
    f = DATA_DIR / f".{name}.key"
    if f.exists():
        return f.read_text().strip()
    val = secrets.token_urlsafe(48)
    f.write_text(val)
    f.chmod(0o600)
    return val


JWT_SECRET = os.getenv("ENC_JWT_SECRET") or _load_or_create_key("jwt")
ACCESS_TTL = int(os.getenv("ENC_ACCESS_TTL", str(15 * 60)))          # 15 минут
REFRESH_TTL = int(os.getenv("ENC_REFRESH_TTL", str(30 * 24 * 3600)))  # 30 дней

# ── Политики продукта ───────────────────────────────────────────────────────
FILE_TTL_HOURS = int(os.getenv("ENC_FILE_TTL_HOURS", "24"))   # файл живёт ровно 24 часа
# «Только локально»: как только получатель скачал файл целиком, копия на сервере
# удаляется безвозвратно и остаётся лишь на его устройстве.
FILE_BURN_AFTER_DOWNLOAD = os.getenv("ENC_FILE_BURN_AFTER_DOWNLOAD", "1") == "1"
FILE_BURN_GRACE_SECONDS = int(os.getenv("ENC_FILE_BURN_GRACE", "45"))  # запас на повторные попытки
FILE_MAX_BYTES = int(os.getenv("ENC_FILE_MAX_BYTES", str(200 * 1024 * 1024)))
PURGE_INTERVAL = int(os.getenv("ENC_PURGE_INTERVAL", "300"))  # чистка каждые 5 минут

# Один аккаунт на устройство (жёстко) + максимум устройств в одном аккаунте.
ONE_ACCOUNT_PER_DEVICE = os.getenv("ENC_ONE_ACCOUNT_PER_DEVICE", "1") == "1"
MAX_DEVICES_PER_ACCOUNT = int(os.getenv("ENC_MAX_DEVICES", "4"))
# Срок, после которого устройство можно отвязать и переиспользовать (анти-мультиакк).
DEVICE_REBIND_COOLDOWN_DAYS = int(os.getenv("ENC_DEVICE_COOLDOWN_DAYS", "30"))

RATE_LIMIT_PER_MIN = int(os.getenv("ENC_RATE_LIMIT", "240"))
# Множитель для точечных лимитов (вход, регистрация, восстановление).
# Нужен тестам: вся сюита идёт с одного IP и создаёт десятки аккаунтов.
RATE_LIMIT_FACTOR = float(os.getenv("ENC_RATE_FACTOR", "1"))
MAX_MESSAGE_BYTES = int(os.getenv("ENC_MAX_MESSAGE_BYTES", str(64 * 1024)))
GROUP_MAX_MEMBERS = int(os.getenv("ENC_GROUP_MAX", "200"))
RECOVERY_WORDS = int(os.getenv("ENC_RECOVERY_WORDS", "24"))   # BIP39-фраза

VERSION = "3.4.0"      # единый порт 3000 для сервера и всех клиентов

# ── Администрирование ───────────────────────────────────────────────────────
# Логины, получающие админ-права (панель управления сервером).
# Задаётся через ENC_ADMINS, по умолчанию — saness.
ADMIN_USERNAMES = {
    u.strip().lower() for u in os.getenv("ENC_ADMINS", "saness").split(",") if u.strip()
}
APP_NAME = "Encryption"
