"""
Аутентификация, устройства, восстановление доступа.

Ключевые принципы:
  • пароль никогда не покидает устройство в открытом виде (клиент шлёт PBKDF2-хеш);
  • сервер дополнительно хеширует полученное значение Argon2id;
  • один аккаунт = одно устройство (device_bindings), обход возможен только
    через «освобождение устройства» с выдержкой или через восстановление доступа;
  • приватные ключи E2E бэкапятся в ЗАШИФРОВАННОМ виде — сервер не может их прочитать.
"""
from __future__ import annotations

import json
import math
import secrets
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status

from .. import db
from ..config import (
    ADMIN_USERNAMES, ACCESS_TTL, APP_NAME, DEVICE_REBIND_COOLDOWN_DAYS, MAX_DEVICES_PER_ACCOUNT,
                      ONE_ACCOUNT_PER_DEVICE, PORT, PUBLIC_IP, RECOVERY_WORDS, VERSION)
from ..models import (ChallengeRequest, DeviceInfo, LoginRequest, PairApproveRequest,
                      PairClaimRequest, PairStartRequest, RecoverKeysRequest, RecoverRequest,
                      RefreshRequest, RegisterRequest)
from ..realtime import hub
from ..security import (client_ip, current_session, hash_secret, jwt_decode, make_tokens,
                        needs_rehash, require_rate, sha256_hex, verify_secret)

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])

KDF_ITERATIONS = 310_000
SESSION_NAME_LIMIT = MAX_DEVICES_PER_ACCOUNT


def _server_info() -> dict[str, Any]:
    return {
        "name": APP_NAME,
        "version": VERSION,
        "host": PUBLIC_IP,
        "port": PORT,
        "policy": {
            "file_ttl_hours": 24,
            "one_account_per_device": ONE_ACCOUNT_PER_DEVICE,
            "max_devices": MAX_DEVICES_PER_ACCOUNT,
            "device_rebind_cooldown_days": DEVICE_REBIND_COOLDOWN_DAYS,
            "recovery_words": RECOVERY_WORDS,
        },
        "encryption": {
            "layer1": "AES-256-GCM (случайный ключ сообщения)",
            "layer2": "RSA-4096-OAEP-SHA256 (ключ сообщения на получателя)",
            "layer3": "ECDH P-256 + HKDF-SHA256 + AES-256-GCM (forward secrecy)",
            "signature": "ECDSA P-256 (подпись конверта)",
            "kdf_password": f"PBKDF2-SHA512 x{KDF_ITERATIONS} (на устройстве) + Argon2id (на сервере)",
            "transport": "TLS 1.2/1.3 (nginx/uvicorn) + WebSocket Secure",
        },
    }


# ── Вспомогательные проверки устройства ────────────────────────────────────
async def _device_gate(dev: DeviceInfo, username: str | None = None,
                       user_id: int | None = None) -> None:
    """
    Политика «один аккаунт на устройство».
    device_id привязывается к аккаунту навсегда; освобождение — через 30 дней.
    """
    row = await db.fetchone("SELECT * FROM device_bindings WHERE device_id=?", (dev.device_id,))
    if row is None:
        return
    bound_user = int(row["user_id"])
    released = row["released_at"]
    if released and (time.time() - int(released)) < DEVICE_REBIND_COOLDOWN_DAYS * 86400:
        days_left = math.ceil((DEVICE_REBIND_COOLDOWN_DAYS * 86400 - (time.time() - int(released))) / 86400)
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"code": "DEVICE_REBIND_COOLDOWN", "days_left": days_left,
                    "message": f"Устройство освобождено недавно. Повторная привязка — через {days_left} дн."})
    if released and (time.time() - int(released)) >= DEVICE_REBIND_COOLDOWN_DAYS * 86400:
        return  # карантин истёк — устройство свободно
    if user_id is not None and bound_user == user_id:
        return  # это то же самое устройство того же аккаунта
    raise HTTPException(
        status.HTTP_409_CONFLICT,
        detail={"code": "DEVICE_BOUND",
                "message": "Это устройство уже привязано к другому аккаунту. "
                           "Один аккаунт на устройство — жёсткое правило сервера. "
                           "Варианты: войти в тот аккаунт, освободить устройство "
                           f"(через {DEVICE_REBIND_COOLDOWN_DAYS} дн.) или использовать другое устройство."})


