"""
Админ-панель сервера Encryption.

Доступ: только логины из ENC_ADMINS (по умолчанию — saniss).

Что доступно администратору:
  • обзор сервера: пользователи, чаты, сообщения, файлы, место на диске;
  • пользователи: поиск, блокировка/разблокировка, выход со всех устройств,
    выдача и снятие админ-прав, полное удаление аккаунта;
  • чаты: список групп, роспуск группы;
  • файлы: список, удаление, уборка истёкших и «надгробий»;
  • журнал безопасности: кто, когда, что делал;
  • рассылка объявлений, которые видят все клиенты;
  • настройки сервера (например, закрыть регистрацию).

Важно: администратор НЕ может читать переписку — сервер хранит только
шифротекст, и это правило не обходится никакими правами.
"""
from __future__ import annotations

import json
import shutil
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status

from .. import db
from ..config import (ADMIN_USERNAMES, FILE_TTL_HOURS, FILES_DIR, GROUP_MAX_MEMBERS,
                      MAX_MESSAGE_BYTES, RATE_LIMIT_PER_MIN, FILE_MAX_BYTES, VERSION)
from ..models import (AdminBroadcastRequest, AdminRoleRequest, AdminSettingsRequest,
                      AdminUserActionRequest)
from ..realtime import hub
from ..security import current_session, require_admin
from ._common import fanout

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])
client_router = APIRouter(prefix="/api/v1", tags=["common"])


# ── Хелперы ─────────────────────────────────────────────────────────────────
async def setting(key: str, default: str = "") -> str:
    row = await db.fetchone("SELECT value FROM settings WHERE key=?", (key,))
    return row["value"] if row else default


async def set_setting(key: str, value: str, by: int | None = None) -> None:
    await db.execute(
        """INSERT INTO settings(key,value,updated_at,updated_by) VALUES(?,?,?,?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at,
                                          updated_by=excluded.updated_by""",
        (key, value, db.now(), by))


def _user_row(row: Any, *, sessions: int = 0, devices: int = 0, messages: int = 0) -> dict[str, Any]:
    blocked = bool(row["blocked_at"]) or bool(row["is_banned"])
    return {
        "id": int(row["id"]),
        "username": row["username"],
        "display_name": row["display_name"],
        "about": row["about"],
        "role": row["role"] if "role" in row.keys() else "user",
        "is_admin": (row["role"] if "role" in row.keys() else "user") == "admin"
                    or str(row["username"]).lower() in ADMIN_USERNAMES,
        "blocked": blocked,
        "blocked_reason": row["blocked_reason"] if "blocked_reason" in row.keys() else None,
        "blocked_at": row["blocked_at"] if "blocked_at" in row.keys() else None,
        "created_at": int(row["created_at"]),
        "last_seen": int(row["last_seen"] or 0),
        "online": int(row["id"]) in hub.online_users(),
        "sessions": sessions,
        "devices": devices,
        "messages": messages,
        "has_recovery": bool(row["recovery_hash"]),
    }


async def _target(uid: int) -> Any:
    row = await db.fetchone("SELECT * FROM users WHERE id=?", (uid,))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            detail={"code": "USER_NOT_FOUND", "message": "Пользователь не найден"})
    return row


async def _guard_admin_target(row: Any, actor: dict) -> None:
    """Нельзя применять опасные действия к самому себе и к другим администраторам."""
    if int(row["id"]) == int(actor["id"]):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            detail={"code": "SELF_ACTION", "message": "Действие над своим аккаунтом недоступно"})
    if (row["role"] if "role" in row.keys() else "user") == "admin" \
            or str(row["username"]).lower() in ADMIN_USERNAMES:
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            detail={"code": "TARGET_IS_ADMIN", "message": "Нельзя изменять другого администратора"})


