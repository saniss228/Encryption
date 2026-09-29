#!/usr/bin/env python3
"""
Приёмочный тест сценария «только локально».

Проверяет полный путь: получатель скачивает файл → сервер удаляет свою копию →
файл помечен local_only, метаданные и сообщение это отражают → повторная попытка
скачать файл отвечает 410 LOCAL_ONLY.

Запуск:  python3 tools/test_local_only.py [http://127.0.0.1:3000]
"""
from __future__ import annotations

import json
import secrets
import sys
import time
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3000").rstrip("/")
SUF = secrets.token_hex(3)
OK, FAIL = [], []


def call(method: str, path: str, body=None, token=None, raw: bytes | None = None,
         content_type: str = "application/json"):
    url = BASE + path
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", content_type)
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            payload = r.read()
            return r.status, (json.loads(payload) if payload[:1] in (b"{", b"[") else payload)
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            return e.code, json.loads(payload)
        except Exception:
            return e.code, {"raw": payload[:200].decode("utf-8", "replace")}


def _code(resp) -> str | None:
    """Код ошибки из ответа сервера (формат {"error": {"code": ...}})."""
    if not isinstance(resp, dict):
        return None
    err = resp.get("error") or resp.get("detail") or {}
    return err.get("code") if isinstance(err, dict) else None


def check(name: str, cond: bool, extra: str = "") -> None:
    (OK if cond else FAIL).append(name)
    print(("  ✅ " if cond else "  ❌ ") + name + (f"  {extra}" if extra else ""))


def register(username: str, device: str):
    body = {
        "username": username,
        "display_name": username,
        "auth_hash": "a" * 64,
        "keys": {
            "ik_dh_pub": "dh" + secrets.token_hex(20),
            "ik_sign_pub": "sg" + secrets.token_hex(20),
            "rsa_pub": "rs" + secrets.token_hex(20),
            "spk_pub": "sp" + secrets.token_hex(20),
            "spk_sig": "ss" + secrets.token_hex(20),
            "one_time_keys": [],
        },
        "device": {"device_id": device, "name": "тест", "platform": "web", "app_version": "3.0.0"},
    }
    st, res = call("POST", "/api/v1/auth/register", body)
    assert st in (200, 201), f"register {username}: {st} {res}"
    return res["tokens"]["access_token"], res["user"]["id"]


def envelope(uid_a: int, uid_b: int) -> dict:
    """Конверт, удовлетворяющий серверной проверке формы (содержимое — заглушки)."""
    return {
        "v": 2,
        "alg": "AES-256-GCM+RSA-4096-OAEP",
        "ts": int(time.time() * 1000),
        "l1": {"alg": "AES-256-GCM", "iv": "aXY=", "ct": "Y2lwaGVy"},
        "wrap": {
            str(uid_a): {"rsa": "cnNh", "dh": "ZGg="},
            str(uid_b): {"rsa": "cnNh", "dh": "ZGg="},
        },
        "sig": "c2ln",
        "signer": uid_a,
    }