async def _register_device(user_id: int, dev: DeviceInfo, request: Request) -> None:
    existing = await db.fetchone("SELECT * FROM devices WHERE id=?", (dev.device_id,))
    if existing:
        await db.execute(
            "UPDATE devices SET name=?,platform=?,app_version=?,fingerprint=?,last_seen=?,revoked_at=NULL,ip_last=? WHERE id=?",
            (dev.name, dev.platform, dev.app_version, dev.fingerprint, db.now(),
             client_ip(request), dev.device_id))
    else:
        cnt = await db.fetchone("SELECT COUNT(*) AS c FROM devices WHERE user_id=?",
                                (user_id,))
        if cnt and int(cnt["c"]) >= MAX_DEVICES_PER_ACCOUNT:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail={"code": "TOO_MANY_DEVICES",
                        "message": f"В аккаунте уже {MAX_DEVICES_PER_ACCOUNT} устройств. "
                                   "Отвяжите лишнее в настройках → «Устройства»."})
        await db.execute(
            """INSERT INTO devices(id,user_id,name,platform,app_version,fingerprint,created_at,
                                   last_seen,ip_first,ip_last)
               VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (dev.device_id, user_id, dev.name, dev.platform, dev.app_version, dev.fingerprint,
             db.now(), db.now(), client_ip(request), client_ip(request)))
    bind = await db.fetchone("SELECT * FROM device_bindings WHERE device_id=?", (dev.device_id,))
    if bind is None:
        await db.execute(
            "INSERT INTO device_bindings(device_id,user_id,bound_at) VALUES(?,?,?)",
            (dev.device_id, user_id, db.now()))
    elif int(bind["user_id"]) != user_id and bind["released_at"]:
        await db.execute(
            "UPDATE device_bindings SET user_id=?,bound_at=?,released_at=NULL WHERE device_id=?",
            (user_id, db.now(), dev.device_id))


async def _create_session(user_id: int, username: str, dev: DeviceInfo, request: Request) -> dict:
    tokens = make_tokens(user_id, username, dev.device_id)
    sid = secrets.token_urlsafe(18)
    await db.execute(
        """INSERT INTO sessions(id,user_id,device_id,refresh_hash,created_at,expires_at,ip,user_agent)
           VALUES(?,?,?,?,?,?,?,?)""",
        (sid, user_id, dev.device_id, sha256_hex(tokens["refresh_token"]), db.now(),
         db.now() + 30 * 86400, client_ip(request), request.headers.get("user-agent", "")[:256]))
    tokens["session_id"] = sid
    # помечаем отозванные прошлые сессии этого устройства
    await db.execute(
        "UPDATE sessions SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL AND id<>?",
        (db.now(), dev.device_id, sid))
    return tokens


def _public_user(row: Any) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "username": row["username"],
        "display_name": row["display_name"],
        "about": row["about"],
        "avatar_id": row["avatar_id"],
        "created_at": int(row["created_at"]),
        "keys": {
            "ik_dh_pub": row["ik_dh_pub"],
            "ik_sign_pub": row["ik_sign_pub"],
            "rsa_pub": row["rsa_pub"],
            "spk_pub": row["spk_pub"],
            "spk_sig": row["spk_sig"],
        },
        "has_recovery": bool(row["recovery_hash"]),
        "role": (row["role"] if "role" in row.keys() else "user"),
        "is_admin": (row["role"] if "role" in row.keys() else "user") == "admin"
                    or str(row["username"]).lower() in ADMIN_USERNAMES,
        "blocked": bool(row["blocked_at"]) if "blocked_at" in row.keys() else False,
    }


# ── Проверка устройства / существования логина ─────────────────────────────
@router.post("/device/check")
async def device_check(body: ChallengeRequest, request: Request):
    require_rate(request, "device_check", 60)
    binding = await db.fetchone("SELECT * FROM device_bindings WHERE device_id=?", (body.device.device_id,))
    user = await db.fetchone("SELECT id,username FROM users WHERE username=?", (body.username,))
    if binding and not binding["released_at"]:
        bound = await db.fetchone("SELECT username FROM users WHERE id=?", (int(binding["user_id"]),))
        return {
            "device_bound": True,
            "bound_to": bound["username"] if bound else None,
            "same_user": bool(user and bound and user["username"] == bound["username"]),
            "username_exists": bool(user),
            "kdf": {"algo": "PBKDF2-SHA512", "iterations": KDF_ITERATIONS, "salt_hint": "username"},
        }
    return {
        "device_bound": False,
        "bound_to": None,
        "username_exists": bool(user),
        "kdf": {"algo": "PBKDF2-SHA512", "iterations": KDF_ITERATIONS, "salt_hint": "username"},
    }


# ── Регистрация ────────────────────────────────────────────────────────────
@router.post("/register", status_code=201)
async def register(body: RegisterRequest, request: Request):
    require_rate(request, "register", 10)
    await _device_gate(body.device)

    # Регистрацию можно закрыть в админ-панели (админские логины пускаются всегда)
    from .admin import setting
    is_root = body.username.lower() in ADMIN_USERNAMES
    if not is_root and (await setting("registration_open", "1")) != "1":
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            detail={"code": "REGISTRATION_CLOSED",
                                    "message": "Регистрация новых аккаунтов закрыта администратором"})

    exists = await db.fetchone("SELECT id FROM users WHERE username=?", (body.username,))
    if exists:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            detail={"code": "USERNAME_TAKEN", "message": "Логин занят"})

    uid = await db.insert(
        """INSERT INTO users(username,display_name,about,auth_hash,ik_dh_pub,ik_sign_pub,rsa_pub,
                             spk_pub,spk_sig,one_time_keys,key_backup,recovery_wrap,recovery_hash,
                             recovery_hint,created_at,last_seen)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (body.username, body.display_name or body.username, "", hash_secret(body.auth_hash),
         body.keys.ik_dh_pub, body.keys.ik_sign_pub, body.keys.rsa_pub, body.keys.spk_pub,
         body.keys.spk_sig, json.dumps(body.keys.one_time_keys),
         json.dumps(body.key_backup) if body.key_backup else None,
         json.dumps(body.recovery.get("wrap")) if body.recovery and body.recovery.get("wrap") else None,
         hash_secret(body.recovery["phrase_hash"]) if body.recovery and body.recovery.get("phrase_hash") else None,
         body.recovery_hint, db.now(), db.now()))

    # Логины из ENC_ADMINS (по умолчанию — saniss) сразу получают админ-права
    if is_root:
        await db.execute("UPDATE users SET role='admin' WHERE id=?", (uid,))

    await _register_device(uid, body.device, request)
    tokens = await _create_session(uid, body.username, body.device, request)
    await db.audit("register", user_id=uid, device_id=body.device.device_id,
                   ip=client_ip(request), platform=body.device.platform)
    row = await db.fetchone("SELECT * FROM users WHERE id=?", (uid,))
    return {"user": _public_user(row), "tokens": tokens, "server": _server_info()}


