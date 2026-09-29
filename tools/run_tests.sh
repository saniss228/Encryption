#!/usr/bin/env bash
# ============================================================================
#  Полный прогон тестов Encryption.
#    1) криптография (оба слоя, подпись, фраза восстановления, файлы)
#    2) API end-to-end (регистрация, чат, доставка, файлы, восстановление)
#    3) файлы: удаление с сервера после скачивания получателем
#    4) резервная копия и перенос данных на другой сервер
#    5) UI в headless-браузере (два независимых профиля = два устройства)
#       + проверка 3.4.1: удаление из друзей, долгое нажатие, журнал
#    6) админ-панель: API (права saness, блокировка, копия данных, рассылка)
#    7) админ-панель: интерфейс в браузере (свой сервер, все локализации)
#
#  Запуск:  bash tools/run_tests.sh
#  Требуется: node 18+, python3, зависимости сервера (server/requirements.txt)
#  Для UI-тестов: npm i puppeteer (в любой каталог, путь указывается PUPPETEER_DIR)
# ============================================================================
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ENC_ROOT="$ROOT"
PORT="${ENC_TEST_PORT:-8031}"
export ENC_BASE="http://127.0.0.1:$PORT"
# Скриншоты прогона складываем вне репозитория (в проект они не попадают)
export ENC_SHOTS_DIR="${ENC_SHOTS_DIR:-/tmp/enc-shots}"
DATA="$(mktemp -d)"
PASS=0; FAIL=0

echo "══════ 1/8 Криптографическое ядро и файлы запуска ══════"
CORE_OK=1
node "$ROOT/tools/tests/test_crypto.mjs" || CORE_OK=0
# Файлы запуска для Windows: скрипт PowerShell должен быть в UTF-8 с BOM (иначе
# PowerShell 5.1 читает русский текст как ANSI и вывод превращается в «кракозябры»),
# а .cmd — с переводами строк CRLF (иначе cmd.exe спотыкается на переходах).
python3 - "$ROOT" <<'PYEOF' || CORE_OK=0
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
ok = True
ps1_files = sorted(root.glob("tools/**/*.ps1"))
if not ps1_files:
    print("  ✗ не найдено ни одного .ps1")
    ok = False
for ps1 in ps1_files:
    rel = ps1.relative_to(root)
    if ps1.read_bytes().startswith(b"\xef\xbb\xbf"):
        print(f"  ✓ {rel}: UTF-8 с BOM")
    else:
        print(f"  ✗ {rel} без BOM — на Windows PowerShell 5.1 будет «кракозябры»")
        ok = False
for name in ("START-ENCRYPTION-WINDOWS.cmd", "ЗАПУСТИТЬ-МЕССЕНДЖЕР-WINDOWS.cmd"):
    raw = (root / name).read_bytes()
    if b"\r\n" in raw:
        print(f"  ✓ {name}: переводы строк CRLF")
    else:
        print(f"  ✗ {name}: нет CRLF")
        ok = False

# Логин администратора по умолчанию должен совпадать во всех точках входа:
# сервер, лаунчер Windows, лаунчер Linux и служба systemd.
expected = 'saness'
places = {
    "server/config.py": 'os.getenv("ENC_ADMINS", "saness")',
    "tools/start-encryption.ps1": "'saness'",
    "tools/start-server.sh": "${ENC_ADMINS:-saness}",
    "deploy/encryption.service": "ENC_ADMINS=saness",
}
places["tools/start-server.sh"] = "${ENC_ADMINS:-saness}"
for name, needle in places.items():
    text = (root / name).read_text(encoding="utf-8", errors="replace")
    if needle in text:
        print(f"  ✓ {name}: администратор по умолчанию — {expected}")
    else:
        print(f"  ✗ {name}: не найден администратор по умолчанию {expected} ({needle})")
        ok = False
# Единый порт 3000 у сервера и файлов запуска (клиенты собираются с тем же адресом)
port_places = {
    "server/config.py": 'os.getenv("ENC_PORT", "3000")',
    "tools/start-encryption.ps1": "$Port     = 3000",
    "tools/start-server.sh": "${PORT:-3000}",
    "deploy/encryption.service": "ENC_PORT=3000",
    "deploy/nginx-encryption.conf": "127.0.0.1:3000",
    "web/js/app.js": "http://45.90.45.92:3000",
    "desktop/main.js": "http://45.90.45.92:3000",
}
for name, needle in port_places.items():
    text = (root / name).read_text(encoding="utf-8", errors="replace")
    if needle in text:
        print(f"  ✓ {name}: порт 3000")
    else:
        print(f"  ✗ {name}: не найден порт 3000 ({needle})")
        ok = False
