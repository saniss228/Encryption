# Развёртывание на своём сервере (белый IP 45.90.45.92)

## ⚠️ Самое важное: порт 6000

Браузеры (Chrome, Firefox, Edge, Safari) **блокируют прямой доступ к порту 6000** —
он входит в список «небезопасных портов» (X11), и запрос обрывается с ошибкой
`ERR_UNSAFE_PORT`. Поэтому схема такая:

```
Пользователи → http://45.90.45.92  (порт 80/443, nginx)
                        │ proxy_pass
                        ▼
              127.0.0.1:6000  (FastAPI + WebSocket, наружу не смотрит)
```

Нативные приложения (EXE и APK) порт 6000 **могут** использовать напрямую — этот
запрет действует только на браузерные движки. Но рекомендуется всем давать адрес
через nginx: тогда один адрес работает и на сайте, и в приложениях, и открывается
путь к HTTPS.

## Быстрый старт (5 минут)

```bash
# на сервере, от root
sudo bash deploy/install.sh
```

Скрипт сделает: Python/venv → `/opt/encryption` → systemd-службу → nginx (80 → 6000)
→ файрвол (22/80/443 открыты, 6000 закрыт снаружи).

Проверка:

```bash
curl -s http://127.0.0.1:6000/api/v1/health      # {"status":"ok",...}
curl -s http://45.90.45.92/api/v1/health         # то же через nginx
journalctl -u encryption -f                       # логи
```

Откройте `http://45.90.45.92/` — это и есть сайт с мессенджером.

## Ручная установка (если скрипт не подходит)

```bash
apt update && apt install -y python3 python3-venv nginx ufw
useradd -r -s /bin/false -d /opt/encryption encryption
mkdir -p /opt/encryption && cp -r . /opt/encryption/
cd /opt/encryption && python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt
cp deploy/encryption.service /etc/systemd/system/ && systemctl enable --now encryption
cp deploy/nginx-encryption.conf /etc/nginx/sites-available/encryption
ln -s /etc/nginx/sites-available/encryption /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
ufw allow 22,80,443/tcp && ufw deny 6000/tcp && ufw enable
```

## Обновление версии

```bash
# локально
tar czf encryption.tar.gz --exclude data --exclude node_modules --exclude dist .
# на сервере
scp encryption.tar.gz root@45.90.45.92:/tmp/
ssh root@45.90.45.92 'tar xzf /tmp/encryption.tar.gz -C /opt/encryption && \
  /opt/encryption/.venv/bin/pip install -q -r /opt/encryption/server/requirements.txt && \
  systemctl restart encryption'
```
Данные в `/opt/encryption/data` не трогаются: там БД, файлы с TTL 24 ч и логи.

## Админ-панель (доступна аккаунту `saniss`)

Логины из `ENC_ADMINS` (по умолчанию — `saniss`) автоматически получают админ-права:
при регистрации и при каждом входе роль поднимается до `admin`, даже если базу правили
руками. Открыть панель: войти как `saniss` → **Настройки → Приложение → Админ-панель**.

Что внутри: обзор сервера, управление аккаунтами (блокировка с причиной, выход со всех
устройств, админ-права, удаление), группы, файлы, журнал безопасности, рассылка
объявлений всем клиентам, настройки (в том числе закрытая регистрация).

```bash
# в /etc/systemd/system/encryption.service
Environment=ENC_ADMINS=saniss,второй_логин
sudo systemctl daemon-reload && sudo systemctl restart encryption
```

Переписку администратор прочитать не может — на сервере только шифротекст.
Полное описание методов: [`docs/API.md`](API.md#91-админ-панель-apiv1admin).

## HTTPS (настоятельно рекомендуется)

Сертификат Let's Encrypt выдаётся на **домен**, а не на IP. Если есть домен:

```bash
apt install -y certbot python3-certbot-nginx
# A-запись домена → 45.90.45.92
certbot --nginx -d example.ru
```

После этого в `/etc/systemd/system/encryption.service` раскомментируйте
`ENC_TLS_CERT`/`ENC_TLS_KEY`, если хотите TLS и на самом бэкенде, и перезапустите
службу. Клиентам выдавайте адрес `https://example.ru` — WebSocket автоматически
станет `wss://`.

Если домена нет: оставьте HTTP, но помните, что метаданные (кто, кому, когда)
будут видны провайдеру и в сети. Сами сообщения и файлы всё равно зашифрованы.

## Переменные окружения

| Переменная | Значение по умолчанию | Смысл |
|---|---|---|
| `ENC_PORT` | `6000` | порт бэкенда |
| `ENC_HOST` | `0.0.0.0` | адрес прослушивания |
| `ENC_PUBLIC_IP` | `45.90.45.92` | адрес, который видит клиент |
| `ENC_DATA_DIR` | `./data` | БД, файлы, логи |
| `ENC_FILE_TTL_HOURS` | `24` | срок жизни файлов |
| `ENC_FILE_MAX_BYTES` | `209715200` | максимум на файл (200 МБ) |
| `ENC_MAX_DEVICES` | `4` | устройств на аккаунт |
| `ENC_DEVICE_COOLDOWN_DAYS` | `30` | карантин при смене аккаунта на устройстве |
| `ENC_JWT_SECRET` | генерируется | секрет подписи токенов (файл `data/.jwt.key`) |
| `ENC_ALLOWED_ORIGINS` | адрес сайта + localhost + `null` | CORS для нативных оболочек |
| `ENC_TLS_CERT` / `ENC_TLS_KEY` | — | включить HTTPS у самого uvicorn |
| `ENC_ADMINS` | `saniss` | логины администраторов через запятую: им доступна админ-панель |

## Резервное копирование

```bash
# БД + зашифрованные файлы (вложения всё равно удаляются через сутки)
sqlite3 /opt/encryption/data/encryption.db ".backup '/backup/encryption-$(date +%F).db'"
# ключ подписи токенов — храните отдельно: при его потере все сессии завершатся
cp /opt/encryption/data/.jwt.key /backup/
```

## Диагностика

| Симптом | Причина / решение |
|---|---|
| `ERR_UNSAFE_PORT` в браузере | Открываете `:6000` напрямую — используйте `http://45.90.45.92/` через nginx |
| Сайт открылся, но «сервер недоступен» | `systemctl status encryption`, проверьте `journalctl -u encryption` |
| WebSocket не подключается | В nginx должны быть заголовки `Upgrade`/`Connection` (см. `location /ws`) |
| Звонки не идут между разными NAT | Нужен TURN: `apt install coturn`, выдайте клиенту `ice_servers` с `turn:` — см. `/api/v1/calls` |
| Файлы «пропали» | Так и задумано: TTL 24 часа, фоновая уборка каждые 5 минут |
| «Устройство уже привязано к другому аккаунту» | Политика «1 аккаунт на устройство»: освободите устройство (карантин 30 дней) |