# ── Параметры KDF для клиента ──────────────────────────────────────────────
@router.post("/challenge")
async def challenge(body: ChallengeRequest, request: Request):
    require_rate(request, "challenge", 120)
    user = await db.fetchone("SELECT id,created_at FROM users WHERE username=?", (body.username,))
    return {
        "exists": bool(user),
        "kdf": {"algo": "PBKDF2-SHA512", "iterations": KDF_ITERATIONS,
                "salt": f"encryption:{body.username.lower()}"},
        "device_gate": await _device_status(body.device),
    }


async def _device_status(dev: DeviceInfo) -> dict[str, Any]:
    b = await db.fetchone("SELECT * FROM device_bindings WHERE device_id=?", (dev.device_id,))
    if not b:
        return {"bound": False}
    return {"bound": True, "released_at": b["released_at"]}


# ── Вход ───────────────────────────────────────────────────────────────────
@router.post("/login")
async def login(body: LoginRequest, request: Request):
    require_rate(request, "login", 30)
    user = await db.fetchone("SELECT * FROM users WHERE username=?", (body.username,))
    # Одинаковый ответ для «нет пользователя» и «неверный пароль» — защита от перебора логинов
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED,
                            detail={"code": "BAD_CREDENTIALS", "message": "Неверный логин или пароль"})
    if user["is_banned"] or ("blocked_at" in user.keys() and user["blocked_at"]):
        # Пароль проверяем всё равно, чтобы не раскрывать список заблокированных
        verify_secret(user["auth_hash"], body.auth_hash)
        await db.audit("login_blocked", user_id=int(user["id"]), device_id=body.device.device_id,
                       ip=client_ip(request))
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            detail={"code": "USER_BLOCKED",
                                    "message": (user["blocked_reason"] if "blocked_reason" in user.keys()
                                                and user["blocked_reason"] else
                                                "Аккаунт заблокирован администратором")})
    if not verify_secret(user["auth_hash"], body.auth_hash):
        await db.audit("login_failed", user_id=int(user["id"]), device_id=body.device.device_id,
                       ip=client_ip(request))
        raise HTTPException(status.HTTP_401_UNAUTHORIZED,
                            detail={"code": "BAD_CREDENTIALS", "message": "Неверный логин или пароль"})

    await _device_gate(body.device, user_id=int(user["id"]))
    if needs_rehash(user["auth_hash"]):
        await db.execute("UPDATE users SET auth_hash=? WHERE id=?",
                         (hash_secret(body.auth_hash), int(user["id"])))

    # Админский логин всегда получает роль admin (даже после ручных правок в базе)
    if str(user["username"]).lower() in ADMIN_USERNAMES and str(user["role"]) != "admin":
        await db.execute("UPDATE users SET role='admin' WHERE id=?", (int(user["id"]),))

    await _register_device(int(user["id"]), body.device, request)
    tokens = await _create_session(int(user["id"]), user["username"], body.device, request)
    await db.execute("UPDATE users SET last_seen=? WHERE id=?", (db.now(), int(user["id"])))
    await db.audit("login", user_id=int(user["id"]), device_id=body.device.device_id,
                   ip=client_ip(request), platform=body.device.platform)
    fresh = await db.fetchone("SELECT * FROM users WHERE id=?", (int(user["id"]),))
    return {"user": _public_user(fresh), "tokens": tokens, "server": _server_info()}