sys.exit(0 if ok else 1)
PYEOF
# Логика выбора адреса для телефона (tools/lan-ip.ps1) — правила проверяются на
# наборе адаптеров как на Windows: Wi-Fi должен побеждать Radmin VPN и хот-спот.
PS_EXE=""
for c in pwsh powershell; do command -v "$c" >/dev/null 2>&1 && PS_EXE="$c" && break; done
if [ -n "$PS_EXE" ]; then
  if "$PS_EXE" -NoProfile -File "$ROOT/tools/tests/test_lan_ip.ps1"; then :; else CORE_OK=0; fi
else
  echo "  пропущено: проверка адреса для телефона (нет pwsh/powershell)"
fi
if [ "$CORE_OK" = "1" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi

echo
echo "══════ 2/8 API end-to-end (тестовый сервер на :$PORT) ══════"
# В тестах лимиты частоты подняты: все разделы идут с одного IP и создают десятки
# аккаунтов в минуту — иначе получаем 429 RATE_LIMITED (боевой лимит 240/мин,
# регистрация — 10/мин). Множитель ENC_RATE_FACTOR — только для проверок.
ENC_PORT="$PORT" ENC_DATA_DIR="$DATA" ENC_RATE_LIMIT=100000 ENC_RATE_FACTOR=100 \
  python3 -m server.app >"$DATA/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for i in $(seq 1 30); do
  curl -sf "$ENC_BASE/api/v1/health" >/dev/null && break
  sleep 1
done
if node "$ROOT/tools/tests/test_api_e2e.mjs"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi

echo
echo "══════ 3/8 Файлы: удаление с сервера после скачивания («только локально») ══════"
if python3 "$ROOT/tools/test_local_only.py" "$ENC_BASE"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi

echo
echo "══════ 4/8 Резервная копия и перенос данных ══════"
if python3 "$ROOT/tools/test_backup.py" >/tmp/enc-backup-test.log 2>&1; then
  PASS=$((PASS+1)); tail -2 /tmp/enc-backup-test.log | head -1
else
  FAIL=$((FAIL+1)); tail -8 /tmp/enc-backup-test.log
fi

echo
echo "══════ 5/8 UI end-to-end (headless Chrome) ══════"
PUP="${PUPPETEER_DIR:-}"
if [ -n "$PUP" ] && [ -d "$PUP/node_modules/puppeteer" ]; then
  # Скрипты копируем рядом с node_modules: ESM ищет пакеты от своего файла, а не от cwd
  cp "$ROOT/tools/tests/test_ui_demo.mjs" "$ROOT/tools/tests/test_ui_e2e.mjs" "$ROOT/tools/tests/test_admin_ui.mjs" \
     "$ROOT/tools/tests/test_ui_341.mjs" "$PUP/"
  # test_ui_341 — проверка правок 3.4.1: удаление из друзей, долгое нажатие, журнал
  (cd "$PUP" && node test_ui_demo.mjs && node test_ui_e2e.mjs && node test_ui_341.mjs) \
    && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
else
  echo "  пропущено: укажите PUPPETEER_DIR=/путь/с/установленным/puppeteer"
  echo "  установка: mkdir -p /tmp/ui && cd /tmp/ui && npm i puppeteer"
fi

echo
echo "══════ 6/8 Админ-панель: API (логин saness) ══════"
if python3 "$ROOT/tools/test_admin.py" "$ENC_BASE"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi

echo
echo "══════ 7/8 Друзья и блокировки (написать можно только друзьям) ══════"
if ENC_ROOT="$ROOT" ENC_BASE="$ENC_BASE" node "$ROOT/tools/tests/test_friends.mjs"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi

echo
echo "══════ 8/8 Админ-панель: интерфейс в браузере ══════"
if [ -n "$PUP" ] && [ -d "$PUP/node_modules/puppeteer" ]; then
  cp "$ROOT/tools/tests/test_admin_ui.mjs" "$PUP/"
  (cd "$PUP" && ENC_ROOT="$ROOT" node test_admin_ui.mjs) && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
else
  echo "  пропущено: нужен PUPPETEER_DIR"
fi

echo
echo "═══════════════════════════════════════"
echo " Итог: успешно $PASS, провалено $FAIL"
echo "═══════════════════════════════════════"
exit $((FAIL > 0 ? 1 : 0))
