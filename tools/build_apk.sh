#!/usr/bin/env bash
# ============================================================================
#  Сборка APK без Gradle: aapt2 → javac → d8 → zipalign → apksigner.
#  Требуется: JDK 17+, Android SDK (platforms/android-34, build-tools/34.0.0).
#
#  Запуск:  bash tools/build_apk.sh
#  Результат: release/android/Encryption-3.0.0.apk
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AND="$ROOT/android"
OUT="$ROOT/release/android"
# Версия берётся из server/config.py — единый источник для сервера, сайта и клиентов
APP_VERSION="$(grep -oP 'VERSION = "\K[0-9.]+' "$ROOT/server/config.py" | head -1)"
APP_VERSION="${APP_VERSION:-3.2.0}"
VERSION_CODE="$(printf '%s' "$APP_VERSION" | awk -F. '{printf "%d", $1*10000 + $2*100 + $3}')"

# Версия в AndroidManifest.xml должна совпадать с версией релиза: aapt2 подставляет
# --version-name/--version-code только тогда, когда значения не заданы в манифесте.
MANIFEST="$ROOT/android/AndroidManifest.xml"
if [ -f "$MANIFEST" ]; then
  sed -i -E "s/(android:versionCode=\")[0-9]+(\")/\1${VERSION_CODE}\2/; s/(android:versionName=\")[0-9.]+(\")/\1${APP_VERSION}\2/" "$MANIFEST"
fi
BUILD="$AND/build"

# ── Пути к инструментам ───────────────────────────────────────────────────
# Пути ищутся в порядке: переменные окружения → /opt/toolchain (см. tools/setup_toolchain.sh) → домашний каталог
if [ -z "${JAVA_HOME:-}" ]; then
  for c in /opt/toolchain/jdk21 /opt/jdk21 "$HOME/.jdk"; do [ -x "$c/bin/javac" ] && JAVA_HOME="$c" && break; done
fi
if [ -z "${ANDROID_HOME:-}" ]; then
  for c in /opt/toolchain/android-sdk /opt/android-sdk "$HOME/.android-sdk"; do [ -d "$c/platforms" ] && ANDROID_HOME="$c" && break; done
fi
export JAVA_HOME="${JAVA_HOME:-}"
SDK="${ANDROID_HOME:-}"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
PATH="$JAVA_HOME/bin:$BT:$PATH"

# d8 из build-tools 34 стабильно работает с байткодом, который генерирует javac 8–17.
# JDK 21+ даёт class-файлы, на которых d8 падает с внутренней ошибкой, поэтому
# для компиляции приложения берём javac 11/17, а для инструментов — любой JDK.
if [ -x /usr/bin/javac ]; then JAVAC=/usr/bin/javac; else JAVAC="$JAVA_HOME/bin/javac"; fi
"$JAVAC" -version 2>&1 | head -1
[ -x "$JAVAC" ] || { echo "Нет javac. Установите JDK: bash tools/setup_toolchain.sh"; exit 1; }
[ -f "$PLATFORM" ] || { echo "Нет android.jar: $PLATFORM"; echo "Запустите: bash tools/setup_toolchain.sh"; exit 1; }
[ -x "$BT/aapt2" ] || { echo "Нет aapt2 в $BT"; echo "Запустите: bash tools/setup_toolchain.sh"; exit 1; }

echo "▶ 1/7 Подготовка каталогов"
rm -rf "$BUILD" "$OUT"
mkdir -p "$BUILD"/{compiled,gen,classes,dex} "$OUT"

echo "▶ 2/7 Копируем веб-клиент в assets (тот же UI, что на сайте и ПК)"
mkdir -p "$AND/assets/www"
rm -rf "$AND/assets/www"; mkdir -p "$AND/assets/www"; cp -a "$ROOT/web/." "$AND/assets/www/"
# каталог assets в APK не должен содержать лишнего
rm -f "$AND/assets/www/"*.map

echo "▶ 3/7 Компиляция ресурсов (aapt2 compile)"
"$BT/aapt2" compile --dir "$AND/res" -o "$BUILD/compiled/res.zip"
mkdir -p "$BUILD/compiled/flat" && (cd "$BUILD/compiled/flat" && unzip -q -o ../res.zip)

echo "▶ 4/7 Линковка (aapt2 link) → base APK + R.java"
"$BT/aapt2" link \
  -o "$BUILD/base.apk" \
  -I "$PLATFORM" \
  --manifest "$AND/AndroidManifest.xml" \
  --java "$BUILD/gen" \
  $(find "$BUILD/compiled/flat" -name '*.flat' | sort) \
  -A "$AND/assets" \
  --min-sdk-version 23 --target-sdk-version 34 \
  --version-code "${VERSION_CODE:-40200}" --version-name "${APP_VERSION}" \
  --no-version-vectors

echo "▶ 5/7 Компиляция Java (javac)"
mkdir -p "$BUILD/classes"
"$JAVAC" -encoding UTF-8 -source 1.8 -target 1.8 -nowarn \
  -classpath "$PLATFORM" \
  -d "$BUILD/classes" \
  $(find "$AND/src" "$BUILD/gen" -name '*.java')

echo "▶ 6/7 DEX (d8)"
"$BT/d8" --release --min-api 23 --lib "$PLATFORM" \
  --output "$BUILD/dex" $(find "$BUILD/classes" -name '*.class')

echo "▶ 7/7 Упаковка, выравнивание и подпись"
cp "$BUILD/base.apk" "$BUILD/unsigned.apk"
(cd "$BUILD/dex" && zip -q -X "$BUILD/unsigned.apk" classes.dex)
"$BT/zipalign" -f -p 4 "$BUILD/unsigned.apk" "$BUILD/aligned.apk"

KS="$AND/keystore/encryption.keystore"
if [ ! -f "$KS" ]; then
  echo "  • создаём самоподписанный ключ (замените на свой для публикации)"
  mkdir -p "$(dirname "$KS")"
  keytool -genkeypair -v -keystore "$KS" -alias encryption -keyalg RSA -keysize 4096 \
    -validity 10950 -storepass encryption -keypass encryption \
    -dname "CN=Encryption, OU=Encryption Messenger, O=Encryption, L=Tirana, C=AL" >/dev/null 2>&1
fi

"$BT/apksigner" sign --ks "$KS" --ks-key-alias encryption \
  --ks-pass pass:encryption --key-pass pass:encryption \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --out "$OUT/Encryption-${APP_VERSION}.apk" "$BUILD/aligned.apk"

"$BT/apksigner" verify --print-certs "$OUT/Encryption-${APP_VERSION}.apk" | head -5

SIZE=$(du -h "$OUT/Encryption-${APP_VERSION}.apk" | cut -f1)
echo
echo "════════════════════════════════════════════"
echo " APK готов: $OUT/Encryption-${APP_VERSION}.apk ($SIZE)"
echo " Установка: adb install -r $OUT/Encryption-${APP_VERSION}.apk"
echo "           или скопировать файл на телефон и открыть"
echo "════════════════════════════════════════════"
