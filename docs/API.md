# API Encryption v3.2.2

Полный справочник по HTTP и WebSocket API сервера **Encryption**.
Сервер ничего не знает о содержимом сообщений: он принимает и хранит только
шифротекст, оболочки ключей и подписи.

---

## 1. Общие сведения

| Параметр | Значение |
|---|---|
| Базовый адрес (сайт и API) | `http://45.90.45.92` (через nginx, порт 80/443) |
| Порт приложений (ПК/Android) | `6000` |
| Внутренний порт бэкенда | `6000` (uvicorn, за nginx) |
| Второй порт для браузера | `8080` локально — браузеры блокируют 6000 (`ERR_UNSAFE_PORT`), см. `ENC_ALT_PORTS` |
| Формат | JSON (`Content-Type: application/json`), файлы — октет-поток |
| Версия API | `v1` (`/api/v1/...`) |
| Версия продукта | `3.2.2` |
| Аутентификация | `Authorization: Bearer <access_token>` |
| Время жизни access-токена | 15 минут |
| Время жизни refresh-токена | 30 дней (ротация при каждом обновлении) |
| Хранение файлов | ровно 24 часа **или** до скачивания получателем |
| «Один аккаунт на устройство» | жёсткая привязка `device_id`, освобождение — карантин 30 дней |
| Администратор | логины из `ENC_ADMINS` (по умолчанию `saniss`) → раздел 9.1 |

Здоровье сервиса: `GET /api/v1/health` → `{"status":"ok","version":"3.2.2","file_ttl_hours":24,...}`

### Формат ошибок

```json
{ "error": { "code": "LOCAL_ONLY", "message": "Файл уже скачан: копии на сервере нет" } }
```

Коды, которые встречаются чаще всего:

| Код | HTTP | Смысл |
|---|---|---|
| `BAD_ENVELOPE` | 400 | конверт не той формы (нет слоя 1/2, подписи) |
| `PAYLOAD_TOO_LARGE` | 413 | сообщение больше лимита |
| `DEVICE_BOUND` | 409 | устройство уже привязано к другому аккаунту |
| `UNAUTHORIZED` | 401 | нет/просрочен токен |
| `FORBIDDEN` | 403 | нет доступа к чату или файлу |
| `FILE_GONE` | 404 | файл не найден |
| `FILE_EXPIRED` | 410 | истёк 24-часовой срок |
| `LOCAL_ONLY` | 410 | файл удалён после скачивания: копия только у получателя |
| `RATE_LIMITED` | 429 | слишком много попыток (пароль, фраза) |
| `ADMIN_ONLY` | 403 | метод доступен только администратору |
| `USER_BLOCKED` | 403 | аккаунт заблокирован администратором (в `message` — причина) |
| `REGISTRATION_CLOSED` | 403 | регистрация новых аккаунтов закрыта в админ-панели |
| `SELF_ACTION` | 400 | администратор пытается применить опасное действие к себе |
| `TARGET_IS_ADMIN` / `ROOT_ADMIN` | 403 / 400 | цель — администратор, которого менять нельзя |

---

## 2. Модель шифрования (что видит сервер)

Каждое сообщение — конверт, который сервер не разбирает:

```json
{
  "v": 2,
  "alg": "AES-256-GCM+RSA-4096-OAEP",
  "ts": 1790610000000,
  "l1":  { "alg": "AES-256-GCM", "iv": "…", "ct": "…" },
  "wrap": { "12": { "rsa": "…", "dh": "…" }, "13": { "rsa": "…", "dh": "…" } },
  "sig": "…", "signer": 12, "burn": false
}
```

* **Слой 1** — содержимое под симметричным ключом сообщения (AES-256-GCM, AAD `enc|<chatId>|<ts>`).
* **Слой 2** — тот же ключ, завёрнутый для каждого участника: `rsa` (RSA-4096-OAEP-SHA256) и `dh` (ECDH P-256 + AES-GCM, forward secrecy).
* **Подпись** — ECDSA P-256 по строке `ct1|chatId|ts`; ключ подписи у каждого устройства свой.
* Сервер проверяет только **форму** конверта и размер, содержимое прочитать не может.

