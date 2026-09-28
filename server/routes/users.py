"""Профиль, поиск пользователей, ключевые бандлы, бэкап ключей, контакты, звонки, аудит."""
from __future__ import annotations

import json
import secrets
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status

from .. import db
from ..config import (DEVICE_REBIND_COOLDOWN_DAYS, FILE_TTL_HOURS, GROUP_MAX_MEMBERS,
                      MAX_DEVICES_PER_ACCOUNT, RECOVERY_WORDS, VERSION)
from ..models import (CallCreateRequest, CallUpdateRequest, ContactUpdateRequest, KeyBundle,
                      UpdateMeRequest)
from ..security import current_session
from ..config import PUBLIC_IP, PORT
from ._common import member

router = APIRouter(prefix="/api/v1", tags=["users"])


def _pub(r: Any) -> dict:
    return {
        "id": int(r["id"]), "username": r["username"], "display_name": r["display_name"],
        "about": r["about"], "avatar_id": r["avatar_id"], "last_seen": int(r["last_seen"]),
        "created_at": int(r["created_at"]),
    }


# ── Профиль ────────────────────────────────────────────────────────────────
@router.get("/users/me")
async def me(sess: dict = Depends(current_session)):
    u = sess["user"]
    chats = await db.fetchone("SELECT COUNT(*) AS c FROM chat_members WHERE user_id=?", (int(u["id"]),))
    devs = await db.fetchone("SELECT COUNT(*) AS c FROM devices WHERE user_id=? AND revoked_at IS NULL",
                             (int(u["id"]),))
    return {
        "user": {**_pub(u), "has_recovery": bool(u["recovery_hash"]),
                 "recovery_hint": u["recovery_hint"], "flags": json.loads(u["flags"] or "{}")},
        "device_id": sess["device_id"],
        "chats": int(chats["c"]), "devices": int(devs["c"]),
        "policy": {"file_ttl_hours": FILE_TTL_HOURS, "one_account_per_device": True,
                   "max_devices": MAX_DEVICES_PER_ACCOUNT,
                   "device_rebind_cooldown_days": DEVICE_REBIND_COOLDOWN_DAYS,
                   "recovery_words": RECOVERY_WORDS, "group_max_members": GROUP_MAX_MEMBERS},
        "server": {"host": PUBLIC_IP, "port": PORT, "version": VERSION},
    }


