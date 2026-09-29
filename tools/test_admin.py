#!/usr/bin/env python3
"""
Приёмочный тест админ-панели (логин saness).

Проверяет: выдача админ-прав, отказ обычному пользователю, обзор сервера,
блокировку и разблокировку, принудительный выход, рассылку объявлений,
закрытие регистрации, уборку файлов, журнал и удаление аккаунта.

Запуск:  python3 tools/test_admin.py [http://127.0.0.1:6000]
"""
from __future__ import annotations

import json
import secrets
import sys
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:6000").rstrip("/")
SUF = secrets.token_hex(3)
OK: list[str] = []
FAIL: list[str] = []


def call(method: str, path: str, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:200].decode("utf-8", "replace")}


def call_raw(method: str, path: str, body=None, token=None) -> tuple[int, bytes]:
    """То же, что call(), но для двоичных ответов (файл копии данных)."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def code_of(resp) -> str | None:
    if not isinstance(resp, dict):
        return None
    err = resp.get("error") or resp.get("detail") or {}
    return err.get("code") if isinstance(err, dict) else None


def check(name: str, cond: bool, extra: str = "") -> None:
    (OK if cond else FAIL).append(name)
    print(("  ✅ " if cond else "  ❌ ") + name + (f"   {extra}" if extra else ""))


def register(username: str, device: str):
    body = {
        "username": username, "display_name": username, "auth_hash": "a" * 64,
        "keys": {"ik_dh_pub": "dh" + secrets.token_hex(20), "ik_sign_pub": "sg" + secrets.token_hex(20),
                 "rsa_pub": "rs" + secrets.token_hex(20), "spk_pub": "sp" + secrets.token_hex(20),
                 "spk_sig": "ss" + secrets.token_hex(20), "one_time_keys": []},
        "device": {"device_id": device, "name": "тест", "platform": "web", "app_version": "3.1.0"},
    }
    st, res = call("POST", "/api/v1/auth/register", body)
    return st, res


def main() -> int:
    print(f"→ Сервер: {BASE}   (админ по умолчанию: saness)\n")

    # ── Админ-аккаунт saness ────────────────────────────────────────────────
    st, res = register("saness", "admin_dev_" + SUF + "_0001")
    if st == 409:
        # Аккаунт уже есть (повторный прогон) — входим тем же тестовым секретом
        st, res = call("POST", "/api/v1/auth/login", {
            "username": "saness", "auth_hash": "a" * 64,
            "device": {"device_id": "admin_dev_" + SUF + "_0001", "name": "тест", "platform": "web"}})
        check("повторный вход saness", st == 200, f"{st}")
        admin_token = res.get("tokens", {}).get("access_token") if st == 200 else None
        if admin_token:
            check("роль admin сохраняется при входе", res["user"].get("role") == "admin",
                  str(res["user"].get("role")))
    else:
        check("регистрация saness", st == 201, f"{st}")
        admin_token = res.get("tokens", {}).get("access_token") if st == 201 else None
        if admin_token:
            check("saness получил роль admin", res["user"].get("role") == "admin",
                  str(res["user"].get("role")))

    # ── Обычный пользователь ────────────────────────────────────────────────
    user_name = "adm_u_" + SUF
    st, res = register(user_name, "user_dev_" + SUF + "_0002")
    check("регистрация обычного пользователя", st == 201, f"{st}")
    user_token = res["tokens"]["access_token"]
    user_id = res["user"]["id"]
    check("обычный пользователь без прав админа", res["user"].get("role") == "user",
          str(res["user"].get("role")))

    st, r = call("GET", "/api/v1/admin/overview", token=user_token)
    check("обычному пользователю админ-API закрыт (403 ADMIN_ONLY)",
          st == 403 and code_of(r) == "ADMIN_ONLY", f"{st} {code_of(r)}")

    if not admin_token:
        print("\n(нет токена saness — остальные проверки пропущены)")
        return 0 if not FAIL else 1

    # ── Обзор сервера ───────────────────────────────────────────────────────
    st, ov = call("GET", "/api/v1/admin/overview", token=admin_token)
    check("GET /admin/overview", st == 200 and "users" in ov, f"{st}")
    if st == 200:
        check("в обзоре есть место на диске и версия",
              ov["disk"]["total"] > 0 and ov["server"]["version"].startswith("3."),
              f"версия {ov['server']['version']}, свободно {ov['disk']['free'] // 1048576} МБ")

    st, users = call("GET", f"/api/v1/admin/users?q={user_name}", token=admin_token)
    check("поиск пользователя в админке", st == 200 and any(u["username"] == user_name for u in users["users"]),
          f"найдено {len(users.get('users', []))}")

    # ── Блокировка ──────────────────────────────────────────────────────────
    st, r = call("POST", f"/api/v1/admin/users/{user_id}/block", {"reason": "тест блокировки"}, token=admin_token)
    check("блокировка пользователя", st == 200 and r.get("blocked") is True, f"{st}")

    st, r = call("POST", "/api/v1/auth/login", {
        "username": user_name, "auth_hash": "a" * 64,
        "device": {"device_id": "user_dev_" + SUF + "_0002", "name": "тест", "platform": "web"}})
    check("заблокированный не может войти (403 USER_BLOCKED)",
          st == 403 and code_of(r) == "USER_BLOCKED", f"{st} {code_of(r)}")

    st, r = call("POST", f"/api/v1/admin/users/{user_id}/unblock", {}, token=admin_token)
    check("разблокировка", st == 200 and r.get("blocked") is False, f"{st}")

    st, r = call("POST", "/api/v1/auth/login", {
        "username": user_name, "auth_hash": "a" * 64,
        "device": {"device_id": "user_dev_" + SUF + "_0002", "name": "тест", "platform": "web"}})
    check("после разблокировки вход работает", st == 200, f"{st}")

    # ── Принудительный выход ────────────────────────────────────────────────
    st, r = call("POST", f"/api/v1/admin/users/{user_id}/logout", {}, token=admin_token)
    check("принудительный выход со всех устройств", st == 200 and r.get("ok") is True, f"{st}")

    # ── Рассылка ────────────────────────────────────────────────────────────
    st, r = call("POST", "/api/v1/admin/broadcast",
                 {"text": "Плановые работы ночью", "level": "warning"}, token=admin_token)
    check("рассылка объявления", st == 201 and r.get("id"), f"{st}")
    ann_id = r.get("id")

    st, r = call("GET", "/api/v1/announcements", token=user_token)
    check("объявление видно пользователю", st == 200 and any(
        a["text"] == "Плановые работы ночью" for a in r.get("announcements", [])), f"{st}")

    # ── Настройки: закрытая регистрация ─────────────────────────────────────
    st, r = call("PUT", "/api/v1/admin/settings", {"registration_open": False}, token=admin_token)
    check("закрытие регистрации", st == 200 and r["changed"].get("registration_open") is False, f"{st}")
    st, r = register("closed_" + SUF, "closed_dev_" + SUF + "_0003")
    check("новый аккаунт не создаётся (403 REGISTRATION_CLOSED)",
          st == 403 and code_of(r) == "REGISTRATION_CLOSED", f"{st} {code_of(r)}")
    st, r = call("PUT", "/api/v1/admin/settings", {"registration_open": True}, token=admin_token)
    check("регистрация снова открыта", st == 200, f"{st}")

    # ── Файлы и журнал ──────────────────────────────────────────────────────
    st, r = call("GET", "/api/v1/admin/files?filter=on_server", token=admin_token)
    check("список файлов на сервере", st == 200 and "files" in r, f"{st} ({len(r.get('files', []))} шт.)")
    st, r = call("POST", "/api/v1/admin/files/purge", {}, token=admin_token)
    check("уборка истёкших файлов и надгробий", st == 200 and "expired_removed" in r, f"{st}")

    st, r = call("GET", "/api/v1/admin/audit?limit=20", token=admin_token)
    events = [e["event"] for e in r.get("events", [])] if st == 200 else []
    check("журнал безопасности пишет админ-действия",
          st == 200 and "admin_user_blocked" in events and "admin_broadcast" in events,
          f"{st}, событий {len(events)}")

    st, r = call("GET", "/api/v1/admin/chats?type=group", token=admin_token)
    check("список групп", st == 200 and "chats" in r, f"{st}")

    # ── Защита от опасных действий над собой ────────────────────────────────
    st, me = call("GET", "/api/v1/users/me", token=admin_token)
    admin_id = (me.get("user") or me)["id"]
    st, r = call("POST", f"/api/v1/admin/users/{admin_id}/block", {"reason": "сам себя"}, token=admin_token)
    check("нельзя заблокировать себя (400 SELF_ACTION)", st == 400 and code_of(r) == "SELF_ACTION",
          f"{st} {code_of(r)}")

    # ── Удаление аккаунта ───────────────────────────────────────────────────
    st, r = call("DELETE", f"/api/v1/admin/users/{user_id}", token=admin_token)
    check("удаление аккаунта", st == 200 and r.get("deleted") == user_id, f"{st}")
    st, r = call("GET", f"/api/v1/admin/users/{user_id}", token=admin_token)
    check("удалённый аккаунт больше не находится (404)", st == 404, f"{st}")

    st, r = call("DELETE", f"/api/v1/admin/announcements/{ann_id}", token=admin_token)
    check("отключение объявления", st == 200 and r.get("active") is False, f"{st}")

    # ── Резервная копия данных (перенос сервера) ────────────────────────────
    st, r = call("GET", "/api/v1/admin/backup/info", token=admin_token)
    check("сведения о копии данных", st == 200 and "stats" in r and r["stats"]["database_bytes"] > 0,
          f"{st}, база {r.get('stats', {}).get('database_bytes', 0)} Б")
    st, r = call("GET", "/api/v1/admin/backup/info")
    check("обычному пользователю копия недоступна", st in (401, 403), f"{st}")

    st, blob = call_raw("POST", "/api/v1/admin/backup/export", {"password": "копия-пароль-1"}, token=admin_token)
    check("копия данных выгружается", st == 200 and len(blob) > 1000 and blob[:7] == b"ENCBK1\n",
          f"{st}, {len(blob)} Б")
    if st == 200 and blob[:7] == b"ENCBK1\n":
        import tempfile, pathlib as _p
        sys.path.insert(0, str(_p.Path(__file__).resolve().parent.parent))
        from server import backup as _backup
        tmp = _p.Path(tempfile.mkdtemp())
        f = tmp / "api.encbak"
        f.write_bytes(blob)
        info = _backup.peek(f, "копия-пароль-1")
        check("копия с сервера читается и цела",
              info["files"] >= 1 and info["restored_bytes"] > 0,
              f"файлов {info['files']}, {info['restored_bytes']} Б")
        try:
            _backup.peek(f, "другой-пароль-1")
            check("копия с сервера не открывается чужим паролем", False, "открылась!")
        except _backup.BackupError:
            check("копия с сервера не открывается чужим паролем", True)
        st, r = call("DELETE", "/api/v1/admin/backup/files", token=admin_token)
        check("скачанные копии убираются с сервера", st == 200 and r.get("ok") is True, f"{st}")

    print(f"\n{'=' * 62}\nПройдено: {len(OK)}   Провалено: {len(FAIL)}")
    if FAIL:
        print("Провалены: " + ", ".join(FAIL))
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