Отпечатки и назначение ключей: `GET /api/v1/users/{username}/bundle`.

---

## 3. Аутентификация и устройства

### 3.1 Проверка устройства

`POST /api/v1/auth/device/check`

```json
{ "device_id": "0f6a…e1", "username": "anna" }
```

Ответ:

```json
{ "device_id": "0f6a…e1", "bound": true, "bound_to": "anna", "same_user": true,
  "released_at": null, "can_register": false, "quarantine_days": 30 }
```

### 3.2 Регистрация

`POST /api/v1/auth/register`

```json
{
  "username": "anna",
  "display_name": "Анна",
  "auth_hash": "PBKDF2-SHA512(пароль, соль=username, 310000)",
  "keys": {
    "ik_dh_pub": "…", "ik_sign_pub": "…", "rsa_pub": "…",
    "spk_pub": "…", "spk_sig": "…", "one_time_keys": ["…"]
  },
  "device": { "device_id": "0f6a…e1", "name": "Ноутбук", "platform": "web", "app_version": "3.2.2" },
  "key_backup": { "alg": "AES-256-GCM", "iv": "…", "ct": "…" },
  "recovery":  { "alg": "Argon2id+AES-GCM", "iv": "…", "ct": "…" }
}
```

Ответ `201`: `{"user":{…},"tokens":{"access_token","refresh_token","expires_in":900,"refresh_expires_in":2592000,"session_id"},"server":{…}}`

**Пароль в открытом виде не уходит никогда.** На сервер попадает только `auth_hash`.

### 3.3 Вход

`POST /api/v1/auth/challenge` → `{"challenge":"…","expires_in":120}`
`POST /api/v1/auth/login` → `{"username":"anna","challenge":"…","auth_hash":"…","device":{…}}`

Успешный вход выдаёт пару токенов; повторный вход с того же `device_id` — это «то же устройство».

### 3.4 Обновление и завершение сессии

| Метод | Путь | Назначение |
|---|---|---|
| `POST` | `/api/v1/auth/refresh` | `{"refresh_token":"…"}` → новая пара токенов (старый refresh гасится) |
| `POST` | `/api/v1/auth/logout` | завершить текущую сессию |
| `POST` | `/api/v1/auth/logout-all` | завершить все сессии аккаунта |
| `GET` | `/api/v1/auth/sessions` | список активных сессий (IP, устройство, время) |
| `POST` | `/api/v1/auth/sessions/revoke/{session_id}` | погасить сессию |
| `GET` | `/api/v1/auth/devices` | устройства аккаунта |
| `DELETE` | `/api/v1/auth/devices/{device_id}?release=true` | отвязать/освободить устройство |

### 3.5 «Тревожная кнопка»

`POST /api/v1/auth/panic` — разом: завершает все сессии, стирает бэкап ключей и
отвязывает все устройства, кроме текущего.

---

## 4. Восстановление доступа (забыли пароль)

Три независимых пути — выбирает пользователь.

### 4.1 Фраза из 24 слов (основной путь)

1. `POST /api/v1/auth/recover` — `{"username","phrase_proof","new_auth_hash","new_keys","new_key_backup"}`
   * `phrase_proof` — локально посчитанное подтверждение (`Argon2id(фраза) + случайная соль`), **сама фраза на сервер не отправляется**;
   * сервер сверяет хеш и выдаёт новый доступ, гася прежние сессии.
2. `POST /api/v1/auth/recover/keys` — `{"username","phrase_proof"}` → зашифрованный бэкап приватных ключей (расшифровка только на устройстве).

Инструкция для пользователя: `GET /api/v1/security/recovery-guide`.

### 4.2 Привязка нового устройства к работающему аккаунту

