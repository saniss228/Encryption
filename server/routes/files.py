"""
Файлы: шифруются на устройстве ДО загрузки, живут РОВНО 24 часа, затем
безвозвратно удаляются (и запись в БД, и блоки на диске).
Загрузка/скачивание — по чанкам, чтобы поддержать большие файлы и докачку.
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import shutil
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse

from .. import db
from ..config import (FILE_BURN_AFTER_DOWNLOAD, FILE_BURN_GRACE_SECONDS, FILE_MAX_BYTES,
                      FILE_TTL_HOURS, FILES_DIR)
from ..models import FileInitRequest
from ..security import current_session
from ._common import member

router = APIRouter(prefix="/api/v1/files", tags=["files"])


def _file_dir(file_id: str) -> Path:
    return FILES_DIR / file_id


def _chunk_path(file_id: str, index: int) -> Path:
    return _file_dir(file_id) / f"{index:06d}.part"


class _BackgroundHook:
    """Выполняет корутину после завершения StreamingResponse."""

    def __init__(self, coro_fn) -> None:
        self._coro_fn = coro_fn

    async def __call__(self) -> None:
        try:
            await self._coro_fn()
        except Exception:
            pass


async def _get_file(file_id: str, user_id: int, *, need_member: bool = True):
    row = await db.fetchone("SELECT * FROM files WHERE id=?", (file_id,))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            detail={"code": "FILE_GONE",
                                    "message": "Файл не найден или удалён (срок хранения — 24 часа)"})
    if int(row["local_only"]):
        raise HTTPException(status.HTTP_410_GONE,
                            detail={"code": "LOCAL_ONLY",
                                    "message": "Файл уже скачан: копии на сервере нет, "
                                               "файл остался только на устройстве получателя"})
    if int(row["expires_at"]) < db.now():
        await _purge_file(file_id)
        raise HTTPException(status.HTTP_410_GONE,
                            detail={"code": "FILE_EXPIRED",
                                    "message": "Срок хранения файла (24 часа) истёк"})
    if int(row["owner_id"]) != user_id and need_member:
        if row["chat_id"]:
            await member(row["chat_id"], user_id)
        else:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Нет доступа к файлу")
    return row


async def _purge_file(file_id: str) -> None:
    d = _file_dir(file_id)
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)
    await db.execute("DELETE FROM files WHERE id=?", (file_id,))


# ── «Только локально»: скачал получатель → файл удаляется с сервера ────────
def _load_served(row: Any) -> dict[str, list[int]]:
    try:
        return json.loads(row["served"] or "{}")
    except Exception:
        return {}


async def _mark_served(file_id: str, user_id: int, index: int) -> dict[str, list[int]]:
    row = await db.fetchone("SELECT served, chunks FROM files WHERE id=?", (file_id,))
    if not row:
        return {}
    served = _load_served(row)
    lst = set(served.get(str(user_id), []))
    lst.add(index)
    served[str(user_id)] = sorted(lst)
    await db.execute("UPDATE files SET served=? WHERE id=?", (json.dumps(served), file_id))
    return served


def _recipient_has_all(row: Any, served: dict[str, list[int]], user_id: int) -> bool:
    """Получатель (не владелец) забрал все чанки файла."""
    if int(row["owner_id"]) == user_id:
        return False
    return len(served.get(str(user_id), [])) >= int(row["chunks"])


async def _notify_file_consumed(file_row: Any, by_user_id: int, reason: str) -> None:
    """Сообщаем участникам чата, что копии на сервере больше нет."""
    from ..realtime import hub
    event = {
        "t": "file.consumed", "file_id": file_row["id"], "chat_id": file_row["chat_id"],
        "by_user_id": by_user_id, "reason": reason, "at": db.now(),
        "local_only": True,
    }
    if file_row["chat_id"]:
        members = await db.fetchall("SELECT user_id FROM chat_members WHERE chat_id=?",
                                    (file_row["chat_id"],))
        await hub.send_to_users({int(m["user_id"]) for m in members}, event)
    else:
        await hub.send_to_user(int(file_row["owner_id"]), event)
        await hub.send_to_user(by_user_id, event)


async def _consume_file(file_id: str, by_user_id: int, reason: str = "downloaded") -> bool:
    """
    Удаляет файл с сервера безвозвратно: остаётся только локальная копия у получателя.
    Вызывается (1) подтверждением клиента после успешной расшифровки,
    (2) автоматически, когда получатель забрал все чанки.
    """
    row = await db.fetchone("SELECT * FROM files WHERE id=?", (file_id,))
    if not row or row["consumed_at"]:
        return False
    await db.execute(
        "UPDATE files SET consumed_at=?, consumed_by=?, local_only=1 WHERE id=? AND consumed_at IS NULL",
        (db.now(), by_user_id, file_id))
    if row["chat_id"]:
        await db.execute(
            """UPDATE messages SET local_only=1
                WHERE attachment_id=? AND deleted_at IS NULL""", (file_id,))
    # Удаляем сами данные с диска, но запись сохраняем как отметку «был скачан»
    shutil.rmtree(_file_dir(file_id), ignore_errors=True)
    await db.execute("UPDATE files SET size=0, key_wrap='', name_enc='' WHERE id=?", (file_id,))
    await db.audit("file_consumed", user_id=by_user_id,
                   detail={"file_id": file_id, "reason": reason, "chat_id": row["chat_id"]})
    await _notify_file_consumed(row, by_user_id, reason)
    return True


async def _consume_later(file_id: str, by_user_id: int, delay: int) -> None:
    """Отложенное удаление: даём клиенту время докачать/перечитать файл."""
    await asyncio.sleep(max(1, delay))
    try:
        await _consume_file(file_id, by_user_id, reason="served_all_chunks")
    except Exception:
        pass


@router.post("/init", status_code=201)
async def init_upload(body: FileInitRequest, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    if body.size > FILE_MAX_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            detail={"code": "TOO_LARGE",
                                    "message": f"Максимум {FILE_MAX_BYTES // (1024*1024)} МБ на файл"})
    if body.chat_id:
        await member(body.chat_id, uid)
    fid = "f" + secrets.token_hex(12)
    _file_dir(fid).mkdir(parents=True, exist_ok=True)
    chunks = (body.size + body.chunk_size - 1) // body.chunk_size if body.size else 0
    expires = db.now() + FILE_TTL_HOURS * 3600
    await db.execute(
        """INSERT INTO files(id,owner_id,chat_id,size,kind,mime,name_enc,key_wrap,sha256,chunk_size,
                             chunks,created_at,expires_at,downloads,max_downloads)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (fid, uid, body.chat_id, body.size, body.kind, body.mime, body.name_enc, body.key_wrap,
         body.sha256, body.chunk_size, chunks, db.now(), expires, 0, 0))
    return {"file_id": fid, "chunk_size": body.chunk_size, "chunks": chunks,
            "expires_at": expires, "ttl_hours": FILE_TTL_HOURS}


