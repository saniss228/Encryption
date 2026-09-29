/* ============================================================================
 * Encryption — десктоп-приложение (Electron).
 * UI тот же, что на сайте (общие файлы из ../web), отличается только оболочка:
 *  • окно, трей, системные уведомления, ярлыки, автозапуск;
 *  • подключение к вашему серверу Encryption (адрес задаётся один раз при первом запуске);
 *  • безопасность: контекст изолирован, nodeIntegration выключен, разрешено
 *    только общение с вашим сервером.
 * ========================================================================== */
const { app, BrowserWindow, Menu, Tray, shell, ipcMain, dialog, nativeImage, session } = require('electron');
const path = require('path');
const fs = require('fs');

// Адрес боевого сервера (как в APK и на сайте: порт 3000). Меняется
// пользователем в «Настройки → Сервер»; после смены применяется при входе.
const DEFAULT_SERVER = 'http://45.90.45.92:3000';
let win = null;
let tray = null;

/* ── Конфиг приложения (адрес сервера, настройки окна) ───────────────────── */
const configPath = () => path.join(app.getPath('userData'), 'config.json');
// Адрес, сохранённый до перехода на порт 3000 (6000 или 8080), переводим на 3000
function toCurrentPort(url) {
  try {
    const u = new URL(url);
    if (u.port === '6000' || u.port === '8080') return u.protocol + '//' + u.hostname + ':3000';
  } catch (e) { /* не адрес — оставляем как есть */ }
  return '';
}
function readConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (cfg && cfg.serverUrl) {
      const fixed = toCurrentPort(cfg.serverUrl);
      if (fixed) { cfg.serverUrl = fixed; writeConfig({ serverUrl: fixed }); }
    }
    return cfg || {};
  } catch (e) { return {}; }
}
function writeConfig(patch) {
  const cfg = Object.assign(readConfig(), patch);
  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2)); } catch (e) {}
  return cfg;
}

const WEB_DIR = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(__dirname, '..', 'web');
const INDEX = 'file://' + path.join(WEB_DIR, 'index.html');

function createWindow() {
  const cfg = readConfig();
  win = new BrowserWindow({
    width: cfg.windowWidth || 1280,
    height: cfg.windowHeight || 840,
    minWidth: 380,
    minHeight: 520,
    title: 'Encryption',
    backgroundColor: '#0b1020',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
      // Медиа для звонков
      backgroundThrottling: false,
    },
  });

  win.loadURL(INDEX + '?server=' + encodeURIComponent(cfg.serverUrl || DEFAULT_SERVER));

  win.on('resize', () => {
    if (win && !win.isMinimized()) {
      const [w, h] = win.getSize();
      writeConfig({ windowWidth: w, windowHeight: h });
    }
  });
  win.on('close', (e) => {
    if (!app.isQuitting && readConfig().minimizeToTray) { e.preventDefault(); win.hide(); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  // Внешние запросы: не пускаем на произвольные домены (защита от подмены UI)
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => {
    const url = new URL(details.url);
    const allowed = (readConfig().allowAnyServer === true) ||
      ['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.hostname === new URL(readConfig().serverUrl || DEFAULT_SERVER).hostname ||
      url.hostname.endsWith('.encryption.local');
    const isLocal = details.url.startsWith('file://');
    cb({ cancel: !(allowed || isLocal) });
  });
}

/* ── Трей ───────────────────────────────────────────────────────────────── */
function createTray() {
  try {
    const iconPath = path.join(__dirname, 'build', 'icon.png');
    tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 }));
    tray.setToolTip('Encryption — защищённый мессенджер');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Открыть Encryption', click: () => { win && (win.show(), win.focus()); } },
      { label: 'Свернуть в трей при закрытии', type: 'checkbox', checked: !!readConfig().minimizeToTray,
        click: (i) => writeConfig({ minimizeToTray: i.checked }) },
      { type: 'separator' },
      { label: 'Проверить обновления…', click: () => dialog.showMessageBox({ message: 'Обновление: скачайте новую версию с сайта сервера.' }) },
      { label: 'Выход', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    tray.on('double-click', () => { win && (win.show(), win.focus()); });
  } catch (e) { console.warn('tray', e.message); }
}