| Метод | Путь | Кто вызывает | Ответ |
|---|---|---|---|
| `POST` | `/api/v1/auth/pair/start` | новый (доверенный) аккаунт со старого устройства | `{"code":"482913","expires_in":300}` |
| `POST` | `/api/v1/auth/pair/approve` | старое устройство: `{"code":"482913","key_bundle":"…"}` | подтверждение |
| `POST` | `/api/v1/auth/pair/claim` | новый клиент: `{"code":"482913","device":{…}}` | токены новой сессии |
| `POST` | `/api/v1/auth/pair/cancel` | любой из двух | отмена |

### 4.3 Освобождение устройства

`GET /api/v1/security/devices/release-info` — сколько дней карантина осталось;
`DELETE /api/v1/auth/devices/{device_id}?release=true` — освободить устройство
(после 30 дней на нём можно создать другой аккаунт).

---

## 5. Чаты

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/api/v1/chats` | список чатов пользователя (с последним сообщением, непрочитанными) |
| `POST` | `/api/v1/chats` | создать чат: `{"type":"direct\|group\|saved","peer_username":"boris","title":"","members":["…"],"ttl_seconds":0}` |
| `GET` | `/api/v1/chats/{chat_id}` | карточка чата (участники, роли, TTL) |
| `PATCH` | `/api/v1/chats/{chat_id}` | название, аватар, `ttl_seconds` |
| `POST` | `/api/v1/chats/{chat_id}/members` | добавить/удалить участника, сменить роль |
| `POST` | `/api/v1/chats/{chat_id}/leave` | выйти из группы |
| `DELETE` | `/api/v1/chats/{chat_id}` | удалить чат у себя |
| `POST` | `/api/v1/chats/{chat_id}/pin` | закрепить/открепить чат в списке |
| `POST` | `/api/v1/chats/{chat_id}/archive` | архив |
| `POST` | `/api/v1/chats/{chat_id}/mute` | без звука до указанного времени |
| `POST` | `/api/v1/chats/{chat_id}/draft` | сохранить черновик |
| `POST` | `/api/v1/chats/{chat_id}/wallpaper` | обои чата |
| `POST` | `/api/v1/chats/{chat_id}/invite` | ссылка-приглашение в группу |
| `GET` | `/api/v1/chats/{chat_id}/invites` | активные приглашения |
| `POST` | `/api/v1/chats/join/{token}` | вступить по ссылке |
| `GET` | `/api/v1/chats/{chat_id}/search` | поиск по чату (по расшифрованному на устройстве) |
| `GET` | `/api/v1/chats/{chat_id}/stats` | статистика чата |

Типы чатов: `direct` (личный), `group` (до 200 участников), `saved` («Избранное» — личное хранилище).

---

## 6. Сообщения

| Метод | Путь | Назначение |
|---|---|---|
| `POST` | `/api/v1/messages` | отправить сообщение (конверт, см. §2) |
| `GET` | `/api/v1/messages?chat_id=…&limit=…&before=…&after=…` | история |
| `GET` | `/api/v1/messages/{message_id}` | одно сообщение |
| `GET` | `/api/v1/messages/{message_id}/context` | контекст вокруг сообщения (переход по ссылке) |
| `PATCH` | `/api/v1/messages/{message_id}` | изменить (окно 48 часов) |
| `DELETE` | `/api/v1/messages/{message_id}` | удалить у всех |
| `POST` | `/api/v1/messages/{message_id}/reaction` | `{"emoji":"🔥"}` |
| `POST` | `/api/v1/messages/{message_id}/receipt` | доставлено/прочитано |
| `POST` | `/api/v1/messages/{message_id}/pin` | закрепить сообщение |
| `POST` | `/api/v1/messages/read-all` | прочитать всё |
| `GET` | `/api/v1/messages/search/global?q=…` | поиск по всем чатам |

Отправка (фрагмент):

```json
{
  "chat_id": "u12-u13",
  "payload": { "v": 2, "l1": {…}, "wrap": {…}, "sig": "…", "signer": 12, "burn": false },
  "type": "file",
  "attachment_id": "f3a1…",
  "attachment_meta": { "name": "отчёт.pdf", "size": 152000, "mime": "application/pdf" },
  "ttl_seconds": 3600,
  "burn_after_read": false,
  "client_msg_id": "локальный-id-для-идемпотентности"
}
```

Поля `ttl_seconds` и `burn_after_read` включают самоуничтожение: сервер удаляет
сообщение по расписанию и рассылает событие `message.deleted`.
В JSON сообщения есть флаг **`local_only`** — «вложение удалено с сервера после
скачивания» (см. §7).

---

## 7. Файлы: 24 часа и «только локально»

Правило продукта: файл хранится на сервере **не больше 24 часов** и удаляется
**сразу после того, как получатель скачал его**. У удалённого файла остаётся
«надгробие» (запись без данных, 7 дней) — чтобы клиенты показали метку
**«Только локально / Local only»**.

### 7.1 Загрузка

1. `POST /api/v1/files/init`

```json
{ "chat_id": "u12-u13", "size": 3145728, "kind": "file", "mime": "application/pdf",
  "name_enc": "…имя, зашифрованное на устройстве…", "key_wrap": "…ключ файла в конверте…",
  "chunk_size": 1048576, "sha256": "…" }
