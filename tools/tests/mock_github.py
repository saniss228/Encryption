#!/usr/bin/env python3
"""
Локальная «заглушка» GitHub API для проверки скрипта публикации
(tools/publish/github_upload.py и отправить-на-github.ps1).

Поднимает HTTP-сервер, который ведёт себя как api.github.com в нужной части:
/user, /repos/…/git/ref/heads/main, /commits/<sha>, /trees/<sha>,
POST /git/blobs, POST /git/trees, POST /git/commits, PATCH /git/refs/heads/main,
POST /git/tags, POST /git/refs.

Все запросы пишет в журнал (JSON) — по нему проверяется, что скрипт отправил
ровно те файлы, что нужно.

Запуск:  python3 tools/tests/mock_github.py [порт] [путь-к-журналу]
"""
from __future__ import annotations

import base64
import hashlib
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
LOG_PATH = sys.argv[2] if len(sys.argv) > 2 else "/tmp/mock_github_log.json"

PARENT = "05863298a2768d9cbbcf6547c6b901abc6c719de"
BASE_TREE = "tree-before-3.1.0"
LOG: list[dict] = []
COUNTER = {"blob": 0}
LOCK = threading.Lock()
# Файл, который «уже есть в репозитории» с тем же содержимым — проверяем пропуск загрузки
KNOWN = {}


def blob_sha(data: bytes) -> str:
    h = hashlib.sha1()
    h.update(b"blob %d\0" % len(data))
    h.update(data)
    return h.hexdigest()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_a):        # тишина в выводе
        pass

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _record(self, body=None) -> None:
        entry = {"method": self.command, "path": self.path}
        if body is not None:
            entry["body"] = body
        with LOCK:
            LOG.append(entry)
            with open(LOG_PATH, "w", encoding="utf-8") as fh:
                json.dump(LOG, fh, ensure_ascii=False, indent=1)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except Exception:
            return {"_raw": raw[:200].decode("utf-8", "replace")}

    def _auth_ok(self) -> bool:
        return (self.headers.get("Authorization") or "").startswith("Bearer ")

    # ── GET ────────────────────────────────────────────────────────────────
    def do_GET(self):
        self._record()
        if not self._auth_ok():
            return self._send(401, {"message": "Requires authentication"})
        p = self.path
        if p == "/user":
            return self._send(200, {"login": "saniss228"})
        if p == "/repos/saniss228/Encryption":
            return self._send(200, {"full_name": "saniss228/Encryption", "default_branch": "main",
                                    "permissions": {"push": True, "admin": True}})
        if p == "/repos/saniss228/Encryption/git/ref/heads/main":
            return self._send(200, {"ref": "refs/heads/main",
                                    "object": {"sha": PARENT, "type": "commit"}})
        if p == f"/repos/saniss228/Encryption/git/commits/{PARENT}":
            return self._send(200, {"sha": PARENT, "tree": {"sha": BASE_TREE}})
        if p.startswith(f"/repos/saniss228/Encryption/git/trees/{BASE_TREE}"):
            tree = [{"path": path, "mode": "100644", "type": "blob", "sha": sha}
                    for path, sha in KNOWN.items()]
            return self._send(200, {"sha": BASE_TREE, "tree": tree, "truncated": False})
        if "/git/ref/tags/" in p:
            return self._send(404, {"message": "Not Found"})
        return self._send(404, {"message": "Not Found"})

    # ── POST / PATCH ───────────────────────────────────────────────────────
    def do_POST(self):
        body = self._body()
        self._record(body)
        if not self._auth_ok():
            return self._send(401, {"message": "Requires authentication"})
        p = self.path
        if p.endswith("/git/blobs"):
            COUNTER["blob"] += 1
            # Проверяем, что содержимое действительно base64 и совпадает по SHA-1
            data = base64.b64decode(body["content"])
            return self._send(201, {"sha": blob_sha(data)})
        if p.endswith("/git/trees"):
            return self._send(201, {"sha": "new-tree-sha"})
        if p.endswith("/git/commits"):
            return self._send(201, {"sha": "newcommit1234567890"})
        if p.endswith("/git/tags"):
            return self._send(201, {"sha": "newtagobject"})
        if p.endswith("/git/refs"):
            return self._send(201, {"ref": body.get("ref"), "object": {"sha": body.get("sha")}})
        if p.endswith("/releases"):
            return self._send(201, {"html_url": "https://github.com/saniss228/Encryption/releases/tag/v3.1.0"})
        return self._send(404, {"message": "Not Found"})

    def do_PATCH(self):
        body = self._body()
        self._record(body)
        if not self._auth_ok():
            return self._send(401, {"message": "Requires authentication"})
        if "/git/refs/" in self.path:
            return self._send(200, {"ref": self.path.split("/repos/")[-1], "object": {"sha": body.get("sha")}})
        return self._send(404, {"message": "Not Found"})


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    with LOCK:
        with open(LOG_PATH, "w") as fh:
            json.dump([], fh)
    print(f"Заглушка GitHub API: http://127.0.0.1:{PORT}   журнал: {LOG_PATH}", flush=True)
    srv.serve_forever()