# ── Обновление токена ──────────────────────────────────────────────────────
@router.post("/refresh")
async def refresh(body: RefreshRequest, request: Request):
    require_rate(request, "refresh", 120)
    claims = jwt_decode(body.refresh_token)
    if claims.get("s") != "refresh":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Не refresh-токен")
    h = sha256_hex(body.refresh_token)
    sess = await db.fetchone("SELECT * FROM sessions WHERE refresh_hash=? AND revoked_at IS NULL", (h,))
    if not sess:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Сессия отозвана")
    uid = int(sess["user_id"])
    user = await db.fetchone("SELECT * FROM users WHERE id=? AND is_banned=0", (uid,))
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Пользователь недоступен")
    dev_id = str(sess["device_id"])
    dev = await db.fetchone("SELECT * FROM devices WHERE id=? AND revoked_at IS NULL", (dev_id,))
    if not dev:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Устройство отозвано")

    tokens = make_tokens(uid, user["username"], dev_id)
    # ротация refresh-токена
    await db.execute(
        "UPDATE sessions SET refresh_hash=?, expires_at=? WHERE id=?",
        (sha256_hex(tokens["refresh_token"]), db.now() + 30 * 86400, sess["id"]))
    tokens["session_id"] = sess["id"]
    return {"tokens": tokens, "user": _public_user(user)}


