/* ============================================================================
 * Друзья: заявки, блокировки и правило «писать можно только друзьям».
 *
 * Как работает:
 *   • чтобы написать человеку, нужно отправить заявку по его логину и дождаться,
 *     пока он её примет — до этого поле ввода в чате заблокировано с подсказкой;
 *   • заявку можно принять, отклонить или отменить; дружба всегда взаимная;
 *   • блокировка обрывает дружбу и запрещает сообщения, звонки и «печатает…».
 *
 * Модуль самодостаточен: он обращается к App (состояние и API) и к UI (окна,
 * тосты) и не меняет логику шифрования.
 * ========================================================================== */
(function (global) {
  'use strict';
  const F = {};
  const T = (k, v) => (window.I18N ? I18N.t(k, v) : k);

  const App = () => global.App;
  const U = () => global.UI;

  // ── Состояние ────────────────────────────────────────────────────────────
  F.friends = new Map();    // id → пользователь
  F.blocked = new Map();    // id → пользователь (кого заблокировал я)
  F.incoming = [];          // входящие заявки {id, from_id, username, display_name, ...}
  F.outgoing = [];          // исходящие заявки
  F.loaded = false;

  F.isFriend = (id) => F.friends.has(Number(id));
  F.isBlocked = (id) => F.blocked.has(Number(id));
  F.incomingFrom = (id) => F.incoming.find((r) => Number(r.from_id) === Number(id)) || null;
  F.outgoingTo = (id) => F.outgoing.find((r) => Number(r.to_id) === Number(id)) || null;

  /** Отношение с собеседником личного чата: friend | incoming | outgoing | blocked | none */
  F.relationOf = function (peerId) {
    const a = App();
    const id = Number(peerId);
    if (!a || !a.user) return 'none';
    if (F.isBlocked(id)) return 'blocked';
    if (F.isFriend(id)) return 'friend';
    if (F.incomingFrom(id)) return 'incoming';
    if (F.outgoingTo(id)) return 'outgoing';
    return 'none';
  };

  F.peerOfChat = function (chat) {
    if (!chat || chat.type !== 'direct') return null;
    const a = App();
    return (chat.members || []).find((m) => Number(m.id) !== Number(a.user.id)) || null;
  };

  // ── Загрузка с сервера ───────────────────────────────────────────────────
  F.load = async function () {
    const a = App();
    if (!a || !a.api || !a.api.access) return;
    try {
      const r = await a.api.get('/api/v1/friends');
      F.friends = new Map((r.friends || []).map((u) => [Number(u.user_id || u.id), u]));
      F.blocked = new Map((r.blocked || []).map((u) => [Number(u.user_id || u.id), u]));
      F.incoming = r.incoming || [];
      F.outgoing = r.outgoing || [];
      F.loaded = true;
    } catch (e) { /* сервер недоступен — интерфейс останется прежним */ }
    F.refreshBadge();
    F.applyGateToActive();
    if (a) a.renderChatList && a.renderChatList();
  };

  F.refreshBadge = function () {
    const badge = U().$('friendsBadge');
    if (!badge) return;
    const n = F.incoming.length;
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.classList.toggle('hidden', n === 0);
  };

  // ── Действия ─────────────────────────────────────────────────────────────
  F.request = async function (username, message) {
    const a = App();
    try {
      const r = await a.api.post('/api/v1/friends/requests', { username, message: message || '' });
      if (r.already_friends) {
        U().toast(T('friends.acceptDone'), 'ok');
        F.friends.set(Number(r.friend.user_id || r.friend.id), r.friend);
      } else if (r.request) {
        F.outgoing.push(r.request);
        U().toast(T('friends.requested'), 'ok');
      }
      F.refreshBadge();
      F.applyGateToActive();
      a.renderChatList && a.renderChatList();
      return true;
    } catch (e) {
      const code = e && e.code;
      if (code === 'ALREADY_REQUESTED') U().toast(T('friends.requested'));
      else if (code === 'BLOCKED') U().toast(T('friends.gateBlocked'), 'err');
      else U().toast((e && e.message) || T('conn.error'), 'err');
      return false;
    }
  };

  F.accept = async function (rid) {
    const a = App();
    try {
      const r = await a.api.post(`/api/v1/friends/requests/${rid}/accept`, {});
      const req = F.incoming.find((x) => x.id === rid);
      F.incoming = F.incoming.filter((x) => x.id !== rid);
      if (r.friend) F.friends.set(Number(r.friend.user_id || r.friend.id), r.friend);
      else if (req) F.friends.set(Number(req.from_id), { user_id: req.from_id, username: req.username, display_name: req.display_name });
      U().toast(T('friends.acceptDone'), 'ok');
      F.afterChange();
      return true;
    } catch (e) { U().toast((e && e.message) || T('conn.error'), 'err'); return false; }
  };

  F.decline = async function (rid) {
    const a = App();
    try {
      await a.api.post(`/api/v1/friends/requests/${rid}/decline`, {});
      F.incoming = F.incoming.filter((x) => x.id !== rid);
      F.afterChange();
    } catch (e) { U().toast((e && e.message) || T('conn.error'), 'err'); }
  };

  F.cancel = async function (rid) {
    const a = App();
    try {
      await a.api.delete(`/api/v1/friends/requests/${rid}`);
      F.outgoing = F.outgoing.filter((x) => x.id !== rid);
      F.afterChange();
    } catch (e) { U().toast((e && e.message) || T('conn.error'), 'err'); }
  };

  F.remove = async function (userId) {
    const a = App();
    if (!await U().confirmDialog(T('friends.remove'), T('friends.removeAsk'), T('common.delete'), true)) return;
    try {
      await a.api.delete('/api/v1/friends/' + userId);
      F.friends.delete(Number(userId));
      U().toast(T('friends.removed'), 'ok');
      F.afterChange();
    } catch (e) { U().toast((e && e.message) || T('conn.error'), 'err'); }
  };

  F.block = async function (userId) {
    const a = App();
    if (!await U().confirmDialog(T('friends.block'), T('friends.blockAsk'), T('friends.block'), true)) return;
    try {
      const r = await a.api.post(`/api/v1/friends/${userId}/block`, {});
      F.friends.delete(Number(userId));
      F.blocked.set(Number(userId), r.blocked || { user_id: userId });
      F.incoming = F.incoming.filter((x) => Number(x.from_id) !== Number(userId));
      F.outgoing = F.outgoing.filter((x) => Number(x.to_id) !== Number(userId));
      U().toast(T('friends.blockedDone'), 'ok');
      F.afterChange();
    } catch (e) { U().toast((e && e.message) || T('conn.error'), 'err'); }
  };

  F.unblock = async function (userId) {
    const a = App();
    try {
      await a.api.post(`/api/v1/friends/${userId}/unblock`, {});
      F.blocked.delete(Number(userId));
      U().toast(T('friends.unblockedDone'), 'ok');
      F.afterChange();
    } catch (e) { U().toast((e && e.message) || T('conn.error'), 'err'); }
  };

  F.afterChange = function () {
    F.refreshBadge();
    F.applyGateToActive();
    const a = App();
    a.renderChatList && a.renderChatList();
    if (F.panelTab && !U().$('modal').classList.contains('hidden')) F.renderPanel();
  };

  // ── События с сервера ────────────────────────────────────────────────────
  F.onEvent = function (ev) {
    if (ev.t === 'friend.request') {
      const r = ev.request;
      if (r && !F.incoming.some((x) => x.id === r.id)) F.incoming.push(r);
      U().toast(T('friends.incomingToast') + (r && r.display_name ? ': ' + r.display_name : ''), 'ok', 6000);
      U().beep && U().beep('in');
    } else if (ev.t === 'friend.accepted') {
      const u = ev.user || {};
      F.friends.set(Number(u.user_id || u.id), u);
      F.outgoing = F.outgoing.filter((x) => Number(x.to_id) !== Number(u.user_id || u.id));
      U().toast(T('friends.acceptedTheirs', { name: u.display_name || u.username || '' }), 'ok');
    } else if (ev.t === 'friend.declined') {
      F.outgoing = F.outgoing.filter((x) => Number(x.to_id) !== Number(ev.user_id));
      U().toast(T('friends.declinedTheirs'));
    } else if (ev.t === 'friend.removed') {
      F.friends.delete(Number(ev.user_id));
    } else if (ev.t === 'friend.request.cancelled') {
      F.incoming = F.incoming.filter((x) => Number(x.from_id) !== Number(ev.user_id));
    } else return;
    F.afterChange();
  };

  // ── Полоса-подсказка в чате ──────────────────────────────────────────────
  F.gateFor = function (chat) {
    const peer = F.peerOfChat(chat);
    if (!peer) return null;
    const rel = F.relationOf(peer.id);
    const name = peer.display_name || peer.username;
    if (rel === 'friend') return null;
    if (rel === 'blocked') {
      return {
        state: 'blocked', blocked: true, title: T('friends.gateBlocked'),
        note: F.isBlocked(peer.id) ? T('friends.youBlocked') : '',
        actions: [
          { label: T('friends.unblock'), primary: true, fn: () => F.unblock(peer.id) },
          { label: T('friends.remove'), ghost: true, fn: () => F.remove(peer.id) },
        ],
      };
    }
    if (rel === 'incoming') {
      const req = F.incomingFrom(peer.id);
      return {
        state: 'incoming', title: T('friends.gateIncoming', { name }),
        note: req && req.message ? req.message : T('friends.requestNote'),
        actions: [
          { label: T('friends.accept'), primary: true, fn: () => req && F.accept(req.id) },
          { label: T('friends.decline'), ghost: true, fn: () => req && F.decline(req.id) },
        ],
      };
    }
    if (rel === 'outgoing') {
      const req = F.outgoingTo(peer.id);
      return {
        state: 'outgoing', title: T('friends.gateOutgoing'), note: T('friends.requestNote'),
        actions: [{ label: T('friends.cancel'), ghost: true, fn: () => req && F.cancel(req.id) }],
      };
    }
    return {
      state: 'none', title: T('friends.gateTitle'), note: T('friends.requestNote'),
      actions: [{ label: T('friends.add'), primary: true, fn: () => F.request(peer.username) }],
    };
  };

  /** Показать/скрыть полосу и поле ввода для открытого чата. */
  F.applyGate = function (chat) {
    const bar = U().$('friendGate');
    const composerRow = document.querySelector('.composer-row');
    if (!bar || !composerRow) return;
    if (!F.loaded) {   // список друзей ещё не получен — не мешаем писать
      bar.classList.add('hidden');
      composerRow.classList.remove('hidden');
      return;
    }
    const gate = F.gateFor(chat);
    if (!gate) {
      bar.classList.add('hidden');
      bar.innerHTML = '';
      composerRow.classList.remove('hidden');
      return;
    }
    bar.classList.toggle('blocked', !!gate.blocked);
    bar.innerHTML = `<div class="fg-text"><b>${U().esc(gate.title)}</b>` +
      (gate.note ? `<small>${U().esc(gate.note)}</small>` : '') + `</div>` +
      `<div class="fg-actions"></div>`;
    const acts = bar.querySelector('.fg-actions');
    (gate.actions || []).forEach((act) => {
      const b = document.createElement('button');
      b.className = 'btn' + (act.primary ? ' primary' : (act.ghost ? ' ghost' : ''));
      b.textContent = act.label;
      b.onclick = () => act.fn();
      acts.appendChild(b);
    });
    bar.classList.remove('hidden');
    composerRow.classList.add('hidden');
  };

  F.applyGateToActive = function () {
    const a = App();
    if (!a || !a.activeChatId) return;
    const chat = a.chatsById[a.activeChatId];
    if (chat) F.applyGate(chat);
  };

  // ── Окно «Друзья» ────────────────────────────────────────────────────────
  F.panelTab = 'all';

  F.panel = function (tab) {
    F.panelTab = tab || F.panelTab || 'all';
    U().modal(T('friends.title'),
      `<div class="tabs small" id="frTabs">
         <button class="tab" data-fr="all">${U().esc(T('friends.tab.all'))} · ${F.friends.size}</button>
         <button class="tab" data-fr="requests">${U().esc(T('friends.tab.requests'))}${F.incoming.length ? ' · ' + F.incoming.length : ''}</button>
         <button class="tab" data-fr="blocked">${U().esc(T('friends.tab.blocked'))} · ${F.blocked.size}</button>
       </div>
       <label>${U().esc(T('friends.search'))}<input id="frFind" placeholder="${U().esc(T('friends.search'))}" autocomplete="off"></label>
       <div id="frBody"></div>`, { actions: false });
    U().$('frTabs').querySelectorAll('[data-fr]').forEach((b) => {
      b.onclick = () => { F.panelTab = b.dataset.fr; F.renderPanel(); };
    });
    F.renderPanel();
  };

  F.renderPanel = function () {
    const body = U().$('frBody');
    if (!body) return;
    const esc = U().esc;
    U().$('frTabs').querySelectorAll('[data-fr]').forEach((b) => b.classList.toggle('active', b.dataset.fr === F.panelTab));
    const q = (U().$('frFind') && U().$('frFind').value || '').trim().toLowerCase();
    const match = (u) => !q || String(u.username || '').toLowerCase().includes(q) ||
      String(u.display_name || '').toLowerCase().includes(q);

    if (F.panelTab === 'all') {
      const list = [...F.friends.values()].filter(match);
      body.innerHTML = list.length
        ? list.map((u) => F.rowFriend(u)).join('')
        : `<p class="muted small">${esc(T('friends.empty'))}</p>` + F.searchBlock();
    } else if (F.panelTab === 'requests') {
      const inc = F.incoming.filter(match), out = F.outgoing.filter(match);
      body.innerHTML = (inc.length ? `<h3>${esc(T('friends.tab.requests'))}</h3>` + inc.map((r) => F.rowIncoming(r)).join('') : '') +
        (out.length ? `<h3>${esc(T('friends.requested'))}</h3>` + out.map((r) => F.rowOutgoing(r)).join('') : '') +
        (!inc.length && !out.length ? `<p class="muted small">${esc(T('friends.requestsEmpty'))}</p>` : '') + F.searchBlock();
    } else {
      const list = [...F.blocked.values()].filter(match);
      body.innerHTML = list.length ? list.map((u) => F.rowBlocked(u)).join('')
        : `<p class="muted small">${esc(T('friends.blockedEmpty'))}</p>` + F.searchBlock();
    }
    F.bindRows();
  };

  /** Поиск по логину прямо в окне друзей: сразу видно, кто есть кто. */
  F.searchBlock = function () {
    const esc = U().esc;
    return `<h3>${esc(T('friends.search'))}</h3>
      <div class="list-row"><input id="frSearchUser" placeholder="${esc(T('friends.search'))}" autocomplete="off">
      <button class="btn primary" id="frSearchGo">${esc(T('newchat.search'))}</button></div>
      <div id="frSearchOut" class="muted small"></div>`;
  };

  F.rowFriend = function (u) {
    const esc = U().esc, id = Number(u.user_id || u.id);
    const on = App().online && App().online.has(id);
    return `<div class="friend-row" data-uid="${id}" data-act="write" data-username="${esc(u.username)}">
      ${U().avatarHTML(u, 'sm')}
      <div class="fr-body"><b><span class="online-dot ${on ? 'on' : ''}"></span>${esc(u.display_name || u.username)}</b>
        <small>@${esc(u.username)}${on ? ' · ' + esc(T('chat.online')) : ''}</small></div>
      <div class="fr-actions">
        <button class="btn" data-act="write" data-username="${esc(u.username)}">${esc(T('friends.write'))}</button>
        <button class="btn ghost" data-act="remove" data-uid="${id}">${esc(T('friends.remove'))}</button>
        <button class="btn ghost" data-act="block" data-uid="${id}">${esc(T('friends.block'))}</button>
      </div></div>`;
  };

  F.rowIncoming = function (r) {
    const esc = U().esc;
    return `<div class="friend-row">
      ${U().avatarHTML({ username: r.username, display_name: r.display_name }, 'sm')}
      <div class="fr-body"><b>${esc(r.display_name || r.username)}</b><small>@${esc(r.username)}</small>
        ${r.message ? `<div class="friend-note">${esc(r.message)}</div>` : ''}
        <div class="friend-note">${esc(T('friends.requestNote'))}</div></div>
      <div class="fr-actions">
        <button class="btn primary" data-act="accept" data-rid="${esc(r.id)}">${esc(T('friends.accept'))}</button>
        <button class="btn ghost" data-act="decline" data-rid="${esc(r.id)}">${esc(T('friends.decline'))}</button>
      </div></div>`;
  };

  F.rowOutgoing = function (r) {
    const esc = U().esc;
    return `<div class="friend-row">
      ${U().avatarHTML({ username: r.username, display_name: r.display_name }, 'sm')}
      <div class="fr-body"><b>${esc(r.display_name || r.username)}</b><small>@${esc(r.username)}</small>
        <div class="friend-note">${esc(T('friends.requested'))}</div></div>
      <div class="fr-actions">
        <button class="btn ghost" data-act="cancel" data-rid="${esc(r.id)}">${esc(T('friends.cancel'))}</button>
      </div></div>`;
  };

  F.rowBlocked = function (u) {
    const esc = U().esc, id = Number(u.user_id || u.id);
    return `<div class="friend-row">
      ${U().avatarHTML(u, 'sm')}
      <div class="fr-body"><b>${esc(u.display_name || u.username)}</b><small>@${esc(u.username)}</small>
        <div class="friend-note"><span class="role-chip">${esc(T('friends.blockedBadge'))}</span></div></div>
      <div class="fr-actions">
        <button class="btn primary" data-act="unblock" data-uid="${id}">${esc(T('friends.unblock'))}</button>
      </div></div>`;
  };

  F.bindRows = function () {
    const root = U().$('frBody');
    if (!root) return;
    root.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const act = b.dataset.act;
        if (act === 'accept') await F.accept(b.dataset.rid);
        else if (act === 'decline') await F.decline(b.dataset.rid);
        else if (act === 'cancel') await F.cancel(b.dataset.rid);
        else if (act === 'remove') await F.remove(Number(b.dataset.uid));
        else if (act === 'block') await F.block(Number(b.dataset.uid));
        else if (act === 'unblock') await F.unblock(Number(b.dataset.uid));
        else if (act === 'write') { U().closeModal(); await App().ensureDirectChat(b.dataset.username); }
      };
    });
    const go = U().$('frSearchGo');
    const input = U().$('frSearchUser');
    if (go && input) {
      const run = async () => {
        const q = input.value.trim();
        if (!q) return;
        const out = U().$('frSearchOut');
        out.textContent = '…';
        try {
          const r = await App().api.get('/api/v1/users/search', { q });
          const list = r.users || [];
          if (!list.length) { out.innerHTML = `<p class="muted small">${U().esc(T('friends.nothing'))}</p>`; return; }
          out.innerHTML = list.map((u) => F.rowSearchResult(u)).join('');
          out.querySelectorAll('[data-act]').forEach((b) => {
            b.onclick = async () => {
              const act = b.dataset.act;
              if (act === 'add') await F.request(b.dataset.username);
              else if (act === 'accept') await F.accept(b.dataset.rid);
              else if (act === 'write') { U().closeModal(); await App().ensureDirectChat(b.dataset.username); }
              else if (act === 'unblock') await F.unblock(Number(b.dataset.uid));
            };
          });
        } catch (err) { out.textContent = (err && err.message) || T('conn.error'); }
      };
      go.onclick = run;
      input.onkeydown = (e) => { if (e.key === 'Enter') run(); };
    }
  };

  /** Строка результата поиска: кнопка зависит от отношений. */
  F.rowSearchResult = function (u) {
    const esc = U().esc, id = Number(u.id || u.user_id);
    const rel = u.relation || (F.isBlocked(id) ? 'blocked' : (F.isFriend(id) ? 'friend'
      : (F.incomingFrom(id) ? 'incoming' : (F.outgoingTo(id) ? 'outgoing' : 'none'))));
    let action = '';
    if (rel === 'friend') action = `<button class="btn" data-act="write" data-username="${esc(u.username)}">${esc(T('friends.write'))}</button>`;
    else if (rel === 'incoming') action = `<button class="btn primary" data-act="accept" data-rid="${esc(u.incoming_request_id || '')}">${esc(T('friends.accept'))}</button>`;
    else if (rel === 'outgoing') action = `<span class="role-chip">${esc(T('friends.requested'))}</span>`;
    else if (rel === 'blocked') action = `<button class="btn primary" data-act="unblock" data-uid="${id}">${esc(T('friends.unblock'))}</button>`;
    else action = `<button class="btn primary" data-act="add" data-username="${esc(u.username)}">${esc(T('friends.add'))}</button>`;
    return `<div class="friend-row">
      ${U().avatarHTML(u, 'sm')}
      <div class="fr-body"><b>${esc(u.display_name || u.username)}</b><small>@${esc(u.username)}</small></div>
      <div class="fr-actions">${action}</div></div>`;
  };

  /** Кнопка действия для результата поиска в окне «Новый чат». */
  F.actionButtonHTML = function (u) {
    const esc = U().esc, id = Number(u.id || u.user_id);
    const rel = u.relation || 'none';
    if (rel === 'friend') return `<button class="btn" data-fa="write" data-username="${esc(u.username)}">${esc(T('friends.write'))}</button>`;
    if (rel === 'incoming') return `<button class="btn primary" data-fa="accept" data-rid="${esc(u.incoming_request_id || '')}">${esc(T('friends.accept'))}</button>`;
    if (rel === 'outgoing') return `<button class="btn" data-fa="cancel" data-rid="${esc(u.outgoing_request_id || '')}" disabled>${esc(T('friends.requested'))}</button>`;
    if (rel === 'blocked') return `<button class="btn primary" data-fa="unblock" data-uid="${id}">${esc(T('friends.unblock'))}</button>`;
    return `<button class="btn primary" data-fa="add" data-username="${esc(u.username)}">${esc(T('friends.add'))}</button>`;
  };

  global.Friends = F;
})(typeof window !== 'undefined' ? window : self);