@router.put("/{file_id}/chunk")
async def upload_chunk(file_id: str, index: int = Query(ge=0), request: Request = None,
                       sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    row = await _get_file(file_id, uid, need_member=False)
    if int(row["owner_id"]) != uid:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Только владелец может загружать чанки")
    if index >= int(row["chunks"]):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Индекс чанка вне диапазона")
    data = await request.body()
    if len(data) > int(row["chunk_size"]) + 1024:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Чанк больше заявленного размера")
    p = _chunk_path(file_id, index)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return {"ok": True, "index": index, "size": len(data)}


@router.post("/{file_id}/complete")
async def complete_upload(file_id: str, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    row = await _get_file(file_id, uid, need_member=False)
    if int(row["owner_id"]) != uid:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Нет прав")
    missing = [i for i in range(int(row["chunks"])) if not _chunk_path(file_id, i).exists()]
    if missing:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            detail={"code": "CHUNKS_MISSING", "missing": missing[:50]})
    return {"ok": True, "file_id": file_id, "expires_at": int(row["expires_at"])}


@router.get("/{file_id}/meta")
async def file_meta(file_id: str, sess: dict = Depends(current_session)):
    """
    Метаданные файла. Если копия уже удалена после скачивания получателем,
    возвращаем описание «надгробия» (200), а не ошибку: клиенту нужно показать
    карточку «только локально», а не пустой экран.
    """
    uid = int(sess["user"]["id"])
    raw = await db.fetchone("SELECT * FROM files WHERE id=?", (file_id,))
    if not raw:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            detail={"code": "FILE_GONE", "message": "Файл не найден или удалён"})
    if int(raw["owner_id"]) != uid and raw["chat_id"]:
        await member(raw["chat_id"], uid)
    if int(raw["local_only"]):
        return {
            "file_id": raw["id"], "size": 0, "kind": raw["kind"], "mime": raw["mime"],
            "name_enc": "", "key_wrap": "", "sha256": "", "chunk_size": int(raw["chunk_size"]),
            "chunks": int(raw["chunks"]), "uploaded_chunks": [],
            "created_at": int(raw["created_at"]), "expires_at": int(raw["expires_at"]),
            "ttl_left": 0,
            "local_only": True, "on_server": False,
            "consumed_at": raw["consumed_at"], "consumed_by": raw["consumed_by"],
            "burn_after_download": FILE_BURN_AFTER_DOWNLOAD,
            "server_can_read": False,
            "note": "Файл скачан получателем и удалён с сервера: копия осталась только на устройстве",
        }
    row = await _get_file(file_id, uid)
    done = [i for i in range(int(row["chunks"])) if _chunk_path(file_id, i).exists()]
    return {
        "file_id": row["id"], "size": int(row["size"]), "kind": row["kind"], "mime": row["mime"],
        "name_enc": row["name_enc"], "key_wrap": row["key_wrap"], "sha256": row["sha256"],
        "chunk_size": int(row["chunk_size"]), "chunks": int(row["chunks"]),
        "uploaded_chunks": done, "created_at": int(row["created_at"]),
        "expires_at": int(row["expires_at"]), "ttl_left": max(0, int(row["expires_at"]) - db.now()),
        "local_only": bool(row["local_only"]), "consumed_at": row["consumed_at"],
        "burn_after_download": FILE_BURN_AFTER_DOWNLOAD,
        "server_can_read": False,
        "note": "Содержимое зашифровано на устройстве (AES-256-GCM); сервер хранит только шифротекст и удалит его через 24 часа",
    }