# ── Обзор ───────────────────────────────────────────────────────────────────
@router.get("/overview")
async def overview(sess: dict = Depends(require_admin)):
    now = db.now()
    one = await db.fetchone("SELECT COUNT(*) c FROM users")
    blocked = await db.fetchone("SELECT COUNT(*) c FROM users WHERE blocked_at IS NOT NULL OR is_banned=1")
    admins = await db.fetchone("SELECT COUNT(*) c FROM users WHERE role='admin'")
    chats = await db.fetchone("SELECT COUNT(*) c FROM chats")
    groups = await db.fetchone("SELECT COUNT(*) c FROM chats WHERE type='group'")
    msgs = await db.fetchone("SELECT COUNT(*) c FROM messages WHERE deleted_at IS NULL")
    msgs24 = await db.fetchone("SELECT COUNT(*) c FROM messages WHERE created_at > ?", (now - 86400,))
    files = await db.fetchone("SELECT COUNT(*) c, COALESCE(SUM(size),0) s FROM files WHERE local_only=0")
    served = await db.fetchone("SELECT COUNT(*) c FROM files WHERE local_only=1")
    expired = await db.fetchone(
        "SELECT COUNT(*) c FROM files WHERE local_only=0 AND expires_at < ?", (now,))
    sessions = await db.fetchone("SELECT COUNT(*) c FROM sessions WHERE revoked_at IS NULL AND expires_at > ?", (now,))
    devices = await db.fetchone("SELECT COUNT(*) c FROM devices WHERE revoked_at IS NULL")
    audit24 = await db.fetchone("SELECT COUNT(*) c FROM audit_log WHERE at > ?", (now - 86400,))

    disk = shutil.disk_usage(str(FILES_DIR))
    used_on_disk = 0
    if FILES_DIR.exists():
        for d in FILES_DIR.iterdir():
            if d.is_dir():
                for f in d.iterdir():
                    try:
                        used_on_disk += f.stat().st_size
                    except OSError:
                        pass

    return {
        "server": {
            "version": VERSION,
            "uptime_note": "фоновая уборка каждые 5 минут",
            "now": now,
            "file_ttl_hours": FILE_TTL_HOURS,
            "max_file_mb": FILE_MAX_BYTES // (1024 * 1024),
            "max_message_kb": MAX_MESSAGE_BYTES // 1024,
            "rate_limit_per_min": RATE_LIMIT_PER_MIN,
            "group_max_members": GROUP_MAX_MEMBERS,
        },
        "users": {"total": int(one["c"]), "blocked": int(blocked["c"]), "admins": int(admins["c"]),
                  "online": len(hub.online_users())},
        "chats": {"total": int(chats["c"]), "groups": int(groups["c"])},
        "messages": {"total": int(msgs["c"]), "last_24h": int(msgs24["c"])},
        "files": {"on_server": int(files["c"]), "bytes_on_server": int(files["s"]),
                  "local_only": int(served["c"]), "expired_pending": int(expired["c"]),
                  "bytes_on_disk": used_on_disk},
        "sessions": {"active": int(sessions["c"]), "devices": int(devices["c"])},
        "audit": {"events_24h": int(audit24["c"])},
        "disk": {"total": disk.total, "used": disk.used, "free": disk.free},
        "registration_open": (await setting("registration_open", "1")) == "1",
    }


# ── Пользователи ────────────────────────────────────────────────────────────
@router.get("/users")
async def list_users(q: str = Query(default="", max_length=64),
                     filter: str = Query(default="all"),  # all | blocked | admins | online | recent
                     limit: int = Query(default=50, ge=1, le=200),
                     offset: int = Query(default=0, ge=0),
                     sess: dict = Depends(require_admin)):
    sql = ["SELECT u.*, (SELECT COUNT(*) FROM sessions s WHERE s.user_id=u.id AND s.revoked_at IS NULL) sc, "
           "(SELECT COUNT(*) FROM devices d WHERE d.user_id=u.id AND d.revoked_at IS NULL) dc, "
           "(SELECT COUNT(*) FROM messages m WHERE m.sender_id=u.id AND m.deleted_at IS NULL) mc "
           "FROM users u"]
    where: list[str] = []
    params: list[Any] = []
    if q:
        where.append("(u.username LIKE ? OR u.display_name LIKE ?)")
        params += [f"%{q}%", f"%{q}%"]
    if filter == "blocked":
        where.append("(u.blocked_at IS NOT NULL OR u.is_banned=1)")
    elif filter == "admins":
        where.append("(u.role='admin' OR lower(u.username) IN (%s))"
                     % ",".join("?" * len(ADMIN_USERNAMES)))
        params += sorted(ADMIN_USERNAMES)
    if where:
        sql.append("WHERE " + " AND ".join(where))
    sql.append("ORDER BY u.last_seen DESC, u.id DESC LIMIT ? OFFSET ?")
    params += [limit, offset]
    rows = await db.fetchall(" ".join(sql), params)
    users = [_user_row(r, sessions=int(r["sc"]), devices=int(r["dc"]), messages=int(r["mc"])) for r in rows]
    if filter == "online":
        users = [u for u in users if u["online"]]
    total = await db.fetchone("SELECT COUNT(*) c FROM users")
    return {"users": users, "total": int(total["c"]), "limit": limit, "offset": offset}


