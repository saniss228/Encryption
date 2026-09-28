"""
Сообщения. Сервер работает как «слепой ретранслятор»:
принимает конверт двойного шифрования, хранит его как есть, раздаёт участникам.
Ни расшифровки, ни анализа содержимого на сервере нет.
"""
from __future__ import annotations

import json
import secrets
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import ValidationError

from .. import db
from ..config import MAX_MESSAGE_BYTES
from ..models import MessageCreateRequest, MessageUpdateRequest, ReactionRequest, ReceiptRequest
from ..security import current_session
from ._common import (chat_or_404, fanout, load_reactions, load_receipts, member, member_ids,
                      message_json, touch_chat)

router = APIRouter(prefix="/api/v1/messages", tags=["messages"])

EDIT_WINDOW = 48 * 3600


def _validate_payload(payload: dict[str, Any]) -> None:
    raw = json.dumps(payload, separators=(",", ":"))
    if len(raw.encode()) > MAX_MESSAGE_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            detail={"code": "PAYLOAD_TOO_LARGE",
                                    "message": f"Сообщение больше {MAX_MESSAGE_BYTES // 1024} КБ"})
    if not isinstance(payload.get("l1"), dict) or "ct" not in payload["l1"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            detail={"code": "BAD_ENVELOPE",
                                    "message": "Конверт должен содержать слой 1 (AES-256-GCM)"})
    if "wrap" not in payload or not isinstance(payload["wrap"], dict) or not payload["wrap"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            detail={"code": "BAD_ENVELOPE",
                                    "message": "Конверт должен содержать слой 2 (RSA-OAEP-обёртки ключа)"})
    wrap = payload["wrap"]
    if not any(isinstance(v, dict) and "rsa" in v and "dh" in v for v in wrap.values()):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            detail={"code": "BAD_ENVELOPE",
                                    "message": "Каждая запись wrap должна содержать два слоя ключа: "
                                               "rsa (RSA-4096-OAEP) и dh (ECDH+AES-GCM)"})
    if "sig" not in payload or "signer" not in payload:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            detail={"code": "BAD_ENVELOPE",
                                    "message": "Конверт должен быть подписан (ECDSA P-256)"})


async def _expiry_for(chat: dict, req: MessageCreateRequest, uid: int) -> tuple[int | None, int]:
    ttl = req.ttl_seconds
    if ttl is None:
        own = await db.fetchone("SELECT custom_ttl FROM chat_members WHERE chat_id=? AND user_id=?",
                                (req.chat_id, uid))
        ttl = int(own["custom_ttl"]) if own and int(own["custom_ttl"]) else int(chat["ttl_seconds"])
    expires = db.now() + ttl if ttl and ttl > 0 else None
    return expires, int(ttl or 0)


