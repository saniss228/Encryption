#!/usr/bin/env bash
# ============================================================================
#  Encryption — установка сервера на VPS с белым IP (проверено на Debian 12/13,
#  Ubuntu 22.04/24.04). Запускать от root:  sudo bash deploy/install.sh
#
#  Что делает:
#    1) ставит Python, nginx, ufw
#    2) копирует проект в /opt/encryption и создаёт venv
#    3) ставит systemd-службу (порт 3000)
#    4) настраивает nginx на 80 порт → 3000 (сайт в браузере)
#    5) открывает 80/443 в файрволе
# ============================================================================
set -euo pipefail

PUBLIC_IP="${ENC_PUBLIC_IP:-45.90.45.92}"
BACKEND_PORT="${ENC_PORT:-3000}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DST_DIR="/opt/encryption"

echo "▶ Источник: $SRC_DIR"
echo "▶ Назначение: $DST_DIR (белый IP: $PUBLIC_IP, бэкенд-порт: $BACKEND_PORT)"

echo "▶ 1/6 Системные пакеты…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip nginx ufw curl rsync

echo "▶ 2/6 Пользователь и каталоги…"
id -u encryption >/dev/null 2>&1 || useradd -r -s /bin/false -d "$DST_DIR" encryption
mkdir -p "$DST_DIR"
tar --exclude=./data --exclude=./.git --exclude=./node_modules --exclude=./dist --exclude=./desktop/node_modules -cf - -C "$SRC_DIR" . | tar -xf - -C "$DST_DIR"
mkdir -p "$DST_DIR/data/files" "$DST_DIR/data/media" "$DST_DIR/data/logs"
chown -R encryption:encryption "$DST_DIR"

echo "▶ 3/6 Виртуальное окружение и зависимости…"
python3 -m venv "$DST_DIR/.venv"
"$DST_DIR/.venv/bin/pip" install --quiet --upgrade pip wheel
"$DST_DIR/.venv/bin/pip" install --quiet -r "$DST_DIR/server/requirements.txt"
chown -R encryption:encryption "$DST_DIR/.venv"

echo "▶ 4/6 systemd-служба…"
install -m 644 "$DST_DIR/deploy/encryption.service" /etc/systemd/system/encryption.service
sed -i "s/ENC_PUBLIC_IP=.*/ENC_PUBLIC_IP=$PUBLIC_IP/" /etc/systemd/system/encryption.service
sed -i "s/ENC_PORT=.*/ENC_PORT=$BACKEND_PORT/" /etc/systemd/system/encryption.service
systemctl daemon-reload
systemctl enable encryption >/dev/null
systemctl restart encryption
sleep 2
systemctl --no-pager --lines=5 status encryption || true

echo "▶ 5/6 nginx (порт 80 → $BACKEND_PORT)…"
install -m 644 "$DST_DIR/deploy/nginx-encryption.conf" /etc/nginx/sites-available/encryption
sed -i "s/server_name 45.90.45.92;/server_name $PUBLIC_IP;/" /etc/nginx/sites-available/encryption
ln -sf /etc/nginx/sites-available/encryption /etc/nginx/sites-enabled/encryption
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "▶ 6/6 Файрвол…"
ufw allow 22/tcp >/dev/null 2>&1 || true
ufw allow 80/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
# Порт 3000 открываем и снаружи: к нему напрямую подключаются приложения (ПК и Android)
ufw allow 3000/tcp >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

cat <<EOF

════════════════════════════════════════════════════════════════
 Готово! Мессенджер Encryption развёрнут.

 Сайт с мессенджером:  http://$PUBLIC_IP/            ← открывайте так
 Бэкенд:               http://127.0.0.1:$BACKEND_PORT  (порт открыт и наружу:
                       к нему напрямую подключаются приложения)

 Проверка:  curl -s http://127.0.0.1:$BACKEND_PORT/api/v1/health
 Логи:      journalctl -u encryption -f
 Данные:    $DST_DIR/data   (БД, файлы с TTL 24 ч, логи)
 Обновление: rsync проекта в $DST_DIR && systemctl restart encryption

 TLS/HTTPS (очень рекомендуется): нужен домен, привязанный к $PUBLIC_IP
   apt install -y certbot python3-certbot-nginx
   certbot --nginx -d ваш-домен.ru
════════════════════════════════════════════════════════════════
EOF