@router.post("/logout")
async def logout(sess: dict = Depends(current_session)):
    await db.execute("UPDATE sessions SET revoked_at=? WHERE id=?",
                     (db.now(), sess["claims"].get("jti")))  # type: ignore[arg-type]
    # точнее: отзываем все сессии данного устройства
    await db.execute("UPDATE sessions SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL",
                     (db.now(), sess["device_id"]))
    await db.audit("logout", user_id=int(sess["user"]["id"]), device_id=sess["device_id"],
                   ip=sess["ip"])
    return {"ok": True}


@router.post("/logout-all")
async def logout_all(except_current: bool = True, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    if except_current:
        await db.execute("UPDATE sessions SET revoked_at=? WHERE user_id=? AND device_id<>?",
                         (db.now(), uid, sess["device_id"]))
    else:
        await db.execute("UPDATE sessions SET revoked_at=? WHERE user_id=?", (db.now(), uid))
    await db.audit("logout_all", user_id=uid, device_id=sess["device_id"])
    return {"ok": True}


@router.post("/panic")
async def panic(sess: dict = Depends(current_session)):
    """
    «Тревожная кнопка»: разом завершает все сессии, стирает бэкап ключей и
    отвязывает все устройства, кроме текущего.
    """
    uid = int(sess["user"]["id"])
    await db.execute("UPDATE users SET key_backup=NULL, recovery_wrap=NULL, recovery_hash=NULL WHERE id=?", (uid,))
    await db.execute("UPDATE sessions SET revoked_at=? WHERE user_id=? AND device_id<>?",
                     (db.now(), uid, sess["device_id"]))
    await db.execute("UPDATE devices SET revoked_at=? WHERE user_id=? AND id<>?",
                     (db.now(), uid, sess["device_id"]))
    await db.audit("panic_wipe", user_id=uid, device_id=sess["device_id"])
    return {"ok": True, "message": "Все другие устройства отключены, облачный бэкап ключей удалён."}


# ── Восстановление доступа ────────────────────────────────────────────────
@router.post("/recover")
async def recover(body: RecoverRequest, request: Request):
    """
    Восстановление пароля по 24-словной фразе.
    Фраза НИКОГДА не покидает устройство целиком: клиент нормализует её,
    локально считает Argon2id и присылает только подтверждение + новые ключи.
    Сервер сверяет хеш и выдаёт новый доступ, разом убивая все старые сессии.
    """
    require_rate(request, "recover", 10)
    user = await db.fetchone("SELECT * FROM users WHERE username=?", (body.username,))
    if not user or not user["recovery_hash"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            detail={"code": "NO_RECOVERY",
                                    "message": "Для этого аккаунта восстановление по фразе не настроено. "
                                               "Используйте вход с уже авторизованного устройства "
                                               "или обратитесь в поддержку."})
    if not verify_secret(user["recovery_hash"], body.phrase_hash):
        await db.audit("recover_failed", user_id=int(user["id"]), ip=client_ip(request))
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            detail={"code": "BAD_PHRASE", "message": "Фраза восстановления не подходит"})

    uid = int(user["id"])
    await _device_gate(body.device, user_id=uid)
    await db.execute("UPDATE users SET auth_hash=? WHERE id=?", (hash_secret(body.new_auth_hash), uid))
    await db.execute("UPDATE sessions SET revoked_at=? WHERE user_id=?", (db.now(), uid))
    await db.execute("UPDATE devices SET revoked_at=? WHERE user_id=? AND id<>?",
                     (db.now(), uid, body.device.device_id))
    if body.keys:
        await db.execute(
            """UPDATE users SET ik_dh_pub=?,ik_sign_pub=?,rsa_pub=?,spk_pub=?,spk_sig=?,one_time_keys=?
               WHERE id=?""",
            (body.keys.ik_dh_pub, body.keys.ik_sign_pub, body.keys.rsa_pub, body.keys.spk_pub,
             body.keys.spk_sig, json.dumps(body.keys.one_time_keys), uid))
    if body.key_backup:
        await db.execute("UPDATE users SET key_backup=? WHERE id=?", (json.dumps(body.key_backup), uid))
    if body.recovery:
        await db.execute("UPDATE users SET recovery_wrap=?, recovery_hash=? WHERE id=?",
                         (json.dumps(body.recovery.get("wrap")) if body.recovery.get("wrap") else None,
                          hash_secret(body.recovery["phrase_hash"]) if body.recovery.get("phrase_hash") else None,
                          uid))
    await _register_device(uid, body.device, request)
    tokens = await _create_session(uid, user["username"], body.device, request)
    await db.audit("recover_ok", user_id=uid, device_id=body.device.device_id, ip=client_ip(request))
    fresh = await db.fetchone("SELECT * FROM users WHERE id=?", (uid,))
    return {"user": _public_user(fresh), "tokens": tokens, "server": _server_info()}


