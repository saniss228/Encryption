#!/usr/bin/env bash
# ============================================================================
#  Публикация проекта Encryption на GitHub.
#
#  Запуск:
#     bash tools/push_github.sh <ссылка-на-репозиторий> [токен]
#
#  Примеры:
#     bash tools/push_github.sh https://github.com/username/encryption.git
#     bash tools/push_github.sh https://github.com/username/encryption.git ghp_xxxxxxxx
#
#  Без токена git спросит логин и пароль (пароль = Personal Access Token).
#  Токен можно получить: GitHub → Settings → Developer settings →
#  Personal access tokens → Tokens (classic) → Generate new token (scope: repo).
# ============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REMOTE_URL="${1:-}"
TOKEN="${2:-}"

if [ -z "$REMOTE_URL" ]; then
  echo "Укажите ссылку на репозиторий, например:"
  echo "  bash tools/push_github.sh https://github.com/username/encryption.git"
  exit 1
fi

# Подставляем токен в адрес, чтобы git не спрашивал пароль
if [ -n "$TOKEN" ]; then
  PUSH_URL="$(printf '%s' "$REMOTE_URL" | sed -E "s#https://#https://x-access-token:${TOKEN}@#")"
else
  PUSH_URL="$REMOTE_URL"
fi

git remote remove origin 2>/dev/null || true
git remote add origin "$REMOTE_URL"

echo "▶ 1/4 Проверяем состояние репозитория"
git add -A
if ! git diff --cached --quiet; then
  git commit -q -m "Encryption 3.0.0: локальные файлы, 4 языка, документация API" || true
fi
git log --oneline -3

echo "▶ 2/4 Тег версии"
git tag -f v3.0.0 -m "Encryption 3.0.0" >/dev/null 2>&1 || true
git tag | tail -3

echo "▶ 3/4 Отправляем ветки и тег"
# Ветка github-main построена поверх истории репозитория saniss228/Encryption,
# поэтому push в main проходит как fast-forward и ничего не перезаписывает.
if git show-ref --verify --quiet refs/heads/github-main; then
  SRC="github-main"
else
  SRC="$(git rev-parse --abbrev-ref HEAD)"
fi
echo "   отправляю ветку $SRC → main"
git push "$PUSH_URL" "$SRC:main" --tags

echo "▶ 4/4 Готово"
echo "  Репозиторий: $REMOTE_URL"
echo "  Ветка: main   Тег: v3.0.0"
if [ -n "$TOKEN" ]; then
  git remote set-url origin "$REMOTE_URL"   # не оставляем токен в конфиге
fi
