"""
Друзья и блокировки.

Правило мессенджера: **написать человеку можно только после того, как он принял
заявку в друзья**. Заявка отправляется по логину; принятие создаёт дружбу
взаимно (две записи в таблице contacts — по одной на каждую сторону), поэтому
«односторонних» друзей не бывает.

Дружба в базе — это пара строк contacts (owner→peer) без флага blocked.
Блокировка обрывает дружбу с обеих сторон и запрещает заявки, сообщения и
звонки между этими людьми.
"""
from __future__ import annotations

import secrets
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from .. import db
from ..models import FriendRequestCreate
from ..security import current_session

router = APIRouter(prefix="/api/v1", tags=["friends"])


# ── Общие проверки (используются и другими модулями) ───────────────────────
async def are_friends(a: int, b: int) -> bool:
    """Дружба взаимна: у обеих сторон есть запись, и никто никого не заблокировал."""
    if a == b:
        return True
    rows = await db.fetchall(
        "SELECT owner_id, blocked FROM contacts WHERE (owner_id=? AND peer_id=?) OR (owner_id=? AND peer_id=?)",
        (a, b, b, a))
    have = {int(r["owner_id"]): int(r["blocked"]) for r in rows}
    return len(have) == 2 and have.get(a, 1) == 0 and have.get(b, 1) == 0


async def blocked_between(a: int, b: int) -> bool:
    row = await db.fetchone(
        """SELECT 1 AS x FROM contacts
            WHERE blocked=1 AND ((owner_id=? AND peer_id=?) OR (owner_id=? AND peer_id=?))""",
        (a, b, b, a))
    return bool(row)


async def friend_ids(user_id: int) -> set[int]:
    """С кем этот пользователь в друзьях (взаимно, без блокировок)."""
    rows = await db.fetchall(
        """SELECT c1.peer_id AS pid FROM contacts c1
             JOIN contacts c2 ON c2.owner_id=c1.peer_id AND c2.peer_id=c1.owner_id
            WHERE c1.owner_id=? AND c1.blocked=0 AND c2.blocked=0""", (user_id,))
    return {int(r["pid"]) for r in rows}


async def _user_row(user_id: int) -> Any:
    row = await db.fetchone("SELECT * FROM users WHERE id=?", (user_id,))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            detail={"code": "NO_USER", "message": "Пользователь не найден"})
    return row


def _person(row: Any, online: set[int] | None = None) -> dict[str, Any]:
    uid = int(row["id"])
    return {
        "user_id": uid, "id": uid, "username": row["username"],
        "display_name": row["display_name"] or row["username"],
        "avatar_id": row["avatar_id"], "about": row["about"], "last_seen": int(row["last_seen"]),
        "online": (uid in online) if online is not None else False,
    }


def _request_json(row: Any, online: set[int] | None = None) -> dict[str, Any]:
    # id заявки — строка-токен («fr…»), поэтому приводим только числа.
    from_me = bool(row.get("from_me")) if isinstance(row, dict) else False
    peer_id = int(row["to_id"] if from_me else row["from_id"])
    return {
        "id": str(row["id"]), "from_id": int(row["from_id"]), "to_id": int(row["to_id"]),
        "message": row["message"] or "", "created_at": int(row["created_at"]),
        "username": row["username"], "display_name": row["display_name"] or row["username"],
        "avatar_id": row["avatar_id"], "from_me": from_me,
        "online": (peer_id in online) if online is not None else False,
    }


async def _notify(user_id: int, event: dict[str, Any]) -> None:
    from ..realtime import hub
    await hub.send_to_user(user_id, event)


async def _housekeeping(a: int, b: int, *, block: bool) -> None:
    """Убираем заявки в обе стороны и, при блокировке, чужую запись дружбы."""
    await db.execute(
        "DELETE FROM friend_requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)",
        (a, b, b, a))
    if block:
        await db.execute("DELETE FROM contacts WHERE owner_id=? AND peer_id=?", (b, a))