@router.post("/recover/keys")
async def recover_keys(body: RecoverKeysRequest, request: Request):
    """Достаём зашифрованный бэкап ключей по фразе (расшифровка — только на устройстве)."""
    require_rate(request, "recover_keys", 10)
    user = await db.fetchone("SELECT * FROM users WHERE username=?", (body.username,))
    if not user or not user["recovery_hash"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"code": "NO_RECOVERY"})
    if not verify_secret(user["recovery_hash"], body.phrase_hash):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            detail={"code": "BAD_PHRASE", "message": "Фраза восстановления не подходит"})
    return {"key_backup": json.loads(user["key_backup"]) if user["key_backup"] else None,
            "recovery_wrap": json.loads(user["recovery_wrap"]) if user["recovery_wrap"] else None}


# ── Связывание нового устройства по коду (вход без ввода пароля) ───────────
@router.post("/pair/start")
async def pair_start(body: PairStartRequest, request: Request):
    require_rate(request, "pair_start", 20)
    code = f"{secrets.randbelow(1_000_000):06d}"
    pid = secrets.token_urlsafe(16)
    await db.execute(
        """INSERT INTO pairs(id,code,device_id,device_name,platform,created_at,expires_at)
           VALUES(?,?,?,?,?,?,?)""",
        (pid, code, body.device.device_id, body.device.name, body.device.platform,
         db.now(), db.now() + 600))
    return {"pair_id": pid, "code": code, "expires_in": 600,
            "hint": "Введите этот код на уже авторизованном устройстве: Настройки → Устройства → Добавить устройство"}


@router.post("/pair/approve")
async def pair_approve(body: PairApproveRequest, sess: dict = Depends(current_session)):
    row = await db.fetchone("SELECT * FROM pairs WHERE code=? AND status='pending' AND expires_at>?",
                            (body.code, db.now()))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            detail={"code": "PAIR_NOT_FOUND", "message": "Код не найден или истёк"})
    uid = int(sess["user"]["id"])
    await db.execute("UPDATE pairs SET status='approved',user_id=?,key_bundle=? WHERE id=?",
                     (uid, body.key_bundle, row["id"]))
    await db.audit("pair_approve", user_id=uid, detail={"device_id": row["device_id"]})
    return {"ok": True}


