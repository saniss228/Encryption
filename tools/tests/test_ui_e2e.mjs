import puppeteer from 'puppeteer';
const BASE = process.env.ENC_BASE || 'http://127.0.0.1:8031';
const S = Date.now().toString().slice(-5);
const A = 'anna' + S, B = 'boris' + S;
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-dev-shm-usage'] });
const errs = [];
// Скриншоты пишем ВНЕ репозитория: это артефакты прогона, а не файлы проекта.
// Каталог задаётся ENC_SHOTS_DIR (по умолчанию — временный).
import { mkdirSync as __mkShots } from 'node:fs';
const SHOTS = process.env.ENC_SHOTS_DIR || '/tmp/enc-shots';
__mkShots(SHOTS, { recursive: true });

async function newUser(name, display) {
  // Отдельный профиль браузера = отдельное «устройство» (иначе сработает
  // политика «один аккаунт на устройство» — что мы уже проверили отдельно)
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1400, height: 880 });
  page.on('pageerror', e => errs.push(name + ' pageerror: ' + e.message));
  page.on('console', m => console.log('  [' + name + ']', m.type(), m.text().slice(0, 160)));
  // Любой ответ с ошибкой — с адресом запроса, чтобы не искать «404» вслепую
  page.on('response', (r) => { if (r.status() >= 400) console.log('  [' + name + '] HTTP ' + r.status() + ' ' + r.url()); });
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
  await page.screenshot({ path: `${SHOTS}/screen-recovery-${name === A ? 'a' : 'b'}.png` });
  await page.evaluate(() => document.getElementById('phraseDone') ? (document.getElementById('phraseAck').click(), document.getElementById('phraseDone').click()) : null);
  return { page, phrase };
}
console.log('1. Регистрируем двух пользователей (RSA-4096 генерируется на устройстве)…');
const a = await newUser(A, 'Анна');
const b = await newUser(B, 'Борис');
console.log('   фраза А (24 слова):', a.phrase.split(' ').slice(0,5).join(' ') + ' …', '| слов:', a.phrase.split(' ').length);

console.log('2. Анна ищет Бориса: просто «написать» незнакомцу нельзя — только заявка…');
await a.page.click('#newChatBtn');
await a.page.waitForSelector('#ncSearch');
await a.page.type('#ncSearch', B.slice(0, 6));
await a.page.waitForFunction(() => document.querySelectorAll('#ncResults [data-u]').length > 0, { timeout: 15000 });
const searchBtn = await a.page.$eval('#ncResults [data-fa]', (el) => ({ act: el.dataset.fa, text: el.textContent.trim() }));
console.log('   кнопка в поиске:', JSON.stringify(searchBtn));
await a.page.click('#ncResults [data-fa="add"]');
await new Promise(r => setTimeout(r, 1200));
console.log('   заявка отправлена');
await a.page.evaluate(() => UI.closeModal());      // окно «Новый чат» закрываем — оно было открыто

console.log('2b. У Бориса появилась заявка (счётчик и окно «Друзья»)…');
await b.page.waitForFunction(() => {
  const el = document.getElementById('friendsBadge');
  return el && !el.classList.contains('hidden');
}, { timeout: 20000 }).then(() => console.log('   счётчик заявок появился')).catch(() => console.log('   ✗ счётчик не появился'));
await b.page.click('#friendsBtn');
await b.page.waitForSelector('#frTabs', { timeout: 10000 });
await b.page.evaluate(() => document.querySelector('[data-fr=requests]').click());
await new Promise(r => setTimeout(r, 500));
await b.page.click('#frBody [data-act=accept]');
await new Promise(r => setTimeout(r, 1500));
const accepted = await b.page.evaluate(() => {
  const btn = document.getElementById('friendsBtn');
  return { badge: !document.getElementById('friendsBadge').classList.contains('hidden') };
});
console.log('   Борис принял заявку, счётчик пуст:', !accepted.badge);
await b.page.evaluate(() => document.getElementById('modalClose').click());

console.log('2c. Крестик и Esc закрывают окна…');
const closeCheck = await b.page.evaluate(async () => {
  const out = {};
  document.getElementById('newChatBtn').click();
  out.modalOpened = !document.getElementById('modal').classList.contains('hidden');
  out.hasClose = !!document.getElementById('modalClose');
  document.getElementById('modalClose').click();
  out.closedByX = document.getElementById('modal').classList.contains('hidden');
  document.getElementById('newChatBtn').click();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  out.closedByEsc = document.getElementById('modal').classList.contains('hidden');
  return out;
});
console.log('   окно открылось:', closeCheck.modalOpened, '| крестик есть:', closeCheck.hasClose,
  '| закрыто крестиком:', closeCheck.closedByX, '| закрыто Esc:', closeCheck.closedByEsc);

console.log('3. Анна открывает чат с другом и отправляет сообщение…');
await a.page.evaluate(async (uname) => { await App.openChat((await App.api.post('/api/v1/chats', { type:'direct', peer_username: uname })).id); }, B);
await a.page.waitForSelector('#chatView:not(.hidden)', { timeout: 20000 });
const gateGone = await a.page.evaluate(() => document.getElementById('friendGate').classList.contains('hidden'));
console.log('   поле ввода доступно (подсказки о дружбе нет):', gateGone);
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

