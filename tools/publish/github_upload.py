#!/usr/bin/env python3
"""
Выгрузка файлов проекта Encryption в GitHub через REST API.

Git не нужен — все файлы отправляются напрямую в GitHub: создаются блобы,
дерево, коммит, обновляется ветка (main) и ставится тег v3.1.0.

Запуск:
    python3 github_upload.py --token <ТОКЕН> [--repo saniss228/Encryption]
                             [--files ./files] [--branch main] [--tag v3.1.0]
                             [--release]

Токен нужен с правом Contents: Read and write (fine-grained) либо scope repo (classic).
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

API = os.environ.get("GH_API_BASE", "https://api.github.com").rstrip("/")
UA = "encryption-publish/1.0"
COMMIT_SUBJECT = "Encryption 3.1.0 — третья версия мессенджера"
COMMIT_BODY = """Что внутри:
- сервер FastAPI: REST API + WebSocket + раздача сайта (server/)
- сайт-клиент, общий с приложениями ПК и Android (web/)
- оболочка для Windows (desktop/) и Android (android/) + скрипты сборки (tools/)
- документация: docs/API.md (REST + WebSocket, примеры curl), SECURITY, DEPLOY, RECOVERY, FEATURES
- сборка релиза одной командой: bash tools/build_release.sh
- тесты: bash tools/run_tests.sh (крипто, API, «только локально», админ-панель, интерфейс)

Шифрование: каждое сообщение шифруется дважды (AES-256-GCM + RSA-4096-OAEP),
плюс ECDH P-256 для forward secrecy и подпись ECDSA. Сервер видит только шифротекст.

Клиенты: сайт (запускается вместе с сервером), приложение для ПК, приложение для Android.
Файлы живут ровно 24 часа и удаляются с сервера сразу после скачивания получателем
(метка «Только локально / Local only»). Интерфейс переведён на 4 языка.

