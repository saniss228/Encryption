/* ============================================================================
 * Encryption — веб-клиент (логика приложения).
 * Тот же код работает на сайте, в Android-оболочке и в десктоп-версии.
 * ========================================================================== */
(function () {
  'use strict';
  const { $, esc, toast, modal, closeModal, confirmDialog, fillAvatar, initials,
    timeHM, dayLabel, humanTime, size, countdown, ttlLabel, codeBlock, beep } = UI;
  const T = (k, v) => (window.I18N ? I18N.t(k, v) : k);   // локализация: см. js/i18n.js

  const App = {
    api: null,
    server: null,
    user: null,
    identity: null,
    password: null,
    serverInfo: null,
    chats: [],
    chatsById: {},
    activeChatId: null,
    messages: {},          // chatId -> [decrypted]
    seenIds: {},           // chatId -> Set(message id)
    typingTimers: {},
    typingUsers: {},       // chatId -> {userId: until}
    online: new Set(),
    pending: {},           // clientMsgId -> {chatId, body}
    attachQueue: [],
    settings: null,
    demo: false,
    filter: 'all',
  };
  window.App = App;
  // Публичные точки входа для нативных оболочек (Electron/Android) и тестов
  App.sendMessage = (...args) => sendMessage(...args);
  App.sendCurrent = () => sendCurrent();
  App.openChat = (id) => openChat(id);
  App.openAttachment = (m) => openAttachment(m);
  App.openSettings = (t) => openSettings(t);
  App.renderMessages = (id) => renderMessages(id);
  App.renderChatList = () => renderChatList();
  App.markLocalOnly = (m, att, silent) => markLocalOnly(m, att, silent);
  App.toast = (text, kind, ms) => toast(text, kind, ms);
  App.serverBase = null;

  /** Открыть личный чат по логину: создать при необходимости и показать. */
  App.ensureDirectChat = async function (username) {
    try {
      const chat = await App.api.post('/api/v1/chats', { type: 'direct', peer_username: username });
      if (!App.chatsById[chat.id]) App.chats.unshift(chat);
      App.chatsById[chat.id] = chat;
      hydrateChat(chat);
      renderChatList();
      await openChat(chat.id);
      return chat;
    } catch (e) {
      toast((e && e.message) || T('conn.error'), 'err');
      return null;
    }
  };

  /* ══ Серверы: официальный и свой ════════════════════════════════════════ */
  // Официальный сервер проекта. Свои адреса пользователь вводит сам — они
  // сохраняются на устройстве и применяются при следующем входе.
  const OFFICIAL_SERVERS = [
    { url: 'http://45.90.45.92:3000', key: 'auth.server.officialMain' },
  ];

  function normalizeServer(input) {
    let v = String(input || '').trim().replace(/\/+$/, '');
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
    try {
      const u = new URL(v);
      if (!u.hostname || !/^[\w.-]+$/.test(u.hostname)) return '';
      return u.protocol + '//' + u.host;
    } catch (e) { return ''; }
  }

  function officialServers() {
    const list = [];
    if (location.protocol.startsWith('http')) {
      list.push({ url: location.origin, key: 'auth.server.officialThis' });
    }
    OFFICIAL_SERVERS.forEach((o) => { if (!list.some((x) => x.url === o.url)) list.push(o); });
    return list;
  }

  /* Переход на единый порт 3000. В прежних версиях сервер отвечал на 6000
     (а сайт — на 8080), поэтому адрес, сохранённый на устройстве до обновления,
     переводим на 3000: иначе вход сломался бы у тех, кто уже выбрал сервер. */
  function toCurrentPort(url) {
    try {
      const u = new URL(url);
      if (u.port === '6000' || u.port === '8080') return u.protocol + '//' + u.hostname + ':3000';
    } catch (e) { /* не адрес — оставляем как есть */ }
    return '';
  }

  function savedServer() {
    const s = Store.get('server', null);
    if (!s || !s.url) return null;
    const fixed = toCurrentPort(s.url);
    if (fixed) {
      const upd = Object.assign({}, s, { url: fixed, saved_at: Date.now() });
      Store.set('server', upd);
      return upd;
    }
    return s;
  }

  function prettyHost(url) {
    return String(url || '').replace(/^https?:\/\//, '');
  }

  async function pingServer(url, timeoutMs) {
    const base = String(url || '').replace(/\/+$/, '');
    if (!base) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 4000);
    try {
      const r = await fetch(base + '/api/v1/health', { signal: ctrl.signal, cache: 'no-store' });
      const j = await r.json();
      return j && j.status === 'ok' ? j : null;
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Проверяет адрес, сохраняет выбор и перезапускает клиент на новом сервере. */
  async function useServer(input, opts) {
    const quiet = !!(opts && opts.quiet);
    const url = normalizeServer(input);
    if (!url) {
      if (!quiet) toast(T('auth.server.badAddress'), 'err', 6000);
      return false;
    }
    const health = await pingServer(url);
    if (!health) {
      if (!quiet) toast(T('auth.server.unreachable'), 'err', 7000);
      return false;
    }
    const mode = officialServers().some((x) => x.url === url) ? 'official' : 'custom';
    Store.set('server', { url, mode, saved_at: Date.now() });
    // Нативные оболочки (ПК и Android) держат адрес у себя — сообщаем и им
    try {
      if (window.NATIVE_APP && window.NATIVE_APP.setServer) await window.NATIVE_APP.setServer(url);
      if (window.AndroidNative && window.AndroidNative.setServer) window.AndroidNative.setServer(url);
    } catch (e) { /* оболочка может не поддерживать — не мешаем входу */ }
    if (!quiet) toast(T('settings.saved'), 'ok');
    setTimeout(() => location.reload(), 500);
    return true;
  }

  function renderServerPicker() {
    const list = $('serverList');
    if (!list || !$('serverTabs')) return;
    const saved = savedServer();
    const current = App.serverBase || '';
    const options = officialServers().map((s) =>
      `<option value="${esc(s.url)}">${esc(T(s.key))} — ${esc(prettyHost(s.url))}</option>`);
    if (saved && !officialServers().some((x) => x.url === saved.url)) {
      options.push(`<option value="${esc(saved.url)}">${esc(T('auth.server.custom'))} — ${esc(prettyHost(saved.url))}</option>`);
    }
    list.innerHTML = options.join('');
    if ([...list.options].some((o) => o.value === current)) list.value = current;

    const setMode = (mode) => {
      $('serverTabs').querySelectorAll('.tab').forEach((b) =>
        b.classList.toggle('active', b.dataset.srv === mode));
      $('serverOfficialBox').classList.toggle('hidden', mode !== 'official');
      $('serverCustomBox').classList.toggle('hidden', mode !== 'custom');
    };
    $('serverTabs').querySelectorAll('.tab').forEach((b) => {
      b.onclick = () => setMode(b.dataset.srv);
    });
    setMode(saved && saved.mode === 'custom' ? 'custom' : 'official');
    $('serverCustomInput').value = saved && saved.mode === 'custom' ? saved.url : '';
    list.onchange = () => { if (list.value !== current) useServer(list.value); };
    $('serverCustomApply').onclick = () => useServer($('serverCustomInput').value);
    $('serverCustomInput').onkeydown = (e) => { if (e.key === 'Enter') useServer(e.target.value); };

    const state = $('serverPickState');
    pingServer(current).then((h) => {
      if (!state) return;
      state.textContent = h ? T('auth.server.online') : T('auth.server.offline');
      state.className = 'badge ' + (h ? 'ok' : 'bad');
    });
  }

  /* ══ Инициализация ══════════════════════════════════════════════════════ */
  async function init() {
    App.settings = Store.settings();
    applyTheme(App.settings.theme);
    initLocale();
    renderFeatureGrid();
    bindStaticHandlers();

    // Адрес сервера по приоритету: оболочка приложения → выбор пользователя →
    // адрес, с которого открыт сайт → официальный сервер.
    const picked = savedServer();
    const base =
      normalizeServer(window.__SERVER_BASE__) ||
      normalizeServer(window.NATIVE_APP && window.NATIVE_APP.serverBase) ||
      normalizeServer(picked && picked.url) ||
      (location.protocol.startsWith('http') ? location.origin : OFFICIAL_SERVERS[0].url);
    App.serverBase = base;
    App.api = new Api(App.serverBase);
    // Журнал: каждый запрос к серверу, каждая ошибка и место, где она возникла
    if (window.Log) window.Log.wrapRequest(App.api);
    renderServerPicker();          // рисовать выбор сервера можно только зная адрес
    const badge = $('serverBadge');
    try {
      const h = await App.api.get('/api/v1/health');
      if (h && h.version) window.APP_VERSION = h.version;   // версия попадёт в журнал
      App.serverInfo = h;
      badge.textContent = T('app.secureConnection');
      badge.className = 'badge ok';
    } catch (e) {
      badge.textContent = T('app.offlineDemo');
      badge.className = 'badge bad';
    }

    const bound = Store.bindingInfo();
    if (bound) $('deviceNotice').textContent = T('auth.deviceBound', { user: bound.username });
    if (Store.usingMemory) toast(T('auth.memoryWarning'), '', 6000);

    // Автовход, если есть сохранённые токены и локальные ключи
    if (App.api.restoreTokens && Store.tokens() && Store.hasIdentity(bound ? bound.username : '')) {
      try { await resumeSession(); } catch (e) { /* ждём ручного входа */ }
    }
    if (location.pathname.startsWith('/join/')) {
      App.pendingInvite = location.pathname.split('/').pop();
    }
  }

  async function resumeSession() {
    const d = Store.device();
    const info = await App.api.get('/api/v1/users/me');
    App.user = info.user;
    const b = Store.bindingInfo();
    const username = b ? b.username : App.user.username;
    App.identity = await loadIdentityFor(username);
    if (!App.identity) throw new Error(T('msg.noKey'));
    App.identity.userId = App.user.id;
    enterMain();
  }

  /** Получаем личные ключи: локально или из шифрованного бэкапа на сервере. */
  async function loadIdentityFor(username, password) {
    let identity = password ? await Store.loadIdentity(username, password) : null;
    if (identity) return identity;
    if (!password) return null;
    try {
      const backup = await App.api.get('/api/v1/users/me/backup');
      if (backup && backup.key_backup) {
        identity = await Crypto.unwrapWithPassword(username, password, backup.key_backup);
        if (identity) { await Store.saveIdentity(username, password, identity); return identity; }
      }
    } catch (e) { /* бэкапа нет — сгенерируем новые ключи */ }
    return null;
  }

  function enterMain() {
    $('authScreen').classList.add('hidden');
    $('mainScreen').classList.remove('hidden');
    fillAvatar($('meAvatar'), App.user);
    $('meName').textContent = App.user.display_name || App.user.username;
    $('meStatus').innerHTML = '@' + esc(App.user.username) +
      (App.user.is_admin ? ` <span class="adm-badge adm-admin">🛡 ${esc(T('admin.badge'))}</span>` : '');
    App.api.on(handleRealtime);
    App.api.onConnection = (online) => {
      const dot = $('connDot');
      dot.className = 'conn-dot ' + (online ? 'on' : 'off');
      $('meStatus').innerHTML = online
        ? '@' + esc(App.user.username) + (App.user.is_admin ? ` <span class="adm-badge adm-admin">🛡 ${esc(T('admin.badge'))}</span>` : '')
        : esc(T('app.offline'));
    };
    App.api.connectWS();
    loadChats().then(() => {
      if (App.pendingInvite) joinInvite(App.pendingInvite);
    });
    startTtlTicker();
    notifyPermission();
    Friends.load();
    loadAnnouncements();
    setInterval(loadAnnouncements, 300000);   // раз в 5 минут — на случай пропущенной рассылки
  }

  /* ══ Аутентификация ═════════════════════════════════════════════════════ */
  function authBusy(form, busy, text) {
    const btn = form.querySelector('button[type=submit]');
    if (!btn) return;
    if (busy) { btn.dataset.label = btn.textContent; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> ${esc(text || T('common.waiting'))}`; }
    else { btn.disabled = false; btn.textContent = btn.dataset.label || T('common.done'); }
  }

  async function doLogin(form) {
    const username = form.username.value.trim().toLowerCase();
    const password = form.password.value;
    if (!username || !password) return;
    authBusy(form, true, T('auth.checking'));
    try {
      const dev = Store.device();
      const check = await App.api.post('/api/v1/auth/device/check', { username, device: dev }).catch(() => null);
      if (check && check.device_bound && check.bound_to && !check.same_user) {
        authBusy(form, false);
        modal(T('auth.deviceBoundTitle'),
          `<p>${esc(T('auth.deviceBoundText', { user: check.bound_to }))}</p>`, {});
        return;
      }
      const auth = await Crypto.authHash(username, password);
      const res = await App.api.post('/api/v1/auth/login', { username, auth_hash: auth, device: dev });
      await finishAuth(username, password, res);
      if (check && check.device_bound && !check.same_user) { /* недостижимо */ }
    } catch (e) {
      authBusy(form, false);
      toast(e.message || T('conn.error'), 'err');
    }
  }

  async function doRegister(form) {
    const username = form.username.value.trim().toLowerCase();
    const display = form.display_name.value.trim();
    const p1 = form.password.value, p2 = form.password2.value;
    if (!/^[a-z0-9_]{3,32}$/.test(username)) return toast(T('auth.usernameHint'), 'err');
    if (p1.length < 8) return toast(T('auth.passwordShort'), 'err');
    if (p1 !== p2) return toast(T('auth.passwordMismatch'), 'err');
    authBusy(form, true, T('auth.generatingKeys'));
    try {
      const dev = Store.device();
      const identity = await Crypto.generateIdentity();
      const auth = await Crypto.authHash(username, p1);
      const phrase = Crypto.newRecoveryPhrase();
      const wrap = await Crypto.wrapWithPhrase(username, phrase, identity);
      const phraseHash = await Crypto.phraseHash(username, phrase);
      const keyBackup = await Crypto.wrapWithPassword(username, p1, identity);
      authBusy(form, true, T('auth.registering'));
      const res = await App.api.post('/api/v1/auth/register', {
        username, display_name: display || username, auth_hash: auth,
        keys: Crypto.publicBundle(identity), device: dev,
        key_backup: keyBackup,
        recovery: { wrap: wrap, phrase_hash: phraseHash },
        recovery_hint: '',
      });
      await Store.saveIdentity(username, p1, identity);
      await finishAuth(username, p1, res, identity);
      showRecoveryPhrase(phrase);
    } catch (e) {
      authBusy(form, false);
      toast(e.message || T('conn.error'), 'err');
    }
  }

  function showRecoveryPhrase(phrase) {
    modal(T('phrase.title'), `
      <p>${esc(T('phrase.text'))}</p>
      <div class="code-box small" id="phraseBox">${esc(phrase.join(' '))}</div>
      <label class="check"><input type="checkbox" id="phraseAck"> ${esc(T('phrase.ack'))}</label>
      <p class="muted small">${esc(T('phrase.note'))}</p>
      <div class="modal-actions">
        <button class="btn" id="phraseCopy">${esc(T('phrase.copy'))}</button>
        <button class="btn primary" id="phraseDone" disabled>${esc(T('phrase.done'))}</button>
      </div>`, { actions: false });
    $('phraseAck').onchange = (e) => { $('phraseDone').disabled = !e.target.checked; };
    $('phraseCopy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText(phrase.join(' ')); toast(T('common.copied'), 'ok'); };
    $('phraseDone').onclick = closeModal;
  }

  async function finishAuth(username, password, res, identity) {
    // Токены сессии: access (15 мин) + refresh (30 дней, ротация на сервере)
    if (res.tokens) App.api.setTokens(res.tokens);
    App.user = res.user;
    App.identity = identity || await loadIdentityFor(username, password);
    if (!App.identity) {
      // ключей нет ни локально, ни в бэкапе — создаём новый набор (историю не прочитать)
      App.identity = await Crypto.generateIdentity();
      const kb = await Crypto.wrapWithPassword(username, password, App.identity);
      await App.api.put('/api/v1/users/me/keys', Crypto.publicBundle(App.identity));
      await App.api.put('/api/v1/users/me/backup', { key_backup: kb });
      await Store.saveIdentity(username, password, App.identity);
      toast(T('settings.rotateText'), 'ok', 6000);
    }
    App.identity.userId = App.user.id;
    App.password = password;
    await Store.unlock(password, username);
    Store.saveAccount({ username, display_name: App.user.display_name });
    Store.boundAccount(username);
    App.demo = !!res.demo;
    enterMain();
  }

  async function doRecover(form) {
    const username = form.username.value.trim().toLowerCase();
    const phrase = form.phrase.value.trim();
    const password = form.password.value;
    if (phrase.split(/\s+/).length < 24) return toast(T('auth.needPhrase'), 'err');
    authBusy(form, true, T('auth.checkingPhrase'));
    try {
      const phraseHash = await Crypto.phraseHash(username, phrase);
      let identity = null;
      try {
        const kb = await App.api.post('/api/v1/auth/recover/keys', { username, phrase_hash: phraseHash });
        if (kb.key_backup) {
          try { identity = await Crypto.unwrapWithPhrase(username, phrase, kb.recovery_wrap || {}); }
          catch (e) { identity = null; }
          if (!identity) {
            // бэкап под паролем нам недоступен без старого пароля — пробуем фразу напрямую по key_backup невозможен
            identity = await Crypto.generateIdentity();
            toast(T('auth.oldBackup'), '', 5000);
          }
        }
      } catch (e) { /* нет бэкапа */ }
      const fresh = identity || await Crypto.generateIdentity();
      const auth = await Crypto.authHash(username, password);
      const res = await App.api.post('/api/v1/auth/recover', {
        username, phrase_hash: phraseHash, new_auth_hash: auth,
        keys: Crypto.publicBundle(fresh), device: Store.device(),
        key_backup: await Crypto.wrapWithPassword(username, password, fresh),
        recovery: { wrap: await Crypto.wrapWithPhrase(username, phrase, fresh), phrase_hash: phraseHash },
      });
      await Store.saveIdentity(username, password, fresh);
      await finishAuth(username, password, res, fresh);
      toast(T('auth.restoreAccess'), 'ok');
    } catch (e) {
      authBusy(form, false);
      toast(e.message || T('auth.restoreFailed'), 'err');
    }
  }

  async function startPairing() {
    try {
      const res = await App.api.post('/api/v1/auth/pair/start', { device: Store.device() });
      $('pairStatus').innerHTML = codeBlock(res.code) +
        `<p class="muted small">${esc(T('auth.pairCodeExpires', { min: Math.round(res.expires_in / 60) }))} ${esc(T('auth.pairHint'))}</p>`;
      const poll = setInterval(async () => {
        try {
          const claim = await App.api.post('/api/v1/auth/pair/claim', { pair_id: res.pair_id, code: res.code, device: Store.device() });
          clearInterval(poll);
          if (claim.key_bundle) {
            const kb = typeof claim.key_bundle === 'string' ? JSON.parse(claim.key_bundle) : claim.key_bundle;
            const identity = kb.identity || kb;
            App.identity = identity;
            await Store.saveIdentityRaw(claim.user.username, identity);
          }
          App.user = claim.user;
          App.identity = App.identity || await Crypto.generateIdentity();
          App.identity.userId = App.user.id;
          Store.boundAccount(claim.user.username);
          enterMain();
          toast(T('settings.deviceConfirmed'), 'ok');
        } catch (e) { /* ждём подтверждения */ }
      }, 2500);
    } catch (e) { toast(e.message || T('conn.error'), 'err'); }
  }

  async function startDemo() {
    App.api = DemoApi();
    App.demo = true;
    try {
      const res = await App.api.post('/api/v1/auth/demo', {});
      App.serverInfo = res.server;
      // Ключи демо-пользователя создаются внутри демо-сервера: берём их,
      // чтобы конверты расшифровывались тем же устройством (экономим и генерацию RSA).
      const identity = (App.api.identityFor && App.api.identityFor('demo')) || await Crypto.generateIdentity();
      App.identity = identity;
      App.user = res.user;
      App.identity.userId = App.user.id;
      Store.set('theme', App.settings.theme);
      enterMain();
      toast(T('auth.demo'), 'ok', 4000);
    } catch (e) { toast(e.message || T('conn.error'), 'err'); }
  }

  /* ══ Чаты ═══════════════════════════════════════════════════════════════ */
  async function loadChats() {
    const res = await App.api.get('/api/v1/chats');
    App.chats = res.chats || [];
    App.chatsById = {};
    App.chats.forEach((c) => { App.chatsById[c.id] = c; hydrateChat(c); });
    renderChatList();
    return App.chats;
  }

  function hydrateChat(chat) {
    chat.members.forEach((m) => { if (m.online) App.online.add(m.id); });
    chat.title = chat.title || peerName(chat) || T('chat.defaultTitle');
  }

  function peerName(chat) {
    if (chat.type === 'saved') return T('newchat.saved');
    if (chat.type === 'group') return chat.title || T('newchat.group');
    const peer = chat.members.find((m) => m.id !== App.user.id);
    return peer ? (peer.display_name || peer.username) : T('chat.peer');
  }
  function peerOf(chat) {
    return chat.members.find((m) => m.id !== App.user.id) || chat.members[0] || {};
  }
  function chatAvatarUser(chat) {
    if (chat.type === 'group') return { display_name: chat.title || T('newchat.group'), avatar_url: chat.avatar_url };
    const p = peerOf(chat);
    return { display_name: p.display_name || p.username, avatar_url: p.avatar_url };
  }

  function renderChatList() {
    const list = $('chatList');
    const term = ($('chatSearch').value || '').trim().toLowerCase();
    let chats = App.chats.slice();
    if (App.filter === 'unread') chats = chats.filter((c) => (c.unread || 0) > 0);
    if (App.filter === 'groups') chats = chats.filter((c) => c.type === 'group');
    if (App.filter === 'archived') chats = chats.filter((c) => c.me && c.me.archived);
    else chats = chats.filter((c) => !(c.me && c.me.archived));
    if (term) chats = chats.filter((c) => peerName(c).toLowerCase().includes(term) || (lastPreview(c) + '').toLowerCase().includes(term));
    chats.sort((a, b) => ((b.me && b.me.pinned) ? 1 : 0) - ((a.me && a.me.pinned) ? 1 : 0) || (b.updated_at - a.updated_at));
    list.innerHTML = '';
    if (!chats.length) {
      list.innerHTML = `<div class="muted small" style="padding:14px">${esc(T('chat.emptyList'))}</div>`;
    }
    chats.forEach((chat) => {
      const el = document.createElement('div');
      el.className = 'chat-item' + (chat.id === App.activeChatId ? ' active' : '');
      const peer = peerOf(chat);
      const online = chat.type === 'direct' && App.online.has(peer.id);
      el.innerHTML = `
        ${UI.avatarHTML(chatAvatarUser(chat))}
        <div class="ci-body">
          <div class="ci-top"><span class="ci-name">${esc(peerName(chat))}</span>
            <span class="ci-time">${chat.last_message ? humanTime(chat.last_message.created_at) : ''}</span></div>
          <div class="ci-top">
            <span class="ci-last">${esc(lastPreview(chat))}</span>
            <span class="ci-badges">
              ${relationChip(chat)}
              ${chat.me && chat.me.muted_until > Date.now() / 1000 ? '<span class="lock-mini">🔕</span>' : ''}
              ${chat.me && chat.me.pinned ? '<span class="lock-mini">📌</span>' : ''}
              ${chat.unread ? `<span class="unread">${chat.unread}</span>` : ''}
              ${online ? `<span class="lock-mini" title="${esc(T('chat.member.online'))}">●</span>` : ''}
            </span>
          </div>
        </div>`;
      el.onclick = () => openChat(chat.id);
      UI.onLongPress(el, () => App.openChatMenu && App.openChatMenu(chat));
      list.appendChild(el);
    });
  }

  /** Небольшая метка в списке чатов: «не в друзьях» / «заблокирован». */
  function relationChip(chat) {
    if (!chat || chat.type !== 'direct' || !Friends.loaded) return '';
    const peer = Friends.peerOfChat(chat);
    if (!peer) return '';
    const rel = Friends.relationOf(peer.id);
    if (rel === 'friend') return '';
    if (rel === 'blocked') return `<span class="role-chip">${esc(T('friends.blockedBadge'))}</span>`;
    return `<span class="role-chip">${esc(T('chat.notFriends'))}</span>`;
  }

  function lastPreview(chat) {
    const cached = App.messages[chat.id];
    if (cached && cached.length) {
      const m = cached[cached.length - 1];
      const body = m.deleted ? T('chat.deleted') : (m.text || (m.attachment ? '📎 ' + m.attachment.name : '🔒'));
      return (m.out ? T('chat.you') + ': ' : '') + body;
    }
    if (!chat.last_message) return T('chat.noMessages');
    return '🔒 ' + T('chat.encryptedPreview');
  }

  async function openChat(chatId) {
    App.activeChatId = chatId;
    const chat = App.chatsById[chatId] || await App.api.get('/api/v1/chats/' + chatId);
    App.chatsById[chatId] = chat;
    $('emptyState').classList.add('hidden');
    $('chatView').classList.remove('hidden');
    document.querySelector('.main-screen').classList.add('chat-open');
    renderChatHead(chat);
    Friends.applyGate(chat);
    renderChatList();
    await loadMessages(chatId);
    markRead(chatId);
  }

  function renderChatHead(chat) {
    const peer = peerOf(chat);
    fillAvatar($('peerAvatar'), chatAvatarUser(chat));
    $('peerName').textContent = peerName(chat);
    const status = $('peerStatus');
    if (chat.type === 'group') {
      const on = chat.members.filter((m) => App.online.has(m.id)).length;
      status.textContent = T('chat.membersOnline', { total: chat.members.length, online: on });
    } else if (App.typingUsers[chat.id]) {
      status.innerHTML = `<span class="typing">${esc(T('chat.typing'))}</span>`;
    } else {
      status.textContent = App.online.has(peer.id)
        ? T('chat.online')
        : (peer.last_seen ? T('chat.lastSeen', { time: humanTime(peer.last_seen) }) : T('chat.offline'));
    }
  }

  /* ══ Сообщения: загрузка и расшифровка ══════════════════════════════════ */
  async function loadMessages(chatId, opts) {
    opts = opts || {};
    const chat = App.chatsById[chatId] || { members: [] };
    const res = await App.api.get('/api/v1/messages', { chat_id: chatId, limit: opts.limit || 80, before: opts.before });
    const list = (res.messages || []).map(rawToMessage).filter(Boolean);

    // Расшифровка конвертов двойного шифрования выполняется ЛОКАЛЬНО, на устройстве.
    await Promise.all(list.map((m) => decryptInto(m, m._raw, chat).catch(() => m)));

    const existing = opts.before ? (App.messages[chatId] || []) : [];
    const merged = dedupe([...list, ...existing]);
    merged.forEach((m) => { delete m._pendingRaw; });
    App.messages[chatId] = merged;
    App.seenIds[chatId] = new Set(merged.map((m) => m.id));
    renderMessages(chatId);
    if (merged.length) Store.cacheMessages(chatId, merged.map((m) => Object.assign({}, m, { _raw: undefined })).slice(-200));
    return merged;
  }

  function dedupe(list) {
    const map = new Map();
    list.forEach((m) => map.set(m.id, m));
    return Array.from(map.values()).sort((a, b) => a.ts - b.ts);
  }

  /** Преобразуем серверное сообщение в локальное, расшифровывая конверт. */
  function rawToMessage(raw) {
    const chatId = raw.chat_id;
    const chat = App.chatsById[chatId] || { members: [] };
    const sender = (chat.members || []).find((m) => m.id === raw.sender_id) || {};
    const out = raw.sender_id === (App.user ? App.user.id : -1);
    const msg = {
      _raw: raw,
      attachmentId: raw.attachment_id || null,
      localOnly: !!raw.local_only,
      id: raw.id, chatId, senderId: raw.sender_id, senderName: sender.display_name || sender.username || ('#' + raw.sender_id),
      out, ts: raw.created_at, edited_at: raw.edited_at, deleted: !!raw.deleted_at,
      type: raw.type, reactions: raw.reactions || [], receipts: raw.receipts || [],
      burn: !!raw.burn_after_read, expires_at: raw.expires_at, pinned: !!raw.pinned,
      replyTo: raw.reply_to, text: '', attachment: null, verified: null, locked: false,
    };
    return msg;
  }

  /** Асинхронно расшифровываем конверт; ключи и содержимое не покидают устройство. */
  async function decryptInto(msg, raw, chat) {
    if (!raw || !raw.payload || !raw.payload.l1) { msg.text = T('msg.unavailable'); return msg; }
    const sender = chat.members.find((m) => m.id === raw.sender_id) || {};
    try {
      const res = await Crypto.open(raw.payload, App.identity, sender.ik_sign_pub, chat.id);
      msg.text = res.plain.text || '';
      msg.verified = res.verified;
      if (res.plain.attachment) msg.attachment = res.plain.attachment;
      msg.system = res.plain.system || null;
    } catch (e) {
      msg.locked = true;
      msg.text = T('msg.noKey') + (e && e.message ? ' (' + e.message + ')' : '');
    }
    return msg;
  }

  async function renderMessages(chatId) {
    const chat = App.chatsById[chatId];
    const box = $('messages');
    const list = (App.messages[chatId] || []).slice().sort((a, b) => a.ts - b.ts);
    box.innerHTML = '';
    let lastDay = null;
    for (const m of list) {
      const day = dayLabel(m.ts);
      if (day !== lastDay) {
        const sep = document.createElement('div');
        sep.className = 'day-sep';
        sep.textContent = day;
        box.appendChild(sep);
        lastDay = day;
      }
      box.appendChild(messageNode(m, chat));
    }
    const pinned = list.filter((m) => m.pinned).slice(-1)[0];
    const bar = $('pinnedBar');
    if (pinned) {
      bar.classList.remove('hidden');
      bar.innerHTML = `📌 ${esc((pinned.text || '').slice(0, 120))}`;
      bar.onclick = () => { const n = document.querySelector(`[data-mid="${pinned.id}"]`); n && n.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
    } else bar.classList.add('hidden');
    box.scrollTop = box.scrollHeight;
  }

  function messageNode(m, chat) {
    const el = document.createElement('div');
    el.className = 'msg ' + (m.out ? 'out' : '') + (m.deleted ? ' deleted' : '') + (m.pending ? ' pending' : '') + (m.burn ? ' burn' : '');
    el.dataset.mid = m.id;
    const reply = m.replyTo && (App.messages[m.chatId] || []).find((x) => x.id === m.replyTo);
    // Вложения рисует модуль Media: картинки и видео видны сразу, голосовые — плеером
    const attHTML = Media.attachmentHTML(m);
    const ttlLeft = m.expires_at ? Math.max(0, m.expires_at - Date.now() / 1000) : 0;
    const showTicks = m.out ? (m.receipts.some((r) => r.state === 'read') ? '✓✓' : (m.receipts.some((r) => r.state === 'delivered') ? '✓✓' : '✓')) : '';
    el.innerHTML = `
      <div class="msg-actions">
        <button data-act="reply" title="${esc(T('msg.action.reply'))}">↩</button>
        <button data-act="react" title="${esc(T('msg.action.react'))}">😊</button>
        <button data-act="forward" title="${esc(T('msg.action.forward'))}">➡</button>
        <button data-act="pin" title="${esc(T('msg.action.pin'))}">📌</button>
        ${m.out ? `<button data-act="edit" title="${esc(T('msg.action.edit'))}">✎</button>` : ''}
        ${m.out ? `<button data-act="delete" title="${esc(T('msg.action.delete'))}">🗑</button>` : ''}
      </div>
      ${chat.type === 'group' && !m.out ? `<div class="msg-head">${esc(m.senderName)}</div>` : ''}
      ${reply ? `<div class="msg-reply" data-jump="${esc(reply.id)}"><b>${esc(reply.out ? T('chat.you') : reply.senderName)}</b><br>${esc((reply.text || T('msg.attachment')).slice(0, 90))}</div>` : ''}
      ${m.deleted ? `<div class="msg-text muted">${esc(T('chat.deleted'))}</div>` : `<div class="msg-text">${linkify(m.text)}</div>`}
      ${attHTML}
      <div class="msg-reactions">${(m.reactions || []).map((r) => `<span class="reaction ${r.user_id === App.user.id ? 'mine' : ''}" data-emoji="${esc(r.emoji)}">${esc(r.emoji)}</span>`).join('')}</div>
      <div class="msg-meta">
        ${m.verified === true ? `<span title="${esc(T('msg.signed'))}">🔏</span>` : ''}
        ${m.verified === false ? `<span title="${esc(T('msg.tampered'))}">⚠️</span>` : ''}
        ${m.burn ? `<span class="ttl" title="${esc(T('msg.burn'))}">💥</span>` : ''}
        ${ttlLeft ? `<span class="ttl" data-ttl="${esc(m.id)}">${countdown(ttlLeft)}</span>` : ''}
        ${m.edited_at ? `<span>${esc(T('msg.editWindow').split(' ')[0])}</span>` : ''}
        ${m.pending ? '<span class="spinner"></span>' : ''}
        <span>${timeHM(m.ts)}</span>
        <span>${showTicks}</span>
      </div>`;

    el.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = (ev) => { ev.stopPropagation(); messageAction(btn.dataset.act, m); };
    });
    // Долгое нажатие на сообщении: то же меню, но без мелких кнопок
    UI.onLongPress(el, () => messageSheet(m, chat));
    el.querySelectorAll('.reaction').forEach((r) => {
      r.onclick = (ev) => { ev.stopPropagation(); toggleReaction(m, r.dataset.emoji); };
    });
    Media.bind(el, m);
    const jump = el.querySelector('[data-jump]');
    if (jump) jump.onclick = () => { const n = document.querySelector(`[data-mid="${jump.dataset.jump}"]`); n && n.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
    return el;
  }

  function linkify(text) {
    return esc(text || '').replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  }

  /* ══ Отправка сообщений ════════════════════════════════════════════════ */
  async function sendCurrent() {
    const input = $('composerInput');
    const text = input.value.trim();
    if (!text && !App.attachQueue.length) return;
    input.value = '';
    autoGrow(input);
    await sendMessage(text, {});
  }

  function recipientsOf(chat) {
    return chat.members.map((m) => ({ id: m.id, rsa_pub: m.rsa_pub, ik_dh_pub: m.ik_dh_pub }));
  }

  async function sendMessage(text, opts) {
    const chat = App.chatsById[App.activeChatId];
    if (!chat) return;
    const logDone = window.Log ? window.Log.step('msg', 'отправка сообщения в чат ' + chat.id) : null;
    const attachments = App.attachQueue.splice(0);
    let attachment = null;
    try {
      if (attachments.length) {
        const item = attachments[0];
        attachment = await uploadAttachment(chat, item);
      }
      const plain = {
        text, kind: attachment ? attachment.kind : 'text', ts: Date.now(),
        from: App.user.username,
        attachment: attachment || undefined,
        reply: opts.replyTo ? { id: opts.replyTo } : undefined,
      };
      const clientMsgId = 'm' + Crypto.randomId(8);
      const payload = await Crypto.seal(plain, App.identity, recipientsOf(chat), chat.id,
        { burn: !!opts.burn, ts: Math.floor(Date.now() / 1000) });

      const local = {
        id: clientMsgId, chatId: chat.id, senderId: App.user.id, senderName: App.user.display_name,
        out: true, ts: Math.floor(Date.now() / 1000), text, attachment, reactions: [], receipts: [],
        replyTo: opts.replyTo || null, burn: !!opts.burn, verified: true, edited_at: null, deleted: false,
        expires_at: opts.ttl_seconds ? Math.floor(Date.now() / 1000) + opts.ttl_seconds : null,
      };
      App.messages[chat.id] = dedupe([...(App.messages[chat.id] || []), local]);
      renderMessages(chat.id);

      const body = {
        chat_id: chat.id, payload, type: attachment ? attachment.kind : 'text',
        reply_to: opts.replyTo || null, burn_after_read: !!opts.burn,
        ttl_seconds: opts.ttl_seconds || null, client_msg_id: clientMsgId,
        attachment_id: attachment ? attachment.file_id : null,
        attachment_meta: attachment ? { name: attachment.name, size: attachment.size, mime: attachment.mime } : null,
      };
      if (App.demo) body._text = text;
      const saved = await App.api.post('/api/v1/messages', body);
      local.pending = false;
      if (saved && saved.id) local.id = saved.id;
      updateChatFromMessage(chat.id, local);
      clearReply();
      if (logDone) logDone(true, { id: local.id });
    } catch (e) {
      if (logDone) logDone(false, { код: e.code, сообщение: e.message });
      // Понятные подсказки вместо кода ошибки: переписка только для друзей
      if (e.code === 'NOT_FRIENDS') {
        toast(T('msg.needFriends'), 'err', 6000);
        Friends.applyGateToActive();
      } else if (e.code === 'BLOCKED') {
        toast(T('msg.blocked'), 'err', 6000);
        Friends.applyGateToActive();
      } else {
        toast(e.message || T('msg.notSent'), 'err');
      }
      if (e.code === 'NETWORK') {
        const mid = 'm' + Crypto.randomId(8);
        toast(T('msg.queued'), '', 6000);
      }
    }
  }

  function updateChatFromMessage(chatId, msg) {
    const chat = App.chatsById[chatId];
    if (!chat) return;
    chat.updated_at = msg.ts;
    chat.last_message = { id: msg.id, created_at: msg.ts };
    renderChatList();
  }

  async function messageAction(action, m) {
    const chat = App.chatsById[m.chatId];
    if (window.Log) window.Log.info('msg', 'действие «' + action + '» над сообщением', { id: m.id, chat: m.chatId });
    if (action === 'reply') { setReply(m); return; }
    if (action === 'react') { quickReaction(m); return; }
    if (action === 'forward') { forwardDialog(m, chat); return; }
    if (action === 'pin') {
      await App.api.post(`/api/v1/messages/${m.id}/pin?pinned=${!m.pinned}`, {});
      m.pinned = !m.pinned; renderMessages(m.chatId); return;
    }
    if (action === 'edit') {
      modal(T('msg.editTitle'), `<textarea id="editText" rows="4">${esc(m.text)}</textarea>`, { actions: false });
      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      actions.innerHTML = `<button class="btn" id="editCancel">${esc(T('common.cancel'))}</button>
        <button class="btn primary" id="editSave">${esc(T('settings.save'))}</button>`;
      $('modalBody').appendChild(actions);
      $('editCancel').onclick = closeModal;
      $('editSave').onclick = async () => {
        const text = $('editText').value.trim();
        const plain = { text, kind: 'text', ts: Math.floor(Date.now() / 1000), edited: true, from: App.user.username };
        const payload = await Crypto.seal(plain, App.identity, recipientsOf(chat), chat.id, { ts: Math.floor(Date.now() / 1000) });
        try {
          await App.api.patch('/api/v1/messages/' + m.id, { payload });
          m.text = text; m.edited_at = Math.floor(Date.now() / 1000);
          closeModal(); renderMessages(m.chatId);
          toast(T('msg.editWindow'), 'ok', 2500);
        } catch (e) { toast(e.message || T('conn.error'), 'err'); }
      };
      return;
    }
    if (action === 'delete') {
      if (await confirmDialog(T('msg.deleteTitle'), T('msg.deleteText'), T('common.delete'), true)) {
        await App.api.del('/api/v1/messages/' + m.id);
        m.deleted = true; m.text = ''; renderMessages(m.chatId);
      }
    }
  }

  /** Меню действий по долгому нажатию: единый вид для сообщений, чатов и друзей. */
  function actionSheet(title, items) {
    UI.sheet(title, items);
  }

  /** Меню сообщения: действия те же, что у кнопок, плюс копирование текста. */
  function messageSheet(m, chat) {
    if (!m || m.deleted) return;
    const canCopy = !!(m.text && navigator.clipboard);
    actionSheet(m.out ? T('chat.you') : peerName(chat), [
      { key: 'reply', icon: '↩', label: T('msg.action.reply'), run: () => messageAction('reply', m) },
      { key: 'react', icon: '😊', label: T('msg.action.react'), run: () => messageAction('react', m) },
      { key: 'forward', icon: '➡', label: T('msg.action.forward'), run: () => messageAction('forward', m) },
      { key: 'copy', icon: '📋', label: T('msg.action.copy'), run: () => copyMessage(m), show: canCopy },
      { key: 'pin', icon: '📌', label: m.pinned ? T('msg.action.unpin') : T('msg.action.pin'), run: () => messageAction('pin', m) },
      m.out ? { key: 'edit', icon: '✎', label: T('msg.action.edit'), run: () => messageAction('edit', m) } : null,
      m.out ? { key: 'delete', icon: '🗑', label: T('msg.action.delete'), danger: true, run: () => messageAction('delete', m) } : null,
    ].filter((x) => x && x.show !== false));
  }

  async function copyMessage(m) {
    try {
      await navigator.clipboard.writeText(m.text || '');
      toast(T('msg.copied'), 'ok', 2500);
      if (window.Log) window.Log.debug('msg', 'текст сообщения скопирован', { id: m.id });
    } catch (e) {
      if (window.Log) window.Log.warn('msg', 'копирование не удалось', { id: m.id, имя: e && e.name });
      toast(T('msg.copyFailed'), 'err');
    }
  }

  function setReply(m) {
    App.replyTo = m.id;
    $('replyBar').classList.remove('hidden');
    $('replyText').innerHTML = `<b>${esc(m.out ? T('chat.you') : m.senderName)}</b>: ${esc((m.text || T('msg.attachment')).slice(0, 80))}`;
    $('composerInput').focus();
  }
  function clearReply() {
    App.replyTo = null;
    $('replyBar').classList.add('hidden');
  }

  const QUICK = ['👍', '❤️', '🔥', '😂', '😮', '😢', '🙏', '🎉'];
  function quickReaction(m) {
    modal(T('msg.reactionTitle'), QUICK.map((e) => `<button class="btn ghost" data-qr="${e}" style="font-size:22px">${e}</button>`).join(''), { actions: false });
    $('modalBody').querySelectorAll('[data-qr]').forEach((b) => {
      b.onclick = () => { toggleReaction(m, b.dataset.qr); closeModal(); };
    });
  }
  async function toggleReaction(m, emoji) {
    try { await App.api.post(`/api/v1/messages/${m.id}/reaction`, { emoji }); }
    catch (e) { /* в демо тоже работает */ }
    m.reactions = m.reactions || [];
    const i = m.reactions.findIndex((r) => r.user_id === App.user.id && r.emoji === emoji);
    if (i >= 0) m.reactions.splice(i, 1); else m.reactions.push({ user_id: App.user.id, emoji });
    renderMessages(m.chatId);
  }
  function forwardDialog(m, chat) {
    modal(T('msg.forwardTitle'), App.chats.map((c) => `<div class="list-row" data-fwd="${esc(c.id)}">
      ${UI.avatarHTML(chatAvatarUser(c), 'sm')}<div class="grow"><b>${esc(peerName(c))}</b></div></div>`).join(''), { actions: false });
    $('modalBody').querySelectorAll('[data-fwd]').forEach((row) => {
      row.onclick = async () => {
        const target = App.chatsById[row.dataset.fwd];
        const text = `↪️ ${T('msg.forwardedFrom', { name: m.senderName })}\n${m.text}`;
        closeModal();
        const recipients = recipientsOf(target);
        const plain = { text, kind: 'text', ts: Date.now(), from: App.user.username, forward: m.id };
        const payload = await Crypto.seal(plain, App.identity, recipients, target.id, {});
        try {
          await App.api.post('/api/v1/messages', { chat_id: target.id, payload, type: 'text' });
          toast(T('msg.forwarded', { chat: peerName(target) }), 'ok');
        } catch (e) { toast(e.message || T('conn.error'), 'err'); }
      };
    });
  }

  async function markRead(chatId) {
    try { await App.api.post('/api/v1/messages/read-all?chat_id=' + encodeURIComponent(chatId), {}); } catch (e) {}
    const chat = App.chatsById[chatId];
    if (chat) chat.unread = 0;
    const list = App.messages[chatId] || [];
    for (const m of list.filter((x) => !x.out && x.expires_at && x.burn).slice(-10)) {
      App.api.post(`/api/v1/messages/${m.id}/receipt`, { state: 'read' }).catch(() => {});
    }
    renderChatList();
  }

  /* ══ Файлы (шифрование на устройстве, 24 часа в облаке) ════════════════ */
  async function uploadAttachment(chat, item) {
    const file = item.file;
    const kind = item.kind || guessKind(file);
    const fk = await Crypto.newFileKey();
    const nameEnc = await Crypto.aesEncrypt(fk.key, new TextEncoder().encode(file.name || 'file'),
      Crypto.rand(12)).then((ct) => Crypto.b64(ct)).catch(() => '');
    const chatId = chat.id;
    UI.toast(T('file.encrypting', { name: file.name, percent: 0 }), '', 600000);
    const els = document.querySelectorAll('.toast');
    const notify = (progress) => {
      const el = els[els.length - 1];
      if (el) el.textContent = T('file.encrypting', { name: file.name, percent: Math.round(progress * 100) });
    };
    const done = () => { const el = els[els.length - 1]; if (el) el.remove(); };
    const init = await App.api.post('/api/v1/files/init', {
      chat_id: chatId, size: file.size, kind, mime: file.type || 'application/octet-stream',
      name_enc: nameEnc, key_wrap: '', chunk_size: Crypto.FILE_CHUNK,
    });
    const cs = init.chunk_size;
    const total = init.chunks;
    for (let i = 0; i < total; i++) {
      const buf = await file.slice(i * cs, Math.min((i + 1) * cs, file.size)).arrayBuffer();
      const aad = new TextEncoder().encode('file|' + init.file_id);
      const enc = await Crypto.encryptChunk(fk, i, buf, aad);
      await App.api.request('PUT', `/api/v1/files/${init.file_id}/chunk?index=${i}`, new Blob([enc]));
      notify((i + 1) / Math.max(total, 1));
    }
    await App.api.post(`/api/v1/files/${init.file_id}/complete`, {});
    done();
    return { file_id: init.file_id, key: fk.keyB64, name: file.name, size: file.size,
      mime: file.type || 'application/octet-stream', kind, chunks: total, chunk_size: cs,
      expires_at: init.expires_at };
  }

  function guessKind(file) {
    const t = (file.type || '').toLowerCase();
    if (t.startsWith('image/')) return 'image';
    if (t.startsWith('video/')) return 'video';
    if (t.startsWith('audio/')) return 'voice';
    return 'file';
  }

  async function openAttachment(m) {
    return Media.open(m);
  }

  /**
   * Файл скачан и расшифрован на устройстве → сообщаем серверу,
   * он удаляет свою копию: файл становится «только локальным».
   */
  async function markLocalOnly(m, att, silent) {
    att.localOnly = true;
    m.localOnly = true;
    try {
      await App.api.post(`/api/v1/files/${att.file_id}/consumed`, {});
      if (!silent) toast(T('file.localOnlyNote'), 'ok', 6000);
    } catch (e) { /* сервер мог уже удалить копию сам */ }
    if (App.activeChatId === m.chatId && !silent) renderMessages(m.chatId);
  }

  /* ══ Объявления администратора ══════════════════════════════════════════ */
  const HIDDEN_ANN = 'enc_hidden_ann';

  function annHiddenSet() {
    try { return JSON.parse(localStorage.getItem(HIDDEN_ANN) || '[]'); } catch (e) { return []; }
  }

  /** Список актуальных объявлений с сервера — видят все пользователи. */
  async function loadAnnouncements() {
    if (!App.api || !App.api.access) return;
    try {
      const res = await App.api.get('/api/v1/announcements');
      const list = (res.announcements || []).filter((a) => !annHiddenSet().includes(a.id));
      // Если объявлений нет, но администратор оставил приветственную заметку — показываем её
      if (!list.length && res.welcome_note) {
        list.push({ id: 0, text: res.welcome_note, level: 'info' });
      }
      renderAnnBanner(list);
    } catch (e) { /* сервер недоступен — молча пропускаем */ }
  }

  function renderAnnBanner(list) {
    const host = $('annBanner');
    if (!host) return;
    if (!list || !list.length) { host.classList.add('hidden'); host.innerHTML = ''; return; }
    const a = list[0];
    host.className = 'ann-banner ann-' + (a.level || 'info');
    host.innerHTML = `<b>${esc(T('admin.broadcastTitle'))}</b>${esc(a.text)}
      <span class="muted small" style="display:block;margin-top:2px">${esc(T('chat.tapToHide'))}</span>`;
    host.title = T('chat.tapToHide');
    host.onclick = () => { hideAnnouncement(a.id, true); };
  }

  function showAnnouncement(ev) {
    renderAnnBanner([{ id: ev.id, text: ev.text, level: ev.level }]);
    toast(ev.text, ev.level === 'critical' ? 'err' : 'ok', 9000);
  }

  function hideAnnouncement(id, remember) {
    if (remember && id) {
      try {
        const set = annHiddenSet();
        set.push(id);
        localStorage.setItem(HIDDEN_ANN, JSON.stringify(set.slice(-30)));
      } catch (e) { /* приватный режим — просто скрываем */ }
    }
    const host = $('annBanner');
    if (host) { host.classList.add('hidden'); host.innerHTML = ''; }
  }

  /** Аккаунт заблокирован администратором: показываем причину и возвращаем на вход. */
  function showBlockedScreen(reason) {
    const text = reason || T('admin.blocked');
    try {
      App.api.disconnectWS();
      App.api.clearTokens();
    } catch (e) { /* не критично */ }
    try { localStorage.setItem('enc_blocked_reason', text); } catch (e) { /* приватный режим */ }
    setTimeout(() => location.reload(), 2500);
  }

  /* ══ Realtime события ═══════════════════════════════════════════════════ */
  /* Действия пользователя в журнал: видно, что нажали и что из этого вышло. */
  document.addEventListener('click', (e) => {
    if (!window.Log) return;
    const el = e.target && e.target.closest ? e.target.closest('[data-act],[data-fr],[data-tab],button') : null;
    if (!el) return;
    const act = el.dataset && (el.dataset.act || el.dataset.fr || el.dataset.tab);
    const label = (act || el.id || (el.textContent || '').trim().slice(0, 24) || el.tagName);
    window.Log.debug('ui', 'нажатие: ' + label, { id: el.id || undefined, mid: el.dataset && el.dataset.mid });
  }, true);

  async function handleRealtime(ev) {
    // В журнал — только вид события и идентификаторы: без текста и ключей
    if (window.Log) {
      window.Log.debug('ws', 'событие ' + (ev && ev.t), {
        chat: ev && ev.chat_id, msg: ev && ev.message_id, user: ev && (ev.user_id || ev.from),
      });
    }
    switch (ev.t) {
      case 'conn':
        if (ev.online) {
          toast(T('conn.restored'), 'ok', 2000);
          loadChats();
          Friends.load();      // список друзей мог измениться, пока связи не было
        }
        break;
      case 'hello':
        (ev.online || []).forEach((id) => App.online.add(id));
        renderChatList();
        if (App.activeChatId) renderChatHead(App.chatsById[App.activeChatId]);
        break;
      case 'presence': {
        if (ev.online) App.online.add(ev.user_id); else App.online.delete(ev.user_id);
        renderChatList();
        if (App.activeChatId) renderChatHead(App.chatsById[App.activeChatId]);
        break;
      }
      case 'friend.request':
      case 'friend.accepted':
      case 'friend.declined':
      case 'friend.removed':
      case 'friend.request.cancelled':
        Friends.onEvent(ev);
        break;
      case 'message':
        await onIncoming(ev.message);
        break;
      case 'message.edited': {
        const m = (App.messages[ev.chat_id] || []).find((x) => x.id === ev.message_id);
        if (m) {
          const chat = App.chatsById[ev.chat_id];
          const fake = { chat_id: ev.chat_id, sender_id: m.senderId, payload: ev.payload, id: m.id, created_at: m.ts };
          await decryptInto(m, fake, chat);
          m.edited_at = ev.edited_at;
          renderMessages(ev.chat_id);
        }
        break;
      }
      case 'message.deleted': {
        const m = (App.messages[ev.chat_id] || []).find((x) => x.id === ev.message_id);
        if (m) { m.deleted = true; m.text = ''; m.attachment = null; renderMessages(ev.chat_id); }
        break;
      }
      case 'message.reaction': {
        const m = (App.messages[ev.chat_id] || []).find((x) => x.id === ev.message_id);
        if (m) {
          m.reactions = m.reactions || [];
          const i = m.reactions.findIndex((r) => r.user_id === ev.user_id && r.emoji === ev.emoji);
          if (i >= 0) m.reactions.splice(i, 1); else m.reactions.push({ user_id: ev.user_id, emoji: ev.emoji });
          renderMessages(ev.chat_id);
        }
        break;
      }
      case 'message.receipt': {
        const m = (App.messages[ev.chat_id] || []).find((x) => x.id === ev.message_id);
        if (m) {
          m.receipts = m.receipts || [];
          m.receipts.push({ user_id: ev.user_id, state: ev.state, at: ev.at });
          if (App.activeChatId === ev.chat_id) renderMessages(ev.chat_id);
        }
        break;
      }
      case 'message.pinned': {
        const m = (App.messages[ev.chat_id] || []).find((x) => x.id === ev.message_id);
        if (m) { m.pinned = ev.pinned; renderMessages(ev.chat_id); }
        break;
      }
      case 'typing':
        if (ev.user_id !== App.user.id) {
          App.typingUsers[ev.chat_id] = ev.state ? ev.user_id : null;
          if (!ev.state) delete App.typingUsers[ev.chat_id];
          if (App.activeChatId === ev.chat_id) {
            renderChatHead(App.chatsById[ev.chat_id]);
            clearTimeout(App.typingTimers[ev.chat_id + ':' + ev.user_id]);
            if (ev.state) App.typingTimers[ev.chat_id + ':' + ev.user_id] = setTimeout(() => {
              delete App.typingUsers[ev.chat_id]; renderChatHead(App.chatsById[ev.chat_id]);
            }, 5000);
          }
        }
        break;
      case 'read':
        if (ev.user_id !== App.user.id) {
          const chat = App.chatsById[ev.chat_id];
          if (chat && chat.last_message) chat.peer_read_at = ev.up_to;
        }
        break;
      case 'chat.created':
      case 'chat.updated':
        await loadChats();
        break;
      case 'chat.member.add':
      case 'chat.member.remove':
      case 'chat.member.role':
        if (App.chatsById[ev.chat_id]) {
          App.chatsById[ev.chat_id] = await App.api.get('/api/v1/chats/' + ev.chat_id);
          hydrateChat(App.chatsById[ev.chat_id]);
          renderChatHead(App.chatsById[ev.chat_id]);
        }
        break;
      case 'call.invite':
        // Окно входящего звонка и уведомление показывает модуль звонков — здесь
        // не дублируем (в v3.3.0 выходило два одинаковых уведомления).
        Call.incoming(ev);
        break;
      case 'call.signal':
        Call.signal(ev);
        break;
      case 'call.state':
        Call.state(ev);
        break;
      case 'file.consumed': {
        // Получатель скачал файл — копии на сервере больше нет
        const list = App.messages[ev.chat_id] || [];
        let touched = false;
        list.forEach((m) => {
          if (m.attachmentId === ev.file_id || (m.attachment && m.attachment.file_id === ev.file_id)) {
            m.localOnly = true;
            if (m.attachment) m.attachment.localOnly = true;
            touched = true;
          }
        });
        if (touched && App.activeChatId === ev.chat_id) renderMessages(ev.chat_id);
        break;
      }
      case 'device.revoked':
        toast(T('conn.deviceRevoked'), 'err', 6000);
        break;
      case 'announcement':
        showAnnouncement(ev);
        break;
      case 'announcement.off':
        hideAnnouncement(ev.id);
        break;
      case 'account.blocked':
        showBlockedScreen(ev.reason);
        break;
      default: break;
    }
  }

  async function onIncoming(raw) {
    const chatId = raw.chat_id;
    if (!App.chatsById[chatId]) {
      await loadChats();
    }
    const chat = App.chatsById[chatId];
    if (!chat) return;
    const msg = rawToMessage(raw);
    await decryptInto(msg, raw, chat);
    const list = App.messages[chatId] || [];
    if (!list.some((m) => m.id === msg.id)) list.push(msg);
    App.messages[chatId] = dedupe(list);
    Store.cacheMessages(chatId, App.messages[chatId].slice(-200));
    msg.out = msg.senderId === App.user.id;
    if (App.activeChatId === chatId) {
      renderMessages(chatId);
      if (!msg.out) {
        markRead(chatId);
        App.api.post(`/api/v1/messages/${msg.id}/receipt`, { state: 'read' }).catch(() => {});
      }
    } else {
      if (!msg.out) {
        chat.unread = (chat.unread || 0) + 1;
        notify(msg, chat);
        if (!(chat.me && chat.me.muted_until > Date.now() / 1000)) beep('in');
      }
    }
    updateChatFromMessage(chatId, msg);
  }

  function notify(msg, chat) {
    if (!App.settings.notifications || document.hasFocus()) return;
    if (window.NATIVE_APP && window.NATIVE_APP.notify) {
      window.NATIVE_APP.notify(peerName(chat), (msg.text || T('msg.attachment')).slice(0, 120));
      return;
    }
    try {
      if (window.Notification && Notification.permission === 'granted') {
        new Notification(peerName(chat), { body: (msg.text || T('msg.attachment')).slice(0, 120), tag: msg.id });
      }
    } catch (e) {}
  }
  function notifyPermission() {
    try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch (e) {}
  }

  /* ══ Правая панель: профиль, участники, безопасность ═══════════════════ */
  async function openChatInfo() {
    const chat = App.chatsById[App.activeChatId];
    if (!chat) return;
    $('rightPanel').classList.remove('hidden');
    $('panelTitle').textContent = chat.type === 'group' ? T('chatmenu.type.group') : T('settings.tab.profile');
    const peer = peerOf(chat);
    const body = $('panelBody');
    const myKeys = Crypto.publicBundle(App.identity);
    const typeLabel = { group: T('chatmenu.type.group'), saved: T('chatmenu.type.saved') }[chat.type] || T('chatmenu.type.direct');
    const rows = [
      [T('chatmenu.chatType'), typeLabel],
      [T('chatmenu.membersCount'), chat.members.length],
      [T('chatmenu.keyFingerprint'), Crypto.fingerprint(peer.ik_dh_pub || myKeys.ik_dh_pub)],
      [T('chatmenu.autoDelete'), ttlLabel(chat.ttl_seconds)],
    ];
    body.innerHTML = `
      <div style="text-align:center">
        ${UI.avatarHTML(chatAvatarUser(chat), 'lg')}
        <h2 style="margin:8px 0 2px">${esc(peerName(chat))}</h2>
        <div class="muted small">${chat.type === 'direct' ? '@' + esc(peer.username || '') : esc(T('chat.groupChat'))}</div>
      </div>
      <h3>${esc(T('chatmenu.encryption'))}</h3>
      ${rows.map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><span>${esc(Array.isArray(v) ? v.join(', ') : v)}</span></div>`).join('')}
      ${row(T('settings.layer1'), 'AES-256-GCM')}
      ${row(T('settings.layer2'), 'RSA-4096-OAEP')}
      ${row(T('settings.layer3'), 'ECDH P-256 (FS)')}
      <h3>${esc(T('ttl.title'))}</h3>
      <div class="row-between">
        <span class="muted small">${esc(T('chatmenu.autoDelete'))}</span>
        <select id="ttlSelect">
          ${[[0, T('ttl.off')], [60, T('ttl.1min')], [3600, T('ttl.1hour')], [86400, T('ttl.24hours')], [604800, T('ttl.7days')]]
            .map(([v, l]) => `<option value="${v}" ${chat.ttl_seconds == v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
        </select>
      </div>
      <h3>${esc(T('chatmenu.filesTitle'))}</h3>
      <p class="muted small">${esc(T('chatmenu.filesText'))}</p>
      <h3>${esc(T('chatmenu.participants'))}</h3>
      ${chat.members.map((m) => `<div class="list-row">${UI.avatarHTML({ display_name: m.display_name || m.username }, 'sm')}
        <div class="grow"><b>${esc(m.display_name || m.username)}</b><br><small class="muted">${esc(m.role)}${App.online.has(m.id) ? ' • ' + esc(T('chat.member.online')) : ''}</small></div>
        ${chat.type === 'group' && m.id !== App.user.id ? `<button class="icon-btn" data-kick="${m.id}">✕</button>` : ''}</div>`).join('')}
      ${chat.type === 'group' ? `
        <h3>${esc(T('chatmenu.controls'))}</h3>
        <button class="btn" id="inviteBtn">${esc(T('chatmenu.createInvite'))}</button>
        <button class="btn danger" id="leaveBtn" style="margin-top:8px">${esc(T('chatmenu.leaveGroup'))}</button>` : ''}
      ${chat.type === 'direct' ? `<h3>${esc(T('friends.title'))}</h3>
        <div id="friendActions"></div>` : ''}
      <h3>${esc(T('chatmenu.dangerZone'))}</h3>
      <button class="btn danger" id="clearChatBtn">${esc(T('chatmenu.clearChat'))}</button>`;

    // Дружба и блокировка прямо из карточки собеседника
    if (chat.type === 'direct' && peer && peer.id) {
      const rel = Friends.relationOf(peer.id);
      const fa = body.querySelector('#friendActions');
      const inc = Friends.incomingFrom(peer.id);
      let html = '';
      if (rel === 'friend') {
        html = `<button class="btn" id="faWrite">${esc(T('friends.write'))}</button>
          <button class="btn ghost" id="faRemove" style="margin-top:8px">${esc(T('friends.remove'))}</button>
          <button class="btn danger" id="faBlock" style="margin-top:8px">${esc(T('friends.block'))}</button>`;
      } else if (rel === 'blocked') {
        html = `<p class="muted small">${esc(T('friends.youBlocked'))}</p>
          <button class="btn primary" id="faUnblock">${esc(T('friends.unblock'))}</button>
          <button class="btn danger" id="faRemove" style="margin-top:8px">${esc(T('friends.remove'))}</button>`;
      } else if (rel === 'incoming') {
        html = `<p class="muted small">${esc(T('friends.gateIncoming', { name: peerName(chat) }))}</p>
          <button class="btn primary" id="faAccept">${esc(T('friends.accept'))}</button>
          <button class="btn ghost" id="faDecline" style="margin-top:8px">${esc(T('friends.decline'))}</button>`;
      } else if (rel === 'outgoing') {
        html = `<p class="muted small">${esc(T('friends.requested'))}</p>
          <button class="btn ghost" id="faCancel">${esc(T('friends.cancel'))}</button>`;
      } else {
        html = `<p class="muted small">${esc(T('friends.requestNote'))}</p>
          <button class="btn primary" id="faAdd">${esc(T('friends.add'))}</button>`;
      }
      if (fa) {
        fa.innerHTML = html;
        const on = (id, fn) => { const b = fa.querySelector(id); if (b) b.onclick = fn; };
        on('#faWrite', () => openChat(chat.id));
        on('#faAdd', () => Friends.request(peer.username));
        on('#faAccept', () => inc && Friends.accept(inc.id));
        on('#faDecline', () => inc && Friends.decline(inc.id));
        on('#faCancel', () => { const o = Friends.outgoingTo(peer.id); o && Friends.cancel(o.id); });
        on('#faRemove', () => Friends.remove(peer.id));
        on('#faBlock', () => Friends.block(peer.id));
        on('#faUnblock', () => Friends.unblock(peer.id));
      }
    }
    $('ttlSelect').onchange = async (e) => {
      const v = parseInt(e.target.value, 10);
      await App.api.patch('/api/v1/chats/' + chat.id, { ttl_seconds: v });
      chat.ttl_seconds = v;
      toast(T('ttl.title') + ': ' + ttlLabel(v), 'ok');
    };
    body.querySelectorAll('[data-kick]').forEach((b) => {
      b.onclick = async () => {
        const uid = parseInt(b.dataset.kick, 10);
        const member = chat.members.find((m) => m.id === uid) || {};
        if (await confirmDialog(T('chatmenu.kickTitle'),
            T('chatmenu.kickText', { user: member.display_name || member.username }), T('common.delete'), true)) {
          await App.api.post(`/api/v1/chats/${chat.id}/members`, { action: 'remove', user_id: uid });
          chat.members = chat.members.filter((m) => m.id !== uid);
          openChatInfo();
        }
      };
    });
    const inv = body.querySelector('#inviteBtn');
    if (inv) inv.onclick = async () => {
      const r = await App.api.post(`/api/v1/chats/${chat.id}/invite`, {});
      modal(T('chatmenu.inviteTitle'), `<p>${esc(T('chatmenu.inviteText'))}</p>
        <div class="code-box small">${esc(location.origin + r.link)}</div>`, { actions: false });
      const acts = document.createElement('div');
      acts.className = 'modal-actions';
      acts.innerHTML = `<button class="btn primary" id="copyInv">${esc(T('common.copy'))}</button>`;
      $('modalBody').appendChild(acts);
      $('copyInv').onclick = () => { navigator.clipboard && navigator.clipboard.writeText(location.origin + r.link); toast(T('common.copied'), 'ok'); };
    };
    const lv = body.querySelector('#leaveBtn');
    if (lv) lv.onclick = async () => {
      if (await confirmDialog(T('chatmenu.leaveTitle'), T('chatmenu.leaveText'), T('common.logout'), true)) {
        await App.api.post(`/api/v1/chats/${chat.id}/leave`, {});
        App.chats = App.chats.filter((c) => c.id !== chat.id);
        delete App.chatsById[chat.id];
        App.activeChatId = null;
        $('chatView').classList.add('hidden');
        $('emptyState').classList.remove('hidden');
        $('rightPanel').classList.add('hidden');
        renderChatList();
      }
    };
    const cl = body.querySelector('#clearChatBtn');
    if (cl) cl.onclick = async () => {
      if (await confirmDialog(T('chatmenu.clearTitle'), T('chatmenu.clearText'), T('common.delete'), true)) {
        App.messages[chat.id] = [];
        Store.cacheMessages(chat.id, []);
        renderMessages(chat.id);
        toast(T('settings.cacheCleared'), 'ok');
      }
    };
  }

  /* ══ Настройки ══════════════════════════════════════════════════════════ */
  function openSettings(tab) {
    tab = tab || 'profile';
    const body = modal(T('settings.title'), `
      <div class="tabs small" id="settingsTabs">
        <button class="tab ${tab === 'profile' ? 'active' : ''}" data-st="profile">${esc(T('settings.tab.profile'))}</button>
        <button class="tab ${tab === 'security' ? 'active' : ''}" data-st="security">${esc(T('settings.tab.security'))}</button>
        <button class="tab ${tab === 'devices' ? 'active' : ''}" data-st="devices">${esc(T('settings.tab.devices'))}</button>
        <button class="tab ${tab === 'files' ? 'active' : ''}" data-st="files">${esc(T('settings.tab.files'))}</button>
        <button class="tab ${tab === 'app' ? 'active' : ''}" data-st="app">${esc(T('settings.tab.app'))}</button>
        <button class="tab ${tab === 'server' ? 'active' : ''}" data-st="server">${esc(T('settings.tab.server'))}</button>
      </div>
      <div id="settingsBody"></div>`, { actions: false });
    body.querySelectorAll('[data-st]').forEach((b) => { b.onclick = () => openSettings(b.dataset.st); });
    settingsBody(tab);
  }

  async function settingsBody(tab) {
    const host = $('settingsBody');
    const s = App.settings;
    const row = (label, value) => `<div class="kv"><span>${esc(label)}</span><span>${esc(value)}</span></div>`;

    if (tab === 'profile') {
      host.innerHTML = `
        <div style="text-align:center">${UI.avatarHTML({ display_name: App.user.display_name }, 'lg')}</div>
        <label>${esc(T('settings.name'))}<input id="setName" value="${esc(App.user.display_name || '')}"></label>
        <label>${esc(T('settings.about'))}<input id="setAbout" value="${esc(App.user.about || '')}" maxlength="256"></label>
        <label>${esc(T('settings.username'))}<input value="@${esc(App.user.username)}" disabled></label>
        <button class="btn primary" id="saveProfile">${esc(T('settings.save'))}</button>`;
      $('saveProfile').onclick = async () => {
        try {
          await App.api.patch('/api/v1/users/me', { display_name: $('#setName').value.trim(), about: $('#setAbout').value.trim() });
          App.user.display_name = $('setName').value.trim();
          App.user.about = $('setAbout').value.trim();
          $('meName').textContent = App.user.display_name;
          fillAvatar($('meAvatar'), App.user);
          toast(T('settings.profileUpdated'), 'ok');
        } catch (e) { toast(e.message || T('conn.error'), 'err'); }
      };
      return;
    }

    if (tab === 'server') {
      const cur = App.serverBase || '';
      const saved = savedServer();
      const official = officialServers();
      host.innerHTML = `
        <h3>${esc(T('settings.server.title'))}</h3>
        ${row(T('settings.server.current'), prettyHost(cur))}
        ${row(T('settings.server.mode'), saved && saved.mode === 'custom'
              ? T('auth.server.custom') : T('auth.server.official'))}
        <p class="muted small">${esc(T('settings.server.hint'))}</p>
        <label>${esc(T('settings.server.address'))}
          <input id="setServerUrl" value="${esc(cur)}" placeholder="http://1.2.3.4:3000"
                 autocomplete="off" spellcheck="false"></label>
        <button class="btn primary" id="setServerSave">${esc(T('settings.server.apply'))}</button>
        <div class="row-between" style="margin-top:10px">
          <button class="link" id="setServerOfficial">${esc(T('settings.server.toOfficial'))}</button>
          <button class="link" id="setServerCheck">${esc(T('settings.server.check'))}</button>
        </div>
        <h3 style="margin-top:14px">${esc(T('settings.server.migrateTitle'))}</h3>
        <p class="muted small">${esc(T('settings.server.migrate'))}</p>`;
      $('setServerSave').onclick = () => useServer($('setServerUrl').value);
      $('setServerOfficial').onclick = () => useServer(official[official.length - 1].url);
      $('setServerCheck').onclick = async () => {
        const h = await pingServer(cur);
        toast(h ? T('auth.server.online') : T('auth.server.offline'), h ? 'ok' : 'err');
      };
      return;
    }

    if (tab === 'security') {
      const myFp = Crypto.fingerprint(Crypto.publicBundle(App.identity).ik_dh_pub);
      host.innerHTML = `
        <h3>${esc(T('settings.encryption'))}</h3>
        ${row(T('settings.layer1'), 'AES-256-GCM')}
        ${row(T('settings.layer2'), 'RSA-4096-OAEP')}
        ${row(T('settings.layer3'), 'ECDH P-256 (FS)')}
        ${row(T('settings.signature'), 'ECDSA P-256')}
        ${row(T('settings.passwordProtection'), 'PBKDF2 ×310 000 + Argon2id')}
        <h3>${esc(T('settings.myFingerprint'))}</h3>
        <div class="mono">${esc(myFp)}</div>
        <h3>${esc(T('settings.recoveryPhrase'))}</h3>
        <p class="muted small">${esc(App.user.has_recovery ? T('settings.recoverySet') : T('settings.recoveryMissing'))}</p>
        <button class="btn" id="newPhrase">${esc(T('settings.newPhrase'))}</button>
        <h3>${esc(T('settings.accountTitle'))}</h3>
        <button class="btn" id="rotateKeys">${esc(T('settings.rotateKeys'))}</button>
        <button class="btn" id="panicBtn" style="margin-top:8px">${esc(T('settings.panic'))}</button>
        <h3>${esc(T('settings.securityLog'))}</h3>
        <div id="secLog" class="muted small">${esc(T('settings.loading'))}</div>`;
      $('newPhrase').onclick = async () => {
        const phrase = Crypto.newRecoveryPhrase();
        const wrap = await Crypto.wrapWithPhrase(App.user.username, phrase, App.identity);
        const phraseHash = await Crypto.phraseHash(App.user.username, phrase);
        const keyBackup = await Crypto.wrapWithPassword(App.user.username, App.password || '', App.identity);
        await App.api.put('/api/v1/users/me/backup', { key_backup: keyBackup, recovery_wrap: wrap, recovery_phrase_hash: phraseHash });
        closeModal();
        showRecoveryPhrase(phrase);
      };
      $('rotateKeys').onclick = async () => {
        if (!await confirmDialog(T('settings.rotateTitle'), T('settings.rotateText'), T('settings.rotateKeys'), true)) return;
        const identity = await Crypto.generateIdentity();
        identity.userId = App.user.id;
        await App.api.put('/api/v1/users/me/keys', Crypto.publicBundle(identity));
        App.identity = identity;
        const kb = await Crypto.wrapWithPassword(App.user.username, App.password || '', identity);
        await App.api.put('/api/v1/users/me/backup', { key_backup: kb });
        await Store.saveIdentityRaw(App.user.username, identity).catch(() => {});
        toast(T('settings.keysUpdated'), 'ok');
      };
      $('panicBtn').onclick = async () => {
        if (!await confirmDialog(T('settings.panicTitle'), T('settings.panicText'), T('common.continue'), true)) return;
        try { await App.api.post('/api/v1/auth/panic', {}); toast(T('settings.panicDone'), 'ok', 6000); }
        catch (e) { toast(e.message || T('conn.error'), 'err'); }
      };
      try {
        const log = await App.api.get('/api/v1/security/log');
        $('secLog').innerHTML = (log.events || []).slice(0, 15).map((e) =>
          `<div class="kv"><span>${esc(e.event)}</span><span>${esc(humanTime(e.at))}</span></div>`).join('') || esc(T('settings.empty'));
      } catch (e) { $('secLog').textContent = T('common.unavailable'); }
      return;
    }

    if (tab === 'devices') {
      host.innerHTML = `<div id="devList" class="muted small">${esc(T('settings.loading'))}</div>
        <h3>${esc(T('settings.oneDeviceTitle'))}</h3>
        <p class="muted small">${esc(T('settings.oneDeviceText'))}</p>
        <h3>${esc(T('settings.addDeviceTitle'))}</h3>
        <p class="muted small">${esc(T('settings.addDeviceText'))}</p>
        <input id="pairCodeInput" placeholder="${esc(T('settings.pairCodePlaceholder'))}" inputmode="numeric">
        <button class="btn" id="pairApprove" style="margin-top:8px">${esc(T('settings.confirmDevice'))}</button>`;
      try {
        const d = await App.api.get('/api/v1/auth/devices');
        const current = (d.devices || []).find((x) => x.current) || {};
        const others = (d.devices || []).filter((x) => !x.current);
        $('devList').innerHTML =
          `<div class="list-row">${UI.avatarHTML({ display_name: current.name || '•' }, 'sm')}
             <div class="grow"><b>${esc(current.name || '')}</b><br><small class="muted">${esc(T('chat.online'))}</small></div>
             <span class="badge ok">${esc(T('chat.you'))}</span></div>` +
          (others.length ? others.map((x) => `<div class="list-row">
             <div class="grow"><b>${esc(x.name || x.platform || '')}</b><br>
               <small class="muted">${esc(x.online ? T('chat.online') : (x.last_seen ? T('chat.lastSeen', { time: humanTime(x.last_seen) }) : T('chat.offline')))}</small></div>
             <button class="link" data-rev="${esc(x.id)}">${esc(T('settings.device.unbind'))}</button>
             <button class="link" data-rel="${esc(x.id)}">${esc(T('settings.device.release'))}</button>
           </div>`).join('') : `<p class="muted small">${esc(T('settings.empty'))}</p>`);
        host.querySelectorAll('[data-rev]').forEach((b) => b.onclick = async () => {
          await App.api.del('/api/v1/auth/devices/' + b.dataset.rev);
          toast(T('settings.device.unbound'), 'ok'); openSettings('devices');
        });
        host.querySelectorAll('[data-rel]').forEach((b) => b.onclick = async () => {
          if (await confirmDialog(T('settings.oneDeviceTitle'), T('settings.oneDeviceText'), T('settings.device.release'), true)) {
            await App.api.del('/api/v1/auth/devices/' + b.dataset.rel + '?release=true');
            toast(T('settings.device.released'), 'ok', 6000);
            openSettings('devices');
          }
        });
      } catch (e) { $('devList').textContent = T('common.unavailable'); }
      $('pairApprove').onclick = async () => {
        const code = $('pairCodeInput').value.trim();
        if (!/^\d{6}$/.test(code)) return toast(T('settings.pairCodePlaceholder'), 'err');
        try {
          await App.api.post('/api/v1/auth/pair/approve', { code, key_bundle: JSON.stringify({ identity: App.identity }) });
          toast(T('settings.deviceConfirmed'), 'ok', 5000);
        } catch (e) { toast(e.message || T('settings.codeInvalid'), 'err'); }
      };
      return;
    }

    if (tab === 'files') {
      host.innerHTML = `
        <h3>${esc(T('settings.fileTitle'))}</h3>
        ${row(T('settings.fileTtl'), T('settings.fileTtlValue'))}
        ${row(T('settings.fileWhere'), T('settings.fileWhereValue'))}
        ${row(T('settings.fileWho'), T('settings.fileWhoValue'))}
        <div class="local-badge">🔒 ${esc(T('file.localOnlyBadge'))}</div>
        <p class="muted small">${esc(T('settings.fileNote'))}</p>
        <h3>${esc(T('settings.defaultTimer'))}</h3>
        <div class="row-between"><span class="muted small">${esc(T('ttl.title'))}</span>
          <select id="defTtl">
            ${[[0, T('ttl.off')], [3600, T('ttl.1hour')], [86400, T('ttl.24hours')], [604800, T('ttl.7days')]]
              .map(([v, l]) => `<option value="${v}" ${String(s.defTtl || 0) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}
          </select>
        </div>
        <button class="btn" id="clearCache" style="margin-top:10px">${esc(T('settings.clearCache'))}</button>`;
      $('defTtl').onchange = (e) => { s.defTtl = parseInt(e.target.value, 10); Store.saveSettings(s); toast(T('settings.saved'), 'ok'); };
      $('clearCache').onclick = () => { Store.clearCache(); App.messages = {}; toast(T('settings.cacheCleared'), 'ok'); if (App.activeChatId) renderMessages(App.activeChatId); };
      return;
    }

    // ── Вкладка «Приложение»: оформление, язык, уведомления, аккаунт ──────
    host.innerHTML = `
      <h3>${esc(T('settings.appearance'))}</h3>
      <div class="row-between"><span>${esc(T('settings.darkTheme'))}</span>
        <button class="switch ${s.theme === 'dark' ? 'on' : ''}" id="swTheme"></button></div>
      <div class="row-between" style="margin-top:10px"><span>${esc(T('settings.language'))}</span>
        <select id="langSelect" style="width:auto">
          <option value="auto" ${I18N.isAuto ? 'selected' : ''}>${esc(T('settings.languageAuto'))}</option>
          ${I18N.available.map((l) => `<option value="${l.code}" ${(!I18N.isAuto && I18N.locale === l.code) ? 'selected' : ''}>${esc(l.label)}</option>`).join('')}
        </select></div>
      <h3>${esc(T('settings.notifications'))}</h3>
      <div class="row-between"><span>${esc(T('settings.notify'))}</span>
        <button class="switch ${s.notifications ? 'on' : ''}" id="swNotify"></button></div>
      <div class="row-between" style="margin-top:10px"><span>${esc(T('settings.sounds'))}</span>
        <button class="switch ${s.sounds ? 'on' : ''}" id="swSound"></button></div>
      <h3>${esc(T('settings.connection'))}</h3>
      ${row(T('settings.connection'), T('settings.connectionValue'))}
      ${row(T('settings.version'), (App.serverInfo && App.serverInfo.version) || '3.1.0')}
      <h3>🔍 ${esc(T('settings.diagnostics'))}</h3>
      <p class="muted small">${esc(T('settings.diagnosticsNote'))}</p>
      <div class="row-between"><span>${esc(T('settings.detailLog'))}</span>
        <button class="switch ${Log.isDetailed() ? 'on' : ''}" id="swLog" title="${esc(T('settings.detailLogHint'))}"></button></div>
      <button class="btn" id="saveLog" style="margin-top:10px">${esc(T('settings.saveLog'))}</button>
      <button class="btn" id="clearLog" style="margin-top:8px">${esc(T('settings.clearLog'))}</button>
      ${App.user.is_admin ? `<h3>🛡 ${esc(T('admin.title'))}</h3>
        <p class="muted small">${esc(T('admin.encryptionNote'))}</p>
        <button class="btn primary" id="adminBtn">${esc(T('admin.title'))}</button>` : ''}
      <h3>${esc(T('settings.accountTitle'))}</h3>
      <button class="btn" id="logoutBtn">${esc(T('settings.logout'))}</button>
      <button class="btn danger" id="wipeBtn" style="margin-top:8px">${esc(T('settings.logoutWipe'))}</button>
      <p class="muted small" style="margin-top:10px">${esc(T('settings.logoutNote'))}</p>`;
    $('swTheme').onclick = (e) => { s.theme = s.theme === 'dark' ? 'light' : 'dark'; applyTheme(s.theme); Store.saveSettings(s); e.target.classList.toggle('on'); };
    $('swNotify').onclick = (e) => { s.notifications = !s.notifications; Store.saveSettings(s); e.target.classList.toggle('on'); if (s.notifications) notifyPermission(); };
    $('swSound').onclick = (e) => { s.sounds = !s.sounds; Store.saveSettings(s); e.target.classList.toggle('on'); };
    $('langSelect').onchange = (e) => {
      const v = e.target.value;
      if (v === 'auto') { I18N.setLocale(null, true); s.locale = 'auto'; }
      else { I18N.setLocale(v, false); s.locale = v; }
      Store.saveSettings(s);
      refreshLocaleUI();
      openSettings('app');
    };
    if ($('adminBtn')) $('adminBtn').onclick = () => { closeModal(); Admin.open(); };
    // Диагностика: подробный режим и выгрузка журнала файлом
    $('swLog').onclick = (e) => { Log.setDetailed(!Log.isDetailed()); e.target.classList.toggle('on'); };
    $('saveLog').onclick = () => {
      const ok = Log.download();
      toast(ok ? T('settings.logSaved') : T('settings.saveLog'), ok ? 'ok' : 'err');
    };
    $('clearLog').onclick = () => { Log.clear(); toast(T('settings.clearLog'), 'ok'); };
    $('logoutBtn').onclick = async () => {
      try { await App.api.post('/api/v1/auth/logout', {}); } catch (e) {}
      doLogout(false);
    };
    $('wipeBtn').onclick = async () => {
      if (await confirmDialog(T('settings.wipeTitle'), T('settings.wipeText'), T('settings.logoutWipe'), true)) {
        try { await App.api.post('/api/v1/auth/logout', {}); } catch (e) {}
        doLogout(true);
      }
    };
  }

  /* ── Язык интерфейса ───────────────────────────────────────────────────── */
  function initLocale() {
    const saved = App.settings.locale || 'auto';
    I18N.setLocale(saved === 'auto' ? null : saved, saved === 'auto');
    I18N.apply(document);
    const sel = $('langSelectAuth');
    if (sel) {
      sel.innerHTML = `<option value="auto">🌐 ${esc(T('settings.languageAuto'))}</option>` +
        I18N.available.map((l) => `<option value="${l.code}">${esc(l.label)}</option>`).join('');
      sel.value = saved;
      sel.onchange = (e) => {
        const v = e.target.value;
        App.settings.locale = v;
        Store.saveSettings(App.settings);
        I18N.setLocale(v === 'auto' ? null : v, v === 'auto');
        refreshLocaleUI();
      };
    }
  }

  /** Перерисовать интерфейс после смены языка без перезагрузки. */
  function refreshLocaleUI() {
    I18N.apply(document);
    renderFeatureGrid();
    if (App.user) {
      $('meStatus').textContent = App.api && App.api.connected ? '@' + App.user.username : T('app.offline');
      renderChatList();
      if (App.activeChatId) {
        renderChatHead(App.chatsById[App.activeChatId]);
        renderMessages(App.activeChatId);
      }
    }
    const badge = $('serverBadge');
    if (badge) badge.textContent = App.serverInfo ? T('app.secureConnection') : T('app.offlineDemo');
    const sel = $('langSelectAuth');
    if (sel) sel.value = App.settings.locale || 'auto';
  }

  function doLogout(wipe) {
    App.api.disconnectWS();
    App.api.clearTokens();
    if (wipe) {
      Store.dropIdentity(App.user.username);
      Store.clearCache();
      Store.releaseBinding();
    }
    location.reload();
  }

  /* ══ Новый чат ══════════════════════════════════════════════════════════ */
  function newChatDialog() {
    modal(T('chat.newChat'), `
      <div class="tabs small" id="ncTabs">
        <button class="tab active" data-nc="user">${esc(T('newchat.user'))}</button>
        <button class="tab" data-nc="group">${esc(T('newchat.group'))}</button>
        <button class="tab" data-nc="saved">${esc(T('newchat.saved'))}</button>
      </div>
      <div id="ncBody"></div>`, { actions: false });
    $('ncTabs').querySelectorAll('[data-nc]').forEach((b) => b.onclick = () => newChatBody(b.dataset.nc));
    newChatBody('user');
  }
  function newChatBody(kind) {
    $('ncTabs').querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.nc === kind));
    const host = $('ncBody');
    if (kind === 'user') {
      host.innerHTML = `<label>${esc(T('newchat.searchLabel'))}<input id="ncSearch" placeholder="${esc(T('newchat.searchPlaceholder'))}"></label>
        <div id="ncResults" class="muted small"></div>`;
      let timer;
      $('ncSearch').oninput = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const q = $('ncSearch').value.trim();
          if (q.length < 1) return;
          try {
            const r = await App.api.get('/api/v1/users/search', { q });
            const list = r.users || [];
            $('ncResults').innerHTML = list.length ? list.map((u) => `<div class="list-row" data-u="${esc(u.username)}">
              ${UI.avatarHTML(u, 'sm')}<div class="grow"><b>${esc(u.display_name || u.username)}</b><br><small>@${esc(u.username)}</small></div>
              ${Friends.actionButtonHTML(u)}</div>`).join('') : esc(T('newchat.nothing'));
            // Просто «написать» незнакомцу нельзя: сначала заявка в друзья
            $('ncResults').querySelectorAll('[data-fa]').forEach((btn) => {
              btn.onclick = async (e) => {
                e.stopPropagation();
                const act = btn.dataset.fa;
                if (act === 'write') { closeModal(); await App.ensureDirectChat(btn.dataset.username); }
                else if (act === 'add') { await Friends.request(btn.dataset.username); newChatBody('user'); }
                else if (act === 'accept') { await Friends.accept(btn.dataset.rid); newChatBody('user'); }
                else if (act === 'unblock') { await Friends.unblock(Number(btn.dataset.uid)); newChatBody('user'); }
              };
            });
          } catch (e) { $('ncResults').textContent = e.message; }
        }, 300);
      };
    } else if (kind === 'group') {
      host.innerHTML = `<label>${esc(T('newchat.groupTitle'))}<input id="ncTitle" placeholder="${esc(T('newchat.groupTitlePlaceholder'))}"></label>
        <label>${esc(T('newchat.groupMembers'))}<input id="ncMembers" placeholder="${esc(T('newchat.groupMembersPlaceholder'))}"></label>
        <button class="btn primary" id="ncCreate">${esc(T('newchat.createGroup'))}</button>`;
      $('ncCreate').onclick = async () => {
        const title = $('ncTitle').value.trim() || T('newchat.group');
        const members = $('ncMembers').value.split(/[,\s]+/).filter(Boolean);
        if (members.length) {
          const first = await App.api.get('/api/v1/users/' + encodeURIComponent(members[0])).catch(() => null);
          if (!first) return toast(T('newchat.userNotFound', { user: members[0] }), 'err');
        }
        await createChat({ type: 'group', title, members });
      };
    } else {
      host.innerHTML = `<p class="muted small">${esc(T('newchat.savedText'))}</p>
        <button class="btn primary" id="ncSaved">${esc(T('newchat.openSaved'))}</button>`;
      $('ncSaved').onclick = () => createChat({ type: 'saved' });
    }
  }
  async function createChat(body) {
    try {
      const chat = await App.api.post('/api/v1/chats', body);
      closeModal();
      if (!App.chatsById[chat.id]) App.chats.unshift(chat);
      App.chatsById[chat.id] = chat;
      hydrateChat(chat);
      renderChatList();
      openChat(chat.id);
    } catch (e) { toast(e.message || T('conn.error'), 'err'); }
  }

  async function joinInvite(token) {
    try {
      const r = await App.api.post('/api/v1/chats/join/' + token, {});
      await loadChats();
      openChat(r.chat_id);
      toast(T('conn.joined'), 'ok');
      history.replaceState({}, '', '/');
    } catch (e) { toast(e.message || T('conn.inviteInvalid'), 'err'); }
  }

  /* ══ Прочее: темы, эмодзи, вложения, набор текста ══════════════════════ */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
  }
  function renderFeatureGrid() {
    const grid = $('featureGrid');
    if (!grid) return;
    const items = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => T('feature.' + i)).filter((x) => x && !x.startsWith('feature.'));
    grid.innerHTML = items.map((f) => `<div>✓ ${esc(f)}</div>`).join('');
  }
  function autoGrow(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px'; }

  const EMOJI = ['😀','😁','😂','🤣','😊','😍','😘','😎','🤩','🤔','😐','😴','😢','😭','😡','🥶','🤯','🥳','👍','👎','👏','🙏','💪','🤝','❤️','🔥','✨','🎉','🔐','🔑','🛡','📎','📷','🎤','🎥','📞','📌','✅','❌','⏱','💥','🚀','🌍','⚡','🧠','💡','📁','🖼','🎵'];
  function toggleEmoji() {
    const picker = $('emojiPicker');
    picker.classList.toggle('hidden');
    if (!picker.innerHTML) {
      picker.innerHTML = `<div class="grid">${EMOJI.map((e) => `<button>${e}</button>`).join('')}</div>`;
      picker.querySelectorAll('button').forEach((b) => b.onclick = () => {
        const input = $('composerInput');
        input.value += b.textContent;
        input.focus();
      });
    }
  }
  function attachFiles(files) {
    Array.from(files).forEach((file) => App.attachQueue.push({ file, kind: guessKind(file) }));
    const box = $('attachPreview');
    box.classList.remove('hidden');
    box.innerHTML = App.attachQueue.map((a, i) => `<span class="attach-chip">📎 ${esc(a.file.name)} (${UI.size(a.file.size)})
      <button class="link" data-rm="${i}">✕</button></span>`).join('') +
      `<span class="muted small">— ${esc(T('file.attachmentNote'))}</span>`;
    box.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => {
      App.attachQueue.splice(parseInt(b.dataset.rm, 10), 1);
      attachFiles([]);
    });
  }

  let typingSent = 0;
  function onComposerInput(e) {
    autoGrow(e.target);
    if (!App.activeChatId) return;
    const now = Date.now();
    if (now - typingSent > 2000) {
      typingSent = now;
      App.api.sendRaw({ t: 'typing', chat_id: App.activeChatId, state: true });
      setTimeout(() => App.api.sendRaw({ t: 'typing', chat_id: App.activeChatId, state: false }), 3000);
    }
  }

  let ttlTicker = null;
  function startTtlTicker() {
    clearInterval(ttlTicker);
    ttlTicker = setInterval(() => {
      document.querySelectorAll('[data-ttl]').forEach((el) => {
        const m = (App.messages[App.activeChatId] || []).find((x) => x.id === el.dataset.ttl);
        if (!m || !m.expires_at) return el.remove();
        const left = m.expires_at - Date.now() / 1000;
        if (left <= 0) { el.textContent = T('msg.deleting'); return; }
        el.textContent = '💥 ' + countdown(left);
      });
    }, 1000);
  }

  /* ══ События интерфейса ════════════════════════════════════════════════ */
  function bindStaticHandlers() {
    // Причина блокировки, оставленная администратором, — показываем на экране входа
    try {
      const blocked = localStorage.getItem('enc_blocked_reason');
      if (blocked) {
        localStorage.removeItem('enc_blocked_reason');
        toast(blocked, 'err', 12000);
      }
    } catch (e) { /* приватный режим — не критично */ }

    // Вкладки авторизации
    $('authTabs').querySelectorAll('.tab').forEach((t) => t.onclick = () => {
      $('authTabs').querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
      $('loginForm').classList.toggle('hidden', t.dataset.tab !== 'login');
      $('registerForm').classList.toggle('hidden', t.dataset.tab !== 'register');
      $('recoverForm').classList.toggle('hidden', t.dataset.tab !== 'recover');
    });
    $('toRecover').onclick = () => $('authTabs').querySelector('[data-tab=recover]').click();
    $('loginForm').onsubmit = (e) => { e.preventDefault(); doLogin(e.target); };
    $('registerForm').onsubmit = (e) => { e.preventDefault(); doRegister(e.target); };
    $('recoverForm').onsubmit = (e) => { e.preventDefault(); doRecover(e.target); };
    $('loginForm').showpass.onchange = (e) => {
      $('loginForm').password.type = e.target.checked ? 'text' : 'password';
      $('registerForm').password.type = e.target.checked ? 'text' : 'password';
    };
    $('recoverTabs').querySelectorAll('.tab').forEach((t) => t.onclick = () => {
      $('recoverTabs').querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
      $('recoverPhrase').classList.toggle('hidden', t.dataset.rtab !== 'phrase');
      $('recoverDevice').classList.toggle('hidden', t.dataset.rtab !== 'device');
      $('recoverHelp').classList.toggle('hidden', t.dataset.rtab !== 'help');
    });
    $('pairStartBtn').onclick = startPairing;
    $('releaseDeviceBtn').onclick = async () => {
      if (await confirmDialog(T('auth.releaseTitle'), T('auth.releaseText'), T('settings.device.release'), true)) {
        Store.releaseBinding();
        toast(T('settings.device.released'), 'ok', 6000);
      }
    };
    $('demoBtn').onclick = startDemo;
    if (window.NATIVE_APP || window.AndroidNative) {
      const row = document.createElement('div');
      row.className = 'row-between small muted';
      row.style.marginTop = '10px';
      row.innerHTML = `<button class="link" id="srvChange">${esc(T('auth.changeServer'))}</button>`;
      $('authScreen').querySelector('.auth-footer').appendChild(row);
      $('srvChange').onclick = () => {
        modal(T('auth.serverDialogTitle'), `
          <label>${esc(T('auth.serverDialogTitle'))}<input id="srvInput" placeholder="https://" value="${esc(App.serverBase)}"></label>
          <p class="muted small">${esc(T('auth.serverDialogHint'))}</p>`, { onClose: () => {} });
        const acts = document.createElement('div');
        acts.className = 'modal-actions';
        acts.innerHTML = `<button class="btn" id="srvCancel">${esc(T('common.cancel'))}</button>
          <button class="btn primary" id="srvSave">${esc(T('settings.save'))}</button>`;
        $('modalBody').appendChild(acts);
        $('srvCancel').onclick = closeModal;
        $('srvSave').onclick = async () => {
          const url = $('srvInput').value.trim().replace(/\/+$/, '');
          if (!/^https?:\/\//.test(url)) return toast('https://', 'err');
          if (window.NATIVE_APP && window.NATIVE_APP.setServer) await window.NATIVE_APP.setServer(url);
          if (window.AndroidNative && window.AndroidNative.setServer) window.AndroidNative.setServer(url);
          window.__SERVER_BASE__ = url;
          toast(T('settings.saved'), 'ok');
          setTimeout(() => location.reload(), 600);
        };
      };
    }

    // Основной интерфейс
    $('newChatBtn').onclick = newChatDialog;
    $('friendsBtn').onclick = () => Friends.panel();
    $('burgerBtn').onclick = () => openSettings('profile');
    $('meBtn').onclick = () => openSettings('profile');
    $('chatSearch').oninput = () => { renderChatList(); localSearch(($('chatSearch').value || '').trim()); };
    $('chatFilters').querySelectorAll('.chip').forEach((c) => c.onclick = () => {
      $('chatFilters').querySelectorAll('.chip').forEach((x) => x.classList.toggle('active', x === c));
      App.filter = c.dataset.filter === 'groups' ? 'groups' : c.dataset.filter;
      if (c.dataset.filter === 'archived') App.filter = 'archived';
      renderChatList();
    });
    $('backBtn').onclick = () => document.querySelector('.main-screen').classList.remove('chat-open');
    $('peerInfo').onclick = openChatInfo;
    $('chatMenuBtn').onclick = () => openChatMenu(App.chatsById[App.activeChatId]);
    App.openChatMenu = openChatMenu;      // доступно из списка чатов и по долгому нажатию

    /** Меню чата: то же самое, что по кнопке «⋯», и по долгому нажатию в списке. */
    function openChatMenu(chat) {
      chat = chat || App.chatsById[App.activeChatId];
      if (!chat) return;
      modal(peerName(chat), `
        <button class="btn" id="cmInfo">${esc(T('chatmenu.info'))}</button>
        <button class="btn" id="cmPin" style="margin-top:8px">${esc(chat.me && chat.me.pinned ? T('chatmenu.unpin') : T('chatmenu.pin'))}</button>
        <button class="btn" id="cmMute" style="margin-top:8px">${esc(chat.me && chat.me.muted_until > Date.now() / 1000 ? T('chatmenu.unmute') : T('chatmenu.mute'))}</button>
        <button class="btn" id="cmArch" style="margin-top:8px">${esc(T('chatmenu.archive'))}</button>
        <button class="btn danger" id="cmDel" style="margin-top:8px">${esc(T('chatmenu.deleteChat'))}</button>`, { actions: false });
      $('cmInfo').onclick = () => { closeModal(); openChatInfo(); };
      $('cmPin').onclick = async () => { await App.api.post(`/api/v1/chats/${chat.id}/pin?pinned=${!(chat.me && chat.me.pinned)}`, {}); chat.me.pinned = !(chat.me && chat.me.pinned); closeModal(); toast(T('common.done'), 'ok'); };
      $('cmMute').onclick = async () => {
        const until = (chat.me && chat.me.muted_until > Date.now() / 1000) ? 0 : Math.floor(Date.now() / 1000) + 8 * 3600;
        await App.api.post(`/api/v1/chats/${chat.id}/mute?until=${until}`, {});
        chat.me.muted_until = until; closeModal(); renderChatList();
        toast(until ? T('chatmenu.muted') : T('chatmenu.unmute'), 'ok');
      };
      $('cmArch').onclick = async () => {
        await App.api.post(`/api/v1/chats/${chat.id}/archive?archived=true`, {});
        chat.me.archived = true; closeModal(); renderChatList(); toast(T('chatmenu.archived'), 'ok');
      };
      $('cmDel').onclick = async () => {
        if (await confirmDialog(T('chatmenu.deleteTitle'),
            chat.type === 'group' ? T('chatmenu.leaveText') : T('chatmenu.deleteText'),
            T('common.delete'), true)) {
          await App.api.del('/api/v1/chats/' + chat.id + (chat.type === 'group' ? '?for_everyone=false' : ''));
          App.chats = App.chats.filter((c) => c.id !== chat.id);
          delete App.chatsById[chat.id];
          App.activeChatId = null;
          $('chatView').classList.add('hidden');
          $('emptyState').classList.remove('hidden');
          renderChatList(); closeModal();
        }
      };
    }

    $('closePanel').onclick = () => $('rightPanel').classList.add('hidden');
    $('sendBtn').onclick = sendCurrent;
    $('composerInput').oninput = onComposerInput;
    $('composerInput').onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey && App.settings.enterToSend) { e.preventDefault(); sendCurrent(); }
    };
    $('emojiBtn').onclick = toggleEmoji;
    $('cancelReply').onclick = clearReply;
    $('attachBtn').onclick = () => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.multiple = true;
      inp.onchange = () => attachFiles(inp.files);
      inp.click();
    };
    $('ttlBtn').onclick = () => {
      const chat = App.chatsById[App.activeChatId];
      modal(T('ttl.title'), `
        <p class="muted small">${esc(T('ttl.text'))}</p>
        <div id="ttlOptions">${[[0, T('ttl.off')], [60, T('ttl.1min')], [3600, T('ttl.1hour')], [86400, T('ttl.24hours')], [604800, T('ttl.7days')]]
          .map(([v, l]) => `<button class="btn" data-ttlopt="${v}" style="margin:4px">${esc(l)}</button>`).join('')}</div>
        <label class="check"><input type="checkbox" id="burnNow"> ${esc(T('ttl.burnNow'))}</label>`, { actions: false });
      $('modalBody').querySelectorAll('[data-ttlopt]').forEach((b) => b.onclick = async () => {
        const v = parseInt(b.dataset.ttlopt, 10);
        await App.api.patch('/api/v1/chats/' + chat.id, { ttl_seconds: v });
        chat.ttl_seconds = v;
        App.sendTtl = v || undefined;
        App.sendBurn = $('burnNow') ? $('burnNow').checked : false;
        closeModal();
        toast(v ? T('chatmenu.autoDelete') + ': ' + ttlLabel(v) : T('chatmenu.autoDelete') + ': ' + T('common.off'), 'ok');
      });
    };
    $('micBtn').onclick = toggleVoiceRecording;
    $('callAudioBtn').onclick = () => Call.start(App.activeChatId, 'audio');
    $('callVideoBtn').onclick = () => Call.start(App.activeChatId, 'video');
    $('searchInChatBtn').onclick = () => {
      modal(T('chat.searchInChat'), `<input id="inChatQ" placeholder="${esc(T('common.search'))}">
        <p class="muted small">${esc(T('chat.empty.text'))}</p>
        <div id="inChatResults"></div>`, { actions: false });
      $('inChatQ').oninput = (e) => {
        const q = e.target.value.trim().toLowerCase();
        if (!q) return;
        const found = (App.messages[App.activeChatId] || []).filter((m) => (m.text || '').toLowerCase().includes(q)).slice(-40).reverse();
        $('inChatResults').innerHTML = found.map((m) => `<div class="kv"><span>${esc((m.text || '').slice(0, 80))}</span><span>${timeHM(m.ts)}</span></div>`).join('') || esc(T('newchat.nothing'));
      };
    };
    $('callHangup').onclick = () => Call.hangup();
    $('callMute').onclick = () => Call.toggleMute();
    $('callVideoToggle').onclick = () => Call.toggleVideo();
    $('callScreen').onclick = () => Call.toggleScreen();
    $('modalBackdrop').onclick = closeModal;

    // Drag & drop файлов
    let dragDepth = 0;
    document.addEventListener('dragenter', (e) => { dragDepth++; $('fileDrop').classList.add('active'); });
    document.addEventListener('dragleave', () => { if (--dragDepth <= 0) $('fileDrop').classList.remove('active'); });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault(); dragDepth = 0;
      $('fileDrop').classList.remove('active');
      if (e.dataTransfer.files.length) attachFiles(e.dataTransfer.files);
    });

    // Клавиатура
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('modal').classList.contains('hidden')) closeModal();
        else if (!$('rightPanel').classList.contains('hidden')) $('rightPanel').classList.add('hidden');
        else clearReply();
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); $('chatSearch').focus(); }
    });

    // Уход со страницы — фиксируем «последнее посещение»
    window.addEventListener('beforeunload', () => { App.api && App.api.disconnectWS(); });
  }

  function localSearch(term) {
    if (!term) return;
    const hits = [];
    Object.entries(App.messages).forEach(([chatId, list]) => {
      list.forEach((m) => { if ((m.text || '').toLowerCase().includes(term.toLowerCase())) hits.push({ chatId, m }); });
    });
    if (hits.length) toast(`${T('common.search')}: ${hits.length} ✓ — ${peerName(App.chatsById[hits[0].chatId] || { members: [] })}`, '', 3500);
  }

  /* Голосовые сообщения */
  let recorder = null, recChunks = [], recStart = 0;
  async function toggleVoiceRecording() {
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recorder = new MediaRecorder(stream);
      recChunks = [];
      recStart = Date.now();
      recorder.ondataavailable = (e) => recChunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recChunks, { type: 'audio/webm' });
        const file = new File([blob], `voice-${new Date().toISOString().slice(0, 19)}.webm`, { type: 'audio/webm' });
        App.attachQueue.push({ file, kind: 'voice' });
        await sendMessage('', {});
        toast(T('file.voiceSent'), 'ok');
      };
      recorder.start();
      $('micBtn').textContent = '⏹';
      toast(T('file.recordVoice'), '', 4000);
      const stopCheck = setInterval(() => {
        if (!recorder || recorder.state !== 'recording') { clearInterval(stopCheck); $('micBtn').textContent = '🎙'; }
        else if (Date.now() - recStart > 120000) { recorder.stop(); clearInterval(stopCheck); }
      }, 500);
    } catch (e) {
      // Разные причины — разные подсказки: отказ в доступе, занятый микрофон,
      // отсутствие микрофона; на телефоне ещё и выключенное разрешение в системе
      const name = (e && e.name) || '';
      const key = name === 'NotAllowedError' || name === 'SecurityError' ? 'file.micDenied'
        : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'file.micMissing'
        : 'file.noMic';
      if (window.Log) window.Log.error('media', 'микрофон недоступен при записи', e, { имя: name });
      toast(T(key), 'err', 6000);
    }
  }

  // Аппаратная кнопка «назад» в Android-оболочке
  window.EncryptionHandleBack = function () {
    if (!$('modal').classList.contains('hidden')) { closeModal(); return true; }
    if (!$('callOverlay').classList.contains('hidden')) { Call.hangup(); return true; }
    if (!$('rightPanel').classList.contains('hidden')) { $('rightPanel').classList.add('hidden'); return true; }
    if (document.querySelector('.main-screen').classList.contains('chat-open')) {
      document.querySelector('.main-screen').classList.remove('chat-open'); return true;
    }
    return false;
  };

  document.addEventListener('DOMContentLoaded', init);
})();