# ── Список: друзья, заявки, заблокированные ────────────────────────────────
@router.get("/friends")
async def my_friends(sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    from ..realtime import hub
    online = hub.online_users()

    friends = await db.fetchall(
        """SELECT u.* FROM contacts c1
             JOIN contacts c2 ON c2.owner_id=c1.peer_id AND c2.peer_id=c1.owner_id
             JOIN users u ON u.id=c1.peer_id
            WHERE c1.owner_id=? AND c1.blocked=0 AND c2.blocked=0
            ORDER BY u.display_name COLLATE NOCASE, u.username COLLATE NOCASE""", (uid,))
    incoming = await db.fetchall(
        """SELECT r.*, u.username, u.display_name, u.avatar_id
             FROM friend_requests r JOIN users u ON u.id=r.from_id
            WHERE r.to_id=? AND r.status='pending' ORDER BY r.created_at DESC""", (uid,))
    outgoing = await db.fetchall(
        """SELECT r.*, u.username, u.display_name, u.avatar_id
             FROM friend_requests r JOIN users u ON u.id=r.to_id
            WHERE r.from_id=? AND r.status='pending' ORDER BY r.created_at DESC""", (uid,))
    blocked = await db.fetchall(
        """SELECT u.* FROM contacts c JOIN users u ON u.id=c.peer_id
            WHERE c.owner_id=? AND c.blocked=1
            ORDER BY u.username COLLATE NOCASE""", (uid,))

    return {
        "friends": [_person(r, online) for r in friends],
        "incoming": [_request_json(dict(r, from_me=0), online) for r in incoming],
        "outgoing": [_request_json(dict(r, from_me=1), online) for r in outgoing],
        "blocked": [_person(r, online) for r in blocked],
    }


# ── Заявка в друзья ───────────────────────────────────────────────────────
@router.post("/friends/requests", status_code=201)
async def send_request(body: FriendRequestCreate, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    peer = await db.fetchone("SELECT * FROM users WHERE username=? AND is_banned=0", (body.username,))
    if not peer:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            detail={"code": "NO_USER", "message": "Пользователь не найден"})
    pid = int(peer["id"])
    if pid == uid:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            detail={"code": "SELF", "message": "Нельзя добавить себя"})
    if await blocked_between(uid, pid):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            detail={"code": "BLOCKED", "message": "Заявку отправить нельзя"})
    if await are_friends(uid, pid):
        return {"ok": True, "already_friends": True,
                "friend": _person(await _user_row(pid))}

    # Если этот человек уже отправил заявку нам — просто принимаем её
    reverse = await db.fetchone(
        "SELECT * FROM friend_requests WHERE from_id=? AND to_id=? AND status='pending'", (pid, uid))
    if reverse:
        return await _accept(int(reverse["id"]), uid, reverse)

    dup = await db.fetchone(
        "SELECT 1 AS x FROM friend_requests WHERE from_id=? AND to_id=? AND status='pending'", (uid, pid))
    if dup:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            detail={"code": "ALREADY_REQUESTED", "message": "Заявка уже отправлена"})

    rid = "fr" + secrets.token_hex(8)
    await db.execute(
        """INSERT INTO friend_requests(id,from_id,to_id,message,status,created_at)
           VALUES(?,?,?,?,?,?)""",
        (rid, uid, pid, (body.message or "")[:200], "pending", db.now()))

    row = await db.fetchone(
        """SELECT r.*, u.username, u.display_name, u.avatar_id FROM friend_requests r
             JOIN users u ON u.id=r.from_id WHERE r.id=?""", (rid,))
    requester = await _user_row(uid)
    await _notify(pid, {"t": "friend.request", "request": _request_json(dict(row))})
    await db.audit("friend_request", user_id=uid, detail={"to": pid})
    return {"ok": True, "request": _request_json(dict(row, from_me=1)),
            "me": _person(requester)}


