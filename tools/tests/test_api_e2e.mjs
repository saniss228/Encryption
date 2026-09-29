import fs from 'fs'; import vm from 'vm';
const ctx = { crypto: globalThis.crypto, btoa, atob, TextEncoder, TextDecoder, console, fetch, setTimeout, Date };
ctx.self = ctx; ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync((process.env.ENC_ROOT || '.') + '/web/js/crypto.js','utf8'), ctx);
const C = ctx.Crypto;
const BASE = process.env.ENC_BASE || 'http://127.0.0.1:8031';
const SUF = Math.random().toString(16).slice(2,7);
const U = (n) => n + SUF;
const j = async (m,p,b,tok) => {
  const r = await fetch(BASE+p, { method:m, headers:{ 'Content-Type':'application/json', ...(tok?{Authorization:'Bearer '+tok}:{}) }, body: b?JSON.stringify(b):undefined });
  const t = await r.text(); let d=null; try{ d=t?JSON.parse(t):null }catch(e){ d=t }
  return { status:r.status, data:d };
};
const dev = (n) => ({ device_id: 'test-device-'+n+'-'+Math.random().toString(16).slice(2,8), name:'Тест '+n, platform:'web', app_version:'1.0.0', fingerprint:'fp'+n });

console.log('── health ──', (await j('GET','/api/v1/health')).data.version);

// Алиса (устройство A)
const aliceID = await C.generateIdentity();
const aliceDev = dev('A');
const aliceReg = await j('POST','/api/v1/auth/register', {
  username: U('alice'), display_name:'Алиса', auth_hash: await C.authHash('alice2','pass12345'),
  keys: C.publicBundle(aliceID), device: aliceDev, key_backup: await C.wrapWithPassword('alice2','pass12345', aliceID),
  recovery: { wrap: await C.wrapWithPhrase('alice2', 'x '.repeat(23)+'x', aliceID), phrase_hash: await C.phraseHash('alice2','x '.repeat(23)+'x') }
});
console.log('register alice:', aliceReg.status, aliceReg.data.user?.username || aliceReg.data.error?.code);
const aliceTok = aliceReg.data.tokens.access_token;
aliceID.userId = aliceReg.data.user.id;

// Боб (устройство B)
const bobID = await C.generateIdentity();
const bobDev = dev('B');
const bobReg = await j('POST','/api/v1/auth/register', { username: U('bob'), display_name:'Боб',
  auth_hash: await C.authHash('bob2','pass12345'), keys: C.publicBundle(bobID), device: bobDev,
  key_backup: await C.wrapWithPassword('bob2','pass12345', bobID) });
console.log('register bob:', bobReg.status);
const bobTok = bobReg.data.tokens.access_token;
bobID.userId = bobReg.data.user.id;

// Один аккаунт на устройство: пробуем зарегистрировать второго пользователя на устройстве А
const dup = await j('POST','/api/v1/auth/register', { username:'hacker', auth_hash: await C.authHash('hacker','pass12345'),
  keys: C.publicBundle(await C.generateIdentity()), device: aliceDev });
console.log('1 аккаунт на устройство →', dup.status, dup.data.error?.code);

// Бандл ключей собеседника
const bundle = await j('GET','/api/v1/users/bob/bundle', null, aliceTok);
console.log('bundle bob:', bundle.status, !!bundle.data.bundle?.rsa_pub);

// Чат и двойное шифрование.
// С версии 3.4.0 писать можно только друзьям, поэтому сначала заявка и принятие.
const chat = await j('POST','/api/v1/chats', { type:'direct', peer_username: U('bob') }, aliceTok);
const chatId = chat.data.id;
const fr = await j('POST','/api/v1/friends/requests', { username: U('bob') }, aliceTok);
const frList = await j('GET','/api/v1/friends', null, bobTok);
const frOk = await j('POST','/api/v1/friends/requests/' + frList.data.incoming[0].id + '/accept', {}, bobTok);
console.log('заявка в друзья → принята:', fr.status, frOk.status);
const recipients = [
  { id: aliceID.userId, rsa_pub: aliceID.rsa.pub, ik_dh_pub: aliceID.dh.pub },
  { id: bobID.userId, rsa_pub: bobID.rsa.pub, ik_dh_pub: bobID.dh.pub },
];
const secret = 'Секретное сообщение 🔐 двойное шифрование';
const env = await C.seal({ text: secret, ts: Date.now(), from:'alice2' }, aliceID, recipients, chatId, { ts: Math.floor(Date.now()/1000) });
const sent = await j('POST','/api/v1/messages', { chat_id: chatId, payload: env, type:'text' }, aliceTok);
console.log('send message:', sent.status, 'id=', sent.data.id);

// Боб читает
const inbox = await j('GET','/api/v1/messages?chat_id='+chatId, null, bobTok);
const raw = inbox.data.messages[0];
const opened = await C.open(raw.payload, bobID, aliceID.sign.pub, chatId);
console.log('bob расшифровал:', JSON.stringify(opened.plain.text), '| подпись ECDSA:', opened.verified);
console.log('сервер видел только:', Object.keys(raw.payload).join(','), '| длина конверта', JSON.stringify(raw.payload).length, 'байт');