```

Ответ `201`: `{"file_id":"f…","chunk_size":1048576,"chunks":3,"expires_at":…,"ttl_hours":24}`

2. `PUT /api/v1/files/{file_id}/chunk?index=N` — тело: зашифрованный чанк
   (`Content-Type: application/octet-stream`). Только владелец.
3. `POST /api/v1/files/{file_id}/complete` — проверка, что все чанки на месте.

Прогресс и остаток срока: `GET /api/v1/files/{file_id}/meta`, `GET /api/v1/files`.

### 7.2 Скачивание

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/api/v1/files/{file_id}/chunk?index=N` | отдать чанк (считается «получатель забрал») |
| `GET` | `/api/v1/files/{file_id}/raw` | отдать файл одним потоком |
| `GET` | `/api/v1/files/{file_id}/meta` | метаданные; для удалённого файла вернёт `local_only:true, on_server:false, size:0` |

Когда получатель забрал **последний** чанк, сервер через 45 секунд удаляет свою
копию (страховка на случай обрыва связи). Клиент может ускорить это:

### 7.3 Подтверждение «скачано и расшифровано»

`POST /api/v1/files/{file_id}/consumed`

```json
{ "ok": true, "local_only": true, "deleted_from_server": true,
  "message": "Файл удалён с сервера: копия осталась только на вашем устройстве" }
```

Что происходит на сервере: каталог с чанками стирается, `size=0`, ключ и имя
обнуляются, ставится `local_only=1`, в чат уходит событие `file.consumed`,
в журнал пишется `file_consumed`.

### 7.4 Статус «только локально»

`GET /api/v1/files/{file_id}/local-only`

```json
{ "file_id": "f…", "local_only": true, "on_server": false,
  "consumed_at": 1790610123, "consumed_by": 13,
  "policy": "Файл хранится на сервере максимум 24 часа и удаляется сразу после скачивания получателем" }
```

### 7.5 После удаления

| Запрос | Ответ |
|---|---|
| любой повторный `chunk` / `raw` | `410 {"error":{"code":"LOCAL_ONLY"}}` |
| `meta` | `200` с `local_only:true` (карточка «только локально») |
| `DELETE /api/v1/files/{file_id}` (владелец) | файл стёрт безвозвратно |

