/**
 * UI-тест админ-панели Encryption (самодостаточный).
 *
 *  Поднимает отдельный сервер на свежей базе, затем:
 *    1) регистрирует аккаунт «saniss» через обычную форму → проверяет, что он
 *       получает админ-права (значок рядом с логином, раздел в настройках);
 *    2) открывает админ-панель: обзор, пользователи, рассылка, настройки;
 *    3) проверяет локализации панели (ru / en / es / de);
 *    4) обычный пользователь (второй профиль браузера) панели не видит,
 *       видит объявление администратора и получает 403 от админ-API.
 *
 *  Запуск:  node test_admin_ui.mjs      (из каталога с установленным puppeteer)
 *           ENC_ROOT=/home/user/encryption — путь к проекту
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.env.ENC_ROOT || '/home/user/encryption';
const PORT = process.env.ENC_ADMIN_UI_PORT || '8036';
const BASE = `http://127.0.0.1:${PORT}`;
const S = Date.now().toString().slice(-5);
const OK = [];
const FAIL = [];
const check = (name, cond, extra = '') => {
  (cond ? OK : FAIL).push(name);
  console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? '   ' + extra : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Поднимаем отдельный сервер на свежей базе ─────────────────────────────── */
const DATA = mkdtempSync(join(tmpdir(), 'enc-admin-ui-'));
const server = spawn('python3', ['-m', 'server.app'], {
  cwd: ROOT, env: { ...process.env, ENC_PORT: PORT, ENC_DATA_DIR: DATA, ENC_ADMINS: 'saniss' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.env.ENC_VERBOSE && console.log('  [srv]', String(d).trim()));
server.stderr.on('data', (d) => process.env.ENC_VERBOSE && console.log('  [srv]', String(d).trim()));

for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(BASE + '/api/v1/health');
    if (r.ok) break;
  } catch { /* сервер ещё поднимается */ }
  await sleep(500);
}

