#!/usr/bin/env bash
# ============================================================================
#  Установка инструментов для пересборки APK (JDK + Android SDK).
#  Ставит всё в /opt/toolchain, чтобы не раздувать каталог проекта.
#  Запуск:  bash tools/setup_toolchain.sh
# ============================================================================
set -euo pipefail
DEST="${TOOLCHAIN_DIR:-/opt/toolchain}"
mkdir -p "$DEST"
cd "$DEST"

echo "▶ 1/3 JDK 21…"
if [ ! -x "$DEST/jdk21/bin/java" ]; then
  curl -sSL -o jdk.tar.gz "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse?project=jdk"
  mkdir -p jdk21 && tar xzf jdk.tar.gz -C jdk21 --strip-components=1 && rm jdk.tar.gz
fi
"$DEST/jdk21/bin/java" -version 2>&1 | head -1

echo "▶ 2/3 Android cmdline-tools…"
if [ ! -x "$DEST/android-sdk/cmdline-tools/latest/bin/sdkmanager" ]; then
  curl -sSL -o cmdline.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
  mkdir -p android-sdk/cmdline-tools
  unzip -q -o cmdline.zip -d android-sdk/cmdline-tools
  mv -f android-sdk/cmdline-tools/cmdline-tools android-sdk/cmdline-tools/latest 2>/dev/null || true
  rm -f cmdline.zip
fi

echo "▶ 3/3 platform-tools + android-34 + build-tools 34.0.0…"
export JAVA_HOME="$DEST/jdk21"
export ANDROID_HOME="$DEST/android-sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
yes | sdkmanager --licenses >/dev/null 2>&1 || true
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0" 2>&1 | tail -2

# javac 11 для d8: в Debian/Ubuntu ставится пакетом
if ! command -v javac >/dev/null; then
  echo "  (нужен также javac 8–17 для d8: apt-get install -y openjdk-11-jdk-headless)"
fi
echo
echo "Готово. Теперь: ANDROID_HOME=$ANDROID_HOME JAVA_HOME=$JAVA_HOME bash tools/build_apk.sh"