@router.patch("/users/me")
async def update_me(body: UpdateMeRequest, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    if body.display_name is not None:
        await db.execute("UPDATE users SET display_name=? WHERE id=?", (body.display_name[:64], uid))
    if body.about is not None:
        await db.execute("UPDATE users SET about=? WHERE id=?", (body.about[:256], uid))
    if body.avatar_id is not None:
        await db.execute("UPDATE users SET avatar_id=? WHERE id=?", (body.avatar_id, uid))
    row = await db.fetchone("SELECT * FROM users WHERE id=?", (uid,))
    return {"user": _pub(row)}


@router.get("/users/me/keys")
async def my_keys(sess: dict = Depends(current_session)):
    u = sess["user"]
    return {"keys": {
        "ik_dh_pub": u["ik_dh_pub"], "ik_sign_pub": u["ik_sign_pub"], "rsa_pub": u["rsa_pub"],
        "spk_pub": u["spk_pub"], "spk_sig": u["spk_sig"],
        "one_time_keys": json.loads(u["one_time_keys"] or "[]"),
    }}


@router.put("/users/me/keys")
async def rotate_keys(body: KeyBundle, sess: dict = Depends(current_session)):
    """Ротация ключей (например, после смены устройства или по расписанию)."""
    uid = int(sess["user"]["id"])
    await db.execute(
        """UPDATE users SET ik_dh_pub=?,ik_sign_pub=?,rsa_pub=?,spk_pub=?,spk_sig=?,one_time_keys=?
           WHERE id=?""",
        (body.ik_dh_pub, body.ik_sign_pub, body.rsa_pub, body.spk_pub, body.spk_sig,
         json.dumps(body.one_time_keys), uid))
    await db.audit("keys_rotate", user_id=uid, device_id=sess["device_id"])
    return {"ok": True}


@router.get("/users/me/backup")
async def get_backup(sess: dict = Depends(current_session)):
    """Зашифрованный бэкап приватных ключей (сервер физически не может его открыть)."""
    u = await db.fetchone("SELECT key_backup,recovery_wrap FROM users WHERE id=?",
                          (int(sess["user"]["id"]),))
    return {"key_backup": json.loads(u["key_backup"]) if u["key_backup"] else None,
            "recovery_wrap": json.loads(u["recovery_wrap"]) if u["recovery_wrap"] else None}


@router.put("/users/me/backup")
async def put_backup(payload: dict, sess: dict = Depends(current_session)):
    """
    Сохранить бэкап. payload = {"key_backup": {...}, "recovery_wrap": {...},
                                "recovery_phrase_hash": "...", "recovery_hint": "..."}
    Клиент передаёт уже зашифрованные блобы + Argon2/PBKDF2-хеш фразы.
    """
    from ..security import hash_secret
    uid = int(sess["user"]["id"])
    kb = payload.get("key_backup")
    rw = payload.get("recovery_wrap")
    ph = payload.get("recovery_phrase_hash")
    hint = (payload.get("recovery_hint") or "")[:128]
    await db.execute(
        "UPDATE users SET key_backup=?, recovery_wrap=?, recovery_hash=COALESCE(?,recovery_hash), recovery_hint=? WHERE id=?",
        (json.dumps(kb) if kb else None, json.dumps(rw) if rw else None,
         hash_secret(ph) if ph else None, hint, uid))
    await db.audit("backup_saved", user_id=uid, device_id=sess["device_id"],
                   has_backup=bool(kb), has_recovery=bool(ph))
    return {"ok": True, "message": "Бэкап сохранён. Фраза восстановления — единственный ключ к нему."}


# ── Поиск и публичные профили ──────────────────────────────────────────────
@router.get("/users/search")
async def search_users(q: str = Query(min_length=1, max_length=64), limit: int = 20,
                       sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    rows = await db.fetchall(
        """SELECT * FROM users WHERE (username LIKE ? OR display_name LIKE ?) AND id<>? AND is_banned=0
            ORDER BY (username=?) DESC, last_seen DESC LIMIT ?""",
        (f"%{q}%", f"%{q}%", uid, q, min(limit, 50)))
    return {"users": [_pub(r) for r in rows]}


@router.get("/users/by-id/{user_id}")
async def user_by_id(user_id: int, sess: dict = Depends(current_session)):
    row = await db.fetchone("SELECT * FROM users WHERE id=?", (user_id,))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Пользователь не найден")
    return {"user": _pub(row)}


@router.get("/users/{username}")
async def user_profile(username: str, sess: dict = Depends(current_session)):
    row = await db.fetchone("SELECT * FROM users WHERE username=?", (username,))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Пользователь не найден")
    contact = await db.fetchone("SELECT * FROM contacts WHERE owner_id=? AND peer_id=?",
                                (int(sess["user"]["id"]), int(row["id"])))
    return {"user": _pub(row), "contact": dict(contact) if contact else None}


@router.get("/users/{username}/bundle")
async def user_bundle(username: str, sess: dict = Depends(current_session)):
    """Публичные ключи собеседника для построения конверта двойного шифрования."""
    row = await db.fetchone("SELECT * FROM users WHERE username=? AND is_banned=0", (username,))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Пользователь не найден")
    otk = json.loads(row["one_time_keys"] or "[]")
    return {
        "user": _pub(row),
        "bundle": {
            "ik_dh_pub": row["ik_dh_pub"], "ik_sign_pub": row["ik_sign_pub"],
            "rsa_pub": row["rsa_pub"], "spk_pub": row["spk_pub"], "spk_sig": row["spk_sig"],
            "one_time_key": otk[0] if otk else None,
        },
        "scheme": {
            "layer1": "AES-256-GCM",
            "layer2": "RSA-4096-OAEP-SHA256 (ключ сообщения)",
            "layer3": "ECDH-P256 + HKDF-SHA256 + AES-256-GCM (второй слой ключа)",
            "signature": "ECDSA-P256",
        },
    }


# ── Контакты ───────────────────────────────────────────────────────────────
@router.get("/contacts")
async def contacts(sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    rows = await db.fetchall(
        """SELECT c.*, u.username, u.display_name, u.avatar_id, u.last_seen, u.about
             FROM contacts c JOIN users u ON u.id=c.peer_id WHERE c.owner_id=?""", (uid,))
    from ..realtime import hub
    return {"contacts": [{
        "user_id": int(r["peer_id"]), "username": r["username"], "display_name": r["display_name"],
        "avatar_id": r["avatar_id"], "about": r["about"], "last_seen": int(r["last_seen"]),
        "alias": r["alias"], "verified": bool(r["verified"]), "blocked": bool(r["blocked"]),
        "online": int(r["peer_id"]) in hub.online_users(),
    } for r in rows]}


@router.put("/contacts/{user_id}")
async def upsert_contact(user_id: int, body: ContactUpdateRequest, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    if user_id == uid:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Нельзя добавить себя")
    peer = await db.fetchone("SELECT id FROM users WHERE id=?", (user_id,))
    if not peer:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Пользователь не найден")
    await db.execute(
        """INSERT INTO contacts(owner_id,peer_id,alias,verified,blocked,created_at)
           VALUES(?,?,?,?,?,?)
           ON CONFLICT(owner_id,peer_id) DO UPDATE SET alias=excluded.alias,
             verified=excluded.verified, blocked=excluded.blocked""",
        (uid, user_id, body.alias, 1 if body.verified else 0, 1 if body.blocked else 0, db.now()))
    return {"ok": True}


@router.delete("/contacts/{user_id}")
async def delete_contact(user_id: int, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    await db.execute("DELETE FROM contacts WHERE owner_id=? AND peer_id=?", (uid, user_id))
    return {"ok": True}


# ── Звонки ─────────────────────────────────────────────────────────────────
@router.post("/calls", status_code=201)
async def create_call(body: CallCreateRequest, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    await member(body.chat_id, uid)
    cid = "c" + secrets.token_hex(10)
    await db.execute(
        "INSERT INTO calls(id,chat_id,caller_id,kind,state,started_at,participants) VALUES(?,?,?,?,?,?,?)",
        (cid, body.chat_id, uid, body.kind, "ring", db.now(), json.dumps([uid])))
    from ._common import fanout
    await fanout(body.chat_id, {"t": "call.invite", "call_id": cid, "chat_id": body.chat_id,
                                "from": uid, "kind": body.kind})
    return {"call_id": cid, "ice_servers": [
        {"urls": "stun:stun.l.google.com:19302"},
        {"urls": "stun:stun1.l.google.com:19302"},
    ], "note": "Медиа идёт по WebRTC DTLS-SRTP (P2P); при непрохождении NAT нужен TURN"}


@router.patch("/calls/{call_id}")
async def update_call(call_id: str, body: CallUpdateRequest, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    row = await db.fetchone("SELECT * FROM calls WHERE id=?", (call_id,))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Звонок не найден")
    await member(row["chat_id"], uid)
    ended = db.now() if body.state in ("ended", "declined", "missed") else None
    await db.execute("UPDATE calls SET state=?,ended_at=? WHERE id=?", (body.state, ended, call_id))
    from ._common import fanout
    await fanout(row["chat_id"], {"t": "call.state", "call_id": call_id, "state": body.state,
                                  "by": uid})
    return {"ok": True}


@router.get("/calls")
async def calls(limit: int = Query(default=50, ge=1, le=200), sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    rows = await db.fetchall(
        """SELECT c.*, u.username AS caller_username FROM calls c
             JOIN chat_members cm ON cm.chat_id=c.chat_id
             JOIN users u ON u.id=c.caller_id
            WHERE cm.user_id=? ORDER BY c.started_at DESC LIMIT ?""", (uid, limit))
    return {"calls": [dict(r) for r in rows]}


# ── Журнал безопасности пользователя ───────────────────────────────────────
@router.get("/security/log")
async def security_log(limit: int = Query(default=50, ge=1, le=200),
                       sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    rows = await db.fetchall(
        "SELECT at,event,device_id,ip,detail FROM audit_log WHERE user_id=? ORDER BY at DESC LIMIT ?",
        (uid, limit))
    return {"events": [dict(r) for r in rows]}


@router.get("/security/devices/release-info")
async def release_info(sess: dict = Depends(current_session)):
    return {
        "one_account_per_device": True,
        "cooldown_days": DEVICE_REBIND_COOLDOWN_DAYS,
        "how_to_change_account": [
            "1) Войдите в текущий аккаунт на этом устройстве.",
            "2) Настройки → Устройства → «Освободить устройство».",
            "3) Подтвердите: устройство уходит в карантин "
            f"{DEVICE_REBIND_COOLDOWN_DAYS} дней и после этого на нём можно создать новый аккаунт.",
            "4) Если доступ к старому аккаунту утерян и фразы восстановления нет — "
            "обратитесь в поддержку с подтверждением владения устройством.",
        ],
    }


@router.get("/security/recovery-guide")
async def recovery_guide():
    return {
        "options": [
            {
                "id": "phrase",
                "title": "Фраза восстановления (24 слова)",
                "steps": [
                    "Откройте приложение → «Забыли пароль?» → «Есть фраза восстановления».",
                    "Введите 24 слова из бумажного/офлайн-бэкапа, задайте новый пароль.",
                    "Сервер проверит фразу и выдаст доступ; все старые сессии будут завершены.",
                ],
                "recommended": True,
            },
            {
                "id": "device_pair",
                "title": "Вход с уже авторизованного устройства",
                "steps": [
                    "На новом устройстве выберите «Забыли пароль?» → «Войти с другого устройства».",
                    "Приложение покажет 6-значный код и QR.",
                    "На устройстве, где вы уже вошли: Настройки → Устройства → «Добавить устройство».",
                    "Введите код — приватные ключи будут переданы в зашифрованном виде только этому устройству.",
                ],
                "recommended": True,
            },
            {
                "id": "support",
                "title": "Если нет ни фразы, ни другого устройства",
                "steps": [
                    "Восстановить переписку невозможно: ключи существуют только на устройствах (E2E).",
                    "Можно создать новый аккаунт: освободить устройство (карантин 30 дней) — но с потерей истории.",
                    "Важно: переписка, загруженная в облако, хранится только 24 часа и тоже недоступна без ключей.",
                ],
                "recommended": False,
            },
        ],
        "warning": "Никогда не вводите фразу восстановления на сторонних сайтах и не отправляйте её в чат.",
    }
