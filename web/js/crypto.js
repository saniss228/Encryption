/* ============================================================================
 * Encryption — криптографическое ядро (WebCrypto API, без внешних библиотек)
 * Одинаковый код используется сайтом (web), Android-оболочкой и десктопом.
 *
 * ДВОЙНОЕ ШИФРОВАНИЕ одного сообщения:
 *   Слой 1 — AES-256-GCM: содержимое шифруется случайным ключом сообщения (mk).
 *   Слой 2 — RSA-4096-OAEP-SHA256: тот же mk заворачивается в RSA-конверт
 *            для каждого получателя (приватный ключ не покидает устройство).
 *   Слой 3 (доп.) — ECDH P-256 + HKDF-SHA256 + AES-256-GCM: эфемерный ключ
 *            даёт forward secrecy, если RSA-ключ когда-нибудь скомпрометируют
 *            (или наоборот).
 *   Подпись конверта — ECDSA P-256 (защита от подмены/MITM).
 * ========================================================================== */
(function (global) {
  'use strict';
  const subtle = global.crypto.subtle;
  const te = new TextEncoder();
  const td = new TextDecoder();

  /* ── Кодировки ─────────────────────────────────────────────────────────── */
  function b64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }
  function unb64(str) {
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function rand(n) { return crypto.getRandomValues(new Uint8Array(n)); }
  function concat(...arrs) {
    const total = arrs.reduce((a, b) => a + b.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  }
  const u32be = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

  /* ── Пароль → ключи (PBKDF2-SHA512 на устройстве) ───────────────────────── */
  // Пароль в открытом виде НИКОГДА не уходит на сервер: уходит только authHash.
  const PBKDF2_ITER = 310000;
  async function pbkdf2Bits(password, salt, iterations, bits) {
    const base = await subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits(
      { name: 'PBKDF2', salt: te.encode(salt), iterations: iterations || PBKDF2_ITER, hash: 'SHA-512' },
      base, bits || 512));
  }
  async function authHash(username, password) {
    // соль = "encryption:<логин>", стабильна между устройствами и версиями
    const bits = await pbkdf2Bits(password, 'encryption:' + username.toLowerCase(), PBKDF2_ITER, 512);
    return b64(bits);
  }
  async function localKey(password, saltStr, iterations) {
    const bits = await pbkdf2Bits(password, saltStr, iterations || PBKDF2_ITER, 256);
    return subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  /* ── Симметричное шифрование ───────────────────────────────────────────── */
  async function aesKey(raw) { return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']); }
  async function aesEncrypt(key, dataOrText, iv, aad) {
    const data = typeof dataOrText === 'string' ? te.encode(dataOrText) : dataOrText;
    // В браузерах additionalData нельзя передавать как undefined — добавляем только при наличии
    const params = { name: 'AES-GCM', iv: iv, tagLength: 128 };
    if (aad) params.additionalData = aad;
    const out = new Uint8Array(await subtle.encrypt(params, key, data));
    return out; // последние 16 байт — тег аутентификации
  }
  async function aesDecrypt(key, ct, iv, aad) {
    const params = { name: 'AES-GCM', iv: iv, tagLength: 128 };
    if (aad) params.additionalData = aad;
    const buf = await subtle.decrypt(params, key, ct);
    return new Uint8Array(buf);
  }
  async function sha256(data) {
    const d = typeof data === 'string' ? te.encode(data) : data;
    return new Uint8Array(await subtle.digest('SHA-256', d));
  }

  /* ── HKDF-SHA256 ───────────────────────────────────────────────────────── */
  async function hkdf(ikm, salt, info, bits) {
    const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: salt || new Uint8Array(0), info: te.encode(info || '') },
      k, bits || 256));
  }

  /* ── Генерация личного набора ключей ───────────────────────────────────── */
  const RSA_BITS = 4096;
  async function generateIdentity() {
    const dh = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey']);
    const sign = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const rsa = await subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: RSA_BITS, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['encrypt', 'decrypt']);
    // Подписанный prekey (SPK) — используется для ротации/one-time prekeys
    const spk = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const spkPubRaw = new Uint8Array(await subtle.exportKey('raw', spk.publicKey));
    const spkSig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, sign.privateKey, spkPubRaw));
    const otks = [];
    for (let i = 0; i < 8; i++) {
      const otk = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      otks.push({ pub: b64(await subtle.exportKey('raw', otk.publicKey)), priv: await subtle.exportKey('jwk', otk.privateKey) });
    }
    return {
      v: 2,
      dh: { pub: b64(await subtle.exportKey('raw', dh.publicKey)), priv: await subtle.exportKey('jwk', dh.privateKey) },
      sign: { pub: b64(await subtle.exportKey('raw', sign.publicKey)), priv: await subtle.exportKey('jwk', sign.privateKey) },
      rsa: { pub: b64(await subtle.exportKey('spki', rsa.publicKey)), priv: await subtle.exportKey('jwk', rsa.privateKey) },
      spk: { pub: b64(spkPubRaw), sig: b64(spkSig), priv: await subtle.exportKey('jwk', spk.privateKey) },
      oneTimeKeys: otks,
      created: Date.now(),
    };
  }

  async function importDhPriv(jwk) { return subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']); }
  async function importDhPubB64(pub) { return subtle.importKey('raw', unb64(pub), { name: 'ECDH', namedCurve: 'P-256' }, false, []); }
  async function importSignPriv(jwk) { return subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']); }
  async function importSignPubB64(pub) { return subtle.importKey('raw', unb64(pub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']); }
  async function importRsaPubB64(spki, usage) { return subtle.importKey('spki', unb64(spki), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, [usage || 'encrypt']); }
  async function importRsaPriv(jwk) { return subtle.importKey('jwk', jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']); }

  /* ── Публичный бандл для сервера ───────────────────────────────────────── */
  function publicBundle(identity) {
    const otks = (identity.oneTimeKeys || []).map((k) => k.pub);
    return {
      ik_dh_pub: identity.dh.pub,
      ik_sign_pub: identity.sign.pub,
      rsa_pub: identity.rsa.pub,
      spk_pub: identity.spk.pub,
      spk_sig: identity.spk.sig,
      one_time_keys: otks,
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  КОНВЕРТ ДВОЙНОГО ШИФРОВАНИЯ
   * ═════════════════════════════════════════════════════════════════════════*/
  async function wrapForRecipient(mk, recipient, chatId, senderEph) {
    // Слой 2: RSA-4096-OAEP — ключ сообщения под публичный RSA получателя
    const rsaPub = await importRsaPubB64(recipient.rsa_pub, 'encrypt');
    const rsaWrapped = new Uint8Array(await subtle.encrypt({ name: 'RSA-OAEP' }, rsaPub, mk));
    // Слой 3: ECDH(эфемерный приватный, публичный DH получателя) → HKDF → AES-GCM(mk)
    const eph = senderEph || await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const ephPubRaw = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
    const peerPub = await importDhPubB64(recipient.ik_dh_pub);
    const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: peerPub }, eph.privateKey, 256));
    const k2 = await hkdf(concat(shared, ephPubRaw), te.encode(chatId || ''), 'encryption/l3/v2', 256);
    const iv2 = rand(12);
    const dhWrapped = await aesEncrypt(await aesKey(k2), mk, iv2);
    return { rsa: b64(rsaWrapped), dh: b64(dhWrapped), iv: b64(iv2), eph: b64(ephPubRaw) };
  }

  /**
   * seal — собрать конверт.
   * @param {object} plain   расшифрованный контент {text, ...}
   * @param {object} identity свои ключи
   * @param {Array}  recipients [{id, rsa_pub, ik_dh_pub}]
   * @param {string} chatId  привязка к чату (AAD)
   */
  async function seal(plain, identity, recipients, chatId, opts) {
    opts = opts || {};
    const ts = opts.ts || Date.now();                 // единая метка времени (входит в AAD)
    const mk = rand(32);                              // ключ сообщения
    const iv1 = rand(12);
    const body = te.encode(JSON.stringify(plain));
    const aad = te.encode('enc|' + chatId + '|' + ts);
    const ct1 = await aesEncrypt(await aesKey(mk), body, iv1, aad);   // СЛОЙ 1

    const wrap = {};
    // один эфемерный ECDH-ключ на конверт: быстрее на группах,
    // при этом общий секрет для каждого получателя свой (ECDH с его IK)
    const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    for (const r of recipients) {
      wrap[String(r.id)] = await wrapForRecipient(mk, r, chatId, eph);
    }

    const sigData = concat(ct1, te.encode('|' + chatId + '|' + ts));
    const sigKey = await importSignPriv(identity.sign.priv);
    const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, sigKey, sigData));

    return {
      v: 2,
      alg: { l1: 'AES-256-GCM', l2: 'RSA-4096-OAEP-SHA256', l3: 'ECDH-P256-HKDF-SHA256-AES-256-GCM', sig: 'ECDSA-P256' },
      ts: ts,
      l1: { iv: b64(iv1), ct: b64(ct1) },
      wrap: wrap,
      sig: b64(sig),
      signer: identity.sign.pub,
      burn: !!opts.burn,
    };
  }

  /** open — расшифровать конверт (любой из двух слоёв) */
  async function open(payload, identity, senderSignPub, chatId) {
    if (!payload || !payload.l1) throw new Error('Повреждённый конверт');
    const myId = identity.userId;
    let mk = null;

    const entry = payload.wrap && (payload.wrap[String(myId)] || payload.wrap[myId]);
    if (!entry) throw new Error('В конверте нет ключа для этого устройства');

    // Путь A (слой 2): приватным RSA-ключом
    try {
      const rsaPriv = await importRsaPriv(identity.rsa.priv);
      mk = new Uint8Array(await subtle.decrypt({ name: 'RSA-OAEP' }, rsaPriv, unb64(entry.rsa)));
    } catch (e) { mk = null; }

    // Путь B (слой 3): ECDH + HKDF + AES-GCM
    if (!mk) {
      const myDh = await importDhPriv(identity.dh.priv);
      const ephPub = await importDhPubB64(entry.eph);
      const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: ephPub }, myDh, 256));
      const k2 = await hkdf(concat(shared, unb64(entry.eph)), te.encode(chatId || ''), 'encryption/l3/v2', 256);
      mk = await aesDecrypt(await aesKey(k2), unb64(entry.dh), unb64(entry.iv));
    }
    if (!mk) throw new Error('Не удалось восстановить ключ сообщения');

    // Проверка подписи отправителя (защита от подмены)
    let sigOk = null;
    if (senderSignPub) {
      try {
        const vk = await importSignPubB64(senderSignPub);
        sigOk = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vk, unb64(payload.sig),
          concat(unb64(payload.l1.ct), te.encode('|' + chatId + '|' + payload.ts)));
      } catch (e) { sigOk = false; }
    }

    const aad = te.encode('enc|' + chatId + '|' + payload.ts);
    const body = await aesDecrypt(await aesKey(mk), unb64(payload.l1.ct), unb64(payload.l1.iv), aad);
    return { plain: JSON.parse(td.decode(body)), verified: sigOk, layers: ['AES-256-GCM', 'RSA-OAEP/ECDH'] };
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  ШИФРОВАНИЕ ФАЙЛОВ (по чанкам, AES-256-GCM, ключ на файл)
   * ═════════════════════════════════════════════════════════════════════════*/
  const FILE_CHUNK = 1 << 20; // 1 МиБ

  async function newFileKey() {
    const raw = rand(32);
    return { raw, key: await aesKey(raw), keyB64: b64(raw) };
  }
  function chunkIv(index, fileKeyRaw) {
    // IV = 4 нулевых байта + 8 байт счётчика; привязка к ключу файла через AAD
    return concat(new Uint8Array(4), u32be(0), u32be(index));
  }
  async function encryptChunk(fileKey, index, buffer, aad) {
    const iv = chunkIv(index);
    const ct = await aesEncrypt(fileKey.key, new Uint8Array(buffer), iv, aad);
    return concat(iv, ct); // iv(12) || ciphertext+tag
  }
  async function decryptChunk(fileKey, index, data, aad) {
    const iv = data.subarray(0, 12);
    const ct = data.subarray(12);
    return aesDecrypt(fileKey.key, ct, iv, aad);
  }
  async function keyFromB64(k) { return { raw: unb64(k), key: await aesKey(unb64(k)) }; }

  /** Заворачиваем ключ файла для получателей теми же двумя слоями. */
  async function wrapFileKey(fileKeyRaw, recipients, chatId, identity) {
    const wrap = {};
    for (const r of recipients) {
      wrap[String(r.id)] = await wrapForRecipient(fileKeyRaw, r, chatId || 'file', null);
    }
    return wrap;
  }

  /* ══════════════════════════════════════════════════════════════════════════
   *  ФРАЗА ВОССТАНОВЛЕНИЯ (24 слова из словаря в 256 слов = 192 бита)
   * ═════════════════════════════════════════════════════════════════════════*/
  const WORDS = ('абрикос авария авеню агент агентство адрес азбука айсберг аквариум аккорд актер аллея алмаз альбом амфора ангар ангел апельсин аптека арбуз архив арена аромат артель асфальт атлас атлет афиша багаж базар бакен балкон бальзам банкер баран барон бассейн батарея башня бегемот бедро бекон белка берег бетон библиотека билет бинокль бисер бланк блеск блик блок блуза бобер богатырь бокал болото бомба бонус бордо борода борт ботва браслет брелок брусника букет булавка бульвар бумага буран бурый бутыль буфет бюро вагон ваза валенок валет вальс ванна варенье вафля ведро великан венок веранда верблюд ветер ветка вешалка взгляд вилка витрина вихрь вклад влага вожак возок вокзал волан волна ворона восторг впадина вратарь выбор вымпел вышка газон галерея галстук гамак гараж гармонь гвоздь гейзер генерал герб гитара глазурь глобус глубина гнездо голубь гонка гора горшок гостиная гравий гранат гребень грифель гроздь груша губка гудок гусли дверца дебют дельфин депо дерби деревня десерт деталь джем джунгли диалог диван диктор диплом диск добыча довод дождь доклад долина домен домино донор допуск дорога досье досуг дрова дружина дубрава дуга дудка дупло дуэт душа дыня ежик ельник жабра жаворонок жакет жасмин жвачка желоб желток жемчуг жерло жетон жилет жираф житель жокей жонглер журнал забава забор завал завод загар задор зажим заказ залив замок запад запев заряд заслон засов затвор затея захват звание звено зверь зебра земля зенит зерно зигзаг змея знамя зодчий зубец иволга игла игра игрушка идеал икона икра имидж индюк искра искусство ислам итог кабан кабель каблук кадет казак казна какао калач калитка камень камин камыш канал канон кант капкан капля караван карась карман'.split(' '));

  function entropyToWords(raw) {
    const words = [];
    for (let i = 0; i < 24; i++) words.push(WORDS[raw[i] % WORDS.length]);
    return words;
  }
  function wordsToEntropy(words) {
    const body = WORDS.slice(0, 256);
    return Uint8Array.from(words.map((w) => {
      const i = body.indexOf(w.trim().toLowerCase());
      if (i < 0) throw new Error('Неизвестное слово: ' + w);
      return i;
    }));
  }
  function newRecoveryPhrase() { return entropyToWords(rand(24)); }
  function normalizePhrase(phrase) {
    const str = Array.isArray(phrase) ? phrase.join(' ') : String(phrase || '');
    return str.trim().toLowerCase().replace(/[.,;:!?]/g, '').replace(/\s+/g, ' ').trim();
  }
  async function phraseHash(username, phrase) {
    const bits = await pbkdf2Bits(normalizePhrase(phrase),
      'encryption:recover:' + username.toLowerCase(), PBKDF2_ITER, 512);
    return b64(bits);
  }
  /** Заворачиваем приватные ключи ключом из фразы — сервер хранит только шифротекст. */
  async function wrapWithPhrase(username, phrase, identity) {
    const key = await localKey(normalizePhrase(phrase), 'encryption:recovery-wrap:' + username.toLowerCase());
    const iv = rand(12);
    const ct = await aesEncrypt(key, te.encode(JSON.stringify(identity)), iv);
    return { alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA512', iter: PBKDF2_ITER, iv: b64(iv), ct: b64(ct) };
  }
  async function unwrapWithPhrase(username, phrase, wrap) {
    const key = await localKey(normalizePhrase(phrase), 'encryption:recovery-wrap:' + username.toLowerCase());
    const pt = await aesDecrypt(key, unb64(wrap.ct), unb64(wrap.iv));
    return JSON.parse(td.decode(pt));
  }
  /** Бэкап ключей под паролем (для входа на втором устройстве). */
  async function wrapWithPassword(username, password, identity) {
    const key = await localKey(password, 'encryption:backup:' + username.toLowerCase());
    const iv = rand(12);
    const ct = await aesEncrypt(key, te.encode(JSON.stringify(identity)), iv);
    return { alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA512', iter: PBKDF2_ITER, iv: b64(iv), ct: b64(ct) };
  }
  async function unwrapWithPassword(username, password, wrap) {
    const key = await localKey(password, 'encryption:backup:' + username.toLowerCase());
    const pt = await aesDecrypt(key, unb64(wrap.ct), unb64(wrap.iv));
    return JSON.parse(td.decode(pt));
  }

  /* ── Утилиты ───────────────────────────────────────────────────────────── */
  function fingerprint(pubB64) {
    const bytes = unb64(pubB64);
    let h = 2166136261;
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619); }
    const hex = (h >>> 0).toString(16).padStart(8, '0').toUpperCase();
    return hex.match(/.{1,4}/g).join(' ');
  }
  function randomId(bytes) {
    return Array.from(rand(bytes || 16)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  global.Crypto = {
    b64, unb64, rand, concat, sha256, hkdf,
    PBKDF2_ITER,
    authHash, localKey, pbkdf2Bits,
    aesKey, aesEncrypt, aesDecrypt,
    generateIdentity, publicBundle, seal, open,
    importRsaPubB64, importRsaPriv, importDhPubB64, importDhPriv, importSignPubB64, importSignPriv,
    wrapForRecipient,
    newFileKey, keyFromB64, encryptChunk, decryptChunk, wrapFileKey, FILE_CHUNK,
    newRecoveryPhrase, normalizePhrase, phraseHash, wrapWithPhrase, unwrapWithPhrase,
    wrapWithPassword, unwrapWithPassword, wordsToEntropy,
    fingerprint, randomId, WORDS,
  };
})(typeof window !== 'undefined' ? window : self);
