"""Общие хелперы для роутов: проверка доступа, сериализация, рассылка событий."""
from __future__ import annotations

import json
import time
from typing import Any

from fastapi import HTTPException, status

from .. import db
from ..realtime import hub


async def member(chat_id: str, user_id: int) -> dict[str, Any]:
    row = await db.fetchone("SELECT * FROM chat_members WHERE chat_id=? AND user_id=?",
                            (chat_id, user_id))
    if not row:
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            detail={"code": "NOT_A_MEMBER", "message": "Нет доступа к этому чату"})
    return dict(row)


async def chat_or_404(chat_id: str) -> dict[str, Any]:
    row = await db.fetchone("SELECT * FROM chats WHERE id=?", (chat_id,))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Чат не найден")
    return dict(row)


def message_json(row: Any, *, reactions: list | None = None,
                 receipts: list | None = None) -> dict[str, Any]:
    d = dict(row)
    return {
        "id": d["id"],
        "chat_id": d["chat_id"],
        "sender_id": int(d["sender_id"]),
        "sender_device": d.get("sender_device", ""),
        "payload": json.loads(d["payload"]) if isinstance(d["payload"], str) else d["payload"],
        "type": d["type"],
        "reply_to": d.get("reply_to"),
        "thread_root": d.get("thread_root"),
        "forward_from": d.get("forward_from"),
        "created_at": int(d["created_at"]),
        "edited_at": d.get("edited_at"),
        "deleted_at": d.get("deleted_at"),
        "expires_at": d.get("expires_at"),
        "burn_after_read": bool(d.get("burn_after_read", 0)),
        "pinned": bool(d.get("pinned", 0)),
        "attachment_id": d.get("attachment_id"),
        "local_only": bool(d.get("local_only", 0)),
        "attachment_meta": json.loads(d["attachment_meta"]) if d.get("attachment_meta") else None,
        "reactions": reactions or [],
        "receipts": receipts or [],
    }


async def load_reactions(message_ids: list[str]) -> dict[str, list[dict]]:
    if not message_ids:
        return {}
    qs = ",".join("?" * len(message_ids))
    rows = await db.fetchall(
        f"SELECT message_id,user_id,emoji FROM reactions WHERE message_id IN ({qs})",
        message_ids)
    out: dict[str, list[dict]] = {}
    for r in rows:
        out.setdefault(r["message_id"], []).append(
            {"user_id": int(r["user_id"]), "emoji": r["emoji"]})
    return out


async def load_receipts(message_ids: list[str]) -> dict[str, list[dict]]:
    if not message_ids:
        return {}
    qs = ",".join("?" * len(message_ids))
    rows = await db.fetchall(
        f"SELECT message_id,user_id,state,at FROM receipts WHERE message_id IN ({qs})",
        message_ids)
    out: dict[str, list[dict]] = {}
    for r in rows:
        out.setdefault(r["message_id"], []).append(
            {"user_id": int(r["user_id"]), "state": r["state"], "at": int(r["at"])})
    return out


async def member_ids(chat_id: str) -> list[int]:
    rows = await db.fetchall("SELECT user_id FROM chat_members WHERE chat_id=?", (chat_id,))
    return [int(r["user_id"]) for r in rows]


async def chat_json(chat: dict, user_id: int) -> dict[str, Any]:
    """Сводка чата для списка: метаданные + последнее сообщение (конверт)."""
    cid = chat["id"]
    members = await db.fetchall(
        """SELECT u.id,u.username,u.display_name,u.avatar_id,u.last_seen,u.ik_dh_pub,u.rsa_pub,
                  cm.role,cm.pinned,cm.archived,cm.muted_until,cm.last_read_at,cm.custom_ttl,cm.draft,cm.wallpaper
             FROM chat_members cm JOIN users u ON u.id=cm.user_id WHERE cm.chat_id=?""", (cid,))
    last = await db.fetchone(
        "SELECT * FROM messages WHERE chat_id=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
        (cid,))
    unread = await db.fetchone(
        """SELECT COUNT(*) AS c FROM messages m
            WHERE m.chat_id=? AND m.deleted_at IS NULL AND m.sender_id<>?
              AND m.created_at > COALESCE((SELECT last_read_at FROM chat_members
                                            WHERE chat_id=? AND user_id=?),0)""",
        (cid, user_id, cid, user_id))
    own = await db.fetchone("SELECT * FROM chat_members WHERE chat_id=? AND user_id=?", (cid, user_id))
    return {
        "id": cid,
        "type": chat["type"],
        "title": chat["title"],
        "avatar_id": chat["avatar_id"],
        "owner_id": chat["owner_id"],
        "ttl_seconds": int(chat["ttl_seconds"]),
        "created_at": int(chat["created_at"]),
        "updated_at": int(chat["updated_at"]),
        "meta": json.loads(chat["meta"]) if chat.get("meta") else {},
        "members": [{
            "id": int(m["id"]), "username": m["username"], "display_name": m["display_name"],
            "avatar_id": m["avatar_id"], "role": m["role"], "last_seen": int(m["last_seen"]),
            "online": m["id"] in hub._conns,  # noqa: SLF001
            "ik_dh_pub": m["ik_dh_pub"], "rsa_pub": m["rsa_pub"],
        } for m in members],
        "last_message": message_json(last) if last else None,
        "unread": int(unread["c"]) if unread else 0,
        "me": {
            "role": own["role"] if own else "member",
            "pinned": bool(own["pinned"]) if own else False,
            "archived": bool(own["archived"]) if own else False,
            "muted_until": int(own["muted_until"]) if own else 0,
            "last_read_at": int(own["last_read_at"]) if own else 0,
            "custom_ttl": int(own["custom_ttl"]) if own else 0,
            "draft": own["draft"] if own else "",
            "wallpaper": own["wallpaper"] if own else None,
        },
    }


async def fanout(chat_id: str, event: dict[str, Any], *, exclude_user: int | None = None) -> None:
    ids = await member_ids(chat_id)
    if exclude_user is not None:
        ids.append(exclude_user)
    await hub.send_to_users(set(ids), event)


async def touch_chat(chat_id: str) -> None:
    await db.execute("UPDATE chats SET updated_at=? WHERE id=?", (int(time.time()), chat_id))