@router.get("/users/{user_id}")
async def user_detail(user_id: int, sess: dict = Depends(require_admin)):
    row = await _target(user_id)
    sessions = await db.fetchall(
        "SELECT id,device_id,created_at,expires_at,revoked_at,ip,user_agent FROM sessions "
        "WHERE user_id=? ORDER BY created_at DESC LIMIT 20", (user_id,))
    devices = await db.fetchall(
        "SELECT id,name,platform,app_version,created_at,last_seen,revoked_at FROM devices "
        "WHERE user_id=? ORDER BY created_at DESC", (user_id,))
    chats = await db.fetchall(
        "SELECT c.id,c.type,c.title,(SELECT COUNT(*) FROM messages m WHERE m.chat_id=c.id) mc "
        "FROM chats c JOIN chat_members cm ON cm.chat_id=c.id WHERE cm.user_id=? LIMIT 50", (user_id,))
    files = await db.fetchall(
        "SELECT id,size,kind,created_at,expires_at,local_only FROM files WHERE owner_id=? "
        "ORDER BY created_at DESC LIMIT 50", (user_id,))
    events = await db.fetchall(
        "SELECT at,event,device_id,ip FROM audit_log WHERE user_id=? ORDER BY at DESC LIMIT 40", (user_id,))
    return {
        "user": _user_row(row, sessions=len([s for s in sessions if not s["revoked_at"]])),
        "sessions": [dict(s) for s in sessions],
        "devices": [dict(d) for d in devices],
        "chats": [dict(c) for c in chats],
        "files": [dict(f) for f in files],
        "audit": [dict(e) for e in events],
    }


@router.post("/users/{user_id}/block")
async def block_user(user_id: int, body: AdminUserActionRequest, sess: dict = Depends(require_admin)):
    """Блокировка: пользователь выкидывается со всех устройств и не может войти."""
    actor = sess["user"]
    row = await _target(user_id)
    await _guard_admin_target(row, actor)
    reason = (body.reason or "Нарушение правил сервиса")[:256]
    await db.execute("UPDATE users SET blocked_at=?, blocked_reason=?, blocked_by=?, is_banned=1 WHERE id=?",
                     (db.now(), reason, int(actor["id"]), user_id))
    await db.execute("UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
                     (db.now(), user_id))
    await db.audit("admin_user_blocked", user_id=user_id, ip=sess.get("ip"),
                   actor=int(actor["id"]), reason=reason)
    try:
        await hub.send_to_user(user_id, {"t": "account.blocked", "reason": reason})
    except Exception:
        pass
    return {"ok": True, "user_id": user_id, "blocked": True, "reason": reason}


@router.post("/users/{user_id}/unblock")
async def unblock_user(user_id: int, body: AdminUserActionRequest = AdminUserActionRequest(),
                       sess: dict = Depends(require_admin)):
    actor = sess["user"]
    await _target(user_id)
    await db.execute("UPDATE users SET blocked_at=NULL, blocked_reason=NULL, blocked_by=NULL, is_banned=0 "
                     "WHERE id=?", (user_id,))
    await db.audit("admin_user_unblocked", user_id=user_id, actor=int(actor["id"]))
    return {"ok": True, "user_id": user_id, "blocked": False}


@router.post("/users/{user_id}/logout")
async def force_logout(user_id: int, sess: dict = Depends(require_admin)):
    """Завершить все сессии пользователя (выйти со всех устройств)."""
    actor = sess["user"]
    row = await _target(user_id)
    await _guard_admin_target(row, actor)
    await db.execute("UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
                     (db.now(), user_id))
    await db.audit("admin_force_logout", user_id=user_id, actor=int(actor["id"]))
    try:
        await hub.send_to_user(user_id, {"t": "device.revoked", "device_id": "*"})
    except Exception:
        pass
    return {"ok": True, "user_id": user_id}


