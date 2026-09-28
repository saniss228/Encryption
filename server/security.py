"""
Безопасность: Argon2id, компактный JWT (HS256), rate-limit, device-binding, аудит.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Any

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHashError
from fastapi import Depends, Header, HTTPException, Request, status

from . import db
from .config import ACCESS_TTL, ADMIN_USERNAMES, JWT_SECRET, REFRESH_TTL

# Argon2id — параметры под сервер уровня «интернет»
_ph = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=2, hash_len=32, salt_len=16)


# ── Хеширование ────────────────────────────────────────────────────────────
def hash_secret(secret: str) -> str:
    """Argon2id над секретом, полученным от клиента (пароль в открытом виде не приходит)."""
    return _ph.hash(secret)


def verify_secret(stored: str, secret: str) -> bool:
    try:
        return _ph.verify(stored, secret)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(stored: str) -> bool:
    try:
        return _ph.check_needs_rehash(stored)
    except Exception:
        return False


def sha256_hex(data: str | bytes) -> str:
    if isinstance(data, str):
        data = data.encode()
    return hashlib.sha256(data).hexdigest()


# ── JWT (HS256), без внешних зависимостей ──────────────────────────────────
def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64u_dec(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def jwt_encode(payload: dict[str, Any], ttl: int) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    body = dict(payload)
    now = int(time.time())
    body.update({"iat": now, "exp": now + ttl, "jti": secrets.token_urlsafe(12)})
    h = _b64u(json.dumps(header, separators=(",", ":")).encode())
    p = _b64u(json.dumps(body, separators=(",", ":")).encode())
    sig = hmac.new(JWT_SECRET.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest()
    return f"{h}.{p}.{_b64u(sig)}"


def jwt_decode(token: str) -> dict[str, Any]:
    try:
        h, p, s = token.split(".")
        expected = hmac.new(JWT_SECRET.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _b64u_dec(s)):
            raise ValueError("bad signature")
        body = json.loads(_b64u_dec(p))
        if int(body.get("exp", 0)) < time.time():
            raise ValueError("expired")
        return body
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Недействительный токен")


def make_tokens(user_id: int, username: str, device_id: str, scope: str = "full",
                ttl_override: int | None = None) -> dict[str, Any]:
    access_ttl = ttl_override or ACCESS_TTL
    access = jwt_encode({"sub": user_id, "u": username, "d": device_id, "s": scope}, access_ttl)
    refresh = jwt_encode({"sub": user_id, "u": username, "d": device_id, "s": "refresh"}, REFRESH_TTL)
    return {
        "access_token": access,
        "refresh_token": refresh,
        "token_type": "Bearer",
        "expires_in": access_ttl,
        "refresh_expires_in": REFRESH_TTL,
    }


# ── Rate limit (в памяти, окно 60 c) ───────────────────────────────────────
_RATE: dict[str, list[float]] = {}


def rate_limit(key: str, limit: int, window: float = 60.0) -> bool:
    now = time.time()
    bucket = _RATE.setdefault(key, [])
    bucket[:] = [t for t in bucket if now - t < window]
    if len(bucket) >= limit:
        return False
    bucket.append(now)
    return True


def client_ip(request: Request) -> str:
    from .config import TRUSTED_PROXY_IPS
    direct = request.client.host if request.client else "0.0.0.0"
    if direct in TRUSTED_PROXY_IPS:
        xff = request.headers.get("x-forwarded-for", "")
        if xff:
            return xff.split(",")[0].strip()
    return direct


# ── Зависимости ────────────────────────────────────────────────────────────
async def current_session(
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Требуется авторизация")
    claims = jwt_decode(authorization.split(" ", 1)[1].strip())
    if claims.get("s") == "refresh":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Нужен access-токен")
    uid = int(claims["sub"])
    device_id = str(claims.get("d") or "")
    row = await db.fetchone("SELECT * FROM users WHERE id=? AND is_banned=0", (uid,))
    if not row:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Пользователь не найден")
    if device_id:
        dev = await db.fetchone(
            "SELECT * FROM devices WHERE id=? AND user_id=? AND revoked_at IS NULL",
            (device_id, uid),
        )
        if not dev:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Устройство отозвано")
        await db.execute("UPDATE devices SET last_seen=? WHERE id=?", (db.now(), device_id))
    return {"user": dict(row), "device_id": device_id, "claims": claims, "ip": client_ip(request)}


# ── Администрирование ──────────────────────────────────────────────────────
def is_admin(user: dict[str, Any] | None) -> bool:
    """Админ — либо роль в БД, либо логин из списка ENC_ADMINS (например, saniss)."""
    if not user:
        return False
    role = str(user.get("role") or "user")
    username = str(user.get("username") or "").lower()
    return role == "admin" or username in ADMIN_USERNAMES


async def ensure_admin_role(user: dict[str, Any]) -> dict[str, Any]:
    """
    Самовосстановление прав: если логин входит в ENC_ADMINS, а роль в БД иная —
    поднимаем роль до admin (чтобы права не терялись после сброса базы/миграций).
    """
    if str(user.get("username") or "").lower() in ADMIN_USERNAMES and str(user.get("role")) != "admin":
        await db.execute("UPDATE users SET role='admin' WHERE id=?", (int(user["id"]),))
        user = dict(user)
        user["role"] = "admin"
    return user


async def require_admin(sess: dict = Depends(current_session)) -> dict[str, Any]:
    """Зависимость для админ-роутов: пропускает только администратора."""
    user = await ensure_admin_role(sess["user"])
    if not is_admin(user):
        await db.audit("admin_denied", user_id=int(user["id"]), device_id=sess.get("device_id"),
                       ip=sess.get("ip"), path=str(sess.get("claims", {}).get("path", "")))
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            detail={"code": "ADMIN_ONLY",
                                    "message": "Доступно только администратору сервера"})
    sess["user"] = user
    return sess


async def current_user(sess: dict = Depends(current_session)) -> dict:
    return sess["user"]


def require_rate(request: Request, key: str, limit: int) -> None:
    ip = client_ip(request)
    if not rate_limit(f"{key}:{ip}", limit):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS,
                            "Слишком много запросов, попробуйте позже")
