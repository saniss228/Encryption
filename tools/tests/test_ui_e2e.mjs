import puppeteer from 'puppeteer';
const BASE = process.env.ENC_BASE || 'http://127.0.0.1:8031';
const S = Date.now().toString().slice(-5);
const A = 'anna' + S, B = 'boris' + S;
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-dev-shm-usage'] });
const errs = [];
async function newUser(name, display) {
  // Отдельный профиль браузера = отдельное «устройство» (иначе сработает
  // политика «один аккаунт на устройство» — что мы уже проверили отдельно)
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1400, height: 880 });
  page.on('pageerror', e => errs.push(name + ' pageerror: ' + e.message));
  page.on('console', m => console.log('  [' + name + ']', m.type(), m.text().slice(0, 160)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.click('[data-tab=register]');
  await page.type('#registerForm [name=username]', name);
  await page.type('#registerForm [name=display_name]', display);
  await page.type('#registerForm [name=password]', 'SuperSecret123');
  await page.type('#registerForm [name=password2]', 'SuperSecret123');
  await page.click('#registerForm [name=terms]');
  await page.click('#registerForm button[type=submit]');
  await page.waitForSelector('#phraseAck', { timeout: 60000 });
  await page.waitForSelector('#phraseAck', { timeout: 20000 });
  const phrase = await page.$eval('#phraseBox', el => el.textContent.trim());
  await page.screenshot({ path: `/home/user/encryption/docs/screen-recovery-${name === A ? 'a' : 'b'}.png` });
  await page.evaluate(() => document.getElementById('phraseDone') ? (document.getElementById('phraseAck').click(), document.getElementById('phraseDone').click()) : null);
  return { page, phrase };
}
console.log('1. Регистрируем двух пользователей (RSA-4096 генерируется на устройстве)…');
const a = await newUser(A, 'Анна');
const b = await newUser(B, 'Борис');
console.log('   фраза А (24 слова):', a.phrase.split(' ').slice(0,5).join(' ') + ' …', '| слов:', a.phrase.split(' ').length);

console.log('2. Анна ищет Бориса и создаёт чат…');
await a.page.click('#newChatBtn');
await a.page.waitForSelector('#ncSearch');
await a.page.type('#ncSearch', B.slice(0, 6));
await a.page.waitForFunction(() => document.querySelectorAll('#ncResults [data-u]').length > 0, { timeout: 15000 });
await a.page.click('#ncResults [data-u]');
await a.page.waitForSelector('#chatView:not(.hidden)', { timeout: 20000 });

console.log('3. Анна отправляет сообщение…');
await a.page.click('#composerInput');
await a.page.type('#composerInput', 'Привет, Борис! Это сообщение зашифровано дважды 🔐');
await a.page.click('#sendBtn');
await new Promise(r => setTimeout(r, 4000));

console.log('4. Борис должен получить его по WebSocket и расшифровать…');
await b.page.waitForFunction(() => document.querySelectorAll('.chat-item').length > 0, { timeout: 30000 });
await b.page.evaluate(() => document.querySelector('.chat-item').click());
await b.page.waitForFunction(() => [...document.querySelectorAll('.msg-text')].some(e => e.textContent.includes('зашифровано дважды')), { timeout: 30000 })
  .then(() => console.log('   ✓ получено и расшифровано на устройстве Бориса'))
  .catch(async () => console.log('   ✗ не получено; тексты:', await b.page.$$eval('.msg-text', e => e.map(x => x.textContent))));

console.log('5. Борис отвечает…');
await b.page.click('#composerInput');
await b.page.type('#composerInput', 'Вижу тебя! Проверка подписи ECDSA прошла.');
await b.page.click('#sendBtn');
await new Promise(r => setTimeout(r, 4000));
const aGot = await a.page.waitForFunction(() => [...document.querySelectorAll('.msg-text')].some(e => e.textContent.includes('Вижу тебя')), { timeout: 25000 })
  .then(() => true).catch(() => false);
console.log('   Анна получила ответ:', aGot);

console.log('6. Отправляем зашифрованный файл (24 часа в облаке)…');
const fileOk = await a.page.evaluate(async () => {
  const blob = new Blob([new Uint8Array(150000).map((_, i) => i % 251)], { type: 'application/pdf' });
  const file = new File([blob], 'документ.pdf', { type: 'application/pdf' });
  App.attachQueue.push({ file, kind: 'file' });
  await App.sendMessage('Держи документ', {});
  const last = App.messages[App.activeChatId].slice(-1)[0];
  return !!last.attachment;
});
await new Promise(r => setTimeout(r, 2500));
console.log('   файл отправлен как вложение:', fileOk);

console.log('7. Проверяем, что сервер не видит текст (конверт в API)…');
const check = await a.page.evaluate(async () => {
  const list = await App.api.get('/api/v1/messages', { chat_id: App.activeChatId, limit: 5 });
  const raw = list.messages.slice(-1)[0];
  return { keys: Object.keys(raw.payload), hasPlaintext: JSON.stringify(raw.payload).includes('Держи документ') };
});
console.log('   поля конверта:', check.keys.join(','), '| открытый текст в конверте:', check.hasPlaintext);

console.log('7b. Борис скачивает файл: копия должна исчезнуть с сервера («только локально»)…');
const dl = await b.page.evaluate(async () => {
  const m = App.messages[App.activeChatId].filter((x) => x.attachment).slice(-1)[0];
  if (!m) return { error: 'вложение не найдено' };
  await App.openAttachment(m);
  await new Promise((r) => setTimeout(r, 800));
  return { fileId: m.attachment.file_id, localOnlyFlag: !!m.localOnly };
});
console.log('   скачано, метка в модели:', dl.localOnlyFlag, '| файл:', dl.fileId);
const serverSide = await b.page.evaluate(async (fid) => {
  try {
    const meta = await App.api.get(`/api/v1/files/${fid}/meta`);
    return { status: 'still_on_server', local_only: meta.local_only, on_server: meta.on_server, size: meta.size };
  } catch (e) {
    return { status: 'gone', code: e.code || e.message };
  }
}, dl.fileId);
console.log('   метаданные на сервере:', JSON.stringify(serverSide));
const goneCheck = await b.page.evaluate(async (fid) => {
  const res = await fetch(`${App.api.base}/api/v1/files/${fid}/chunk?index=0`, {
    headers: { Authorization: 'Bearer ' + App.api.access },
  });
  let code = null;
  try { const j = await res.clone().json(); code = j.error && j.error.code; } catch (e) {}
  return { http: res.status, code };
}, dl.fileId);
console.log('   повторное скачивание →', JSON.stringify(goneCheck));
const bBadge = await b.page.$$eval('.local-badge', (els) => els.map((e) => e.textContent.trim()));
console.log('   метка у Бориса:', bBadge.length ? bBadge : 'нет');
const aBadge = await a.page.waitForFunction(
  () => [...document.querySelectorAll('.local-badge')].some((e) => /Local only/i.test(e.textContent)),
  { timeout: 15000 }).then(() => true).catch(() => false);
const aBadgeText = await a.page.$$eval('.local-badge', (els) => els.map((e) => e.textContent.trim()));
console.log('   Анна видит «только локально»:', aBadge, aBadgeText.length ? aBadgeText : '');

console.log('8. Локализации: переключаем интерфейс на английский…');
await a.page.evaluate(() => document.getElementById('meBtn').click());
await a.page.waitForSelector('#settingsBody');
await a.page.evaluate(() => document.querySelector('[data-st=app]').click());
await new Promise((r) => setTimeout(r, 500));
const langs = await a.page.$$eval('#langSelect option', (els) => els.map((e) => e.value));
console.log('   доступные языки:', langs.join(', '));
await a.page.select('#langSelect', 'en');
await new Promise((r) => setTimeout(r, 700));
const enTabs = await a.page.$$eval('#settingsTabs .tab', (els) => els.map((e) => e.textContent));
console.log('   разделы настроек (en):', enTabs.join(' / '));
await a.page.screenshot({ path: (process.env.ENC_ROOT || '.') + '/docs/screen-settings-en.png' });
await a.page.select('#langSelect', 'ru');
await new Promise((r) => setTimeout(r, 500));

await a.page.screenshot({ path: (process.env.ENC_ROOT || '.') + '/docs/screen-chat.png' });
await b.page.screenshot({ path: (process.env.ENC_ROOT || '.') + '/docs/screen-mobile-check.png' });

console.log('\nФраза для проверки восстановления у Бориса:', b.phrase.split(' ').slice(0, 6).join(' ') + ' …');
console.log('Ошибки страниц:', errs.length ? errs.slice(0, 6) : 'нет');
await browser.close();
