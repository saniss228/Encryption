"""Чаты: личные, группы, «Избранное», участники, инвайты, настройки."""
from __future__ import annotations

import json
import secrets
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status

from .. import db
from ..config import GROUP_MAX_MEMBERS, MAX_MESSAGE_BYTES
from ..models import ChatCreateRequest, ChatUpdateRequest, MemberUpdateRequest
from ..security import current_session
from ._common import chat_json, chat_or_404, fanout, member, touch_chat

router = APIRouter(prefix="/api/v1/chats", tags=["chats"])


@router.get("")
async def list_chats(archived: bool = False, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    rows = await db.fetchall(
        """SELECT c.* FROM chats c JOIN chat_members cm ON cm.chat_id=c.id
            WHERE cm.user_id=? AND cm.archived=? ORDER BY c.updated_at DESC LIMIT 500""",
        (uid, 1 if archived else 0))
    return {"chats": [await chat_json(dict(r), uid) for r in rows]}


@router.post("", status_code=201)
async def create_chat(body: ChatCreateRequest, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    if body.type == "saved":
        cid = f"saved-{uid}"
        existing = await db.fetchone("SELECT id FROM chats WHERE id=?", (cid,))
        if not existing:
            await db.execute(
                "INSERT INTO chats(id,type,title,owner_id,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                (cid, "saved", "Избранное", uid, db.now(), db.now()))
            await db.execute(
                "INSERT INTO chat_members(chat_id,user_id,role,joined_at) VALUES(?,?,?,?)",
                (cid, uid, "owner", db.now()))
        return await chat_json(await chat_or_404(cid), uid)

    if body.type == "direct":
        if not body.peer_username:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                detail={"code": "NO_PEER", "message": "Укажите логин собеседника"})
        peer = await db.fetchone("SELECT * FROM users WHERE username=?", (body.peer_username,))
        if not peer:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail={"code": "NO_USER", "message": "Пользователь не найден"})
        pid = int(peer["id"])
        if pid == uid:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Нельзя создать чат с собой")
        blocked = await db.fetchone(
            "SELECT 1 AS x FROM contacts WHERE ((owner_id=? AND peer_id=? AND blocked=1) OR (owner_id=? AND peer_id=? AND blocked=1))",
            (uid, pid, pid, uid))
        if blocked:
            raise HTTPException(status.HTTP_403_FORBIDDEN,
                                detail={"code": "BLOCKED", "message": "Один из пользователей заблокирован"})
        cid = "-".join(sorted([f"u{uid}", f"u{pid}"]))
        existing = await db.fetchone("SELECT id FROM chats WHERE id=?", (cid,))
        if not existing:
            await db.execute(
                "INSERT INTO chats(id,type,title,owner_id,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                (cid, "direct", "", uid, db.now(), db.now()))
            for m in (uid, pid):
                await db.execute(
                    "INSERT OR IGNORE INTO chat_members(chat_id,user_id,role,joined_at) VALUES(?,?,?,?)",
                    (cid, m, "member", db.now()))
            await fanout(cid, {"t": "chat.created", "chat_id": cid})
        return await chat_json(await chat_or_404(cid), uid)

    # Группа
    members_ids = [uid]
    for uname in body.members:
        u = await db.fetchone("SELECT id FROM users WHERE username=?", (uname,))
        if u and int(u["id"]) not in members_ids:
            members_ids.append(int(u["id"]))
    if len(members_ids) > GROUP_MAX_MEMBERS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Максимум {GROUP_MAX_MEMBERS} участников")
    cid = "g" + secrets.token_hex(12)
    await db.execute(
        "INSERT INTO chats(id,type,title,owner_id,ttl_seconds,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        (cid, "group", body.title or "Новая группа", uid, body.ttl_seconds, db.now(), db.now()))
    for m in members_ids:
        await db.execute(
            "INSERT INTO chat_members(chat_id,user_id,role,joined_at) VALUES(?,?,?,?)",
            (cid, m, "owner" if m == uid else "member", db.now()))
    await fanout(cid, {"t": "chat.created", "chat_id": cid})
    await db.audit("chat_create", user_id=uid, detail={"chat_id": cid, "type": "group"})
    return await chat_json(await chat_or_404(cid), uid)


@router.get("/{chat_id}")
async def get_chat(chat_id: str, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    await member(chat_id, uid)
    return await chat_json(await chat_or_404(chat_id), uid)


@router.patch("/{chat_id}")
async def update_chat(chat_id: str, body: ChatUpdateRequest, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    m = await member(chat_id, uid)
    chat = await chat_or_404(chat_id)
    if chat["type"] == "group" and body.title is not None and m["role"] not in ("owner", "admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Менять название может владелец или админ")
    if body.title is not None:
        await db.execute("UPDATE chats SET title=?,updated_at=? WHERE id=?", (body.title, db.now(), chat_id))
    if body.avatar_id is not None:
        await db.execute("UPDATE chats SET avatar_id=?,updated_at=? WHERE id=?", (body.avatar_id, db.now(), chat_id))
    if body.ttl_seconds is not None:
        if chat["type"] == "group" and m["role"] not in ("owner", "admin"):
            await db.execute("UPDATE chat_members SET custom_ttl=? WHERE chat_id=? AND user_id=?",
                             (body.ttl_seconds, chat_id, uid))
        else:
            await db.execute("UPDATE chats SET ttl_seconds=?,updated_at=? WHERE id=?",
                             (body.ttl_seconds, db.now(), chat_id))
    await fanout(chat_id, {"t": "chat.updated", "chat_id": chat_id})
    return await chat_json(await chat_or_404(chat_id), uid)


@router.post("/{chat_id}/members")
async def members_op(chat_id: str, body: MemberUpdateRequest, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    me = await member(chat_id, uid)
    chat = await chat_or_404(chat_id)
    if chat["type"] != "group":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Операция только для групп")

    target = None
    if body.user_id:
        target = await db.fetchone("SELECT * FROM users WHERE id=?", (body.user_id,))
    elif body.username:
        target = await db.fetchone("SELECT * FROM users WHERE username=?", (body.username,))
    if not target:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Пользователь не найден")
    tid = int(target["id"])

    if body.action in ("add", "remove", "promote", "demote") and me["role"] not in ("owner", "admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Недостаточно прав")

    if body.action == "add":
        cnt = await db.fetchone("SELECT COUNT(*) AS c FROM chat_members WHERE chat_id=?", (chat_id,))
        if cnt and int(cnt["c"]) >= GROUP_MAX_MEMBERS:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Группа заполнена")
        await db.execute(
            "INSERT OR IGNORE INTO chat_members(chat_id,user_id,role,joined_at) VALUES(?,?,?,?)",
            (chat_id, tid, "member", db.now()))
        await fanout(chat_id, {"t": "chat.member.add", "chat_id": chat_id, "user_id": tid})
    elif body.action == "remove":
        if tid == int(chat["owner_id"]):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Владельца удалить нельзя")
        await db.execute("DELETE FROM chat_members WHERE chat_id=? AND user_id=?", (chat_id, tid))
        await fanout(chat_id, {"t": "chat.member.remove", "chat_id": chat_id, "user_id": tid})
    elif body.action == "promote":
        await db.execute("UPDATE chat_members SET role='admin' WHERE chat_id=? AND user_id=?", (chat_id, tid))
        await fanout(chat_id, {"t": "chat.member.role", "chat_id": chat_id, "user_id": tid, "role": "admin"})
    elif body.action == "demote":
        await db.execute("UPDATE chat_members SET role='member' WHERE chat_id=? AND user_id=?", (chat_id, tid))
        await fanout(chat_id, {"t": "chat.member.role", "chat_id": chat_id, "user_id": tid, "role": "member"})
    await touch_chat(chat_id)
    return {"ok": True}


@router.post("/{chat_id}/leave")
async def leave(chat_id: str, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    await member(chat_id, uid)
    chat = await chat_or_404(chat_id)
    if int(chat["owner_id"] or 0) == uid and chat["type"] == "group":
        # передаём владение старшему участнику
        nxt = await db.fetchone(
            """SELECT user_id FROM chat_members WHERE chat_id=? AND user_id<>?
                ORDER BY (role='admin') DESC, joined_at ASC LIMIT 1""", (chat_id, uid))
        if nxt:
            await db.execute("UPDATE chats SET owner_id=? WHERE id=?", (int(nxt["user_id"]), chat_id))
            await db.execute("UPDATE chat_members SET role='owner' WHERE chat_id=? AND user_id=?",
                             (chat_id, int(nxt["user_id"])))
    await db.execute("DELETE FROM chat_members WHERE chat_id=? AND user_id=?", (chat_id, uid))
    await fanout(chat_id, {"t": "chat.member.remove", "chat_id": chat_id, "user_id": uid})
    return {"ok": True}


@router.delete("/{chat_id}")
async def delete_chat(chat_id: str, for_everyone: bool = False, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    me = await member(chat_id, uid)
    chat = await chat_or_404(chat_id)
    if for_everyone:
        if chat["type"] == "group" and int(chat["owner_id"] or 0) != uid:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Удалить группу может только владелец")
        await db.execute("DELETE FROM chats WHERE id=?", (chat_id,))
        await fanout(chat_id, {"t": "chat.deleted", "chat_id": chat_id})
    else:
        await db.execute("DELETE FROM chat_members WHERE chat_id=? AND user_id=?", (chat_id, uid))
        archived = me.get("archived")
        _ = archived
    return {"ok": True}


@router.post("/{chat_id}/pin")
async def pin_chat(chat_id: str, pinned: bool = True, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    await member(chat_id, uid)
    await db.execute("UPDATE chat_members SET pinned=? WHERE chat_id=? AND user_id=?",
                     (1 if pinned else 0, chat_id, uid))
    return {"ok": True}


@router.post("/{chat_id}/archive")
async def archive_chat(chat_id: str, archived: bool = True, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    await member(chat_id, uid)
    await db.execute("UPDATE chat_members SET archived=? WHERE chat_id=? AND user_id=?",
                     (1 if archived else 0, chat_id, uid))
    return {"ok": True}


@router.post("/{chat_id}/mute")
async def mute_chat(chat_id: str, until: int = Query(default=0, ge=0), sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    await member(chat_id, uid)
    await db.execute("UPDATE chat_members SET muted_until=? WHERE chat_id=? AND user_id=?",
                     (until, chat_id, uid))
    return {"ok": True}


@router.post("/{chat_id}/draft")
async def save_draft(chat_id: str, text: str = "", sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    await member(chat_id, uid)
    await db.execute("UPDATE chat_members SET draft=? WHERE chat_id=? AND user_id=?",
                     (text[:4096], chat_id, uid))
    return {"ok": True}


@router.post("/{chat_id}/wallpaper")
async def set_wallpaper(chat_id: str, media_id: str = "", sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    await member(chat_id, uid)
    await db.execute("UPDATE chat_members SET wallpaper=? WHERE chat_id=? AND user_id=?",
                     (media_id or None, chat_id, uid))
    return {"ok": True}


# ── Инвайт-ссылки ──────────────────────────────────────────────────────────
@router.post("/{chat_id}/invite")
async def create_invite(chat_id: str, max_uses: int = 0, ttl_hours: int = 168,
                        sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    me = await member(chat_id, uid)
    chat = await chat_or_404(chat_id)
    if chat["type"] != "group":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Инвайты доступны только для групп")
    if me["role"] not in ("owner", "admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Недостаточно прав")
    token = secrets.token_urlsafe(16)
    await db.execute(
        "INSERT INTO invite_links(token,chat_id,created_by,created_at,expires_at,max_uses) VALUES(?,?,?,?,?,?)",
        (token, chat_id, uid, db.now(), db.now() + ttl_hours * 3600, max_uses))
    return {"token": token, "link": f"/join/{token}", "expires_in_hours": ttl_hours,
            "max_uses": max_uses}


@router.get("/{chat_id}/invites")
async def list_invites(chat_id: str, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    me = await member(chat_id, uid)
    if me["role"] not in ("owner", "admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Недостаточно прав")
    rows = await db.fetchall("SELECT * FROM invite_links WHERE chat_id=? ORDER BY created_at DESC",
                             (chat_id,))
    return {"invites": [dict(r) for r in rows]}


@router.post("/join/{token}")
async def join_by_invite(token: str, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    inv = await db.fetchone("SELECT * FROM invite_links WHERE token=?", (token,))
    if not inv:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ссылка недействительна")
    if inv["expires_at"] and int(inv["expires_at"]) < db.now():
        raise HTTPException(status.HTTP_410_GONE, "Ссылка истекла")
    if int(inv["max_uses"]) and int(inv["uses"]) >= int(inv["max_uses"]):
        raise HTTPException(status.HTTP_410_GONE, "Лимит использований исчерпан")
    cid = inv["chat_id"]
    cnt = await db.fetchone("SELECT COUNT(*) AS c FROM chat_members WHERE chat_id=?", (cid,))
    if cnt and int(cnt["c"]) >= GROUP_MAX_MEMBERS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Группа заполнена")
    await db.execute(
        "INSERT OR IGNORE INTO chat_members(chat_id,user_id,role,joined_at) VALUES(?,?,?,?)",
        (cid, uid, "member", db.now()))
    await db.execute("UPDATE invite_links SET uses=uses+1 WHERE token=?", (token,))
    await fanout(cid, {"t": "chat.member.add", "chat_id": cid, "user_id": uid})
    return {"ok": True, "chat_id": cid}


# ── Поиск по сообщениям (на сервере — только по метаданным, контент зашифрован) ──
@router.get("/{chat_id}/search")
async def search_in_chat(chat_id: str, q: str = Query(min_length=1, max_length=128),
                         limit: int = 30, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    await member(chat_id, uid)
    rows = await db.fetchall(
        """SELECT * FROM messages WHERE chat_id=? AND deleted_at IS NULL
            AND (id LIKE ? OR attachment_meta LIKE ?) ORDER BY created_at DESC LIMIT ?""",
        (chat_id, f"%{q}%", f"%{q}%", min(limit, 100)))
    return {"results": [dict(r) for r in rows],
            "note": "Полнотекстовый поиск выполняется на устройстве — сервер видит только шифротекст",
            "max_message_bytes": MAX_MESSAGE_BYTES}


@router.get("/{chat_id}/stats")
async def chat_stats(chat_id: str, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    await member(chat_id, uid)
    c = await db.fetchone("SELECT COUNT(*) AS c FROM messages WHERE chat_id=?", (chat_id,))
    m = await db.fetchone("SELECT COUNT(*) AS c FROM chat_members WHERE chat_id=?", (chat_id,))
    f = await db.fetchone("SELECT COUNT(*) AS c, COALESCE(SUM(size),0) AS s FROM files WHERE chat_id=?",
                          (chat_id,))
    return {"messages": int(c["c"]), "members": int(m["c"]), "files": int(f["c"]),
            "files_bytes": int(f["s"]), "meta": {"encrypted_payload_only": True}}