Админ-панель (аккаунт saniss): обзор сервера, блокировки, группы, файлы, журнал,
рассылка объявлений, настройки. Переписку администратор прочитать не может."""

TAG_MESSAGE = ("Encryption 3.1.0 — третья версия: API + документация, "
               "«только локально», 4 языка, админ-панель saniss")


# ── Служебное ───────────────────────────────────────────────────────────────
def log(msg: str = "") -> None:
    print(msg, flush=True)


def request(method: str, path: str, token: str, payload=None, retries: int = 3):
    """Запрос к GitHub API. Возвращает (статус, тело)."""
    url = path if path.startswith("http") else API + path
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", UA)
    if data:
        req.add_header("Content-Type", "application/json; charset=utf-8")
    last: tuple[int, dict] = (0, {"message": "нет ответа"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                body = resp.read()
                return resp.status, (json.loads(body) if body else {})
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                parsed = json.loads(raw)
            except Exception:
                parsed = {"message": raw[:300].decode("utf-8", "replace")}
            last = (e.code, parsed)
            # Повторяем только на временных сбоях сервера
            if e.code in (500, 502, 503, 429) and attempt + 1 < retries:
                time.sleep(2 * (attempt + 1))
                continue
            return last
        except Exception as e:                      # сеть, таймаут, DNS
            last = (0, {"message": str(e)})
            if attempt + 1 < retries:
                time.sleep(2 * (attempt + 1))
    return last


def blob_sha(data: bytes) -> str:
    """SHA-1 объекта blob — так GitHub адресует содержимое файла."""
    h = hashlib.sha1()
    h.update(b"blob %d\0" % len(data))
    h.update(data)
    return h.hexdigest()


def collect_files(root: str) -> dict[str, tuple[str, bool]]:
    """Все файлы каталога: путь → (локальный путь, исполняемый ли)."""
    out: dict[str, tuple[str, bool]] = {}
    for base, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in (".git", "__pycache__", "node_modules"))
        for name in sorted(names):
            full = os.path.join(base, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            out[rel] = (full, os.name != "nt" and os.access(full, os.X_OK))
    return out


# ── Основной сценарий ───────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser(description="Отправка проекта Encryption в GitHub (без git)")
    ap.add_argument("--token", default=os.environ.get("GITHUB_TOKEN", ""), help="токен GitHub")
    ap.add_argument("--repo", default="saniss228/Encryption", help="владелец/репозиторий")
    ap.add_argument("--files", default="files", help="каталог с файлами проекта")
    ap.add_argument("--branch", default="main", help="ветка, куда отправить")
    ap.add_argument("--tag", default="v3.1.0", help="тег версии")
    ap.add_argument("--message", default=COMMIT_SUBJECT + "\n\n" + COMMIT_BODY,
                    help="сообщение коммита")
    ap.add_argument("--release", action="store_true", help="создать GitHub Release")
    ap.add_argument("--force-tag", action="store_true", help="переставить тег, если он уже есть")
    args = ap.parse_args()

    token = args.token.strip()
    if not token:
        token = os.environ.get("GH_TOKEN", "").strip()
    if not token:
        log("✗ Не указан токен. Запустите с --token <ТОКЕН> или задайте GITHUB_TOKEN.")
        return 2
    repo = args.repo.strip().strip("/")
    if not os.path.isdir(args.files):
        log(f"✗ Нет каталога с файлами: {args.files}")
        return 2

    # 1. Проверяем токен и репозиторий
    st, me = request("GET", "/user", token)
    if st != 200:
        log(f"✗ Токен не принят (HTTP {st}): {me.get('message')}")
        log("  Проверьте, что токен действующий и с правом Contents: Read and write.")
        return 3
    log(f"→ Токен принят: {me.get('login')}")

    st, info = request("GET", f"/repos/{repo}", token)
    if st != 200:
        log(f"✗ Репозиторий {repo} недоступен (HTTP {st}): {info.get('message')}")
        return 3
    branch = args.branch or info.get("default_branch", "main")
    perms = (info.get("permissions") or {}).get("push")
    log(f"→ Репозиторий: {info.get('full_name')} (ветка по умолчанию: {info.get('default_branch')})")
    if perms is False:
        log("✗ У токена нет права на запись в этот репозиторий (Contents: Read and write).")
        return 3

    # 2. Текущее состояние ветки
    st, ref = request("GET", f"/repos/{repo}/git/ref/heads/{branch}", token)
    if st == 200:
        parent = ref["object"]["sha"]
        st2, pc = request("GET", f"/repos/{repo}/git/commits/{parent}", token)
        if st2 != 200:
            log(f"✗ Не удалось прочитать текущий коммит: {pc.get('message')}")
            return 3
        base_tree = pc["tree"]["sha"]
        log(f"→ Текущая вершина {branch}: {parent[:7]}")
    else:
        parent, base_tree = None, None
        log(f"→ Ветка {branch} пустая — создаём первую версию")

    # 3. Что уже есть в репозитории (чтобы не отправлять то же самое дважды)
    existing: dict[str, str] = {}
    if base_tree:
        st, tr = request("GET", f"/repos/{repo}/git/trees/{base_tree}?recursive=1", token)
        if st == 200:
            for e in tr.get("tree", []):
                if e.get("type") == "blob":
                    existing[e["path"]] = e.get("sha", "")

    # 4. Собираем список файлов
    files = collect_files(args.files)
    log(f"→ Файлов к отправке: {len(files)}")

    entries: list[dict] = []
    uploaded = skipped = 0
    for i, (path, (full, is_exec)) in enumerate(sorted(files.items()), 1):
        with open(full, "rb") as fh:
            data = fh.read()
        sha = blob_sha(data)
        mode = "100755" if is_exec else "100644"
        if existing.get(path) == sha:
            skipped += 1                       # файл не изменился — берём из base_tree
            continue
        st, blob = request("POST", f"/repos/{repo}/git/blobs", token,
                           {"content": base64.b64encode(data).decode("ascii"), "encoding": "base64"})
        if st not in (200, 201):
            log(f"✗ Не удалось загрузить {path} (HTTP {st}): {blob.get('message')}")
            return 4
        entries.append({"path": path, "mode": mode, "type": "blob", "sha": blob["sha"]})
        uploaded += 1
        if uploaded % 10 == 0 or uploaded == 1:
            log(f"   … {uploaded} из {len(files) - skipped} файлов")

    # Удаляем то, чего больше нет в проекте
    removed = 0
    for path in existing:
        if path not in files:
            entries.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
            removed += 1

    log(f"→ Отправлено файлов: {uploaded}, без изменений: {skipped}, удалено: {removed}")

    # 5. Дерево, коммит, ветка
    tree_payload: dict = {"tree": entries}
    if base_tree:
        tree_payload["base_tree"] = base_tree
    st, tree = request("POST", f"/repos/{repo}/git/trees", token, tree_payload)
    if st not in (200, 201):
        log(f"✗ Не удалось создать дерево (HTTP {st}): {tree.get('message')}")
        return 4

    commit_payload = {"message": args.message, "tree": tree["sha"]}
    if parent:
        commit_payload["parents"] = [parent]
    st, commit = request("POST", f"/repos/{repo}/git/commits", token, commit_payload)
    if st not in (200, 201):
        log(f"✗ Не удалось создать коммит (HTTP {st}): {commit.get('message')}")
        return 4
    commit_sha = commit["sha"]

    if parent:
        st, upd = request("PATCH", f"/repos/{repo}/git/refs/heads/{branch}", token,
                          {"sha": commit_sha, "force": False})
    else:
        st, upd = request("POST", f"/repos/{repo}/git/refs", token,
                          {"ref": f"refs/heads/{branch}", "sha": commit_sha})
    if st not in (200, 201):
        log(f"✗ Не удалось обновить ветку {branch} (HTTP {st}): {upd.get('message')}")
        return 4
    log(f"✓ Ветка {branch} обновлена: {parent[:7] + '..' if parent else ''}{commit_sha[:7]}")

    # 6. Тег версии
    st, tagref = request("GET", f"/repos/{repo}/git/ref/tags/{args.tag}", token)
    if st == 200:
        if args.force_tag:
            st, obj = request("POST", f"/repos/{repo}/git/tags", token, {
                "tag": args.tag, "message": TAG_MESSAGE, "object": commit_sha,
                "type": "commit", "tagger": {"name": "Encryption", "email": "dev@encryption.local"}})
            if st in (200, 201):
                request("PATCH", f"/repos/{repo}/git/refs/tags/{args.tag}", token,
                        {"sha": obj["sha"], "force": True})
                log(f"✓ Тег {args.tag} переставлен на {commit_sha[:7]}")
        else:
            log(f"• Тег {args.tag} уже существует — оставляю как есть (--force-tag переставит)")
    else:
        st, obj = request("POST", f"/repos/{repo}/git/tags", token, {
            "tag": args.tag, "message": TAG_MESSAGE, "object": commit_sha,
            "type": "commit", "tagger": {"name": "Encryption", "email": "dev@encryption.local"}})
        if st in (200, 201):
            st, r = request("POST", f"/repos/{repo}/git/refs", token,
                            {"ref": f"refs/tags/{args.tag}", "sha": obj["sha"]})
            log(f"✓ Тег {args.tag} создан" if st in (200, 201)
                else f"• Тег не создан (HTTP {st}): {r.get('message')}")
        else:
            log(f"• Тег не создан: {obj.get('message')}")

    # 7. Релиз (по желанию)
    if args.release:
        st, rel = request("POST", f"/repos/{repo}/releases", token, {
            "tag_name": args.tag, "name": "Encryption 3.1.0",
            "body": COMMIT_BODY, "draft": False, "prerelease": False})
        log(f"✓ Релиз создан: {rel.get('html_url')}" if st in (200, 201)
            else f"• Релиз не создан (HTTP {st}): {rel.get('message')}")

    log()
    log("=" * 70)
    log(f" ГОТОВО. Проверить: https://github.com/{repo}/tree/{branch}")
    log(f" Коммит: https://github.com/{repo}/commit/{commit_sha}")
    log(f" Тег:    https://github.com/{repo}/releases/tag/{args.tag}")
    log("=" * 70)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log("\nПрервано пользователем.")
        sys.exit(130)
