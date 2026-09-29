#!/usr/bin/env bash
# ============================================================================
#  Encryption — запуск мессенджера на Linux / macOS (сервер + сайт + API).
#
#  Что делает скрипт:
#    1. находит python3 (или подсказывает, что установить);
#    2. первый раз создаёт окружение .venv и ставит зависимости сервера;
#    3. запускает сервер, ждёт готовности и открывает сайт в браузере;
#    4. показывает адрес для телефона в той же сети Wi-Fi.
#
#  Порты: 6000 — приложения (ПК и Android) и API (как на сервере проекта);
#         8080 — сайт в браузере на этом компьютере, потому что порт 6000
#         Chrome/Edge блокируют как «небезопасный» (ERR_UNSAFE_PORT).
#         Оба порта обслуживает один и тот же процесс — данные общие.
#
#  Запуск:  bash tools/start-server.sh                    (6000 + 8080)
#           bash tools/start-server.sh 6000 8080          (оба порта вручную)
#           bash tools/start-server.sh 6000 6000          (один порт)
#           PORT=6000 SITEPORT=8080 NO_BROWSER=1 bash tools/start-server.sh
#
#  Остановка: Ctrl+C.
# ============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PORT="${1:-${PORT:-6000}}"                 # основной порт: приложения и API
SITEPORT="${2:-${SITEPORT:-8080}}"         # порт для браузера (6000 браузеры блокируют)
HOST="${HOST:-0.0.0.0}"
VENV="$ROOT/.venv"
PY="$VENV/bin/python"
REQ="$ROOT/server/requirements.txt"

