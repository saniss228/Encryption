#!/usr/bin/env bash
# ============================================================================
#  Сборка релиза Encryption: клиенты + архивы.
#
#    1) APK      → release/android/Encryption-<версия>.apk
#    2) EXE      → release/desktop/Encryption-<версия>-win-x64-portable.exe
#    3) сайт+сервер → release/encryption-<версия>-server-web.zip
#    4) всё в одном → release/encryption-<версия>-all.zip  (сервер + сайт + ПК + Android + документация)
#
#  Запуск:  bash tools/build_release.sh            # всё
#           bash tools/build_release.sh --no-exe   # без Windows-сборки (быстро)
#
#  Требуется: bash tools/setup_toolchain.sh (JDK + Android SDK),
#             для EXE — wine-префикс /opt/toolchain/wine-prefix и npm i в desktop/
# ============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
VERSION="$(grep -oP 'VERSION = "\K[0-9.]+' server/config.py | head -1)"
REL="$ROOT/release"
# Сборка идёт в каталоге рядом с проектом: /tmp может оказаться маленьким (tmpfs)
STAGE="$(mktemp -d "${ENC_STAGE_DIR:-$(dirname "$ROOT")}/.enc-release-XXXX")"
WITH_EXE=1
[ "${1:-}" = "--no-exe" ] && WITH_EXE=0

echo "════════ Сборка релиза Encryption ${VERSION} ════════"
mkdir -p "$REL/desktop" "$REL/android"

# ── 1. Сайт + сервер ────────────────────────────────────────────────────────
# Архивы собираем своим упаковщиком: имена в UTF-8 (иначе Windows покажет «?????»)
rm -f "$REL/encryption-${VERSION}-server-web.zip"
python3 tools/make_zip.py "$REL/encryption-${VERSION}-server-web.zip" . \
  server web deploy tools docs README.md \
  START-ENCRYPTION-WINDOWS.cmd "ЗАПУСТИТЬ-МЕССЕНДЖЕР-WINDOWS.cmd" \
  --exclude '**/__pycache__/**' --exclude '*.pyc' --exclude '*.db' --exclude 'data/**' \
  --exclude '**/node_modules/**'

# ── 2. Windows EXE ──────────────────────────────────────────────────────────
if [ "$WITH_EXE" = 1 ]; then
  echo "  → сборка EXE (несколько минут)…"
  ( cd desktop && WINEPREFIX="${WINEPREFIX:-/opt/toolchain/wine-prefix}" WINEARCH=win32 WINEDEBUG=-all \
      ELECTRON_BUILDER_CACHE="${ELECTRON_BUILDER_CACHE:-/tmp/eb-cache}" \
      npx electron-builder --win portable --x64 >/tmp/exe-build.log 2>&1 ) \
    || { echo "  ! EXE не собрался, смотрите /tmp/exe-build.log"; exit 1; }
  echo "  → EXE: $(du -h "$REL/desktop/Encryption-${VERSION}-win-x64-portable.exe" | cut -f1)"
fi

# ── 3. Всё в одном архиве ───────────────────────────────────────────────────
echo "  → сборка архива «всё в одном»…"
cp -a README.md docs server web deploy tools desktop android "$STAGE/"
cp -a START-ENCRYPTION-WINDOWS.cmd "ЗАПУСТИТЬ-МЕССЕНДЖЕР-WINDOWS.cmd" "$STAGE/"
# Готовые сборки, кэш и сгенерированные копии веб-клиента в архив не нужны
rm -rf "$STAGE"/desktop/node_modules "$STAGE"/desktop/dist "$STAGE"/android/build \
       "$STAGE"/android/assets/www "$STAGE"/desktop/build/win-* "$STAGE"/data
find "$STAGE" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$STAGE" -name '*.pyc' -delete 2>/dev/null || true

mkdir -p "$STAGE/release/desktop" "$STAGE/release/android"
cp -a "$REL/desktop/Encryption-${VERSION}-win-x64-portable.exe" "$STAGE/release/desktop/" 2>/dev/null || true
cp -a "$REL/android/Encryption-${VERSION}.apk" "$STAGE/release/android/"
cp -a "$REL/encryption-${VERSION}-server-web.zip" "$STAGE/release/"
cp -a "release/КАК-УСТАНОВИТЬ.txt" "$STAGE/release/" 2>/dev/null || true

cat > "$STAGE/СОДЕРЖИМОЕ.txt" <<EOF
Encryption ${VERSION} — что в архиве
════════════════════════════════════════════════════════════════════════

СЕРВЕР И САЙТ
  server/            FastAPI: REST API, WebSocket, раздача сайта, уборка файлов по TTL
  web/               клиент (общий для сайта, приложения ПК и Android): HTML/CSS/JS
  deploy/            install.sh, systemd-служба, конфиг nginx  → docs/DEPLOY.md

КЛИЕНТЫ
  release/desktop/Encryption-${VERSION}-win-x64-portable.exe   приложение для Windows (portable)
  release/android/Encryption-${VERSION}.apk                    приложение для Android
  desktop/           исходники оболочки ПК (Electron)
  android/           исходники оболочки Android + скрипт сборки APK

ДОКУМЕНТАЦИЯ
  docs/API.md         ПОЛНЫЙ СПРАВОЧНИК API: REST + WebSocket, примеры curl, лимиты
  docs/FEATURES.md    список функций мессенджера по версиям
  docs/DEPLOY.md      развёртывание на своём сервере, админ-панель, переменные окружения
  docs/SECURITY.md    модель угроз и криптография
  docs/ARCHITECTURE.md  как устроено внутри
  docs/RECOVERY.md    восстановление доступа (24 слова, второе устройство)
  README.md           обзор, быстрый старт, тесты

АДМИН-ПАНЕЛЬ
  Доступна аккаунту saniss (переменная ENC_ADMINS, по умолчанию saniss):
  Настройки → Приложение → Админ-панель. Управление пользователями, группами,
  файлами, рассылка объявлений, журнал безопасности, настройки сервера.
  Переписку администратор прочитать не может — на сервере только шифротекст.

ЗАПУСК ОДНОЙ КОМАНДОЙ
  ЗАПУСТИТЬ-МЕССЕНДЖЕР-WINDOWS.cmd   Windows: двойной клик — окружение, запуск, браузер
  START-ENCRYPTION-WINDOWS.cmd       то же самое латиницей (порт аргументом: 8080 / 9000 / …)
  tools/start-encryption.ps1         PowerShell: -Port -BindHost -NoBrowser -Reinstall
  tools/start-server.sh              Linux/macOS: bash tools/start-server.sh [порт]

ПРОВЕРКА
  bash tools/run_tests.sh                        крипто + API + «только локально» + админ-панель
  PUPPETEER_DIR=/tmp/ui bash tools/run_tests.sh  ещё и интерфейс в headless-браузере
EOF

python3 tools/make_zip.py "$REL/encryption-${VERSION}-all.zip" "$STAGE"
echo "  → всё в одном: $(du -h "$REL/encryption-${VERSION}-all.zip" | cut -f1)"
rm -rf "$STAGE"

echo
echo "════════ Готово ════════"
ls -lh "$REL" | grep -v '^total'