async def _accept(rid: str, uid: int, row: Any = None) -> dict[str, Any]:
    """Принятие заявки: дружба создаётся взаимно у обеих сторон."""
    row = row or await db.fetchone("SELECT * FROM friend_requests WHERE id=?", (rid,))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            detail={"code": "NO_REQUEST", "message": "Заявка не найдена"})
    if int(row["to_id"]) != uid:
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            detail={"code": "NOT_YOURS", "message": "Это не ваша заявка"})
    a, b = int(row["from_id"]), int(row["to_id"])
    now = db.now()
    for owner, peer in ((a, b), (b, a)):
        await db.execute(
            """INSERT INTO contacts(owner_id,peer_id,alias,verified,blocked,created_at)
               VALUES(?,?,?,?,0,?)
               ON CONFLICT(owner_id,peer_id) DO UPDATE SET blocked=0""",
            (owner, peer, "", 0, now))
    await db.execute("DELETE FROM friend_requests WHERE id=?", (rid,))
    await db.execute(
        "DELETE FROM friend_requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)",
        (a, b, b, a))

    from ..realtime import hub
    online = hub.online_users()
    pa, pb = await _user_row(a), await _user_row(b)
    await _notify(a, {"t": "friend.accepted", "user": _person(pb, online)})
    await _notify(b, {"t": "friend.accepted", "user": _person(pa, online)})
    await db.audit("friend_accept", user_id=uid, detail={"with": a})
    other = pb if uid == a else pa
    return {"ok": True, "friend": _person(other, online), "me": _person(pa if uid == a else pb, online)}


@router.post("/friends/requests/{rid}/accept")
async def accept_request(rid: str, sess: dict = Depends(current_session)):
    return await _accept(rid, int(sess["user"]["id"]))


@router.post("/friends/requests/{rid}/decline")
async def decline_request(rid: str, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    row = await db.fetchone("SELECT * FROM friend_requests WHERE id=?", (rid,))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            detail={"code": "NO_REQUEST", "message": "Заявка не найдена"})
    if int(row["to_id"]) != uid:
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            detail={"code": "NOT_YOURS", "message": "Это не ваша заявка"})
    await db.execute("DELETE FROM friend_requests WHERE id=?", (rid,))
    await _notify(int(row["from_id"]), {"t": "friend.declined", "user_id": uid})
    return {"ok": True}


@router.delete("/friends/requests/{rid}")
async def cancel_request(rid: str, sess: dict = Depends(current_session)):
    """Отменить свою исходящую заявку."""
    uid = int(sess["user"]["id"])
    row = await db.fetchone("SELECT * FROM friend_requests WHERE id=?", (rid,))
    if not row or int(row["from_id"]) != uid:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            detail={"code": "NO_REQUEST", "message": "Заявка не найдена"})
    await db.execute("DELETE FROM friend_requests WHERE id=?", (rid,))
    await _notify(int(row["to_id"]), {"t": "friend.request.cancelled", "user_id": uid})
    return {"ok": True}


# ── Управление дружбой ────────────────────────────────────────────────────
@router.delete("/friends/{user_id}")
async def remove_friend(user_id: int, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    await _housekeeping(uid, user_id, block=False)
    await db.execute("DELETE FROM contacts WHERE owner_id=? AND peer_id=?", (uid, user_id))
    await db.execute("DELETE FROM contacts WHERE owner_id=? AND peer_id=?", (user_id, uid))
    await _notify(user_id, {"t": "friend.removed", "user_id": uid})
    return {"ok": True}


@router.post("/friends/{user_id}/block")
async def block_user(user_id: int, sess: dict = Depends(current_session)):
    """Заблокировать: дружба обрывается, заявки и будущие сообщения запрещены."""
    uid = int(sess["user"]["id"])
    if user_id == uid:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            detail={"code": "SELF_ACTION", "message": "Нельзя заблокировать себя"})
    peer = await _user_row(user_id)
    await _housekeeping(uid, user_id, block=True)
    await db.execute(
        """INSERT INTO contacts(owner_id,peer_id,alias,verified,blocked,created_at)
           VALUES(?,?,?,?,1,?)
           ON CONFLICT(owner_id,peer_id) DO UPDATE SET blocked=1""",
        (uid, user_id, "", 0, db.now()))
    await _notify(user_id, {"t": "friend.removed", "user_id": uid})
    await db.audit("user_block", user_id=uid, detail={"blocked": user_id})
    return {"ok": True, "blocked": _person(peer)}


@router.post("/friends/{user_id}/unblock")
async def unblock_user(user_id: int, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    await db.execute("DELETE FROM contacts WHERE owner_id=? AND peer_id=? AND blocked=1", (uid, user_id))
    await db.audit("user_unblock", user_id=uid, detail={"unblocked": user_id})
    return {"ok": True}