say()  { printf '%s\n' "$*"; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
bad()  { printf '\033[31m%s\033[0m\n' "$*"; }

say "══════════════════════════════════════════════════════════════════════"
say "  ENCRYPTION — запуск мессенджера (сервер + сайт)"
say "  Каталог проекта: $ROOT"
say "══════════════════════════════════════════════════════════════════════"

for need in server/app.py web/index.html; do
  [ -f "$need" ] || { bad "✗ Не найден $need. Распакуйте архив целиком."; exit 2; }
done

# ── Python ──────────────────────────────────────────────────────────────────
SYSPY=""
for c in python3 python; do command -v "$c" >/dev/null 2>&1 && SYSPY="$c" && break; done
if [ -z "$SYSPY" ]; then
  bad "✗ Python 3 не найден."
  say "  macOS:  brew install python   (или https://www.python.org/downloads/macos/)"
  say "  Debian/Ubuntu: sudo apt install python3 python3-venv python3-pip"
  exit 3
fi
"$SYSPY" - <<'EOF' || { bad "✗ Нужен Python 3.10 или новее."; exit 3; }
import sys
sys.exit(0 if sys.version_info >= (3, 10) else 1)
EOF
say "→ Python: $("$SYSPY" -c 'import sys;print("%d.%d.%d"%sys.version_info[:3])')  ($(command -v "$SYSPY"))"

# ── Окружение и зависимости ────────────────────────────────────────────────
if [ ! -x "$PY" ]; then
  say "→ Первый запуск: создаю окружение .venv…"
  "$SYSPY" -m venv "$VENV" 2>/dev/null || {
    bad "✗ Не удалось создать .venv (нужен пакет python3-venv)."
    exit 4
  }
fi

if [ -z "${NO_INSTALL:-}" ]; then
  if "$PY" -c 'import fastapi, uvicorn, aiosqlite, argon2, cryptography' >/dev/null 2>&1; then
    say "→ Зависимости уже установлены."
  else
    say "→ Устанавливаю зависимости сервера (один раз)…"
    "$PY" -m pip install --upgrade pip --quiet --disable-pip-version-check
    "$PY" -m pip install -r "$REQ" --quiet --disable-pip-version-check || {
      bad "✗ Не удалось установить зависимости. Проверьте интернет и запустите снова."
      exit 4
    }
  fi
fi

if [ "$PORT" = "$SITEPORT" ]; then
  warn "⚠ Один порт и для приложений, и для браузера. Если это 6000 — сайт на этом компьютере в браузере не откроется."
fi

# ── Свободны ли порты ──────────────────────────────────────────────────────
port_busy() {
  command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":$1 " && return 0
  command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  return 1
}
BUSY=""
for p in "$PORT" "$SITEPORT"; do
  [ "$p" = "$SITEPORT" ] && [ "$p" = "$PORT" ] && [ "$BUSY" != "" ] && continue
  if port_busy "$p"; then BUSY="$p"; break; fi
done
if [ -n "$BUSY" ]; then
  bad "✗ Порт $BUSY уже занят (возможно, мессенджер уже запущен)."
  say "  Откройте http://127.0.0.1:$SITEPORT/ — или запустите с другими портами:"
  say "     bash tools/start-server.sh 6000 8080"
  exit 5
fi

# ── Адреса ─────────────────────────────────────────────────────────────────
LAN_IP=""
if command -v hostname >/dev/null 2>&1; then
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
[ -n "$LAN_IP" ] || LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"

say ""
ok "✓ Сервер запускается."
say "    сайт на этом компьютере:   http://127.0.0.1:$SITEPORT/"
[ -n "$LAN_IP" ] && say "    сайт с телефона (Wi-Fi):   http://$LAN_IP:$SITEPORT/"
say "    порт приложений и API:     $PORT"
[ -n "$LAN_IP" ] && say "    адрес для приложения:      http://$LAN_IP:$PORT"
say "    данные и файлы:            $ROOT/data"
say "    администратор:             ${ENC_ADMINS:-saniss}  (раздел «Админ-панель» в настройках)"
say ""
say "  Остановка сервера — Ctrl+C."
say "══════════════════════════════════════════════════════════════════════"
say ""

export ENC_HOST="$HOST" ENC_PORT="$PORT" ENC_DATA_DIR="$ROOT/data" ENC_WEB_DIR="$ROOT/web"
if [ "$SITEPORT" != "$PORT" ]; then
  export ENC_ALT_PORTS="$SITEPORT"
else
  export ENC_ALT_PORTS=""
fi
export ENC_PUBLIC_IP="${ENC_PUBLIC_IP:-127.0.0.1}"
export ENC_ADMINS="${ENC_ADMINS:-saniss}"

"$PY" -m server.app &
SRV=$!
trap 'kill $SRV 2>/dev/null' INT TERM EXIT

# ── Ждём готовности и открываем браузер ────────────────────────────────────
READY=0
for _ in $(seq 1 40); do
  sleep 0.5
  if command -v curl >/dev/null 2>&1 && curl -sf "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1; then
    READY=1; break
  fi
  kill -0 $SRV 2>/dev/null || break
done

SITE_OK=0
if [ "$READY" = "1" ] && [ "$SITEPORT" != "$PORT" ]; then
  for _ in $(seq 1 20); do
    if command -v curl >/dev/null 2>&1 && curl -sf "http://127.0.0.1:$SITEPORT/api/v1/health" >/dev/null 2>&1; then
      SITE_OK=1; break
    fi
    sleep 0.5
  done
  [ "$SITE_OK" = "1" ] || warn "⚠ Порт для браузера $SITEPORT не ответил — откройте сайт по адресу приложения или перезапустите."
fi

if [ "$READY" = "1" ]; then
  ok "✓ Сервер работает."
  if [ -z "${NO_BROWSER:-}" ] && { [ "$SITEPORT" = "$PORT" ] || [ "$SITE_OK" = "1" ]; }; then
    if command -v xdg-open >/dev/null 2>&1; then xdg-open "http://127.0.0.1:$SITEPORT/" >/dev/null 2>&1 || true
    elif command -v open >/dev/null 2>&1; then open "http://127.0.0.1:$SITEPORT/" >/dev/null 2>&1 || true
    fi
  fi
else
  bad "✗ Сервер не запустился — смотрите вывод выше."
fi

wait $SRV
say ""
say "Сервер остановлен."