def main() -> int:
    print(f"→ Сервер: {BASE}\n")
    ta, id_a = register("lo_a_" + SUF, "dev_a_" + SUF + "_1234567890")
    tb, id_b = register("lo_b_" + SUF, "dev_b_" + SUF + "_1234567890")

    st, chat = call("POST", "/api/v1/chats",
                    {"type": "direct", "peer_username": "lo_b_" + SUF}, token=ta)
    check("A создал личный чат с B", st == 201, f"{st}")
    cid = chat["id"] if st == 201 else None
    if not cid:
        return 1

    # ── Загрузка файла (2 чанка по 64 КиБ) ──────────────────────────────────
    payload = secrets.token_bytes(64 * 1024) * 2
    st, init = call("POST", "/api/v1/files/init", {
        "chat_id": cid, "size": len(payload), "kind": "file", "mime": "application/octet-stream",
        "name_enc": "enc:secret.bin", "key_wrap": "k" * 40, "chunk_size": 64 * 1024,
    }, token=ta)
    check("POST /files/init", st == 201 and init.get("chunks") == 2, f"{st} {init.get('chunks')}")
    fid = init["file_id"]

    for i, part in enumerate(payload[i:i + 65536] for i in range(0, len(payload), 65536)):
        st, r = call("PUT", f"/api/v1/files/{fid}/chunk?index={i}", raw=part,
                     token=ta, content_type="application/octet-stream")
        check(f"PUT чанк {i}", st == 200, f"{st}")
    st, r = call("POST", f"/api/v1/files/{fid}/complete", {}, token=ta)
    check("POST /files/complete", st == 200, f"{st}")

    # ── Сообщение с вложением ───────────────────────────────────────────────
    st, msg = call("POST", "/api/v1/messages", {
        "chat_id": cid, "payload": envelope(id_a, id_b), "type": "file",
        "attachment_id": fid, "attachment_meta": {"name": "secret.bin", "size": len(payload)},
    }, token=ta)
    check("A отправил сообщение с файлом", st == 201, f"{st}")
    mid = msg.get("id") if st == 201 else None

    # ── До скачивания: файл на сервере ──────────────────────────────────────
    st, meta = call("GET", f"/api/v1/files/{fid}/meta", token=tb)
    check("B видит метаданные файла (local_only=false)", st == 200 and meta.get("local_only") in (False, 0),
          f"{st} {meta.get('local_only')!r}")
    check("B видит флаг «удаляется после скачивания»", bool(meta.get("burn_after_download")))

    # ── B скачивает оба чанка ───────────────────────────────────────────────
    got = b""
    for i in range(2):
        st, part = call("GET", f"/api/v1/files/{fid}/chunk?index={i}", token=tb)
        check(f"B скачал чанк {i}", st == 200 and len(part) == 65536, f"{st} {len(part) if isinstance(part, bytes) else part}")
        if isinstance(part, bytes):
            got += part
    check("B получил файл целиком", got == payload)

    # ── B подтверждает: расшифровано и сохранено локально ───────────────────
    st, cons = call("POST", f"/api/v1/files/{fid}/consumed", {}, token=tb)
    check("POST /files/{id}/consumed", st == 200, f"{st} {cons}")
    check("копия удалена с сервера", bool(cons.get("deleted_from_server")), str(cons.get("deleted_from_server")))
    check("ответ помечен как «только локально»", cons.get("local_only") is True)

    # ── Повторное скачивание невозможно ────────────────────────────────────
    st, gone = call("GET", f"/api/v1/files/{fid}/chunk?index=0", token=tb)
    code = _code(gone)
    check("повторное скачивание → 410 LOCAL_ONLY", st == 410 and code == "LOCAL_ONLY", f"{st} {code}")
    st, raw = call("GET", f"/api/v1/files/{fid}/raw", token=tb)
    check("потоковое скачивание тоже закрыто (410)", st == 410 and _code(raw) == "LOCAL_ONLY", f"{st} {_code(raw)}")

    st, lo = call("GET", f"/api/v1/files/{fid}/local-only", token=ta)
    check("GET /files/{id}/local-only → on_server=false",
          st == 200 and lo.get("local_only") is True and lo.get("on_server") is False, f"{st} {lo}")

    # ── Владелец видит метку в метаданных и в сообщении ─────────────────────
    st, meta2 = call("GET", f"/api/v1/files/{fid}/meta", token=ta)
    check("метаданные: local_only=true, on_server=false, size=0",
          st == 200 and meta2.get("local_only") is True and meta2.get("on_server") is False
          and int(meta2.get("size") or 0) == 0, f"{st} {meta2.get('size')}")

    st, page = call("GET", f"/api/v1/messages?chat_id={cid}&limit=50", token=ta)
    items = page.get("messages", page if isinstance(page, list) else [])
    target = next((m for m in items if m.get("id") == mid), None)
    check("сообщение несёт local_only=true", bool(target and target.get("local_only")),
          str(target.get("local_only")) if target else "сообщение не найдено")

    # ── Диск: блоки файла удалены ──────────────────────────────────────────
    st, st_status = call("GET", "/api/v1/files/storage/status", token=ta)
    check("хранилище отвечает", st == 200, f"{st}")

    print(f"\n{'=' * 62}\nПройдено: {len(OK)}   Провалено: {len(FAIL)}")
    if FAIL:
        print("Провалены: " + ", ".join(FAIL))
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
