#!/usr/bin/env bash
# ============================================================================
#  Отправка Encryption 3.1.0 в GitHub — Linux и macOS.
#
#  Что делает:
#    1) если установлен git — отправляет готовую историю из бандла (одним коммитом);
#    2) если git нет (или отправка не прошла) — загружает файлы через GitHub API
#       (нужен python3, есть в Linux и на macOS с инструментами разработчика).
#
#  Запуск:   bash publish-to-github.sh
#  Токен:    спросит один раз (ввод скрыт) либо возьмите из GITHUB_TOKEN
#  Примеры:  bash publish-to-github.sh --token ghp_xxx
#            bash publish-to-github.sh --api-only        # только через API
#            GITHUB_REPO=логин/репозиторий bash publish-to-github.sh
#
#  Токен нигде не сохраняется.
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${GITHUB_REPO:-saniss228/Encryption}"
BRANCH="${GITHUB_BRANCH:-main}"
TAG="${GITHUB_TAG:-v3.1.0}"
TOKEN="${GITHUB_TOKEN:-}"
# Бандл и каталог с файлами ищем рядом со скриптом, затем в соседних каталогах
pick() {
  for c in "$@"; do [ -e "$c" ] && { (cd "$(dirname "$c")" && printf '%s/%s\n' "$(pwd)" "$(basename "$c")"); return 0; }; done
  printf '%s\n' "$1"; return 1
}
BUNDLE="$(pick "$HERE/encryption-3.1.0-github.bundle" "$HERE/../encryption-3.1.0-github.bundle" \
               "$HERE/../release/encryption-3.1.0-github.bundle" "$HERE/../../release/encryption-3.1.0-github.bundle")"
FILES="$(pick "$HERE/files" "$HERE/../files" "$HERE/../../files")"
GIT_URL="${GITHUB_URL:-https://github.com/$REPO.git}"
API_ONLY=0
GIT_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --token)   TOKEN="${2:-}"; shift 2 ;;
    --repo)    REPO="${2:-}"; GIT_URL="https://github.com/$REPO.git"; shift 2 ;;
    --tag)     TAG="${2:-}"; shift 2 ;;
    --api-only) API_ONLY=1; shift ;;
    --git-only) GIT_ONLY=1; shift ;;
    --help|-h) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Неизвестный параметр: $1 (см. --help)"; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
hr()   { say "══════════════════════════════════════════════════════════════════════"; }
fail() { say ""; say "✗ $*"; exit 1; }

hr
say " ОТПРАВКА ENCRYPTION 3.1.0 В GITHUB"
say " Репозиторий: https://github.com/$REPO   ветка: $BRANCH   тег: $TAG"
hr

# ── Токен ───────────────────────────────────────────────────────────────────
if [ -z "$TOKEN" ]; then
  say ""
  say "Нужен токен GitHub с правом записи в репозиторий"
  say "(GitHub → Settings → Developer settings → Personal access tokens →"
  say " Fine-grained tokens → доступ к $REPO → Contents: Read and write)."
  say ""
  say "Если git уже хранит вход в GitHub (GitHub Desktop, credential helper),"
  say "можно просто нажать Enter — отправим через git без токена."
  printf 'Токен (ввод скрыт, Enter — пропустить): '
  read -rs TOKEN
  printf '\n'
fi

# ── Способ 1: git + бандл ───────────────────────────────────────────────────
git_attempt() {
  command -v git >/dev/null 2>&1 || { say "  • git не установлен — этот способ пропускаю"; return 10; }
  [ -f "$BUNDLE" ] || { say "  • не найден файл бандла (encryption-3.1.0-github.bundle)"; return 11; }
  local tmp rc
  tmp="$(mktemp -d 2>/dev/null || mktemp -d -t encryption)" || return 12
  say ""
  say "① Отправляю через git (готовая история из бандла)"
  say "   бандл: $BUNDLE"
  if ! git clone -q "$BUNDLE" "$tmp/repo" >/dev/null 2>&1; then
    rm -rf "$tmp"; return 13
  fi
  git -C "$tmp/repo" checkout -q github-main 2>/dev/null
  git -C "$tmp/repo" remote set-url origin "$GIT_URL"
  if [ -n "$TOKEN" ]; then
    local push_url
    push_url="$(printf '%s' "$GIT_URL" | sed -E "s#https://#https://x-access-token:${TOKEN}@#")"
    GIT_TERMINAL_PROMPT=0 git -C "$tmp/repo" push "$push_url" "github-main:$BRANCH" --tags >"$tmp/push.log" 2>&1
  else
    GIT_TERMINAL_PROMPT=0 git -C "$tmp/repo" push origin "github-main:$BRANCH" --tags >"$tmp/push.log" 2>&1
  fi
  rc=$?
  if [ $rc -eq 0 ]; then
    say "  ✓ история отправлена"
    say ""
    tail -4 "$tmp/push.log" | sed 's/^/    /'
    rm -rf "$tmp"
    return 0
  fi
  say "  • через git не получилось:"
  tail -3 "$tmp/push.log" | sed 's/^/    /'
  rm -rf "$tmp"
  return 1
}

if [ "$API_ONLY" -eq 0 ]; then
  if git_attempt; then
    hr; say " ГОТОВО. Откройте: https://github.com/$REPO"; hr
    exit 0
  fi
  if [ "$GIT_ONLY" -eq 1 ]; then
    fail "git-отправка не прошла (см. сообщение выше)."
  fi
fi

# ── Способ 2: GitHub API без git ────────────────────────────────────────────
if [ -z "$TOKEN" ]; then
  fail "Для отправки через API нужен токен: bash $0 --token <ТОКЕН>"
fi

PY=""
for c in python3 python; do command -v "$c" >/dev/null 2>&1 && PY="$c" && break; done
[ -n "$PY" ] || fail "Нужен python3 (или установите git). В Ubuntu: sudo apt install python3"
[ -d "$FILES" ] || fail "Не найден каталог с файлами проекта ($FILES). Распакуйте архив целиком."

say ""
say "② Отправляю файлы через GitHub API (git не нужен)…"
"$PY" "$HERE/github_upload.py" --token "$TOKEN" --repo "$REPO" --branch "$BRANCH" \
      --tag "$TAG" --files "$FILES" || fail "отправка через API не удалась"

hr
say " ГОТОВО. Откройте: https://github.com/$REPO"
hr