console.log('7c. Картинка видна в переписке сразу (без нажатий)…');
const imgCheck = await a.page.evaluate(async () => {
  const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 160;
  const g = canvas.getContext('2d');
  g.fillStyle = '#4f8cff'; g.fillRect(0, 0, 240, 160);
  g.fillStyle = '#fff'; g.font = 'bold 26px sans-serif'; g.fillText('Encryption', 24, 90);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  const file = new File([blob], 'картинка.png', { type: 'image/png' });
  App.attachQueue.push({ file, kind: 'image' });
  await App.sendMessage('Смотри, какая картинка', {});
  return true;
});
await new Promise(r => setTimeout(r, 3500));
const imgVisible = await b.page.waitForFunction(() => {
  const img = document.querySelector('.att-img');
  return img && img.src && img.src.startsWith('blob:') && img.naturalWidth > 0;
}, { timeout: 25000 }).then(() => true).catch(() => false);
const imgBox = await b.page.evaluate(() => {
  const img = document.querySelector('.att-img');
  return img ? { w: img.naturalWidth, h: img.naturalHeight, shown: img.getBoundingClientRect().height > 20 } : null;
});
console.log('   картинка отрисована в переписке:', imgVisible, JSON.stringify(imgBox), '| отправлено:', imgCheck);

console.log('7d. Голосовое сообщение: плеер играет и переживает перерисовку списка…');
await a.page.evaluate(async () => {
  // Пишем реальный звук: сигнал идёт в тот же поток, из которого пишем
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const dest = ctx.createMediaStreamDestination();
  const rec = new MediaRecorder(dest.stream);
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  const done = new Promise((res) => { rec.onstop = res; });
  rec.start();
  const buf = ctx.createBuffer(1, 8000, 8000);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.sin(i / 20) * 0.2;
  const src = ctx.createBufferSource(); src.buffer = buf; src.connect(dest); src.start();
  setTimeout(() => { try { rec.stop(); } catch (e) {} }, 2600);
  await done;
  const file = new File(chunks, 'voice.webm', { type: 'audio/webm' });
  App.attachQueue.push({ file, kind: 'voice' });
  await App.sendMessage('', {});
});
await new Promise(r => setTimeout(r, 3500));
const voiceUI = await b.page.waitForFunction(() => !!document.querySelector('.voice-play'), { timeout: 25000 })
  .then(() => true).catch(() => false);
const voicePlay = await b.page.evaluate(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const cur = () => { const m = [...document.querySelectorAll('.msg')].find((x) => x._voiceAudio); return m && m._voiceAudio; };
  const btn = document.querySelector('.voice-play');
  if (!btn) return { error: 'кнопки нет' };
  btn.click();
  let играет = false;
  for (let i = 0; i < 50; i++) { const au = cur(); if (au && !au.paused && au.duration > 0) { играет = true; break; } await wait(100); }
  const au = cur();
  const out = {
    играет,
    ссылка: au ? String(au.src || '').slice(0, 5) : '',
    длительность: au ? +(au.duration || 0).toFixed(1) : 0,
    пауза: au ? au.paused : null,
    иконка: btn.textContent.trim(),
    время: document.querySelector('.voice-time').textContent,
  };
  // Перерисовка списка (квитанции, реакции) не должна «убивать» плеер
  const было = cur();
  App.renderMessages(App.activeChatId);
  await wait(500);
  const стало = cur();
  out.после_перерисовки = {
    тот_же_элемент: было === стало,
    ссылка: стало ? String(стало.src || '').slice(0, 5) : '',
    пауза: стало ? стало.paused : null,
    позиция: стало ? +стало.currentTime.toFixed(1) : 0,
    иконка: document.querySelector('.voice-play').textContent.trim(),
  };
  return out;
});
console.log('   плеер голосового есть:', voiceUI, '| играет:', JSON.stringify(voicePlay));
const voiceOk = voiceUI && voicePlay.играет === true && voicePlay.ссылка === 'blob:'
  && voicePlay.после_перерисовки && voicePlay.после_перерисовки.ссылка === 'blob:'
  && voicePlay.после_перерисовки.пауза === false;
console.log('   ' + (voiceOk ? '✓' : '✗') + ' голосовое воспроизводится и не обрывается при перерисовке');

console.log('7e. Окно звонка: крестик и кнопка «Принять» для входящего…');
const callUI = await a.page.evaluate(async () => {
  const out = {};
  // Настоящий звонок в API: тогда «Отклонить» отвечает серверу без ошибок 404
  let callId = 'test-call';
  try {
    const real = await App.api.post('/api/v1/calls', { chat_id: App.activeChatId, kind: 'audio' });
    callId = real.id || real.call_id || callId;
  } catch (e) { /* демо-режим */ }
  out.callId = callId;
  Call.incoming({ chat_id: App.chatsById[App.activeChatId] ? App.activeChatId : 'x', call_id: callId,
    from: App.user.id, kind: 'audio' });
  await new Promise((r) => setTimeout(r, 300));
  out.overlay = !document.getElementById('callOverlay').classList.contains('hidden');
  out.acceptVisible = !document.getElementById('callIncomingActions').classList.contains('hidden');
  out.acceptText = document.getElementById('callAccept').textContent.trim();
  out.declineText = document.getElementById('callDecline').textContent.trim();
  out.hasX = !!document.getElementById('callClose');
  document.getElementById('callDecline').click();
  await new Promise((r) => setTimeout(r, 300));
  out.closed = document.getElementById('callOverlay').classList.contains('hidden');
  return out;
});
console.log('   окно звонка:', JSON.stringify(callUI));

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
await a.page.screenshot({ path: SHOTS + '/screen-settings-en.png' });
await a.page.select('#langSelect', 'ru');
await new Promise((r) => setTimeout(r, 500));

await a.page.screenshot({ path: SHOTS + '/screen-chat.png' });
await b.page.screenshot({ path: SHOTS + '/screen-mobile-check.png' });

console.log('\nФраза для проверки восстановления у Бориса:', b.phrase.split(' ').slice(0, 6).join(' ') + ' …');
console.log('Ошибки страниц:', errs.length ? errs.slice(0, 6) : 'нет');
await browser.close();
