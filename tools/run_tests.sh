#!/usr/bin/env bash
# ============================================================================
#  Полный прогон тестов Encryption.
#    1) криптография (оба слоя, подпись, фраза восстановления, файлы)
#    2) API end-to-end (регистрация, чат, доставка, файлы, восстановление)
#    3) файлы: удаление с сервера после скачивания получателем
#    4) UI в headless-браузере (два независимых профиля = два устройства)
#    5) админ-панель: API (права saniss, блокировка, рассылка, настройки)
#    6) админ-панель: интерфейс в браузере (свой сервер, все локализации)
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
DATA="$(mktemp -d)"
PASS=0; FAIL=0

echo "══════ 1/6 Криптографическое ядро ══════"
if node "$ROOT/tools/tests/test_crypto.mjs"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi

echo
echo "══════ 2/6 API end-to-end (тестовый сервер на :$PORT) ══════"
ENC_PORT="$PORT" ENC_DATA_DIR="$DATA" python3 -m server.app >"$DATA/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for i in $(seq 1 30); do
  curl -sf "$ENC_BASE/api/v1/health" >/dev/null && break
  sleep 1
done
if node "$ROOT/tools/tests/test_api_e2e.mjs"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi

echo
echo "══════ 3/6 Файлы: удаление с сервера после скачивания («только локально») ══════"
if python3 "$ROOT/tools/test_local_only.py" "$ENC_BASE"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi

echo
echo "══════ 4/6 UI end-to-end (headless Chrome) ══════"
PUP="${PUPPETEER_DIR:-}"
if [ -n "$PUP" ] && [ -d "$PUP/node_modules/puppeteer" ]; then
  # Скрипты копируем рядом с node_modules: ESM ищет пакеты от своего файла, а не от cwd
  cp "$ROOT/tools/tests/test_ui_demo.mjs" "$ROOT/tools/tests/test_ui_e2e.mjs" "$ROOT/tools/tests/test_admin_ui.mjs" "$PUP/"
  (cd "$PUP" && node test_ui_demo.mjs && node test_ui_e2e.mjs) \
    && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
else
  echo "  пропущено: укажите PUPPETEER_DIR=/путь/с/установленным/puppeteer"
  echo "  установка: mkdir -p /tmp/ui && cd /tmp/ui && npm i puppeteer"
fi

echo
echo "══════ 5/6 Админ-панель: API (логин saniss) ══════"
if python3 "$ROOT/tools/test_admin.py" "$ENC_BASE"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi

echo
echo "══════ 6/6 Админ-панель: интерфейс в браузере ══════"
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