@router.post("/users/{user_id}/role")
async def set_role(user_id: int, body: AdminRoleRequest, sess: dict = Depends(require_admin)):
    actor = sess["user"]
    row = await _target(user_id)
    if int(row["id"]) == int(actor["id"]):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            detail={"code": "SELF_ACTION", "message": "Свою роль изменить нельзя"})
    role = "admin" if body.role == "admin" else "user"
    if str(row["username"]).lower() in ADMIN_USERNAMES and role != "admin":
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            detail={"code": "ROOT_ADMIN", "message": "Основного администратора снять нельзя"})
    await db.execute("UPDATE users SET role=? WHERE id=?", (role, user_id))
    await db.audit("admin_role_changed", user_id=user_id, actor=int(actor["id"]), role=role)
    return {"ok": True, "user_id": user_id, "role": role}


@router.delete("/users/{user_id}")
async def delete_user(user_id: int, sess: dict = Depends(require_admin)):
    """Полное удаление аккаунта: сессии, устройства, файлы, сообщения, чаты."""
    actor = sess["user"]
    row = await _target(user_id)
    await _guard_admin_target(row, actor)

    files = await db.fetchall("SELECT id FROM files WHERE owner_id=?", (user_id,))
    for f in files:
        d = FILES_DIR / f["id"]
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)

    own_chats = await db.fetchall("SELECT id FROM chats WHERE owner_id=? AND type='group'", (user_id,))
    for c in own_chats:
        await fanout(c["id"], {"t": "chat.deleted", "chat_id": c["id"]})
        await db.execute("DELETE FROM chats WHERE id=?", (c["id"],))

    await db.execute("DELETE FROM files WHERE owner_id=?", (user_id,))
    await db.execute("DELETE FROM messages WHERE sender_id=?", (user_id,))
    await db.execute("DELETE FROM chat_members WHERE user_id=?", (user_id,))
    await db.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
    await db.execute("DELETE FROM devices WHERE user_id=?", (user_id,))
    await db.execute("DELETE FROM device_bindings WHERE user_id=?", (user_id,))
    await db.execute("DELETE FROM contacts WHERE owner_id=? OR peer_id=?", (user_id, user_id))
    username = row["username"]
    await db.execute("DELETE FROM users WHERE id=?", (user_id,))
    await db.audit("admin_user_deleted", actor=int(actor["id"]), username=username, files=len(files))
    return {"ok": True, "deleted": user_id, "username": username, "files_removed": len(files)}


# ── Чаты ────────────────────────────────────────────────────────────────────
@router.get("/chats")
async def list_chats(q: str = Query(default="", max_length=64),
                     type: str = Query(default="group"),
                     limit: int = Query(default=50, ge=1, le=200),
                     sess: dict = Depends(require_admin)):
    sql = ("SELECT c.id,c.type,c.title,c.owner_id,c.created_at,"
           "(SELECT COUNT(*) FROM chat_members m WHERE m.chat_id=c.id) members,"
           "(SELECT COUNT(*) FROM messages m WHERE m.chat_id=c.id AND m.deleted_at IS NULL) messages "
           "FROM chats c")
    params: list[Any] = []
    where = []
    if type in ("group", "direct", "saved"):
        where.append("c.type=?")
        params.append(type)
    if q:
        where.append("(c.title LIKE ? OR c.id LIKE ?)")
        params += [f"%{q}%", f"%{q}%"]
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY c.created_at DESC LIMIT ?"
    params.append(limit)
    rows = await db.fetchall(sql, params)
    return {"chats": [dict(r) for r in rows]}


@router.delete("/chats/{chat_id}")
async def delete_chat(chat_id: str, sess: dict = Depends(require_admin)):
    actor = sess["user"]
    row = await db.fetchone("SELECT * FROM chats WHERE id=?", (chat_id,))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "CHAT_NOT_FOUND", "message": "Чат не найден"})
    await fanout(chat_id, {"t": "chat.deleted", "chat_id": chat_id})
    await db.execute("DELETE FROM chats WHERE id=?", (chat_id,))
    await db.audit("admin_chat_deleted", actor=int(actor["id"]), chat_id=chat_id, type=row["type"])
    return {"ok": True, "deleted": chat_id}


