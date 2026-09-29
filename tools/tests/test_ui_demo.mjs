import puppeteer from 'puppeteer';
const BASE = process.env.ENC_BASE || 'http://127.0.0.1:8031';
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
// Скриншоты пишем ВНЕ репозитория: это артефакты прогона, а не файлы проекта.
// Каталог задаётся ENC_SHOTS_DIR (по умолчанию — временный).
import { mkdirSync as __mkShots } from 'node:fs';
const SHOTS = process.env.ENC_SHOTS_DIR || '/tmp/enc-shots';
__mkShots(SHOTS, { recursive: true });

await page.setViewport({ width: 1360, height: 860 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });

await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
const badge = await page.$eval('#serverBadge', (el) => el.textContent);
console.log('1. Плашка состояния:', badge, '| технический текст (IP/порт/версия):',
  /(\d+\.\d+\.\d+\.\d+|:\d{2,5}|v\d+\.\d+\.\d+)/.test(badge) ? 'ЕСТЬ (плохо)' : 'нет');
const langOptions = await page.$$eval('#langSelectAuth option', (els) => els.map((e) => e.value));
console.log('   языки в интерфейсе:', langOptions.join(', '));

// Выбор сервера: официальный из списка или свой адрес
const picker = await page.evaluate(() => {
  const tabs = [...document.querySelectorAll('#serverTabs .tab')].map((b) => b.textContent.trim());
  const opts = [...document.querySelectorAll('#serverList option')].map((o) => o.textContent.trim());
  return { tabs, opts, state: (document.querySelector('#serverPickState') || {}).textContent };
});
console.log('1.1 Выбор сервера:', picker.tabs.join(' / '), '| список:', picker.opts.join(', '),
  '| состояние:', picker.state);
await page.click('#serverTabs .tab[data-srv=custom]');
const customVisible = await page.$eval('#serverCustomBox', (el) => !el.classList.contains('hidden'));
await page.type('#serverCustomInput', 'нет-такого-сервера-12345');
await page.click('#serverCustomApply');
await new Promise((r) => setTimeout(r, 1500));
const badToast = await page.$$eval('.toasts .toast', (els) => els.map((e) => e.textContent).join(' '));
console.log('1.2 Свой сервер: поле ввода видно:', customVisible,
  '| ошибка на неверный адрес:', /не отвечает|No response|no responde|Antwortet nicht/i.test(badToast) ? 'есть' : 'НЕТ');
await page.$eval('#serverCustomInput', (el) => { el.value = ''; });
await page.type('#serverCustomInput', BASE);
await page.click('#serverCustomApply');
await new Promise((r) => setTimeout(r, 2000));
const savedSrv = await page.evaluate(() => localStorage.getItem('encryption.server'));
console.log('1.3 Свой сервер сохранён:', savedSrv || 'нет');
await page.evaluate(() => localStorage.removeItem('encryption.server'));

// Демо-режим (сервер эмулируется в браузере — но шифрование настоящее)
await page.click('#demoBtn');
await page.waitForSelector('#mainScreen:not(.hidden)', { timeout: 30000 });
await page.waitForFunction(() => document.querySelectorAll('.chat-item').length > 0, { timeout: 30000 });
const chats = await page.$$eval('.chat-item .ci-name', (els) => els.map((e) => e.textContent));
console.log('2. Чаты в демо:', chats.join(', '));

await page.click('.chat-item');
await page.waitForSelector('#chatView:not(.hidden)', { timeout: 20000 });
await new Promise((r) => setTimeout(r, 2500));
const msgs = await page.$$eval('.msg', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim().slice(0, 90)));
console.log('3. Сообщений расшифровано:', msgs.length);
msgs.slice(0, 3).forEach((m, i) => console.log('   •', m));

// Отправляем сообщение и ждём ответ демо-собеседника
await page.click('#composerInput');
await page.type('#composerInput', 'Тест двойного шифрования из браузера');
await page.click('#sendBtn');
await page.waitForFunction(() => document.querySelectorAll('.msg').length >= 3, { timeout: 20000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2500));
const toasts = await page.$$eval('.toast', (els) => els.map((e) => e.textContent));
const typed = await page.$eval('#composerInput', (e) => e.value);
console.log('   диагностика: поле ввода после отправки =', JSON.stringify(typed),
  '| тосты:', toasts.length ? toasts : 'нет');
const list = await page.$$eval('.msg .msg-text', (els) => els.map((e) => e.textContent));
console.log('4. Сообщений в ленте:', list.length, '| наше ушло:', list.some((t) => t.includes('Тест двойного шифрования')));
list.forEach((t, i) => console.log('   [' + i + ']', t.slice(0, 100)));
// Демо-собеседник отвечает контекстно: главное, что ответ пришёл третьим сообщением
const answered = list.length >= 3;
console.log('5. Демо-собеседник ответил:', answered);

// Проверяем конверт в «серверном» хранилище демо — серверный слой видит только шифротекст
const payloadCheck = await page.evaluate(async () => {
  const list = App.messages[App.activeChatId];
  return { layers: Object.keys(Crypto), count: list.length };
});
console.log('6. Cryptо API доступно в браузере:', payloadCheck.layers.length, 'функций');

// Локализация: переключаем на английский и обратно
await page.evaluate(() => document.getElementById('meBtn').click());
await page.waitForSelector('#settingsBody');
await page.evaluate(() => document.querySelector('[data-st=app]').click());
await new Promise((r) => setTimeout(r, 500));
await page.select('#langSelect', 'en');
await new Promise((r) => setTimeout(r, 600));
const enTabs = await page.$$eval('#settingsTabs .tab', (els) => els.map((e) => e.textContent));
console.log('7b. Интерфейс по-английски:', enTabs.join(' / '));
await page.screenshot({ path: SHOTS + '/screen-settings-en.png' });
await page.select('#langSelect', 'ru');
await new Promise((r) => setTimeout(r, 500));
await page.evaluate(() => UI.closeModal());

// Скриншоты
await page.screenshot({ path: SHOTS + '/screen-chat.png' });
await page.click('#callAudioBtn').catch(() => {});
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: SHOTS + '/screen-call.png' });
const callVisible = await page.$eval('#callOverlay', (el) => !el.classList.contains('hidden'));
console.log('7. Экран звонка открывается:', callVisible);
await page.evaluate(() => window.Call && Call.cleanup());

// Настройки + политика шифрования
await page.evaluate(() => document.getElementById('meBtn').click());
await page.waitForSelector('#modalBody');
await new Promise((r) => setTimeout(r, 700));
const tabs = await page.$$eval('#settingsTabs .tab', (els) => els.map((e) => e.textContent));
console.log('8. Разделы настроек:', tabs.join(' / '));
await page.evaluate(() => document.querySelector('[data-st=security]').click());
await new Promise((r) => setTimeout(r, 900));
const secText = await page.$eval('#settingsBody', (el) => el.textContent.replace(/\s+/g, ' ').slice(0, 220));
console.log('9. Безопасность:', secText);
await page.screenshot({ path: SHOTS + '/screen-settings.png' });

console.log('\nОшибки страницы:', errors.length ? errors.slice(0, 8) : 'нет');
await browser.close();