// А сервер не может прочитать: у него нет ни одного приватного ключа
console.log('что хранит сервер (payload.l1.ct):', String(raw.payload.l1.ct).slice(0,40)+'…');

// Второе устройство Алисы: вход с тем же паролем на другом устройстве (device C)
const aliceDev2 = dev('C');
const login2 = await j('POST','/api/v1/auth/login', { username: U('alice'), auth_hash: await C.authHash('alice2','pass12345'), device: aliceDev2 });
console.log('вход на 2-м устройстве:', login2.status);
const backup = await j('GET','/api/v1/users/me/backup', null, login2.data.tokens.access_token);
const restored = await C.unwrapWithPassword('alice2','pass12345', backup.data.key_backup);
console.log('ключи восстановлены из шифрованного бэкапа:', restored.rsa.pub === aliceID.rsa.pub);

// Неверный пароль
const bad = await j('POST','/api/v1/auth/login', { username: U('alice'), auth_hash: await C.authHash('alice2','WRONG'), device: dev('D') });
console.log('неверный пароль →', bad.status, bad.data.error?.code);

// Файл: шифрование чанка + загрузка + скачивание + расшифровка
const fk = await C.newFileKey();
const fileData = new Uint8Array(300000);
for (let o=0;o<fileData.length;o+=65536) crypto.getRandomValues(fileData.subarray(o, Math.min(o+65536, fileData.length)));
const init = await j('POST','/api/v1/files/init', { chat_id: chatId, size: fileData.length, kind:'file',
  mime:'application/octet-stream', name_enc:'enc-name', chunk_size: 262144 }, aliceTok);
const fid = init.data.file_id;
const total = init.data.chunks;
for (let i=0;i<total;i++){
  const slice = fileData.slice(i*262144, Math.min((i+1)*262144, fileData.length));
  const aad = new TextEncoder().encode('file|'+fid);
  const enc = await C.encryptChunk(fk, i, slice.buffer, aad);
  const put = await fetch(`${BASE}/api/v1/files/${fid}/chunk?index=${i}`, { method:'PUT',
    headers:{ Authorization:'Bearer '+aliceTok, 'Content-Type':'application/octet-stream' }, body: enc });
  if (!put.ok) console.log('chunk upload fail', put.status);
}
await j('POST', `/api/v1/files/${fid}/complete`, {}, aliceTok);
const meta = await j('GET', `/api/v1/files/${fid}/meta`, null, bobTok);
const dl = await fetch(`${BASE}/api/v1/files/${fid}/raw`, { headers:{ Authorization:'Bearer '+bobTok } });
const encBytes = new Uint8Array(await dl.arrayBuffer());
const parts = [], cs = meta.data.chunk_size;
for (let i=0;i<meta.data.chunks;i++){
  const encChunk = encBytes.slice(i*(cs+28), (i+1)*(cs+28));
  parts.push(await C.decryptChunk(fk, i, encChunk, new TextEncoder().encode('file|'+fid)));
}
const joined = Buffer.concat(parts.map(p=>Buffer.from(p)));
console.log('файл: чанков', total, '| расшифрован идентично:', joined.equals(Buffer.from(fileData)),
  '| TTL осталось, ч:', ((meta.data.ttl_left)/3600).toFixed(2));

// Поиск пользователей, контакты, политика
console.log('поиск:', (await j('GET','/api/v1/users/search?q=bo', null, aliceTok)).data.users.length, 'найдено');
const pol = await j('GET','/api/v1/security/policy');
console.log('политика: слоёв шифрования', Object.keys(pol.data.double_encryption).length, '| файлы живут', pol.data.storage.file_retention);
// Восстановление по фразе
const phrase = C.newRecoveryPhrase();
await j('PUT','/api/v1/users/me/backup', { key_backup: await C.wrapWithPassword('bob2','pass12345', bobID),
  recovery_wrap: await C.wrapWithPhrase('bob2', phrase, bobID), recovery_phrase_hash: await C.phraseHash('bob2', phrase) }, bobTok);
const rec = await j('POST','/api/v1/auth/recover', { username: U('bob'), phrase_hash: await C.phraseHash('bob2', phrase),
  new_auth_hash: await C.authHash('bob2','newpass12345'), keys: C.publicBundle(bobID), device: dev('B2') });
console.log('восстановление по 24 словам:', rec.status, '| новая сессия выдана:', !!rec.data.tokens);
const recBad = await j('POST','/api/v1/auth/recover', { username: U('bob'), phrase_hash: await C.phraseHash('bob2','неверная фраза здесь'),
  new_auth_hash: await C.authHash('bob2','x'), keys: C.publicBundle(bobID), device: dev('B3') });
console.log('неверная фраза →', recBad.status, recBad.data.error?.code);