@router.post("", status_code=201)
async def send_message(body: MessageCreateRequest, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    m = await member(body.chat_id, uid)
    chat = await chat_or_404(body.chat_id)
    _validate_payload(body.payload)

    if body.reply_to:
        parent = await db.fetchone("SELECT id FROM messages WHERE id=? AND chat_id=?",
                                   (body.reply_to, body.chat_id))
        if not parent:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Сообщение для ответа не найдено")

    expires, ttl = await _expiry_for(chat, body, uid)
    mid = body.client_msg_id or ("m" + secrets.token_hex(12))
    if body.client_msg_id:
        dup = await db.fetchone("SELECT * FROM messages WHERE id=?", (mid,))
        if dup:  # идемпотентность при ретраях
            rx = await load_reactions([mid])
            rc = await load_receipts([mid])
            return message_json(dup, reactions=rx.get(mid, []), receipts=rc.get(mid, []))

    await db.execute(
        """INSERT INTO messages(id,chat_id,sender_id,sender_device,payload,type,reply_to,thread_root,
                                forward_from,created_at,expires_at,burn_after_read,attachment_id,attachment_meta)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (mid, body.chat_id, uid, sess["device_id"], json.dumps(body.payload, separators=(",", ":")),
         body.type, body.reply_to, body.thread_root, body.forward_from, db.now(), expires,
         1 if body.burn_after_read else 0, body.attachment_id,
         json.dumps(body.attachment_meta) if body.attachment_meta else None))
    await touch_chat(body.chat_id)

    row = await db.fetchone("SELECT * FROM messages WHERE id=?", (mid,))
    event = {"t": "message", "message": message_json(row)}

    # Квитанция «доставлено» для тех, кто онлайн
    from ..realtime import hub
    ids = await member_ids(body.chat_id)
    online = [i for i in ids if i != uid and hub.devices(i)]
    for oid in online:
        await db.execute(
            "INSERT OR IGNORE INTO receipts(message_id,user_id,state,at) VALUES(?,?,?,?)",
            (mid, oid, "delivered", db.now()))
    row2 = await db.fetchone("SELECT * FROM messages WHERE id=?", (mid,))
    rc = await load_receipts([mid])
    await fanout(body.chat_id, {"t": "message", "message": message_json(row2, receipts=rc.get(mid, []))},
                 exclude_user=uid)
    await fanout(body.chat_id, {"t": "message.new", "chat_id": body.chat_id, "message_id": mid,
                                "sender_id": uid}, exclude_user=uid)
    return message_json(row2, receipts=rc.get(mid, []))


@router.get("")
async def list_messages(chat_id: str, limit: int = Query(default=50, ge=1, le=200),
                        before: int | None = None, after: int | None = None,
                        thread_root: str | None = None, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    await member(chat_id, uid)
    sql = "SELECT * FROM messages WHERE chat_id=? AND deleted_at IS NULL"
    params: list[Any] = [chat_id]
    if before:
        sql += " AND created_at < ?"
        params.append(before)
    if after:
        sql += " AND created_at > ?"
        params.append(after)
    if thread_root:
        sql += " AND thread_root=?"
        params.append(thread_root)
    sql += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    rows = await db.fetchall(sql, params)
    rows = list(reversed(rows))
    ids = [r["id"] for r in rows]
    rx = await load_reactions(ids)
    rc = await load_receipts(ids)
    return {"messages": [message_json(r, reactions=rx.get(r["id"], []), receipts=rc.get(r["id"], []))
                         for r in rows],
            "has_more": len(rows) == limit}


@router.get("/{message_id}")
async def get_message(message_id: str, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    row = await db.fetchone("SELECT * FROM messages WHERE id=?", (message_id,))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Сообщение не найдено")
    await member(row["chat_id"], uid)
    rx = await load_reactions([message_id])
    rc = await load_receipts([message_id])
    return message_json(row, reactions=rx.get(message_id, []), receipts=rc.get(message_id, []))


@router.patch("/{message_id}")
async def edit_message(message_id: str, body: MessageUpdateRequest, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    row = await db.fetchone("SELECT * FROM messages WHERE id=?", (message_id,))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Сообщение не найдено")
    await member(row["chat_id"], uid)
    if int(row["sender_id"]) != uid:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Редактировать можно только свои сообщения")
    if db.now() - int(row["created_at"]) > EDIT_WINDOW:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Окно редактирования (48 ч) истекло")
    _validate_payload(body.payload)
    await db.execute("UPDATE messages SET payload=?,edited_at=? WHERE id=?",
                     (json.dumps(body.payload, separators=(",", ":")), db.now(), message_id))
    await fanout(row["chat_id"], {"t": "message.edited", "chat_id": row["chat_id"],
                                  "message_id": message_id, "payload": body.payload,
                                  "edited_at": db.now()})
    return {"ok": True}


@router.delete("/{message_id}")
async def delete_message(message_id: str, for_everyone: bool = True,
                         sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    row = await db.fetchone("SELECT * FROM messages WHERE id=?", (message_id,))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Сообщение не найдено")
    await member(row["chat_id"], uid)
    if int(row["sender_id"]) != uid and not for_everyone:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Нет прав")
    if int(row["sender_id"]) != uid:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Удалить можно только свои сообщения")
    await db.execute("UPDATE messages SET deleted_at=?,payload='{}' WHERE id=?", (db.now(), message_id))
    await fanout(row["chat_id"], {"t": "message.deleted", "chat_id": row["chat_id"],
                                  "message_id": message_id})
    return {"ok": True}


@router.post("/{message_id}/reaction")
async def react(message_id: str, body: ReactionRequest, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    row = await db.fetchone("SELECT * FROM messages WHERE id=?", (message_id,))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Сообщение не найдено")
    await member(row["chat_id"], uid)
    exists = await db.fetchone(
        "SELECT 1 AS x FROM reactions WHERE message_id=? AND user_id=? AND emoji=?",
        (message_id, uid, body.emoji))
    if exists:
        await db.execute("DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?",
                         (message_id, uid, body.emoji))
        action = "removed"
    else:
        await db.execute("INSERT INTO reactions(message_id,user_id,emoji,created_at) VALUES(?,?,?,?)",
                         (message_id, uid, body.emoji, db.now()))
        action = "added"
    await fanout(row["chat_id"], {"t": "message.reaction", "chat_id": row["chat_id"],
                                  "message_id": message_id, "user_id": uid,
                                  "emoji": body.emoji, "action": action})
    return {"ok": True, "action": action}


@router.post("/{message_id}/receipt")
async def receipt(message_id: str, body: ReceiptRequest, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    row = await db.fetchone("SELECT * FROM messages WHERE id=?", (message_id,))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Сообщение не найдено")
    await member(row["chat_id"], uid)
    await db.execute("INSERT OR REPLACE INTO receipts(message_id,user_id,state,at) VALUES(?,?,?,?)",
                     (message_id, uid, body.state, db.now()))
    if body.state == "read" and int(row["burn_after_read"]):
        # самоуничтожение: живёт ещё 5 секунд после прочтения
        await db.execute("UPDATE messages SET expires_at=? WHERE id=?",
                         (db.now() + 5, message_id))
    await fanout(row["chat_id"], {"t": "message.receipt", "chat_id": row["chat_id"],
                                  "message_id": message_id, "user_id": uid, "state": body.state})
    return {"ok": True}


@router.post("/{message_id}/pin")
async def pin_message(message_id: str, pinned: bool = True, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    row = await db.fetchone("SELECT * FROM messages WHERE id=?", (message_id,))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Сообщение не найдено")
    me = await member(row["chat_id"], uid)
    chat = await chat_or_404(row["chat_id"])
    if chat["type"] == "group" and me["role"] not in ("owner", "admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Закреплять может владелец или админ")
    await db.execute("UPDATE messages SET pinned=? WHERE id=?", (1 if pinned else 0, message_id))
    await fanout(row["chat_id"], {"t": "message.pinned", "chat_id": row["chat_id"],
                                  "message_id": message_id, "pinned": pinned})
    return {"ok": True}


@router.post("/read-all")
async def read_all(chat_id: str, up_to: int | None = None, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    await member(chat_id, uid)
    ts = up_to or db.now()
    await db.execute("UPDATE chat_members SET last_read_at=? WHERE chat_id=? AND user_id=?",
                     (max(ts, db.now()), chat_id, uid))
    await fanout(chat_id, {"t": "read", "chat_id": chat_id, "user_id": uid, "up_to": ts})
    return {"ok": True}


@router.get("/{message_id}/context")
async def context(message_id: str, radius: int = Query(default=10, ge=1, le=50),
                  sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    row = await db.fetchone("SELECT * FROM messages WHERE id=?", (message_id,))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Сообщение не найдено")
    await member(row["chat_id"], uid)
    before = await db.fetchall(
        """SELECT * FROM messages WHERE chat_id=? AND created_at<=? AND deleted_at IS NULL
            ORDER BY created_at DESC LIMIT ?""",
        (row["chat_id"], row["created_at"], radius))
    after = await db.fetchall(
        """SELECT * FROM messages WHERE chat_id=? AND created_at>? AND deleted_at IS NULL
            ORDER BY created_at ASC LIMIT ?""",
        (row["chat_id"], row["created_at"], radius))
    rows = list(reversed(before)) + list(after)
    ids = [r["id"] for r in rows]
    rx = await load_reactions(ids)
    return {"messages": [message_json(r, reactions=rx.get(r["id"], [])) for r in rows]}


@router.get("/search/global")
async def search_global(q: str = Query(min_length=1, max_length=128), limit: int = 30,
                        sess: dict = Depends(current_session)):
    """
    Поиск по МЕТАДАННЫМ (id, тип, имя вложения, даты). Текст шифрован,
    поэтому полнотекстовый поиск выполняется локально на устройстве.
    """
    uid = int(sess["user"]["id"])
    rows = await db.fetchall(
        f"""SELECT m.* FROM messages m JOIN chat_members cm ON cm.chat_id=m.chat_id
             WHERE cm.user_id=? AND m.deleted_at IS NULL AND (m.type LIKE ? OR m.attachment_meta LIKE ?)
             ORDER BY m.created_at DESC LIMIT ?""",
        (uid, f"%{q}%", f"%{q}%", min(limit, 100)))
    return {"results": [dict(r) for r in rows],
            "note": "Локальный полнотекстовый поиск: клиент индексирует расшифрованные сообщения в защищённом хранилище устройства"}