# ── Файлы ───────────────────────────────────────────────────────────────────
@router.get("/files")
async def list_files(filter: str = Query(default="all"),  # all | on_server | local_only | expired
                     limit: int = Query(default=50, ge=1, le=200),
                     sess: dict = Depends(require_admin)):
    sql = ("SELECT f.*, u.username owner FROM files f LEFT JOIN users u ON u.id=f.owner_id")
    params: list[Any] = []
    if filter == "on_server":
        sql += " WHERE f.local_only=0"
    elif filter == "local_only":
        sql += " WHERE f.local_only=1"
    elif filter == "expired":
        sql += " WHERE f.local_only=0 AND f.expires_at < ?"
        params.append(db.now())
    sql += " ORDER BY f.created_at DESC LIMIT ?"
    params.append(limit)
    rows = await db.fetchall(sql, params)
    return {"files": [{"id": r["id"], "owner": r["owner"], "owner_id": r["owner_id"], "size": int(r["size"]),
                       "kind": r["kind"], "chunks": int(r["chunks"]), "created_at": int(r["created_at"]),
                       "expires_at": int(r["expires_at"]), "local_only": bool(r["local_only"]),
                       "consumed_at": r["consumed_at"]} for r in rows]}


@router.delete("/files/{file_id}")
async def delete_file(file_id: str, sess: dict = Depends(require_admin)):
    actor = sess["user"]
    row = await db.fetchone("SELECT * FROM files WHERE id=?", (file_id,))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "FILE_NOT_FOUND", "message": "Файл не найден"})
    d = FILES_DIR / file_id
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)
    await db.execute("DELETE FROM files WHERE id=?", (file_id,))
    await db.audit("admin_file_deleted", actor=int(actor["id"]), file_id=file_id, size=int(row["size"]))
    return {"ok": True, "deleted": file_id}


@router.post("/files/purge")
async def purge_files(sess: dict = Depends(require_admin)):
    """Уборка: истёкшие файлы и «надгробия» старше 7 дней."""
    actor = sess["user"]
    now = db.now()
    expired = await db.fetchall("SELECT id FROM files WHERE local_only=0 AND expires_at < ?", (now,))
    for f in expired:
        d = FILES_DIR / f["id"]
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
    if expired:
        await db.execute("DELETE FROM files WHERE local_only=0 AND expires_at < ?", (now,))
    tombstones = await db.fetchall(
        "SELECT id FROM files WHERE local_only=1 AND COALESCE(consumed_at,0) < ?", (now - 7 * 86400,))
    for t in tombstones:
        d = FILES_DIR / t["id"]
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
    if tombstones:
        await db.execute("DELETE FROM files WHERE local_only=1 AND COALESCE(consumed_at,0) < ?",
                         (now - 7 * 86400,))
    freed = 0
    await db.audit("admin_files_purged", actor=int(actor["id"]),
                   expired=len(expired), tombstones=len(tombstones))
    return {"ok": True, "expired_removed": len(expired), "tombstones_removed": len(tombstones),
            "freed_bytes": freed}


# ── Журнал, рассылка, настройки ─────────────────────────────────────────────
@router.get("/audit")
async def audit_log(limit: int = Query(default=100, ge=1, le=500),
                    user_id: int | None = None, event: str = Query(default="", max_length=64),
                    sess: dict = Depends(require_admin)):
    sql = ("SELECT a.at,a.event,a.user_id,a.device_id,a.ip,a.detail,u.username "
           "FROM audit_log a LEFT JOIN users u ON u.id=a.user_id")
    where, params = [], []
    if user_id:
        where.append("a.user_id=?")
        params.append(user_id)
    if event:
        where.append("a.event LIKE ?")
        params.append(f"%{event}%")
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY a.at DESC LIMIT ?"
    params.append(limit)
    rows = await db.fetchall(sql, params)
    out = []
    for r in rows:
        try:
            detail = json.loads(r["detail"] or "{}")
        except Exception:
            detail = {}
        out.append({"at": int(r["at"]), "event": r["event"], "user_id": r["user_id"],
                    "username": r["username"], "device_id": r["device_id"], "ip": r["ip"], "detail": detail})
    return {"events": out, "limit": limit}


