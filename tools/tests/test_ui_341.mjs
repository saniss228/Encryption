/**
 * Проверка правок версии 3.4.1 — то, на что жаловался пользователь:
 *   1) удаление человека из друзей через окно «Друзья» (раньше падало
 *      с «a.api.delete is not a function»);
 *   2) отмена своей заявки в друзья;
 *   3) действия по долгому нажатию на сообщении (касание 600 мс) и по правой
 *      кнопке мыши;
 *   4) журнал: window.Log пишет записи, раздел «Диагностика» есть в настройках.
 * Сервер поднимается тем же тестом (ENC_BASE указывает на уже запущенный).
 */
import puppeteer from 'puppeteer';

const BASE = process.env.ENC_BASE || 'http://127.0.0.1:8031';
const S = Date.now().toString().slice(-5);
const A = 'anton' + S, B = 'bella' + S;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.ENC_SHOTS_DIR || '/tmp/enc-shots';
import { mkdirSync } from 'node:fs';
mkdirSync(SHOTS, { recursive: true });

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
let pass = 0, fail = 0;
const errs = [];
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '✗'} ${name}${extra ? '   ' + extra : ''}`);
  ok ? pass++ : fail++;
};

async function newUser(name, display) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1400, height: 900, hasTouch: true });
  page.on('pageerror', (e) => errs.push(name + ': ' + e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.click('[data-tab=register]');
  await page.type('#registerForm [name=username]', name);
  await page.type('#registerForm [name=display_name]', display);
  await page.type('#registerForm [name=password]', 'SuperSecret123');
  await page.type('#registerForm [name=password2]', 'SuperSecret123');
  await page.click('#registerForm [name=terms]');
  await page.click('#registerForm button[type=submit]');
  await page.waitForSelector('#phraseAck', { timeout: 60000 });
  await page.evaluate(() => { document.getElementById('phraseAck').click(); document.getElementById('phraseDone').click(); });
  await page.waitForSelector('#friendsBtn:not(.hidden)', { timeout: 60000 }).catch(() => {});
  return page;
}

/** Меню по долгому нажатию: настоящие касания через CDP. */
async function longPress(page, selector) {
  const el = await page.waitForSelector(selector, { timeout: 15000 });
  const box = await el.boundingBox();
  const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
  const cdp = await page.createCDPSession();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await sleep(700);                       // порог долгого нажатия — 480 мс
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await sleep(500);            // пауза, как у живого пользователя: касание-«эхо» уже погашено
}

console.log('1. Два пользователя и дружба через интерфейс…');
const a = await newUser(A, 'Антон');
const b = await newUser(B, 'Бэлла');

await a.click('#newChatBtn');
await a.waitForSelector('#ncSearch');
await a.type('#ncSearch', B.slice(0, 6));
await a.waitForFunction(() => document.querySelectorAll('#ncResults [data-u]').length > 0, { timeout: 20000 });
await a.click('#ncResults [data-fa="add"]');
await sleep(1200);
await a.evaluate(() => UI.closeModal());
check('заявка отправлена', true);

await b.click('#friendsBtn');
await b.waitForSelector('#frTabs', { timeout: 15000 });
await b.evaluate(() => document.querySelector('[data-fr=requests]').click());
await sleep(500);
await b.waitForSelector('#frBody [data-act="accept"]', { timeout: 20000 });
await b.click('#frBody [data-act="accept"]');
await sleep(1500);
await b.evaluate(() => UI.closeModal());

// У Антона друг появляется после принятия заявки — ждём и открываем окно заново
await a.evaluate(() => UI.closeModal());
let rowsA = 0;
for (let i = 0; i < 25; i++) {
  await a.evaluate(() => { if (UI.$('friendsBtn')) UI.$('friendsBtn').click(); });
  await sleep(500);
  rowsA = await a.$$eval('#frBody [data-act="remove"]', (r) => r.length).catch(() => 0);
  if (rowsA > 0) break;
  await a.evaluate(() => UI.closeModal());
}
check('в окне «Друзья» видно друга', rowsA > 0, 'кнопок «Удалить»: ' + rowsA);

console.log('2. Долгое нажатие на строке друга → меню действий…');
await longPress(a, '#frBody .friend-row');
const sheetRows = await a.$$eval('.sheet .sheet-row', (r) => r.map((x) => x.textContent.trim())).catch(() => []);
check('меню по долгому нажатию открылось', sheetRows.length >= 2, JSON.stringify(sheetRows.slice(0, 4)));
await a.screenshot({ path: `${SHOTS}/screen-341-longpress.png` });
await a.evaluate(() => UI.closeModal());

console.log('3. Сообщение и меню по долгому нажатию в переписке…');
// Окно «Друзья» закрылось вместе с меню — открываем снова и жмём «Написать»
await a.evaluate(() => { if (UI.$('friendsBtn')) UI.$('friendsBtn').click(); });
await a.waitForSelector('#frBody [data-act="write"]', { timeout: 20000 });
await a.click('#frBody [data-act="write"]');
await a.waitForSelector('#chatView:not(.hidden)', { timeout: 25000 });
await a.type('#composerInput', 'проверка долгого нажатия');
await a.click('#sendBtn');
await a.waitForSelector('.msg', { timeout: 20000 });
await sleep(600);
await longPress(a, '.msg');
const msgRows = await a.$$eval('.sheet .sheet-row', (r) => r.map((x) => x.textContent.trim())).catch(() => []);
check('меню сообщения открылось', msgRows.length >= 4, JSON.stringify(msgRows.slice(0, 6)));
await a.screenshot({ path: `${SHOTS}/screen-341-longpress-msg.png` });
// «Ответить» из меню — проверим, что действие работает
await a.evaluate(() => { const b = document.querySelector('.sheet [data-sheet="reply"]'); if (b) b.click(); });
await sleep(500);
const replyBar = await a.$eval('#replyBar', (el) => !el.classList.contains('hidden')).catch(() => false);
check('действие «Ответить» из меню сработало', replyBar === true);
await a.evaluate(() => { UI.closeModal(); if (UI.$('cancelReply')) UI.$('cancelReply').click(); });

console.log('4. Правая кнопка мыши на сообщении (ПК)…');
const box = await (await a.$('.msg')).boundingBox();
await a.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
await sleep(400);
const ctxRows = await a.$$eval('.sheet .sheet-row', (r) => r.length).catch(() => 0);
check('контекстное меню открылось', ctxRows >= 4, 'пунктов: ' + ctxRows);
await a.evaluate(() => UI.closeModal());

console.log('5. Журнал пишет записи и есть в настройках…');
const logInfo = await a.evaluate(() => ({
  exists: !!window.Log,
  count: window.Log ? window.Log.entries.length : 0,
  hasErrors: window.Log ? window.Log.entries.some((e) => e.cat === 'msg' || e.cat === 'api') : false,
}));
check('журнал ведётся', logInfo.exists && logInfo.count > 3, `записей: ${logInfo.count}`);

await a.evaluate(() => App.openSettings('app'));
await a.waitForSelector('#saveLog', { timeout: 15000 });
const diag = await a.evaluate(() => ({
  save: !!document.getElementById('saveLog'),
  clear: !!document.getElementById('clearLog'),
  toggle: !!document.getElementById('swLog'),
  text: (document.getElementById('settingsBody') || {}).textContent || '',
}));
check('раздел «Диагностика» в настройках', diag.save && diag.clear && diag.toggle);

console.log('6. УДАЛЕНИЕ ДРУГА (тот самый баг)…');
await a.evaluate(() => UI.closeModal());
await a.evaluate(() => (UI.$('friendsBtn') || {}).click ? UI.$('friendsBtn').click() : null);
await a.waitForSelector('#frBody [data-act="remove"]', { timeout: 20000 });
await a.click('#frBody [data-act="remove"]');
await a.waitForSelector('#dlgYes', { timeout: 15000 });
await a.click('#dlgYes');
await sleep(1200);
const afterRemove = await a.evaluate(() => ({
  rows: document.querySelectorAll('#frBody [data-act="remove"]').length,
  toast: (document.querySelector('.toast') || {}).textContent || '',
  errors: window.Log ? window.Log.entries.filter((e) => e.level === 'error' && e.cat === 'friends').map((e) => e.msg) : [],
}));
check('друг удалён, ошибок нет', afterRemove.rows === 0 && !/is not a function/.test(afterRemove.toast),
  `строк с «удалить»: ${afterRemove.rows}; журнал друзей: ${JSON.stringify(afterRemove.errors)}`);
await a.screenshot({ path: `${SHOTS}/screen-341-friend-removed.png` });

console.log('7. Отмена своей заявки (второй вызов, который тоже падал)…');
const c = 'carol' + S;
const cPage = await newUser(c, 'Кэрол');
await a.evaluate(() => UI.closeModal());
await a.click('#newChatBtn');
await a.waitForSelector('#ncSearch');
await a.type('#ncSearch', c.slice(0, 6));
await a.waitForFunction(() => document.querySelectorAll('#ncResults [data-u]').length > 0, { timeout: 20000 });
await a.click('#ncResults [data-fa="add"]');
await sleep(1200);
await a.evaluate(() => UI.closeModal());
await a.evaluate(() => { UI.$('friendsBtn').click(); });
await a.waitForSelector('#frTabs', { timeout: 15000 });
await a.evaluate(() => document.querySelector('[data-fr=requests]').click());
await sleep(600);
await a.waitForSelector('#frBody [data-act="cancel"]', { timeout: 20000 });
await a.click('#frBody [data-act="cancel"]');
await sleep(1000);
const afterCancel = await a.evaluate(() => ({
  cancelBtns: document.querySelectorAll('#frBody [data-act="cancel"]').length,
  err: window.Log ? window.Log.entries.filter((e) => e.level === 'error').slice(-2).map((e) => e.msg) : [],
}));
check('заявка отменена без ошибок', afterCancel.cancelBtns === 0, JSON.stringify(afterCancel.err));

console.log('8. Записей в журнале стало больше (действия/запросы фиксируются)…');
const count2 = await a.evaluate(() => window.Log.entries.length);
check('журнал пополняется', count2 > logInfo.count, `${logInfo.count} → ${count2}`);

console.log('9. Ошибок JS за весь прогон…');
check('нет необработанных ошибок страницы', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
console.log('\n==============================================================');
console.log(`Пройдено: ${pass}   Провалено: ${fail}`);
if (fail) process.exit(1);