/* ── Меню приложения ────────────────────────────────────────────────────── */
function buildMenu() {
  const template = [
    {
      label: 'Файл',
      submenu: [
        { label: 'Новый чат', accelerator: 'CmdOrCtrl+N', click: () => win && win.webContents.executeJavaScript("document.getElementById('newChatBtn').click()") },
        { label: 'Настройки', accelerator: 'CmdOrCtrl+,', click: () => win && win.webContents.executeJavaScript("document.getElementById('meBtn').click()") },
        { type: 'separator' },
        { label: 'Адрес сервера…', click: askServer },
        { label: 'Свернуть в трей', accelerator: 'CmdOrCtrl+W', click: () => win && win.hide() },
        { role: 'quit', label: 'Выход' },
      ],
    },
    { label: 'Правка', submenu: [{ role: 'undo', label: 'Отменить' }, { role: 'redo', label: 'Повторить' }, { type: 'separator' }, { role: 'cut', label: 'Вырезать' }, { role: 'copy', label: 'Копировать' }, { role: 'paste', label: 'Вставить' }, { role: 'selectAll', label: 'Выделить всё' }] },
    {
      label: 'Вид',
      submenu: [
        { role: 'reload', label: 'Перезагрузить' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Масштаб 100%' }, { role: 'zoomIn', label: 'Увеличить' }, { role: 'zoomOut', label: 'Уменьшить' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Полный экран' },
      ],
    },
    {
      label: 'Безопасность',
      submenu: [
        { label: 'Политика шифрования', click: () => win && win.webContents.executeJavaScript("window.App && App.serverInfo && UI.toast('AES-256-GCM + RSA-4096-OAEP + ECDH P-256. Сервер видит только шифротекст.', 'ok', 8000)") },
        { label: 'Мой ключ и устройства', click: () => win && win.webContents.executeJavaScript("document.getElementById('meBtn').click()") },
      ],
    },
    { label: 'Справка', submenu: [
      { label: 'О программе', click: () => dialog.showMessageBox({
          type: 'info', title: 'Encryption', message: 'Encryption 3.0.0',
          detail: 'Защищённый мессенджер с двойным шифрованием.\n\nСлой 1: AES-256-GCM\nСлой 2: RSA-4096-OAEP-SHA256\nСлой 3: ECDH P-256 (forward secrecy)\nПодпись: ECDSA P-256\nФайлы: шифруются на устройстве, живут 24 часа и удаляются с сервера после скачивания получателем.\n\nОдна учётная запись на устройство.' }) },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function askServer() {
  const cur = readConfig().serverUrl || DEFAULT_SERVER;
  dialog.showMessageBox({
    type: 'question', buttons: ['Продолжить', 'Отмена'], defaultId: 0, cancelId: 1,
    title: 'Подключение к серверу',
    message: 'Адрес вашего сервера Encryption',
    detail: 'Приложение подключается к серверу, который вы указали при установке. '
      + 'Изменить адрес можно здесь — формат: https://ваш-домен',
  }).then(() => {
    // Простой однострочный ввод через дочернее окно
    const input = new BrowserWindow({ width: 420, height: 156, modal: true, parent: win, title: 'Подключение к серверу', autoHideMenuBar: true });
    input.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
      <body style="font:14px system-ui;padding:16px;background:#121a33;color:#e8edff">
      <label>Адрес сервера</label>
      <input id="u" value="${cur}" style="width:100%;padding:8px;margin:8px 0;background:#0b1020;color:#fff;border:1px solid #22305c;border-radius:8px">
      <button id="ok" style="padding:8px 14px;background:#4f8cff;border:none;color:#fff;border-radius:8px;cursor:pointer">Сохранить</button>
      <script>
        document.getElementById('ok').onclick = () => {
          const url = document.getElementById('u').value.trim();
          location.href = 'encryption-save://' + encodeURIComponent(url);
        };
      </script></body>`));
    input.webContents.on('will-navigate', (e, url) => {
      if (url.startsWith('encryption-save://')) {
        e.preventDefault();
        const newUrl = decodeURIComponent(url.replace('encryption-save://', ''));
        writeConfig({ serverUrl: newUrl });
        input.close();
        win.loadURL(INDEX + '?server=' + encodeURIComponent(newUrl));
      }
    });
  });
}

/* ── IPC ────────────────────────────────────────────────────────────────── */
ipcMain.handle('app-info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  serverUrl: readConfig().serverUrl || DEFAULT_SERVER,
  userData: app.getPath('userData'),
}));
ipcMain.handle('set-server', (e, url) => { writeConfig({ serverUrl: url }); return true; });
ipcMain.handle('open-external', (e, url) => { shell.openExternal(url); return true; });
ipcMain.handle('notify', (e, { title, body }) => {
  if (Notification.isSupported()) new Notification({ title, body, icon: path.join(__dirname, 'build', 'icon.png') }).show();
  return true;
});

/* ── Жизненный цикл ─────────────────────────────────────────────────────── */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    createTray();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