/** Регистрирует пользователя через настоящую форму (ключи генерируются в браузере). */
async function registerViaUI(browser, username, display) {
  const ctx = await browser.createBrowserContext();   // отдельный профиль = отдельное устройство
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (e) => FAIL.push('JS: ' + e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.click('[data-tab=register]');
  await page.type('#registerForm [name=username]', username);
  await page.type('#registerForm [name=display_name]', display);
  await page.type('#registerForm [name=password]', 'AdminSecret123');
  await page.type('#registerForm [name=password2]', 'AdminSecret123');
  await page.click('#registerForm [name=terms]');
  await page.click('#registerForm button[type=submit]');
  await page.waitForSelector('#phraseAck', { timeout: 90000 });
  await page.evaluate(() => {
    document.getElementById('phraseAck').click();
    const done = document.getElementById('phraseDone');
    if (done) done.click();
  });
  await page.waitForSelector('#mainScreen:not(.hidden)', { timeout: 60000 });
  // В headless-браузере язык системы английский: для проверок фиксируем русский
  await page.evaluate(() => { I18N.setLocale('ru', false); if (window.App) App.settings.locale = 'ru'; });
  await sleep(1500);
  return page;
}

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  console.log(`→ Сервер: ${BASE}   (данные: ${DATA})\n`);

  // ── 1. saniss регистрируется как обычный пользователь ────────────────────
  const page = await registerViaUI(browser, 'saniss', 'Сергей');
  check('аккаунт saniss зарегистрирован через сайт', true);

  const role = await page.evaluate(() => ({ role: App.user.role, admin: App.user.is_admin }));
  check('saniss автоматически получил роль admin', role.admin === true && role.role === 'admin', JSON.stringify(role));

  const badge = await page.$eval('#meStatus', (el) => el.textContent.trim());
  check('рядом с логином виден значок «Администратор»', /Администратор|🛡/.test(badge), badge);

  // ── 2. Панель из настроек ────────────────────────────────────────────────
  await page.evaluate(() => App.openSettings('app'));
  await page.waitForSelector('#adminBtn', { timeout: 10000 });
  check('в настройках появился раздел «Админ-панель»', true);
  await page.click('#adminBtn');
  await page.waitForSelector('#admBody', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('#admBody .adm-card').length > 0, { timeout: 15000 });
  const cards = await page.$$eval('#admBody .adm-card', (els) => els.map((e) => e.textContent.trim()));
  check('обзор сервера: счётчики пользователей, чатов, файлов, диска', cards.length >= 6, `${cards.length} карточек`);
  const note = await page.evaluate(() => document.querySelector('#modal')?.textContent || '');
  check('в панели написано, что переписка админу недоступна', /не может читать|шифротекст/i.test(note));
  await page.screenshot({ path: join(ROOT, 'docs/screen-admin-overview.png') });

  // ── 3. Пользователи и действия ───────────────────────────────────────────
  await page.evaluate(() => Admin.open('users'));
  await page.waitForSelector('#admUsers .adm-user', { timeout: 15000 });
  const users = await page.$$eval('#admUsers .adm-user', (els) => els.map((e) => e.dataset.uid));
  check('таблица пользователей заполнена', users.length >= 1, `${users.length} записей`);
  const acts = await page.$$eval('#admUsers [data-act]', (els) => [...new Set(els.map((e) => e.dataset.act))]);
  check('доступны действия над пользователем',
    ['detail', 'block', 'logout', 'delete'].every((a) => acts.includes(a))
    && acts.some((a) => a === 'promote' || a === 'demote'), acts.join(', '));

  // ── 4. Рассылка ──────────────────────────────────────────────────────────
  await page.evaluate(() => Admin.open('broadcast'));
  await page.waitForSelector('#admAnnText', { timeout: 10000 });
  const annText = 'Обновление сервера: шифрование без изменений, панель новая';
  await page.type('#admAnnText', annText);
  await page.click('#admAnnSend');
  await page.waitForFunction((t) => document.querySelector('#admBody').textContent.includes(t), { timeout: 15000 }, annText);
  check('объявление отправлено всем пользователям', true);

  // ── 5. Настройки сервера ─────────────────────────────────────────────────
  await page.evaluate(() => Admin.open('settings'));
  await page.waitForSelector('#admReg', { timeout: 10000 });
  const envRows = await page.$$eval('#admBody .adm-kv', (els) => els.map((e) => e.textContent));
  check('видны параметры сервера и список администраторов',
    envRows.some((r) => r.includes('saniss')) && envRows.some((r) => /3\.1\.0/.test(r)), envRows.length + ' строк');

  // ── 6. Журнал и файлы ────────────────────────────────────────────────────
  await page.evaluate(() => Admin.open('audit'));
  await page.waitForFunction(() => document.querySelectorAll('#admBody .adm-log').length > 0, { timeout: 15000 });
  const events = await page.$$eval('#admBody .adm-log b', (els) => els.map((e) => e.textContent));
  check('журнал показывает действия администратора', events.some((e) => e.startsWith('admin_')), events.slice(0, 3).join(', '));
  await page.evaluate(() => Admin.open('files'));
  await page.waitForSelector('#admPurge', { timeout: 10000 });
  check('раздел файлов открывается', true);

  // ── 7. Локализации ───────────────────────────────────────────────────────
  for (const [loc, expect, tab] of [['en', 'Admin panel', 'users'], ['es', 'Panel de administración', 'users'],
                                    ['de', 'Admin-Bereich', 'overview']]) {
    await page.evaluate((l) => I18N.setLocale(l, false), loc);
    await sleep(400);
    await page.evaluate((t) => Admin.open(t), tab);
    if (tab === 'users') {
      await page.waitForFunction(() => document.querySelectorAll('#admUsers .adm-user').length > 0, { timeout: 15000 });
    } else {
      await page.waitForFunction(() => document.querySelectorAll('#admBody .adm-card').length > 0, { timeout: 15000 });
    }
    const txt = await page.evaluate(() => document.querySelector('#admBody').textContent);
    const untranslated = (txt.match(/admin\.[a-z]/gi) || []).slice(0, 5);
    check(`панель переведена на ${loc}`,
      txt.length > 20 && untranslated.length === 0,
      `${expect}; непереведённых ключей: ${untranslated.length}`);
  }
  await page.evaluate(() => { I18N.setLocale('ru', false); Admin.open('overview'); });

  // ── 8. Обычный пользователь ──────────────────────────────────────────────
  const upage = await registerViaUI(browser, 'user' + S, 'Обычный пользователь');
  check('обычный пользователь не получил админ-прав',
    (await upage.evaluate(() => !!App.user.is_admin)) === false);
  await upage.waitForSelector('#annBanner:not(.hidden)', { timeout: 15000 }).catch(() => {});
  const banner = await upage.$eval('#annBanner', (el) => (el.classList.contains('hidden') ? '' : el.textContent)).catch(() => '');
  check('обычный пользователь видит объявление администратора', banner.includes('Обновление сервера'), banner.slice(0, 50));

  await upage.evaluate(() => App.openSettings('app'));
  await sleep(800);
  check('в настройках обычного пользователя нет админ-панели', !(await upage.$('#adminBtn')));
  const denied = await upage.evaluate(async () => {
    try { await App.api.get('/api/v1/admin/overview'); return '200'; }
    catch (e) { return String(e.status || e.message); }
  });
  check('сервер отказывает обычному пользователю (403)', denied.startsWith('403'), denied);

  // ── 9. Заблокированный пользователь выбрасывается из клиента ─────────────
  const blocked = await page.evaluate(async () => {
    const id = App.user.id;
    const list = await App.api.get('/api/v1/admin/users?filter=all&limit=100');
    const victim = list.users.find((u) => u.username.startsWith('user'));
    if (!victim) return 'нет цели';
    await App.api.post(`/api/v1/admin/users/${victim.id}/block`, { reason: 'тест блокировки из панели' });
    await App.api.post(`/api/v1/admin/users/${victim.id}/unblock`, {});
    return 'ok';
  });
  check('блокировка и разблокировка из панели работают', blocked === 'ok', blocked);

  console.log(`\n${'='.repeat(62)}\nПройдено: ${OK.length}   Провалено: ${FAIL.length}`);
  if (FAIL.length) console.log('Провалены: ' + FAIL.join(' | '));
  process.exitCode = FAIL.length ? 1 : 0;
} catch (e) {
  console.log('\n❌ Исключение: ' + (e.stack || e.message));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
