/* ============================================================================
 * Локальное хранилище устройства.
 * Все секреты (приватные ключи, кэш сообщений) лежат в зашифрованном виде:
 * ключ шифрования хранилища = PBKDF2(пароль пользователя).
 * Если localStorage недоступен (приватный режим, песочница) — работаем в памяти.
 * ========================================================================== */
(function (global) {
  'use strict';
  const PREFIX = 'encryption.';
  let memory = {};
  let usable = true;
  try {
    const probe = PREFIX + 'probe';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
  } catch (e) { usable = false; }

  let storageKey = null;   // CryptoKey (AES-GCM) — появляется после разблокировки

  function rawGet(k) {
    try { return usable ? localStorage.getItem(PREFIX + k) : (memory[k] ?? null); }
    catch (e) { return memory[k] ?? null; }
  }
  function rawSet(k, v) {
    try { if (usable) localStorage.setItem(PREFIX + k, v); else memory[k] = v; }
    catch (e) { memory[k] = v; }
  }
  function rawDel(k) {
    try { if (usable) localStorage.removeItem(PREFIX + k); else delete memory[k]; }
    catch (e) { delete memory[k]; }
  }

  const Store = {
    get usingMemory() { return !usable; },

    get(key, fallback) {
      const v = rawGet(key);
      if (v == null) return fallback;
      try { return JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) { rawSet(key, JSON.stringify(value)); return value; },
    del(key) { rawDel(key); },

    /** Устройство: постоянный, уникальный на устройство идентификатор. */
    device() {
      let d = Store.get('device', null);
      if (!d) {
        d = {
          device_id: 'dev-' + Crypto.randomId(16),
          name: guessDeviceName(),
          platform: guessPlatform(),
          app_version: '1.0.0-web',
          fingerprint: fingerprint(),
          created: Date.now(),
        };
        Store.set('device', d);
      }
      return d;
    },

    settings() {
      return Store.get('settings', { theme: 'dark', notifications: true, sounds: true, readReceipts: true, enterToSend: true });
    },
    saveSettings(s) { return Store.set('settings', s); },

    /** Аккаунты, которые входили на этом устройстве (для авто-подстановки логина). */
    account() { return Store.get('account', null); },
    saveAccount(a) { return Store.set('account', a); },
    clearAccount() { rawDel('account'); },

    /** Ключ шифрования локального хранилища (после ввода пароля). */
    async unlock(password, username) {
      storageKey = await Crypto.localKey(password, 'encryption:device-store:' + username.toLowerCase());
      return storageKey;
    },
    lock() { storageKey = null; },
    get unlocked() { return !!storageKey; },

    /** Личный набор ключей — на диске только в зашифрованном виде. */
    async saveIdentity(username, password, identity) {
      const wrap = await Crypto.wrapWithPassword(username, password, identity);
      Store.set('identity.' + username.toLowerCase(), wrap);
      return wrap;
    },
    /** Загруженная в бэкапе личность (после восстановления/входа на втором устройстве). */
    async loadIdentity(username, password) {
      const wrap = Store.get('identity.' + username.toLowerCase(), null);
      if (!wrap) return null;
      try { return await Crypto.unwrapWithPassword(username, password, wrap); }
      catch (e) { return null; }
    },
    async saveIdentityRaw(username, identity) {
      const wrap = await Crypto.wrapWithPassword(username, 'raw:' + username.toLowerCase() + ':' + deviceIdFor(username), identity);
      Store.set('identity.' + username.toLowerCase(), wrap);
      return wrap;
    },
    hasIdentity(username) { return !!Store.get('identity.' + username.toLowerCase(), null); },
    dropIdentity(username) { rawDel('identity.' + username.toLowerCase()); },

    /** Токены сессии — в localStorage (как в мобильных клиентах), refresh ротируется сервером. */
    tokens() { return Store.get('tokens', null); },
    saveTokens(t) { return Store.set('tokens', t); },
    clearTokens() { rawDel('tokens'); },

    /** Одно устройство — один аккаунт: жёсткая локальная привязка. */
    boundAccount(username) {
      const b = Store.get('bound_account', null);
      if (!b) { Store.set('bound_account', { username, at: Date.now() }); return username; }
      return b.username;
    },
    bindingInfo() { return Store.get('bound_account', null); },
    releaseBinding() { rawDel('bound_account'); },

    /** Кэш расшифрованных сообщений по чатам (зашифрован на диске). */
    async cacheMessages(chatId, messages) {
      if (!storageKey) return;
      const iv = Crypto.rand(12);
      const ct = await Crypto.aesEncrypt(storageKey, new TextEncoder().encode(JSON.stringify(messages)), iv);
      Store.set('cache.' + chatId, { iv: Crypto.b64(iv), ct: Crypto.b64(ct), at: Date.now() });
    },
    async loadCachedMessages(chatId) {
      if (!storageKey) return null;
      const rec = Store.get('cache.' + chatId, null);
      if (!rec) return null;
      try {
        const pt = await Crypto.aesDecrypt(storageKey, Crypto.unb64(rec.ct), Crypto.unb64(rec.iv));
        return JSON.parse(new TextDecoder().decode(pt));
      } catch (e) { return null; }
    },
    clearCache() {
      try {
        Object.keys(usable ? localStorage : memory).forEach((k) => {
          const key = k.startsWith(PREFIX) ? k.slice(PREFIX.length) : k;
          if (key.startsWith('cache.')) rawDel(key);
        });
      } catch (e) {}
    },

    /** Всё стирается: выход «с очисткой» (по умолчанию при выходе ключи не удаляем). */
    wipeAll() {
      const keys = [];
      try {
        if (usable) { for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i)); }
        else keys = Object.keys(memory);
      } catch (e) {}
      keys.forEach((k) => {
        if (k && k.startsWith(PREFIX)) { try { rawDel(k.slice(PREFIX.length)); } catch (e) {} }
      });
      memory = {};
      storageKey = null;
    },
  };

  function guessPlatform() {
    const ua = navigator.userAgent || '';
    if (/Electron/i.test(ua)) return 'windows';
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad/i.test(ua)) return 'ios';
    if (/Mac OS X/i.test(ua)) return 'macos';
    if (/Linux/i.test(ua)) return 'linux';
    return 'web';
  }
  function guessDeviceName() {
    const ua = navigator.userAgent || '';
    const ru = (navigator.language || 'en').toLowerCase().startsWith('ru');
    let os = ru ? 'Устройство' : 'Device';
    if (/Electron/i.test(ua)) os = ru ? 'Encryption для ПК' : 'Encryption for PC';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/iPhone|iPad/i.test(ua)) os = 'iPhone/iPad';
    else if (/Mac OS X/i.test(ua)) os = 'macOS';
    else if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Linux/i.test(ua)) os = 'Linux';
    return os + ' • ' + (navigator.platform || 'web');
  }
  function fingerprint() {
    const src = [navigator.userAgent, navigator.language, screen.width + 'x' + screen.height,
      screen.colorDepth, new Date().getTimezoneOffset(), navigator.hardwareConcurrency || 0].join('|');
    let h = 2166136261;
    for (let i = 0; i < src.length; i++) { h ^= src.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16);
  }
  function deviceIdFor(username) {
    return (Store.get('device', { device_id: 'x' }).device_id || 'x') + ':' + username;
  }

  global.Store = Store;
})(typeof window !== 'undefined' ? window : self);