Прочее:

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/api/v1/files/storage/status` | занятое место, число файлов, сроки |
| `POST` | `/api/v1/files/media/upload` | загрузка аватара/обоев (шифруется так же) |
| `GET` | `/api/v1/files/media/{media_id}` | отдать медиа |

---

## 8. Пользователи, контакты, звонки

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/api/v1/users/me` | свой профиль |
| `PATCH` | `/api/v1/users/me` | имя, «о себе» |
| `GET` | `/api/v1/users/me/keys` | свои публичные ключи |
| `PUT` | `/api/v1/users/me/keys` | ротация ключей |
| `GET` | `/api/v1/users/me/backup` | зашифрованный бэкап приватных ключей |
| `PUT` | `/api/v1/users/me/backup` | сохранить бэкап (+ `recovery_wrap`, `recovery_phrase_hash`, `recovery_hint`) |
| `GET` | `/api/v1/users/search?q=…` | поиск людей по логину/имени |
| `GET` | `/api/v1/users/by-id/{user_id}` | профиль по id |
| `GET` | `/api/v1/users/{username}` | профиль по логину |
| `GET` | `/api/v1/users/{username}/bundle` | **публичные ключи для конверта** |
| `GET` | `/api/v1/contacts` | контакты |
| `PUT` / `DELETE` | `/api/v1/contacts/{user_id}` | добавить / удалить контакт |
| `POST` | `/api/v1/calls` | начать звонок: `{"chat_id":"…","kind":"audio\|video"}` → `{"call_id","ice_servers"}` |
| `PATCH` | `/api/v1/calls/{call_id}` | принять/отклонить/завершить |
| `GET` | `/api/v1/calls` | история звонков |
| `GET` | `/api/v1/security/log` | журнал безопасности (входы, отвязки, удаления файлов) |

---

## 9. Служебные точки

| Метод | Путь | Ответ |
|---|---|---|
| `GET` | `/api/v1/health` | `{"status":"ok","app":"Encryption","version":"3.2.2","file_ttl_hours":24}` |
| `GET` | `/api/v1/security/policy` | четыре слоя защиты и правила хранения файлов |
| `GET` | `/api/v1/site/info` | сведения для клиента (версия, лимиты) |
| `GET` | `/` | сайт (одностраничный клиент) |
| `GET` | `/join/{token}` | страница «вступить в группу по ссылке» |
| `GET` | `/manifest.webmanifest`, `/sw.js` | PWA-манифест и service worker |

---

## 9.1 Админ-панель (`/api/v1/admin/...`)

Доступ: только аккаунты из списка администраторов (`ENC_ADMINS`, по умолчанию — `saniss`).
Каждый запрос проверяется на сервере; права нельзя получить через клиент.
Обычному пользователю любой админ-метод отвечает
`403 {"error":{"code":"ADMIN_ONLY"}}`.