@router.get("/announcements")
async def list_announcements(sess: dict = Depends(require_admin)):
    rows = await db.fetchall(
        "SELECT a.*, u.username FROM announcements a LEFT JOIN users u ON u.id=a.by_user_id "
        "ORDER BY a.at DESC LIMIT 100")
    return {"announcements": [dict(r) for r in rows]}


@router.post("/broadcast", status_code=201)
async def broadcast(body: AdminBroadcastRequest, sess: dict = Depends(require_admin)):
    """Объявление всем пользователям: появится у них баннером в интерфейсе."""
    actor = sess["user"]
    text = body.text.strip()[:2000]
    if not text:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            detail={"code": "EMPTY_TEXT", "message": "Пустое объявление"})
    level = body.level if body.level in ("info", "warning", "critical") else "info"
    expires = db.now() + int(body.ttl_seconds) if body.ttl_seconds else None
    ann_id = await db.insert(
        "INSERT INTO announcements(at,by_user_id,text,level,active,expires_at) VALUES(?,?,?,?,1,?)",
        (db.now(), int(actor["id"]), text, level, expires))
    await db.audit("admin_broadcast", actor=int(actor["id"]), level=level, length=len(text))
    # мгновенно показываем всем, кто онлайн
    await hub.send_to_users(set(hub.online_users()),
                            {"t": "announcement", "id": ann_id, "text": text, "level": level,
                             "at": db.now()})
    return {"ok": True, "id": ann_id, "level": level, "sent_to_online": len(hub.online_users())}


@router.delete("/announcements/{ann_id}")
async def deactivate_announcement(ann_id: int, sess: dict = Depends(require_admin)):
    actor = sess["user"]
    await db.execute("UPDATE announcements SET active=0 WHERE id=?", (ann_id,))
    await db.audit("admin_announcement_off", actor=int(actor["id"]), id=ann_id)
    await hub.send_to_users(set(hub.online_users()), {"t": "announcement.off", "id": ann_id})
    return {"ok": True, "id": ann_id, "active": False}


@router.get("/settings")
async def get_settings(sess: dict = Depends(require_admin)):
    rows = await db.fetchall("SELECT key,value,updated_at FROM settings")
    kv = {r["key"]: r["value"] for r in rows}
    return {
        "settings": {
            "registration_open": kv.get("registration_open", "1") == "1",
            "welcome_note": kv.get("welcome_note", ""),
        },
        "env": {
            "admins": sorted(ADMIN_USERNAMES),
            "file_ttl_hours": FILE_TTL_HOURS,
            "max_file_mb": FILE_MAX_BYTES // (1024 * 1024),
            "group_max_members": GROUP_MAX_MEMBERS,
        },
    }


@router.put("/settings")
async def put_settings(body: AdminSettingsRequest, sess: dict = Depends(require_admin)):
    actor = sess["user"]
    changed: dict[str, Any] = {}
    if body.registration_open is not None:
        await set_setting("registration_open", "1" if body.registration_open else "0", int(actor["id"]))
        changed["registration_open"] = body.registration_open
    if body.welcome_note is not None:
        await set_setting("welcome_note", body.welcome_note[:500], int(actor["id"]))
        changed["welcome_note"] = body.welcome_note[:500]
    await db.audit("admin_settings", actor=int(actor["id"]), changed=changed)
    return {"ok": True, "changed": changed}


# ── Клиентская точка: объявления и публичные флаги ──────────────────────────
@client_router.get("/announcements")
async def my_announcements(sess: dict = Depends(current_session)):
    """Актуальные объявления администратора — их видит каждый вошедший клиент."""
    now = db.now()
    rows = await db.fetchall(
        "SELECT id,at,text,level,expires_at FROM announcements "
        "WHERE active=1 AND (expires_at IS NULL OR expires_at > ?) ORDER BY at DESC LIMIT 10", (now,))
    reg = (await setting("registration_open", "1")) == "1"
    welcome = await setting("welcome_note", "")
    return {"announcements": [dict(r) for r in rows], "registration_open": reg, "welcome_note": welcome}
