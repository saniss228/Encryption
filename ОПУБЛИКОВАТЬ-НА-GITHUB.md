# Публикация Encryption на GitHub

Репозиторий: **https://github.com/saniss228/Encryption** (публичный)

## Состояние: версия 3.1.0 опубликована ✅

| Что | Значение |
|---|---|
| Публикация выполнена | 28.09.2026, обычное обновление (без `--force`) |
| Ветка `main` | `1f05c77` — 102 файла: сервер, сайт, ПК, Android, документация, тесты |
| Коммит версии | `258487a` — «Encryption 3.1.0 — третья версия мессенджера» |
| Тег | `v3.1.0` (отдельный коммит-объект, аннотированный) |
| Релиз | https://github.com/saniss228/Encryption/releases/tag/v3.1.0 — с APK, архивом сервера+сайта и комплектом публикации |
| Проверено из свежего клона | сервер 3.1.0 поднимается, админ-тесты 26/26, «только локально» 20/20, сайт отдаётся |
| История до 3.1.0 | сохранена: предыдущее состояние (`0586329`) и старые теги (`messenger`, `1.2.4`, `re-1.1.0…1.2.3`, `v1.2.3`) на месте |

Ниже — инструкции на случай выхода следующих версий (4.0 и т. д.): они повторяют то,
что уже делалось, и остаются рабочими.

---

## Способ 0. Скрипт из архива `ОТПРАВИТЬ-НА-GITHUB.zip` (ничего настраивать не нужно)

Скачайте `release/ОТПРАВИТЬ-НА-GITHUB.zip` (9,5 МБ), распакуйте и запустите:

* **Windows** — двойной клик по `ЗАПУСТИТЬ-WINDOWS.cmd` (рядом — `PUBLISH-WINDOWS.cmd`);

* **Linux / macOS** — `bash publish-to-github.sh`.

Скрипт один раз спросит токен (ввод скрыт, нигде не сохраняется) и отправит
всё сам: если установлен git — зальёт готовую историю из бандла; если git нет —
загрузит файлы напрямую через GitHub API (на Windows нужен только PowerShell).
Полная инструкция — в файле `КАК-ЗАПУСТИТЬ.txt` внутри архива.

---

## Способ 1. Постоянный токен GitHub (быстрее всего)

Создайте токен: GitHub → **Settings → Developer settings → Personal access tokens
→ Fine-grained tokens** → доступ к репозиторию `Encryption`, права **Contents: Read and write**.
Затем:

```bash
cd /home/user/encryption
git push https://x-access-token:ВАШ_ТОКЕН@github.com/saniss228/Encryption.git github-main:main --tags
```

Скрипт делает то же самое:

```bash
bash tools/push_github.sh https://github.com/saniss228/Encryption.git ВАШ_ТОКЕН
```

После публикации токен можно отозвать — он нужен только для этого запуша.
Ни в один файл репозитория токен не попадает.

---

## Способ 2. Без токена — через git-бандл

Бандл — это обычный файл с полной историей. Он лежит в
`release/encryption-3.1.0-github.bundle` (4,4 МБ) и содержит ветку публикации и тег `v3.1.0`.

```bash
git clone https://github.com/saniss228/Encryption.git enc && cd enc
git pull /путь/к/encryption-3.1.0-github.bundle github-main:main
git push origin main --tags
```

`pull` применит коммит и тег локально, `push` (уже с вашими обычными правами —
GitHub Desktop, credential helper, SSH-ключ) отправит их на GitHub.

---

## Способ 3. Совсем без git — загрузка файлов через сайт GitHub

1. Скачайте `release/encryption-3.1.0-all.zip` и распакуйте его.
2. На странице репозитория: **Add file → Upload files**.
3. Перетащите папки `server/`, `web/`, `desktop/`, `android/`, `deploy/`, `tools/`,
   `docs/` и файлы `README.md`, `.gitignore`, `.gitattributes`.
   Тяжёлые сборки (`release/*.exe`, `release/*.zip`) загружать не нужно — они
   собираются командой `bash tools/build_release.sh`.
4. Комментарий к коммиту: `Encryption 3.1.0 — третья версия мессенджера`.
5. Тег: **Releases → Draft a new release** → tag `v3.1.0` → publish.

---

## Что попадёт в репозиторий

```
server/       FastAPI: REST API + WebSocket + сайт, уборка файлов по TTL, админ-панель
web/          клиент (сайт = приложение ПК = приложение Android), 4 языка
desktop/      Electron-оболочка для Windows
android/      оболочка Android + скрипт сборки APK без Gradle
deploy/       install.sh, systemd, nginx (белый IP 45.90.45.92, порт 6000)
tools/        build_release.sh, build_apk.sh, run_tests.sh, тесты (крипто, API, UI, админ)
docs/         API.md (REST + WebSocket), SECURITY.md, DEPLOY.md, FEATURES.md, RECOVERY.md
README.md     обзор, быстрый старт, проверка
```

**Не попадут** (так настроен `.gitignore`): `data/` с базой и ключами,
`node_modules/`, `__pycache__/`, кэш сборки, готовые `release/*.exe` и `release/*.zip`.
APK (`android/` сборка, 612 КБ) остаётся — он помещается в репозиторий.

---

## Проверка после публикации

```bash
git ls-remote --heads --tags https://github.com/saniss228/Encryption.git | grep -E 'main|v3\.1\.0'
# ожидаем: 0de9e55…  refs/heads/main
#           …        refs/tags/v3.1.0
```

На GitHub: `main` должен показать `README.md`, папки `server/`, `web/`, `android/`,
`desktop/`, `docs/` и коммит «Encryption 3.1.0 — третья версия мессенджера».
