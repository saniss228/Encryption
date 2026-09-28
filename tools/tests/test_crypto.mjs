import fs from 'fs';
import vm from 'vm';
const src = fs.readFileSync(process.env.ENC_ROOT + '/web/js/crypto.js','utf8');
const ctx = { crypto: globalThis.crypto, btoa, atob, TextEncoder, TextDecoder, console };
ctx.self = ctx; ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);
const C = ctx.Crypto;
console.log('wordlist:', C.WORDS.length, 'unique:', new Set(C.WORDS).size);

const t0 = Date.now();
const alice = await C.generateIdentity(); alice.userId = 1;
const bob   = await C.generateIdentity(); bob.userId = 2;
console.log('keygen (2 identity, RSA-4096):', Date.now()-t0, 'ms');
alice.userId = 1; bob.userId = 2;

const recipients = [
  { id: 1, rsa_pub: alice.rsa.pub, ik_dh_pub: alice.dh.pub },
  { id: 2, rsa_pub: bob.rsa.pub,   ik_dh_pub: bob.dh.pub },
];
const t1 = Date.now();
const env = await C.seal({ text: 'Привет, это двойное шифрование 🔐', kind: 'text' }, alice, recipients, 'u1-u2');
console.log('seal:', Date.now()-t1, 'ms | envelope bytes:', JSON.stringify(env).length);

// Получатель: обычная расшифровка (слой 2 RSA)
const r1 = await C.open(env, bob, alice.sign.pub, 'u1-u2');
console.log('open(RSA layer):', r1.plain.text, '| подпись ок:', r1.verified);

// Проверка: ломаем RSA-ключ получателя -> должен сработать слой 3 (ECDH)
const bobBroken = JSON.parse(JSON.stringify(bob)); bobBroken.rsa.priv = alice.rsa.priv;
const r2 = await C.open(env, bobBroken, alice.sign.pub, 'u1-u2');
console.log('open(ECDH fallback works even if RSA key lost):', r2.plain.text);

// Подмена подписи -> verified=false
const envBad = JSON.parse(JSON.stringify(env)); envBad.sig = C.b64(new Uint8Array(64));
const r3 = await C.open(envBad, bob, alice.sign.pub, 'u1-u2');
console.log('tampered signature detected:', r3.verified === false);

// Пароль/фраза
const ah = await C.authHash('alice', 'S3cret!Pass');
console.log('authHash len:', ah.length);
const phrase = C.newRecoveryPhrase();
console.log('phrase (24 words):', phrase.slice(0,4).join(' ')+' ...');
const ph = await C.phraseHash('alice', phrase);
const wrap = await C.wrapWithPhrase('alice', phrase, alice);
const back = await C.unwrapWithPhrase('alice', phrase, wrap);
console.log('recovery wrap roundtrip:', back.rsa.pub === alice.rsa.pub, '| phraseHash len', ph.length);

// Файл: шифрование чанка
const fk = await C.newFileKey();
const data = crypto.getRandomValues(new Uint8Array(4096));
const ct = await C.encryptChunk(fk, 0, data.buffer, new TextEncoder().encode('file'));
const pt = await C.decryptChunk(fk, 0, ct, new TextEncoder().encode('file'));
console.log('file chunk roundtrip:', Buffer.compare(Buffer.from(pt), Buffer.from(data))===0, '| overhead bytes:', ct.length-data.length);
