/* ============================================================================
 * ДЕМО-РЕЖИМ: сервер прямо в браузере (память).
 * Нужен, чтобы посмотреть весь функционал без развёрнутого сервера —
 * шифрование при этом настоящее: конверты строятся тем же ядром Crypto.
 * ========================================================================== */
(function (global) {
  'use strict';

  const now = () => Math.floor(Date.now() / 1000);
  const rid = (p) => p + Math.random().toString(16).slice(2, 14);

  class DemoServer {
    constructor() {
      this.mode = 'demo';
      this.base = 'demo://local';
      this.handlers = [];
      this.connected = false;
      this.access = null; this.refresh = null;
      this.currentUser = null;
      this.users = new Map();     // id -> user
      this.byName = new Map();
      this.identities = new Map(); // username -> identity (ключами владеет «устройство»)
      this.chats = new Map();
      this.messages = [];
      this.files = new Map();
      this.contacts = [];
      this.audit = [];
      this.bus = [];
      this.seq = 1;
      // генерация ключей бота и «демо-пользователя» — асинхронная, ждём в хендлерах
      this.ready = this._bot();
    }

    /* ── Служебное ─────────────────────────────────────────────────────── */
    on(h) { this.handlers.push(h); }
    emit(ev) { this.handlers.forEach((h) => setTimeout(() => h(ev), 0)); }
    setTokens(t) { this.access = t.access_token; this.refresh = t.refresh_token; Store.saveTokens(t); }
    restoreTokens() { return !!Store.tokens(); }
    clearTokens() { Store.clearTokens(); }
    connectWS() { this.connected = true; this.emit({ t: 'conn', online: true }); }
    disconnectWS() { this.connected = false; }
    sendRaw(o) {
      if (o.t === 'typing') return true;
      if (o.t === 'read') return true;
      return true;
    }
    get usingMemory() { return true; }

    async _bot() {
      const botIdentity = await Crypto.generateIdentity();
      const self = await Crypto.generateIdentity();
      const mk = (id, username, display, identity) => {
        const u = {
          id, username, display_name: display, about: 'Демо-аккаунт',
          avatar_id: null, created_at: now(), last_seen: now(),
          ik_dh_pub: identity.dh.pub, ik_sign_pub: identity.sign.pub, rsa_pub: identity.rsa.pub,
          spk_pub: identity.spk.pub, spk_sig: identity.spk.sig, one_time_keys: identity.oneTimeKeys.map((k) => k.pub),
          key_backup: null, recovery_hash: null, recovery_hint: '', is_banned: 0,
        };
        this.users.set(id, u); this.byName.set(username, u); this.identities.set(username, identity);
        return u;
      };
      mk(1, 'encryption_bot', 'Encryption Bot 🤖', botIdentity);
      mk(2, 'demo', 'Вы (демо)', self);
      this.bot = this.users.get(1); this.me = this.users.get(2);
      this.currentUser = this.me;
    }

    async _ensureDemoChat() {
      const cid = 'u2-u1';
      if (this.chats.has(cid)) return cid;
      this.chats.set(cid, { id: cid, type: 'direct', title: '', avatar_id: null, owner_id: 2,
        ttl_seconds: 0, created_at: now(), updated_at: now(), meta: {},
        members: [{ user_id: 2, role: 'member', joined_at: now() }, { user_id: 1, role: 'member', joined_at: now() }] });
      await this._botSay('Здравствуйте! Это демонстрация мессенджера Encryption. ' +
        'Сообщения здесь шифруются по-настоящему: AES-256-GCM для текста и RSA-4096-OAEP для ключа сообщения. ' +
        'Попробуйте написать что-нибудь со словом «шифрование», «файл» или «звонок».');
      return cid;
    }

    async _botSay(text) {
      await this.ready;
      const cid = 'u2-u1';
      const bot = this.bot, mev = this.me;
      const recipients = [
        { id: bot.id, rsa_pub: bot.rsa_pub, ik_dh_pub: bot.ik_dh_pub },
        { id: mev.id, rsa_pub: mev.rsa_pub, ik_dh_pub: mev.ik_dh_pub },
      ];
      const identity = Object.assign(this.identities.get('encryption_bot'), { userId: bot.id });
      const payload = await Crypto.seal({ text, kind: 'text' }, identity, recipients, cid, {});
      const msg = { id: rid('m'), chat_id: cid, sender_id: 1, payload, type: 'text',
        created_at: now(), edited_at: null, deleted_at: null, expires_at: null,
        reactions: [], receipts: [{ user_id: 2, state: 'delivered', at: now() }] };
      this.messages.push(msg);
      this.chats.get(cid).updated_at = now();
      this.emit({ t: 'message', message: msg });
      return msg;
    }

    _match(method, path) {
      // простой роутер: возвращает [handler, params]
      const P = [
        ['POST', /^\/api\/v1\/auth\/demo$/, 'authDemo'],
        ['POST', /^\/api\/v1\/auth\/login$/, 'authLogin'],
        ['POST', /^\/api\/v1\/auth\/register$/, 'authRegister'],
        ['POST', /^\/api\/v1\/auth\/challenge$/, 'authChallenge'],
        ['POST', /^\/api\/v1\/auth\/device\/check$/, 'deviceCheck'],
        ['POST', /^\/api\/v1\/auth\/logout$/, 'ok'],
        ['POST', /^\/api\/v1\/auth\/pair\/start$/, 'ok'],
        ['GET', /^\/api\/v1\/auth\/devices$/, 'devices'],
        ['GET', /^\/api\/v1\/auth\/sessions$/, 'sessions'],
        ['GET', /^\/api\/v1\/health$/, 'health'],
        ['GET', /^\/api\/v1\/site\/info$/, 'siteInfo'],
        ['GET', /^\/api\/v1\/security\/policy$/, 'policy'],
        ['GET', /^\/api\/v1\/security\/log$/, 'auditLog'],
        ['GET', /^\/api\/v1\/users\/me$/, 'me'],
        ['PATCH', /^\/api\/v1\/users\/me$/, 'updateMe'],
        ['GET', /^\/api\/v1\/users\/search$/, 'searchUsers'],
        ['GET', /^\/api\/v1\/users\/([^/]+)\/bundle$/, 'bundle'],
        ['PUT', /^\/api\/v1\/users\/me\/backup$/, 'ok'],
        ['GET', /^\/api\/v1\/chats$/, 'listChats'],
        ['POST', /^\/api\/v1\/chats$/, 'createChat'],
        ['GET', /^\/api\/v1\/chats\/([^/]+)$/, 'getChat'],
        ['PATCH', /^\/api\/v1\/chats\/([^/]+)$/, 'patchChat'],
        ['POST', /^\/api\/v1\/chats\/([^/]+)\/members$/, 'members'],
        ['POST', /^\/api\/v1\/chats\/([^/]+)\/(leave|pin|archive|mute|draft|invite)$/, 'chatOp'],
        ['GET', /^\/api\/v1\/messages$/, 'listMessages'],
        ['POST', /^\/api\/v1\/messages$/, 'sendMessage'],
        ['PATCH', /^\/api\/v1\/messages\/([^/]+)$/, 'editMessage'],
        ['DELETE', /^\/api\/v1\/messages\/([^/]+)$/, 'deleteMessage'],
        ['POST', /^\/api\/v1\/messages\/([^/]+)\/(reaction|receipt|pin)$/, 'msgOp'],
        ['POST', /^\/api\/v1\/messages\/read-all$/, 'ok'],
        ['GET', /^\/api\/v1\/messages\/search\/global$/, 'searchGlobal'],
        ['POST', /^\/api\/v1\/files\/init$/, 'fileInit'],
        ['PUT', /^\/api\/v1\/files\/([^/]+)\/chunk$/, 'fileChunkPut'],
        ['GET', /^\/api\/v1\/files\/([^/]+)\/chunk$/, 'fileChunkGet'],
        ['GET', /^\/api\/v1\/files\/([^/]+)\/meta$/, 'fileMeta'],
        ['POST', /^\/api\/v1\/files\/([^/]+)\/complete$/, 'fileComplete'],
        ['POST', /^\/api\/v1\/files\/([^/]+)\/consumed$/, 'fileConsumed'],
        ['GET', /^\/api\/v1\/files\/([^/]+)\/local-only$/, 'fileLocalOnly'],
        ['GET', /^\/api\/v1\/contacts$/, 'contacts'],
        ['POST', /^\/api\/v1\/calls$/, 'call'],
      ];
      for (const [m, re, name] of P) {
        const mt = path.match(re);
        if (m === method && mt) return [name, mt.slice(1)];
      }
      return [null, []];
    }

    async request(method, path, body, opts) {
      const [q, query] = String(path).split('?');
      const [handler, params] = this._match(method, q);
      if (!handler) {
        if (/files\/.*chunk/.test(q)) return null;
        throw new ApiError('DEMO_NOT_IMPLEMENTED', (window.I18N ? I18N.t('conn.demoUnavailable') : 'Demo mode: section unavailable') + ': ' + q, 501);
      }
      return this['h_' + handler](params, body || {}, new URLSearchParams(query || ''));
    }

    get(p, qs) { return this.request('GET', p + (qs ? (p.includes('?') ? '&' : '?') + new URLSearchParams(qs) : '')); }
    post(p, b, qs) { return this.request('POST', p, b, qs); }
    patch(p, b, qs) { return this.request('PATCH', p, b, qs); }
    put(p, b, qs) { return this.request('PUT', p, b, qs); }
    del(p, qs) { return this.request('DELETE', p, qs); }

    async uploadBlob({ blob, chatId, kind, nameEnc, keyWrap, onProgress, chunkSize }) {
      const cs = chunkSize || 256 * 1024;
      const f = this.h_fileInit([], { chat_id: chatId || 'u2-u1', size: blob.size, kind,
        mime: blob.type || 'application/octet-stream', name_enc: nameEnc || '', key_wrap: keyWrap || '',
        chunk_size: cs });
      const total = f.chunks;
      for (let i = 0; i < total; i++) {
        const slice = blob.slice(i * cs, Math.min((i + 1) * cs, blob.size));
        const buf = new Uint8Array(await slice.arrayBuffer());
        this.files.get(f.file_id).chunksData[i] = buf;
        onProgress && onProgress((i + 1) / Math.max(total, 1));
      }
      return f;
    }
    async downloadBlob(fileId) {
      const rec = this.files.get(fileId);
      if (!rec) throw new ApiError('FILE_GONE', (window.I18N ? I18N.t('file.notFound') : 'File not found'), 404);
      if (rec.local_only) throw new ApiError('LOCAL_ONLY', (window.I18N ? I18N.t('file.localOnlyNote') : 'File already downloaded'), 410);
      return new Blob(rec.chunksData || [], { type: rec.mime || 'application/octet-stream' });
    }

    /** Личность демо-пользователя: выдаём клиенту, чтобы конверты расшифровывались
     *  тем же ключом, которым их «запечатал» демо-сервер (это то же устройство). */
    identityFor(username) {
      const id = this.identities.get(username);
      if (!id) return null;
      const u = this.byName.get(username) || {};
      return Object.assign({}, id, { userId: u.id });
    }

    /* ── Хендлеры ─────────────────────────────────────────────────────── */
    h_ok() { return { ok: true }; }
    h_health() { return { status: 'ok', app: 'Encryption', version: '1.0.0-demo', time: now(), file_ttl_hours: 24 }; }
    h_siteInfo() {
      return { app: 'Encryption', version: '1.0.0-demo',
        stats: { users: this.users.size, messages: this.messages.length, files_in_cloud: this.files.size },
        features: global.FEATURES || [] };
    }
    h_policy() { return global.POLICY || {}; }
    h_authChallenge(p, body) {
      return { exists: this.byName.has(body.username), kdf: { algo: 'PBKDF2-SHA512', iterations: 310000, salt: 'encryption:' + body.username.toLowerCase() } };
    }
    h_deviceCheck(p, body) {
      const device = Store.device();
      const bound = Store.bindingInfo();
      return { device_bound: !!bound, bound_to: bound ? bound.username : null,
        same_user: !!bound && bound.username === body.username,
        username_exists: this.byName.has(body.username),
        kdf: { algo: 'PBKDF2-SHA512', iterations: 310000 } };
    }
    async h_authDemo() {
      await this.ready;
      const cid = await this._ensureDemoChat();
      return this._session(this.me, await this._buildServerInfo(), cid);
    }
    async h_authRegister(p, body) {
      await this.ready;
      if (this.byName.has(body.username)) throw new ApiError('USERNAME_TAKEN', 'Логин занят', 409);
      const id = ++this.seq + 10;
      const identity = await Crypto.generateIdentity();
      const u = { id, username: body.username, display_name: body.display_name || body.username,
        about: '', avatar_id: null, created_at: now(), last_seen: now(),
        ik_dh_pub: body.keys.ik_dh_pub, ik_sign_pub: body.keys.ik_sign_pub, rsa_pub: body.keys.rsa_pub,
        spk_pub: body.keys.spk_pub, spk_sig: body.keys.spk_sig, one_time_keys: body.keys.one_time_keys || [],
        key_backup: body.key_backup || null, recovery_hash: body.recovery ? 'x' : null, recovery_hint: body.recovery_hint || '' };
      this.users.set(id, u); this.byName.set(u.username, u);
      this.identities.set(u.username, identity);
      this.currentUser = u;
      await this._botSay('Привет, ' + u.display_name + '! Рады видеть в демо-режиме. Всё, что вы отправите, ' +
        'шифруется двойным способом, а файлы удаляются через 24 часа.');
      return this._session(u, await this._buildServerInfo());
    }
    async h_authLogin(p, body) {
      await this.ready;
      const u = this.byName.get(body.username);
      if (!u) throw new ApiError('BAD_CREDENTIALS', 'Неверный логин или пароль', 401);
      this.currentUser = u;
      return this._session(u, await this._buildServerInfo());
    }
    async _buildServerInfo() {
      return { name: 'Encryption', version: '1.0.0-demo', host: 'demo://local', port: 0,
        policy: { file_ttl_hours: 24, one_account_per_device: true, max_devices: 4,
          device_rebind_cooldown_days: 30, recovery_words: 24, group_max_members: 200 },
        encryption: { layer1: 'AES-256-GCM', layer2: 'RSA-4096-OAEP-SHA256',
          layer3: 'ECDH P-256 + HKDF-SHA256 + AES-256-GCM', signature: 'ECDSA P-256' } };
    }
    _session(user, server, extraChatId) {
      const tokens = { access_token: 'demo.' + Date.now(), refresh_token: 'demo-refresh.' + Date.now() };
      this.setTokens(tokens);
      this.currentUser = user;
      return { user, tokens, server, demo: true, chatId: extraChatId };
    }
    h_me() {
      return { user: this.currentUser, device_id: Store.device().device_id,
        chats: 1, devices: 1,
        policy: { file_ttl_hours: 24, one_account_per_device: true, max_devices: 4,
          device_rebind_cooldown_days: 30, recovery_words: 24, group_max_members: 200 },
        server: { host: 'demo://local', port: 0, version: '1.0.0-demo' } };
    }
    h_updateMe(p, body) {
      Object.assign(this.currentUser, body);
      return { user: this.currentUser };
    }
    h_searchUsers(p, body, q) {
      const term = (q.get('q') || '').toLowerCase();
      return { users: [...this.users.values()].filter((u) => u.username !== this.currentUser.username &&
        (u.username.includes(term) || (u.display_name || '').toLowerCase().includes(term))) };
    }
    h_bundle(params) {
      const u = this.byName.get(params[0]);
      if (!u) throw new ApiError('NO_USER', 'Пользователь не найден', 404);
      return { user: u, bundle: { ik_dh_pub: u.ik_dh_pub, ik_sign_pub: u.ik_sign_pub, rsa_pub: u.rsa_pub,
        spk_pub: u.spk_pub, spk_sig: u.spk_sig, one_time_key: (u.one_time_keys || [])[0] || null } };
    }
    h_devices() {
      const d = Store.device();
      return { devices: [{ id: d.device_id, name: d.name, platform: d.platform, created_at: now(),
        last_seen: now(), revoked_at: null, current: true, online: true }], max_devices: 4 };
    }
    h_sessions() {
      const d = Store.device();
      return { sessions: [{ id: 'demo', device_id: d.device_id, created_at: now(), expires_at: now() + 2592000,
        revoked_at: null, ip: '127.0.0.1', user_agent: navigator.userAgent, name: d.name, platform: d.platform }],
        current_device: d.device_id };
    }
    h_auditLog() { return { events: this.audit.slice(-50).reverse() }; }

    h_listChats() {
      const uid = this.currentUser.id;
      const chats = [...this.chats.values()].filter((c) => c.members.some((m) => m.user_id === uid));
      return { chats: chats.map((c) => this._chatJson(c, uid)) };
    }
    _chatJson(c, uid) {
      const msgs = this.messages.filter((m) => m.chat_id === c.id && !m.deleted_at);
      const last = msgs[msgs.length - 1] || null;
      return {
        id: c.id, type: c.type, title: c.title || this._peerName(c, uid), avatar_id: c.avatar_id,
        owner_id: c.owner_id, ttl_seconds: c.ttl_seconds, created_at: c.created_at, updated_at: c.updated_at,
        members: c.members.map((m) => {
          const u = this.users.get(m.user_id) || {};
          return { id: m.user_id, username: u.username, display_name: u.display_name, avatar_id: u.avatar_id,
            role: m.role, online: m.user_id !== uid, last_seen: u.last_seen || 0,
            ik_dh_pub: u.ik_dh_pub, rsa_pub: u.rsa_pub };
        }),
        last_message: last, unread: 0,
        me: { role: c.members.find((m) => m.user_id === uid)?.role || 'member', pinned: !!c.pinned,
          archived: false, muted_until: 0, last_read_at: now(), custom_ttl: 0, draft: '' },
      };
    }
    _peerName(c, uid) {
      const other = c.members.find((m) => m.user_id !== uid);
      const u = other && this.users.get(other.user_id);
      return u ? u.display_name : 'Чат';
    }
    async h_createChat(p, body) {
      await this.ready;
      const uid = this.currentUser.id;
      if (body.type === 'group') {
        const cid = rid('g');
        const members = [{ user_id: uid, role: 'owner', joined_at: now() },
          { user_id: 1, role: 'member', joined_at: now() }];
        this.chats.set(cid, { id: cid, type: 'group', title: body.title || 'Новая группа', avatar_id: null,
          owner_id: uid, ttl_seconds: body.ttl_seconds || 0, created_at: now(), updated_at: now(), meta: {}, members });
        await this._botSayTo(cid, 'Группа создана. В ней шифрование то же: каждый участник получает ' +
          'свою RSA-обёртку ключа сообщения.');
        return this._chatJson(this.chats.get(cid), uid);
      }
      const peer = this.byName.get(body.peer_username);
      if (!peer) throw new ApiError('NO_USER', 'Пользователь не найден', 404);
      const cid = ['u' + uid, 'u' + peer.id].sort().join('-');
      if (!this.chats.has(cid)) {
        this.chats.set(cid, { id: cid, type: 'direct', title: '', avatar_id: null, owner_id: uid,
          ttl_seconds: 0, created_at: now(), updated_at: now(), meta: {},
          members: [{ user_id: uid, role: 'member', joined_at: now() }, { user_id: peer.id, role: 'member', joined_at: now() }] });
      }
      return this._chatJson(this.chats.get(cid), uid);
    }
    async _botSayTo(chatId, text) {
      await this.ready;
      const c = this.chats.get(chatId);
      const recipients = c.members.map((m) => {
        const u = this.users.get(m.user_id);
        return { id: u.id, rsa_pub: u.rsa_pub, ik_dh_pub: u.ik_dh_pub };
      });
      const identity = Object.assign(this.identities.get('encryption_bot'), { userId: 1 });
      const payload = await Crypto.seal({ text, kind: 'text' }, identity, recipients, chatId, {});
      this.messages.push({ id: rid('m'), chat_id: chatId, sender_id: 1, payload, type: 'text',
        created_at: now(), deleted_at: null, expires_at: null, reactions: [], receipts: [] });
      this.chats.get(chatId).updated_at = now();
    }
    h_getChat(params) { return this._chatJson(this.chats.get(params[0]), this.currentUser.id); }
    h_patchChat(params, body) {
      const c = this.chats.get(params[0]);
      if (body.title !== undefined) c.title = body.title;
      if (body.ttl_seconds !== undefined) c.ttl_seconds = body.ttl_seconds;
      this.emit({ t: 'chat.updated', chat_id: c.id });
      return this._chatJson(c, this.currentUser.id);
    }
    h_members(params, body) {
      const c = this.chats.get(params[0]);
      if (body.action === 'remove') c.members = c.members.filter((m) => m.user_id !== body.user_id);
      this.emit({ t: 'chat.updated', chat_id: c.id });
      return { ok: true };
    }
    h_chatOp(params, body, q) {
      const c = this.chats.get(params[0]);
      const op = params[1];
      if (op === 'pin') c.pinned = q.get('pinned') !== 'false';
      if (op === 'invite') return { token: 'demo-' + rid('t'), link: '/join/demo', expires_in_hours: 168, max_uses: 0 };
      this.emit({ t: 'chat.updated', chat_id: c.id });
      return { ok: true };
    }
    h_listMessages(p, body, q) {
      const chatId = q.get('chat_id');
      const limit = parseInt(q.get('limit') || '60', 10);
      const msgs = this.messages.filter((m) => m.chat_id === chatId && !m.deleted_at);
      return { messages: msgs.slice(-limit), has_more: msgs.length > limit };
    }
    async h_sendMessage(p, body) {
      await this.ready;
      const uid = this.currentUser.id;
      const chat = this.chats.get(body.chat_id);
      const msg = { id: body.client_msg_id || rid('m'), chat_id: body.chat_id, sender_id: uid,
        payload: body.payload, type: body.type || 'text', reply_to: body.reply_to || null,
        created_at: now(), deleted_at: null, expires_at: body.ttl_seconds ? now() + body.ttl_seconds : null,
        burn_after_read: !!body.burn_after_read, attachment_id: body.attachment_id || null,
        attachment_meta: body.attachment_meta || null, reactions: [], receipts: [] };
      this.messages.push(msg);
      chat.updated_at = now();
      setTimeout(() => this.emit({ t: 'message', message: msg }), 30);
      setTimeout(() => this.emit({ t: 'message.receipt', chat_id: chat.id, message_id: msg.id,
        user_id: 1, state: 'read' }), 900);
      // «живой» бот отвечает
      if (chat.members.some((m) => m.user_id === 1) && uid !== 1) {
        const text = body._text || '';
        setTimeout(() => this._botReply(chat.id, text), 1200 + Math.random() * 900);
      }
      return msg;
    }
    async _botReply(chatId, userText) {
      await this.ready;
      const t = (userText || '').toLowerCase();
      let answer;
      if (/файл|фото|видео|документ/.test(t)) {
        answer = 'Файлы шифруются на устройстве (AES-256-GCM по чанкам), ключ файла заворачивается ' +
          'в RSA-4096 для каждого получателя, а сам файл живёт в облаке ровно 24 часа, после чего удаляется безвозвратно. ' +
          'Кнопка ⏱ в панели чата задаёт автоудаление сообщений.';
      } else if (/звонок|видеозвонок|позвони/.test(t)) {
        answer = 'Звонки идут через WebRTC: медиапоток защищён DTLS-SRTP, ключами обмениваемся внутри ' +
          'сигнализации поверх уже зашифрованного канала. Нажмите 📞 или 🎥 в шапке чата.';
      } else if (/шифр|ключ|безопасн|e2e/.test(t)) {
        answer = 'Каждое сообщение шифруется дважды: (1) AES-256-GCM случайным ключом сообщения, ' +
          '(2) этот ключ заворачивается в RSA-4096-OAEP-SHA256 для каждого получателя. ' +
          'Дополнительно работает ECDH P-256 с эфемерным ключом — forward secrecy. ' +
          'Сервер видит только шифротекст и метаданные.';
      } else if (/восстанов|пароль|фраз|забыл/.test(t)) {
        answer = 'Если забыли пароль — есть три пути: 24-словная фраза восстановления, вход по коду ' +
          'с уже авторизованного устройства (Настройки → Устройства → Добавить устройство) или, если ' +
          'доступа нет совсем, освобождение устройства с карантином 30 дней. Восстановить переписку без ключей нельзя — ' +
          'именно поэтому это защищённый мессенджер.';
      } else if (/привет|здравств|hi|hello/.test(t)) {
        answer = 'Здравствуйте! Всё работает: напишите сообщение, прикрепите файл, создайте группу ' +
          'или включите самоуничтожение кнопкой ⏱. Демо-режим полностью локальный: ваш сервер не задействован.';
      } else {
        answer = 'Принято! Это ответ из демо-канала. Ваше сообщение было запечатано в конверт ' +
          'двойного шифрования прямо в браузере, а хост в этой демонстрации может быть даже отключён.';
      }
      await this._botSay(answer);
    }
    h_editMessage(params, body) {
      const m = this.messages.find((x) => x.id === params[0]);
      if (!m) throw new ApiError('NO_MSG', 'Сообщение не найдено', 404);
      m.payload = body.payload; m.edited_at = now();
      this.emit({ t: 'message.edited', chat_id: m.chat_id, message_id: m.id, payload: m.payload, edited_at: m.edited_at });
      return { ok: true };
    }
    h_deleteMessage(params) {
      const m = this.messages.find((x) => x.id === params[0]);
      if (m) { m.deleted_at = now(); m.payload = {}; this.emit({ t: 'message.deleted', chat_id: m.chat_id, message_id: m.id }); }
      return { ok: true };
    }
    h_msgOp(params, body) {
      const m = this.messages.find((x) => x.id === params[0]);
      if (!m) throw new ApiError('NO_MSG', 'Сообщение не найдено', 404);
      const op = params[1];
      if (op === 'reaction') {
        m.reactions = m.reactions || [];
        const i = m.reactions.findIndex((r) => r.user_id === this.currentUser.id && r.emoji === body.emoji);
        if (i >= 0) m.reactions.splice(i, 1); else m.reactions.push({ user_id: this.currentUser.id, emoji: body.emoji });
        this.emit({ t: 'message.reaction', chat_id: m.chat_id, message_id: m.id, user_id: this.currentUser.id, emoji: body.emoji });
      }
      if (op === 'receipt') {
        m.receipts = m.receipts || [];
        m.receipts.push({ user_id: this.currentUser.id, state: body.state, at: now() });
        this.emit({ t: 'message.receipt', chat_id: m.chat_id, message_id: m.id, user_id: this.currentUser.id, state: body.state });
      }
      return { ok: true };
    }
    h_searchGlobal(p, body, q) {
      const term = (q.get('q') || '').toLowerCase();
      return { results: this.messages.filter((m) => (m.attachment_meta && JSON.stringify(m.attachment_meta).toLowerCase().includes(term))).slice(-20) };
    }
    h_fileInit(p, body) {
      const id = rid('f');
      const cs = body.chunk_size || 262144;
      const chunks = Math.max(1, Math.ceil((body.size || 0) / cs));
      const rec = { id, owner: this.currentUser.id, chat_id: body.chat_id, size: body.size || 0,
        kind: body.kind, mime: body.mime, name_enc: body.name_enc, key_wrap: body.key_wrap,
        chunk_size: cs, chunks, created_at: now(), expires_at: now() + 24 * 3600, chunksData: [] };
      this.files.set(id, rec);
      return { file_id: id, chunk_size: cs, chunks, expires_at: rec.expires_at, ttl_hours: 24 };
    }
    h_fileChunkPut(params, body, q) {
      const rec = this.files.get(params[0]);
      if (!rec) throw new ApiError('FILE_GONE', (window.I18N ? I18N.t('file.notFound') : 'File not found'), 404);
      rec.chunksData[parseInt(q.get('index') || '0', 10)] = body instanceof Blob
        ? new Uint8Array(0) : new Uint8Array(body || []);
      return { ok: true };
    }
    h_fileChunkGet(params) {
      const rec = this.files.get(params[0]);
      if (!rec) throw new ApiError('FILE_GONE', (window.I18N ? I18N.t('file.notFound') : 'File not found'), 404);
      if (rec.local_only) {
        throw new ApiError('LOCAL_ONLY', (window.I18N ? I18N.t('file.localOnlyNote') : 'File already downloaded'), 410);
      }
      return { chunksData: rec.chunksData };
    }
    h_fileMeta(params) {
      const rec = this.files.get(params[0]);
      if (!rec) throw new ApiError('FILE_GONE', (window.I18N ? I18N.t('file.notFound') : 'File not found'), 404);
      return { file_id: rec.id, size: rec.size, kind: rec.kind, mime: rec.mime, name_enc: rec.name_enc,
        key_wrap: rec.key_wrap, chunk_size: rec.chunk_size, chunks: rec.chunks,
        uploaded_chunks: (rec.chunksData || []).map((x, i) => (x ? i : null)).filter((x) => x !== null),
        created_at: rec.created_at, expires_at: rec.expires_at, ttl_left: rec.expires_at - now(),
        local_only: !!rec.local_only, on_server: !rec.local_only,
        consumed_at: rec.consumed_at || null,
        burn_after_download: true,
        note: rec.local_only
          ? 'Файл скачан получателем и удалён с сервера: копия осталась только на устройстве'
          : 'Файл хранится на сервере максимум 24 часа и удаляется сразу после скачивания получателем' };
    }
    h_fileComplete() { return { ok: true }; }

    /* «Скачал получатель → файл удаляется с сервера»: поведение как у настоящего сервера */
    h_fileConsumed(params) {
      const rec = this.files.get(params[0]);
      if (!rec) return { ok: true, local_only: true, deleted_from_server: false };
      const already = !!rec.local_only;
      rec.local_only = true;                     // надгробие: данные стёрты, запись осталась
      rec.consumed_at = rec.consumed_at || now();
      rec.consumed_by = this.currentUser.id;
      rec.size = 0; rec.chunksData = [];
      this.messages.forEach((m) => { if (m.attachment_id === rec.id) m.local_only = true; });
      return { ok: true, local_only: true, deleted_from_server: !already,
        message: (window.I18N ? I18N.t('file.savedNote') : 'File removed from the server') };
    }
    h_fileLocalOnly(params) {
      const rec = this.files.get(params[0]);
      if (!rec) return { file_id: params[0], local_only: true, on_server: false };
      return { file_id: rec.id, local_only: !!rec.local_only, on_server: !rec.local_only,
        consumed_at: rec.consumed_at || null, consumed_by: rec.consumed_by || null,
        policy: 'Файл хранится на сервере максимум 24 часа и удаляется сразу после скачивания получателем' };
    }
    h_contacts() { return { contacts: [] }; }
    h_call(p, body) {
      return { call_id: rid('c'), ice_servers: [{ urls: 'stun:stun.l.google.com:19302' }],
        note: 'Звонки в демо-режиме ограничены: медиапоток WebRTC замкнут на локальную петлю.' };
    }
  }

  global.DemoApi = () => new DemoServer();
  global.FEATURES = [
    'Личные и групповые чаты (до 200 участников)',
    'Двойное шифрование: AES-256-GCM + RSA-4096-OAEP (+ ECDH forward secrecy)',
    'Подпись каждого конверта (ECDSA P-256)',
    'Файлы/фото/видео: шифруются на устройстве, живут ровно 24 часа',
    'Самоуничтожающиеся сообщения, таймер в чате',
    'Редактирование, удаление у всех, ответы, треды, пересылка',
    'Реакции, закрепления, черновики, архив',
    'Аудио- и видеозвонки (WebRTC DTLS-SRTP)',
    'Статусы, «печатает…», квитанции доставки и прочтения',
    'Фраза восстановления из 24 слов, бэкап ключей',
    'Вход по коду с доверенного устройства, список сессий',
    'Один аккаунт на устройство, журнал безопасности',
  ];
  global.POLICY = {
    double_encryption: {
      layer_1: { alg: 'AES-256-GCM', what: 'Содержимое шифруется случайным ключом сообщения на устройстве' },
      layer_2: { alg: 'RSA-4096-OAEP-SHA256', what: 'Ключ сообщения заворачивается в RSA-конверт для каждого получателя' },
      layer_3_forward_secrecy: { alg: 'ECDH P-256 + HKDF-SHA256 + AES-256-GCM', what: 'Эфемерный ключ — forward secrecy' },
      signatures: { alg: 'ECDSA P-256', what: 'Подпись конверта' },
    },
    storage: { server_sees: ['шифротекст', 'метаданные', 'время'],
      server_never_sees: ['текст', 'файлы', 'ключи'], file_retention: '24 часа' },
  };
})(typeof window !== 'undefined' ? window : self);