@router.post("/pair/claim")
async def pair_claim(body: PairClaimRequest, request: Request):
    row = await db.fetchone("SELECT * FROM pairs WHERE id=? AND code=? AND status='approved'",
                            (body.pair_id, body.code))
    if not row or int(row["expires_at"]) < db.now():
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            detail={"code": "PAIR_NOT_FOUND", "message": "Подтверждение не найдено"})
    uid = int(row["user_id"])
    user = await db.fetchone("SELECT * FROM users WHERE id=?", (uid,))
    if not user:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Аккаунт не найден")
    await _register_device(uid, body.device, request)
    tokens = await _create_session(uid, user["username"], body.device, request)
    await db.execute("UPDATE pairs SET status='claimed',claimed_at=? WHERE id=?", (db.now(), row["id"]))
    await db.audit("pair_claim", user_id=uid, device_id=body.device.device_id, ip=client_ip(request))
    return {"user": _public_user(user), "tokens": tokens,
            "key_bundle": json.loads(row["key_bundle"]) if row["key_bundle"] else None,
            "server": _server_info()}


@router.post("/pair/cancel")
async def pair_cancel(body: PairStartRequest):
    await db.execute("UPDATE pairs SET status='cancelled' WHERE device_id=? AND status='pending'",
                     (body.device.device_id,))
    return {"ok": True}


# ── Сессии и устройства ────────────────────────────────────────────────────
@router.get("/sessions")
async def sessions(sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    rows = await db.fetchall(
        """SELECT s.id,s.device_id,s.created_at,s.expires_at,s.revoked_at,s.ip,s.user_agent,
                  d.name,d.platform,d.last_seen
             FROM sessions s LEFT JOIN devices d ON d.id=s.device_id
            WHERE s.user_id=? ORDER BY s.created_at DESC LIMIT 50""", (uid,))
    return {"sessions": [dict(r) for r in rows], "current_device": sess["device_id"]}


@router.post("/sessions/revoke/{session_id}")
async def revoke_session(session_id: str, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    await db.execute("UPDATE sessions SET revoked_at=? WHERE id=? AND user_id=?",
                     (db.now(), session_id, uid))
    await db.audit("session_revoke", user_id=uid, detail={"session": session_id})
    return {"ok": True}


@router.get("/devices")
async def devices(sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    rows = await db.fetchall(
        "SELECT id,name,platform,app_version,created_at,last_seen,revoked_at,ip_last FROM devices WHERE user_id=? ORDER BY created_at",
        (uid,))
    out = []
    for r in rows:
        d = dict(r)
        d["current"] = d["id"] == sess["device_id"]
        d["online"] = d["id"] in hub.devices(uid)
        out.append(d)
    return {"devices": out, "max_devices": MAX_DEVICES_PER_ACCOUNT}


@router.delete("/devices/{device_id}")
async def revoke_device(device_id: str, release: bool = False, sess: dict = Depends(current_session)):
    """
    Отвязка устройства. release=True — «освободить» устройство: после карантина
    (30 дней) на нём можно создать другой аккаунт.
    """
    uid = int(sess["user"]["id"])
    if device_id == sess["device_id"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            detail={"code": "SELF_DEVICE", "message": "Нельзя отвязать текущее устройство"})
    row = await db.fetchone("SELECT * FROM devices WHERE id=? AND user_id=?", (device_id, uid))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Устройство не найдено")
    await db.execute("UPDATE devices SET revoked_at=? WHERE id=?", (db.now(), device_id))
    await db.execute("UPDATE sessions SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL",
                     (db.now(), device_id))
    if release:
        await db.execute("UPDATE device_bindings SET released_at=? WHERE device_id=?",
                         (db.now(), device_id))
    await hub.send_to_user(uid, {"t": "device.revoked", "device_id": device_id})
    await db.audit("device_revoke", user_id=uid, detail={"device_id": device_id, "release": release})
    return {"ok": True, "released": release}
