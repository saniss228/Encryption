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
#  Порт: 3000 — и сайт в браузере, и API, и приложения (ПК и Android).
#  Один адрес для всего: порт 3000 браузеры не блокируют.
#
#  Запуск:  bash tools/start-server.sh                 (порт 3000)
#           bash tools/start-server.sh 9000            (свой порт)
#           PORT=3000 NO_BROWSER=1 bash tools/start-server.sh
#           ENC_LAN_IP=192.168.1.50 bash tools/start-server.sh   (адрес для телефона вручную)
#
#  Остановка: Ctrl+C.
# ============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PORT="${1:-${PORT:-3000}}"                 # порт: сайт, API и приложения
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

# ── Свободен ли порт ───────────────────────────────────────────────────────
port_busy() {
  command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":$1 " && return 0
  command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  return 1
}
if port_busy "$PORT"; then
  bad "✗ Порт $PORT уже занят (возможно, мессенджер уже запущен)."
  say "  Откройте http://127.0.0.1:$PORT/ — или запустите с другим портом:"
  say "     bash tools/start-server.sh 9000"
  exit 5
fi

# ── Адреса ─────────────────────────────────────────────────────────────────
# Адрес для телефона берём с настоящего сетевого адаптера, а не с виртуального
# (VPN, docker) и не с хот-спота Windows — иначе телефон не подключится.
LAN_IP="${ENC_LAN_IP:-}"
if [ -z "$LAN_IP" ]; then
  # 1) адрес интерфейса, через который идёт трафик по умолчанию
  if command -v ip >/dev/null 2>&1; then
    LAN_IP="$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)"
  fi
  # 2) если не вышло — первый обычный адрес из hostname -I
  if [ -z "$LAN_IP" ] && command -v hostname >/dev/null 2>&1; then
    LAN_IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -vE '^(127\.|169\.254\.|$)' | head -1)"
  fi
  # 3) macOS
  if [ -z "$LAN_IP" ]; then
    LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
  fi
fi
LAN_OTHERS=""
if command -v hostname >/dev/null 2>&1; then
  for _ip in $(hostname -I 2>/dev/null); do
    case "$_ip" in 127.*|169.254.*) continue ;; esac
    [ "$_ip" = "$LAN_IP" ] && continue
    LAN_OTHERS="$LAN_OTHERS $_ip"
  done
fi

say ""
ok "✓ Сервер запускается."
say "    на этом компьютере:        http://127.0.0.1:$PORT/"
[ -n "$LAN_IP" ] && say "    с телефона (та же сеть):   http://$LAN_IP:$PORT/"
say "    данные и файлы:            $ROOT/data"
say "    администратор:             ${ENC_ADMINS:-saness}  (раздел «Админ-панель» в настройках)"
[ -n "$LAN_OTHERS" ] && say "    другие адреса этого компьютера:$LAN_OTHERS"
say ""
say "  Остановка сервера — Ctrl+C."
say "══════════════════════════════════════════════════════════════════════"
say ""

export ENC_HOST="$HOST" ENC_PORT="$PORT" ENC_DATA_DIR="$ROOT/data" ENC_WEB_DIR="$ROOT/web"
export ENC_PUBLIC_IP="${ENC_PUBLIC_IP:-127.0.0.1}"
export ENC_ADMINS="${ENC_ADMINS:-saness}"

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