Главное ограничение заложено в саму архитектуру: **администратор не может читать
переписку или файлы** — на сервере хранится только шифротекст, а ключи есть
только на устройствах. Панель управляет аккаунтами, группами, файлами и
настройками, но не содержимым сообщений.

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/admin/overview` | сводка сервера: пользователи (всего/онлайн/заблокированные/админы), чаты, группы, сообщения (всего и за 24 ч), файлы (на сервере, «только локально», занято байт), сессии и устройства, события журнала за сутки, место на диске, состояние регистрации |
| `GET` | `/admin/users?q=&filter=&limit=&offset=` | список аккаунтов; `filter`: `all` \| `blocked` \| `admins` \| `online`; поиск по логину и имени |
| `GET` | `/admin/users/{id}` | карточка: сессии, устройства, чаты, файлы, последние события журнала |
| `POST` | `/admin/users/{id}/block` | блокировка: `{"reason"}` → пользователь выкидывается со всех устройств, вход запрещён (`403 USER_BLOCKED`), по WebSocket приходит `account.blocked` |
| `POST` | `/admin/users/{id}/unblock` | снять блокировку |
| `POST` | `/admin/users/{id}/logout` | завершить все сессии аккаунта (событие `device.revoked`) |
| `POST` | `/admin/users/{id}/role` | выдать/снять админ-права: `{"role":"admin"\|"user"}`; основного админа из `ENC_ADMINS` снять нельзя |
| `DELETE` | `/admin/users/{id}` | полное удаление: сессии, устройства, контакты, файлы с диска, сообщения, собственные группы |
| `GET` | `/admin/chats?type=group&q=` | список групп с числом участников и сообщений |
| `DELETE` | `/admin/chats/{chat_id}` | распустить группу (участники получают `chat.deleted`) |
| `GET` | `/admin/files?filter=on_server\|local_only\|expired\|all` | файлы: владелец, размер, срок жизни, признак «только локально» |
| `DELETE` | `/admin/files/{file_id}` | удалить файл с диска сервера |
| `POST` | `/admin/files/purge` | уборка: истёкшие файлы и «надгробия» старше 7 дней |
| `GET` | `/admin/audit?limit=&user_id=&event=` | журнал безопасности: входы, отвязка устройств, удаление файлов, действия администратора, последние входы из браузера |
| `GET` | `/admin/announcements` | все объявления (активные и отключённые) |
| `POST` | `/admin/broadcast` | объявление всем: `{"text","level":"info\|warning\|critical","ttl_seconds"}` → онлайн-клиенты получают `announcement` мгновенно |
| `DELETE` | `/admin/announcements/{id}` | отключить объявление (событие `announcement.off`) |
| `GET` | `/admin/settings` | настройки сервера + параметры окружения (список админов, срок хранения, лимиты) |
| `PUT` | `/admin/settings` | `{"registration_open":bool,"welcome_note":str}` — закрыть регистрацию новых аккаунтов, текст приветствия |
| `GET` | `/announcements` | **клиентская точка**: активные объявления, состояние регистрации, приветственная заметка (доступна любому вошедшему клиенту) |

Особенности:

* защита от опасных ошибок админа: себя заблокировать/удалить нельзя (`400 SELF_ACTION`),
  другого администратора изменить нельзя (`403 TARGET_IS_ADMIN`);
* роль восстанавливается автоматически: логин из `ENC_ADMINS` получает `role=admin`
  при регистрации и при каждом входе, даже если базу правили вручную;
* удаление аккаунта снимает файлы с диска физически — в журнале остаётся запись
  `admin_user_deleted` с логином и числом удалённых файлов;
* в интерфейсе чата объявление показывается баннером; критичные объявления
  дополнительно всплывают уведомлением.

Пример: заблокировать нарушителя и объявить об обслуживании.

```bash
TOKEN=<access_token администратора>

# найти пользователя
curl -s "$BASE/api/v1/admin/users?q=ivan" -H "Authorization: Bearer $TOKEN"

# заблокировать (все устройства выйдут, вход будет закрыт)
curl -s -X POST "$BASE/api/v1/admin/users/42/block" \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"reason":"Рассылка спама"}'

# объявление всем пользователям
curl -s -X POST "$BASE/api/v1/admin/broadcast" \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"text":"Ночью с 2:00 до 3:00 возможны перерывы","level":"warning"}'
```

---

## 10. WebSocket: события в реальном времени

`GET /ws?token=<access_token>` (WebSocket). Клиент получает JSON-события:

| `t` | Когда приходит | Поля |
|---|---|---|
| `hello` | сразу после подключения | `user_id`, `device_id`, `server_time` |
| `message` | новое сообщение в чате | `message` (готовый `message_json`) |
| `message.new` | то же, «тонкое» уведомление | `chat_id`, `message_id`, `sender_id` |
| `message.edited` / `message.deleted` | правка/удаление | `chat_id`, `message_id` |
| `message.reaction` / `message.receipt` / `message.pinned` | реакции, доставка, закрепы | `chat_id`, `message_id`, … |
| `read` | кто-то прочитал | `chat_id`, `user_id`, `up_to` |
| `typing` | «печатает…» | `chat_id`, `user_id`, `state` |
| `presence` | кто-то вошёл/вышел | `user_id`, `online`, `at` |
| `chat.created` / `chat.updated` / `chat.deleted` | изменения чата | `chat_id` |
| `chat.member.add` / `chat.member.remove` / `chat.member.role` | состав группы | `chat_id`, `user_id` |
| **`file.consumed`** | **получатель скачал файл — копия удалена с сервера** | `file_id`, `chat_id`, `by_user_id`, `reason`, `at`, `local_only:true` |
| `call.invite` / `call.signal` / `call.state` | сигнализация звонков | `call_id`, `from`, `state` |
| `device.revoked` | устройство отключено в настройках или администратором | `device_id` |
| **`announcement`** | **администратор разослал объявление** | `id`, `text`, `level`, `at` |
| **`announcement.off`** | **объявление отключено** | `id` |
| **`account.blocked`** | **аккаунт заблокирован администратором** | `reason` |
| `sync` | список онлайн-пользователей | `online: [...]` |
| `pong` | ответ на `ping` | `at` |

Событие `file.consumed` — ключевое для метки «только локально»: его получают все
устройства участников чата, включая отправителя, и сразу показывают бейдж
`🔒 Local only · Только локально` на карточке вложения.

---

## 11. Примеры

### 11.1 Отправка сообщения (curl)

```bash
TOKEN="…access_token…"

