"""
Realtime-слой: WebSocket-хаб, presence, typing, квитанции, сигнализация звонков.
Один пользователь может держать несколько соединений (несколько устройств).
"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from . import db
from .security import client_ip, jwt_decode

router = APIRouter()


class Hub:
    def __init__(self) -> None:
        self._conns: dict[int, set[WebSocket]] = {}
        self._meta: dict[WebSocket, dict[str, Any]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, user_id: int, device_id: str, ws: WebSocket) -> None:
        async with self._lock:
            self._conns.setdefault(user_id, set()).add(ws)
            self._meta[ws] = {"user_id": user_id, "device_id": device_id, "at": time.time()}

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            meta = self._meta.pop(ws, None)
            if meta:
                s = self._conns.get(meta["user_id"])
                if s:
                    s.discard(ws)
                    if not s:
                        self._conns.pop(meta["user_id"], None)
            return

    def online_users(self) -> set[int]:
        return set(self._conns.keys())

    def devices(self, user_id: int) -> list[str]:
        return [m["device_id"] for ws, m in self._meta.items() if m["user_id"] == user_id]

    async def send_to_user(self, user_id: int, event: dict[str, Any],
                           exclude: WebSocket | None = None) -> None:
        for ws in list(self._conns.get(user_id, ())):
            if ws is exclude:
                continue
            try:
                await ws.send_text(json.dumps(event, ensure_ascii=False))
            except Exception:
                await self.disconnect(ws)

    async def send_to_users(self, user_ids: list[int] | set[int], event: dict[str, Any]) -> None:
        for uid in list(user_ids):
            await self.send_to_user(uid, event)

    async def broadcast_chat(self, chat_id: str, event: dict[str, Any],
                             exclude_user: int | None = None) -> list[int]:
        members = await db.fetchall("SELECT user_id FROM chat_members WHERE chat_id=?", (chat_id,))
        ids = [int(m["user_id"]) for m in members if int(m["user_id"]) != exclude_user]
        # копию получает и отправитель (на его другие устройства — синхронизация)
        if exclude_user is not None:
            ids.append(exclude_user)
        await self.send_to_users(set(ids), event)
        return ids


hub = Hub()


async def _authorize(token: str) -> dict[str, Any] | None:
    try:
        claims = jwt_decode(token)
    except Exception:
        return None
    if claims.get("s") == "refresh":
        return None
    uid = int(claims["sub"])
    dev = str(claims.get("d") or "")
    user = await db.fetchone("SELECT * FROM users WHERE id=? AND is_banned=0", (uid,))
    if not user:
        return None
    if dev:
        d = await db.fetchone(
            "SELECT id FROM devices WHERE id=? AND user_id=? AND revoked_at IS NULL", (dev, uid))
        if not d:
            return None
    return {"user": dict(user), "device_id": dev}


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str = Query(default="")) -> None:
    auth = await _authorize(token)
    if not auth:
        await ws.close(code=4401)
        return

    user = auth["user"]
    uid = int(user["id"])
    device_id = auth["device_id"]

    await ws.accept()
    await hub.connect(uid, device_id, ws)

    # Отдаём присутствие контактам + приветствие
    await ws.send_text(json.dumps({
        "t": "hello",
        "user_id": uid,
        "device_id": device_id,
        "server_time": int(time.time()),
        "online": sorted(hub.online_users()),
    }, ensure_ascii=False))

    await db.execute("UPDATE devices SET last_seen=?, ip_last=? WHERE id=?",
                     (int(time.time()), client_ip(ws), device_id))  # type: ignore[arg-type]
    await _announce_presence(uid, True)

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            await _handle(ws, uid, device_id, msg)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await hub.disconnect(ws)
        if not hub.devices(uid):
            await _announce_presence(uid, False)


async def _announce_presence(user_id: int, online: bool) -> None:
    """Сообщаем о смене статуса только тем, у кого есть общий чат."""
    peers = await db.fetchall(
        """SELECT DISTINCT cm2.user_id AS uid
             FROM chat_members cm1
             JOIN chat_members cm2 ON cm1.chat_id = cm2.chat_id
            WHERE cm1.user_id=? AND cm2.user_id<>?""", (user_id, user_id))
    await hub.send_to_users({int(p["uid"]) for p in peers}, {
        "t": "presence", "user_id": user_id, "online": online, "at": int(time.time()),
    })


async def _handle(ws: WebSocket, uid: int, device_id: str, msg: dict[str, Any]) -> None:
    t = msg.get("t")

    if t == "ping":
        await ws.send_text(json.dumps({"t": "pong", "at": int(time.time())}))
        return

    if t == "typing":
        chat_id = str(msg.get("chat_id") or "")
        if not chat_id or not await _is_member(chat_id, uid) or not await _chat_allows(chat_id, uid):
            return
        await _relay_chat(chat_id, {
            "t": "typing", "chat_id": chat_id, "user_id": uid,
            "state": bool(msg.get("state", True)), "at": int(time.time()),
        }, exclude=ws)
        return

    if t == "read":
        chat_id = str(msg.get("chat_id") or "")
        if not chat_id or not await _is_member(chat_id, uid):
            return
        up_to = int(msg.get("up_to") or 0)
        await db.execute(
            "UPDATE chat_members SET last_read_at=? WHERE chat_id=? AND user_id=?",
            (max(up_to, int(time.time())), chat_id, uid))
        await _relay_chat(chat_id, {
            "t": "read", "chat_id": chat_id, "user_id": uid, "up_to": up_to,
        }, exclude=ws)
        return

    if t == "call.signal":
        to = int(msg.get("to") or 0)
        if to <= 0 or to == uid:
            return
        from .routes.friends import blocked_between
        if await blocked_between(uid, to):
            return
        await hub.send_to_user(to, {
            "t": "call.signal", "from": uid, "call_id": msg.get("call_id"),
            "kind": msg.get("kind", "audio"), "signal": msg.get("signal"),
            "sdp": msg.get("sdp"), "ice": msg.get("ice"),
        })
        return

    if t == "call.invite":
        # Групповой звонок: приглашаем участников чата
        chat_id = str(msg.get("chat_id") or "")
        if not chat_id or not await _is_member(chat_id, uid):
            return
        members = await db.fetchall("SELECT user_id FROM chat_members WHERE chat_id=?", (chat_id,))
        from .routes.friends import blocked_between
        for m in members:
            if int(m["user_id"]) == uid or await blocked_between(uid, int(m["user_id"])):
                continue
            await hub.send_to_user(int(m["user_id"]), {
                "t": "call.invite", "chat_id": chat_id, "from": uid,
                "call_id": msg.get("call_id"), "kind": msg.get("kind", "audio"),
            })
        return

    if t == "sync":
        await ws.send_text(json.dumps({
            "t": "sync", "online": sorted(hub.online_users()), "at": int(time.time())}))
        return


async def _chat_allows(chat_id: str, user_id: int) -> bool:
    """Разрешена ли переписка в этом чате (в личке — только с друзьями)."""
    chat = await db.fetchone("SELECT type FROM chats WHERE id=?", (chat_id,))
    if not chat or chat["type"] != "direct":
        return True
    members = await db.fetchall("SELECT user_id FROM chat_members WHERE chat_id=?", (chat_id,))
    other = next((int(m["user_id"]) for m in members if int(m["user_id"]) != user_id), None)
    if other is None:
        return True
    from .routes.friends import are_friends, blocked_between
    if await blocked_between(user_id, other):
        return False
    limit = await db.fetchone("SELECT value FROM settings WHERE key='friends_only'")
    strict = (limit is None) or (str(limit["value"]) not in ("0", "false", "off"))
    return (not strict) or await are_friends(user_id, other)


async def _is_member(chat_id: str, user_id: int) -> bool:
    row = await db.fetchone(
        "SELECT 1 AS x FROM chat_members WHERE chat_id=? AND user_id=?", (chat_id, user_id))
    return row is not None


async def _relay_chat(chat_id: str, event: dict[str, Any], exclude: WebSocket) -> None:
    members = await db.fetchall("SELECT user_id FROM chat_members WHERE chat_id=?", (chat_id,))
    for m in members:
        for conn in list(hub._conns.get(int(m["user_id"]), ())):  # noqa: SLF001
            if conn is exclude:
                continue
            try:
                await conn.send_text(json.dumps(event, ensure_ascii=False))
            except Exception:
                await hub.disconnect(conn)
