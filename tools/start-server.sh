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
#  Запуск:  bash tools/start-server.sh            (порт 8080)
#           bash tools/start-server.sh 9000       (свой порт)
#           PORT=8080 NO_BROWSER=1 bash tools/start-server.sh
#
#  Остановка: Ctrl+C.
# ============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PORT="${1:-${PORT:-8080}}"
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

if [ "$PORT" = "6000" ]; then
  warn "⚠ Порт 6000 браузеры блокируют (ERR_UNSAFE_PORT). Лучше 8080."
fi

# ── Свободен ли порт ───────────────────────────────────────────────────────
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  bad "✗ Порт $PORT уже занят (возможно, мессенджер уже запущен)."
  say "  Откройте http://127.0.0.1:$PORT/ или запустите с другим портом:"
  say "     bash tools/start-server.sh 8090"
  exit 5
fi

# ── Адреса ─────────────────────────────────────────────────────────────────
LAN_IP=""
if command -v hostname >/dev/null 2>&1; then
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
[ -n "$LAN_IP" ] || LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"

say ""
ok "✓ Сервер запускается:"
say "    на этом компьютере:  http://127.0.0.1:$PORT/"
[ -n "$LAN_IP" ] && say "    с телефона (та же сеть): http://$LAN_IP:$PORT/"
say "    данные и файлы:      $ROOT/data"
say "    администратор:       ${ENC_ADMINS:-saniss}  (раздел «Админ-панель» в настройках)"
say ""
say "  Остановка сервера — Ctrl+C."
say "══════════════════════════════════════════════════════════════════════"
say ""

export ENC_HOST="$HOST" ENC_PORT="$PORT" ENC_DATA_DIR="$ROOT/data" ENC_WEB_DIR="$ROOT/web"
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

if [ "$READY" = "1" ]; then
  ok "✓ Сервер работает."
  if [ -z "${NO_BROWSER:-}" ]; then
    if command -v xdg-open >/dev/null 2>&1; then xdg-open "http://127.0.0.1:$PORT/" >/dev/null 2>&1 || true
    elif command -v open >/dev/null 2>&1; then open "http://127.0.0.1:$PORT/" >/dev/null 2>&1 || true
    fi
  fi
else
  bad "✗ Сервер не запустился — смотрите вывод выше."
fi

wait $SRV
say ""
say "Сервер остановлен."