# 1. Публичные ключи собеседника (для конверта)
curl -s "http://45.90.45.92/api/v1/users/boris/bundle" -H "Authorization: Bearer $TOKEN"

# 2. Отправка (payload уже собран на устройстве клиентом)
curl -s -X POST "http://45.90.45.92/api/v1/messages" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"chat_id":"u12-u13","type":"text","payload":{"v":2,"l1":{"ct":"…"},"wrap":{"13":{"rsa":"…","dh":"…"}},"sig":"…","signer":12}}'
```

### 11.2 Файл: загрузка → скачивание → «только локально»

```bash
# загрузка
FID=$(curl -s -X POST "http://45.90.45.92/api/v1/files/init" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"chat_id":"u12-u13","size":1048576,"kind":"file","chunk_size":1048576}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["file_id"])')
curl -s -X PUT "http://45.90.45.92/api/v1/files/$FID/chunk?index=0" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/octet-stream" --data-binary @chunk0.enc
curl -s -X POST "http://45.90.45.92/api/v1/files/$FID/complete" -H "Authorization: Bearer $TOKEN"

# получатель скачал чанки, расшифровал на устройстве и подтверждает
curl -s -X POST "http://45.90.45.92/api/v1/files/$FID/consumed" -H "Authorization: Bearer $TOKEN_BORIS"
# → {"ok":true,"local_only":true,"deleted_from_server":true,…}

# копии больше нет
curl -s "http://45.90.45.92/api/v1/files/$FID/chunk?index=0" -H "Authorization: Bearer $TOKEN_BORIS"
# → 410 {"error":{"code":"LOCAL_ONLY", …}}
```

---

## 12. Ограничения и правила

| Правило | Значение |
|---|---|
| Максимальный размер файла | 200 МБ (настраивается `ENC_FILE_MAX_BYTES`) |
| Размер чанка | 64 КиБ … 8 МиБ (по умолчанию 1 МиБ) |
| Размер сообщения (конверт) | до 64 КБ (настраивается `ENC_MAX_MESSAGE_BYTES`) |
| Срок хранения файла | 24 часа или до скачивания получателем |
| «Надгробие» после скачивания | 7 дней (затем запись удаляется) |
| Срок хранения сообщения с TTL | 60 секунд … 90 дней |
| Участников в группе | до 200 (`ENC_GROUP_MAX`) |
| Частота запросов | 240 запросов/мин на IP (`ENC_RATE_LIMIT`), иначе `429 RATE_LIMITED` |
| Одно устройство — один аккаунт | жёстко; освобождение через 30 дней |
| Логи | IP, устройство, действие; содержимое сообщений не пишется никогда |

---

**Связанные документы:** [ARCHITECTURE.md](ARCHITECTURE.md) · [SECURITY.md](SECURITY.md) ·
[RECOVERY.md](RECOVERY.md) · [DEPLOY.md](DEPLOY.md) · [FEATURES.md](FEATURES.md)