@router.get("/{file_id}/chunk")
async def download_chunk(file_id: str, index: int = Query(ge=0), token: str = Query(default=""),
                         sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    row = await _get_file(file_id, uid)
    if index >= int(row["chunks"]):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Индекс чанка вне диапазона")
    p = _chunk_path(file_id, index)
    if not p.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Чанк отсутствует")
    await db.execute("UPDATE files SET downloads=downloads+1 WHERE id=?", (file_id,))
    served = await _mark_served(file_id, uid, index)
    # Получатель забрал последний чанк → через небольшую паузу удаляем копию с сервера
    if FILE_BURN_AFTER_DOWNLOAD and _recipient_has_all(row, served, uid):
        asyncio.create_task(_consume_later(file_id, uid, FILE_BURN_GRACE_SECONDS))
    return FileResponse(p, media_type="application/octet-stream",
                        headers={"Content-Encrypted": "aes-256-gcm", "X-File-Id": file_id,
                                 "X-File-Local-Only": "1" if row["local_only"] else "0"})


@router.get("/{file_id}/raw")
async def download_raw(file_id: str, sess: dict = Depends(current_session)):
    """Скачивание одним потоком (для небольших файлов)."""
    uid = int(sess["user"]["id"])
    row = await _get_file(file_id, uid)
    d = _file_dir(file_id)
    if not d.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Файл отсутствует")

    def _iter():
        for i in range(int(row["chunks"])):
            p = _chunk_path(file_id, i)
            if p.exists():
                with open(p, "rb") as fh:
                    while True:
                        blk = fh.read(256 * 1024)
                        if not blk:
                            break
                        yield blk

    from fastapi.responses import StreamingResponse

    async def _track() -> None:
        for i in range(int(row["chunks"])):
            await _mark_served(file_id, uid, i)
        fresh = await db.fetchone("SELECT * FROM files WHERE id=?", (file_id,))
        if fresh and FILE_BURN_AFTER_DOWNLOAD:
            served = _load_served(fresh)
            if _recipient_has_all(fresh, served, uid):
                await _consume_file(file_id, uid, reason="raw_download")

    await db.execute("UPDATE files SET downloads=downloads+1 WHERE id=?", (file_id,))
    return StreamingResponse(_iter(), media_type="application/octet-stream",
                             background=_BackgroundHook(_track),
                             headers={"Content-Encrypted": "aes-256-gcm",
                                      "X-Expires-At": str(int(row["expires_at"]))})


@router.post("/{file_id}/consumed")
async def confirm_consumed(file_id: str, sess: dict = Depends(current_session)):
    """
    Клиент подтверждает: «файл скачан и расшифрован на устройстве».
    Сервер немедленно удаляет свою копию — файл становится «только локальным».
    """
    uid = int(sess["user"]["id"])
    row = await db.fetchone("SELECT * FROM files WHERE id=?", (file_id,))
    if not row:
        return {"ok": True, "already_local_only": True}
    if int(row["owner_id"]) != uid and row["chat_id"]:
        await member(row["chat_id"], uid)
    already = bool(row["consumed_at"])
    if not already:
        await _consume_file(file_id, uid, reason="client_confirmed")
    return {
        "ok": True,
        "local_only": True,
        "deleted_from_server": not already,
        "message": "Файл удалён с сервера: копия осталась только на вашем устройстве",
    }


@router.get("/{file_id}/local-only")
async def local_only_status(file_id: str, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    row = await db.fetchone("SELECT * FROM files WHERE id=?", (file_id,))
    if not row:
        return {"file_id": file_id, "local_only": True, "on_server": False}
    if int(row["owner_id"]) != uid and row["chat_id"]:
        await member(row["chat_id"], uid)
    return {
        "file_id": file_id,
        "local_only": bool(row["local_only"]),
        "on_server": bool(not row["consumed_at"] and int(row["expires_at"]) > db.now()),
        "consumed_at": row["consumed_at"], "consumed_by": row["consumed_by"],
        "policy": "Файл хранится на сервере максимум 24 часа и удаляется сразу после скачивания получателем",
    }


@router.delete("/{file_id}")
async def delete_file(file_id: str, sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    row = await db.fetchone("SELECT * FROM files WHERE id=?", (file_id,))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Файл не найден")
    if int(row["owner_id"]) != uid:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Удалить может только владелец")
    await _purge_file(file_id)
    return {"ok": True, "message": "Файл стёрт безвозвратно"}


@router.get("")
async def my_files(limit: int = Query(default=100, ge=1, le=500), sess: dict = Depends(current_session)):
    uid = int(sess["user"]["id"])
    rows = await db.fetchall(
        "SELECT id,chat_id,size,kind,mime,created_at,expires_at,downloads FROM files WHERE owner_id=? ORDER BY created_at DESC LIMIT ?",
        (uid, limit))
    return {"files": [dict(r) for r in rows], "ttl_hours": FILE_TTL_HOURS,
            "note": "Все файлы автоматически удаляются через 24 часа после загрузки"}


@router.get("/storage/status")
async def storage_status():
    total = shutil.disk_usage(FILES_DIR).total / (1024 ** 3)
    used = shutil.disk_usage(FILES_DIR).used / (1024 ** 3)
    row = await db.fetchone(
        "SELECT COUNT(*) AS c, COALESCE(SUM(size),0) AS s FROM files WHERE expires_at>?", (db.now(),))
    on_disk = sum(f.stat().st_size for f in FILES_DIR.rglob("*.part")) if FILES_DIR.exists() else 0
    return {"files_active": int(row["c"]), "bytes_active": int(row["s"]), "bytes_on_disk": on_disk,
            "disk_total_gb": round(total, 2), "disk_used_gb": round(used, 2),
            "ttl_hours": FILE_TTL_HOURS}


# ── Медиа профиля (аватары/обложки/стикеры) — живут, пока не заменены ──────
MEDIA_MAX = 8 * 1024 * 1024


@router.post("/media/upload", status_code=201)
async def media_upload(request: Request, kind: str = Query(default="avatar", max_length=16),
                       x_media_iv: str = Query(default="", alias="iv"),
                       sess: dict = Depends(current_session)):
    from ..config import MEDIA_DIR
    uid = int(sess["user"]["id"])
    data = await request.body()
    if len(data) > MEDIA_MAX:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Медиа больше 8 МБ")
    mid = "a" + secrets.token_hex(10)
    (MEDIA_DIR / f"{mid}.bin").write_bytes(data)
    await db.execute(
        "INSERT INTO audit_log(at,user_id,event,detail) VALUES(?,?,?,?)",
        (db.now(), uid, "media_upload", f'{{"id":"{mid}","kind":"{kind}"}}'))
    return {"media_id": mid, "url": f"/api/v1/files/media/{mid}", "kind": kind, "bytes": len(data)}


@router.get("/media/{media_id}")
async def media_get(media_id: str, token: str = Query(default=""), sess: dict = Depends(current_session)):
    from ..config import MEDIA_DIR
    p = MEDIA_DIR / f"{media_id}.bin"
    if not p.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Медиа не найдено")
    return FileResponse(p, media_type="application/octet-stream")
