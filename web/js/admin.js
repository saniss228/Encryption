/* ============================================================================
 *  Encryption — админ-панель (только для логинов из ENC_ADMINS, по умолчанию saniss).
 *
 *  Панель открывается из настроек (раздел «Приложение» → кнопка «Админ-панель»)
 *  либо по нажатию на значок администратора рядом с профилем.
 *
 *  Разделы: обзор сервера, пользователи, группы, файлы, журнал, рассылка, настройки.
 *  Сервер повторно проверяет права на каждом запросе — интерфейс лишь отражает их.
 * ========================================================================== */
(function () {
  'use strict';
  const { $, esc, toast, modal, closeModal, confirmDialog, humanTime, size } = UI;
  const T = (k, v) => (window.I18N ? I18N.t(k, v) : k);

  const Admin = {
    tab: 'overview',
    ctx: { users: [], chats: [], files: [], audit: [], announcements: [], settings: {} },
  };
  window.Admin = Admin;

  function isAdmin() {
    return !!(App.user && (App.user.is_admin || App.user.role === 'admin'));
  }
  Admin.isAdmin = isAdmin;

  function api(path, opts) {
    return App.api ? App.api.get(path) : Promise.reject(new Error(T('conn.error')));
  }

  function row(html) { return `<div class="adm-row">${html}</div>`; }
  function kv(label, value, cls) {
    return `<div class="adm-kv"><span>${esc(label)}</span><b class="${cls || ''}">${value}</b></div>`;
  }
  function dash(v) { return v === undefined || v === null || v === '' ? '—' : esc(String(v)); }
  function when(ts) { return ts ? humanTime(Number(ts)) : '—'; }

  /* ── Открытие панели ───────────────────────────────────────────────────── */
  Admin.open = function (tab) {
    if (!isAdmin()) return toast(T('admin.only'), 'err');
    Admin.tab = tab || Admin.tab || 'overview';
    modal(T('admin.title'), `
      <div class="tabs small" id="admTabs">
        ${[['overview', T('admin.tab.overview')], ['users', T('admin.tab.users')], ['chats', T('admin.tab.chats')],
           ['files', T('admin.tab.files')], ['audit', T('admin.tab.audit')], ['broadcast', T('admin.tab.broadcast')],
           ['data', T('admin.tab.data')], ['settings', T('admin.tab.settings')]]
          .map(([k, l]) => `<button class="tab ${Admin.tab === k ? 'active' : ''}" data-adm="${k}">${esc(l)}</button>`).join('')}
      </div>
      <p class="adm-note">🔒 ${esc(T('admin.encryptionNote'))}</p>
      <div id="admBody"><p class="muted small">${esc(T('settings.loading'))}</p></div>`, { actions: false });
    document.querySelectorAll('[data-adm]').forEach((b) => { b.onclick = () => Admin.open(b.dataset.adm); });
    Admin.render();
  };

  Admin.render = async function () {
    const host = $('admBody');
    if (!host) return;
    host.innerHTML = `<p class="muted small">${esc(T('settings.loading'))}</p>`;
    try {
      if (Admin.tab === 'overview') await renderOverview(host);
      else if (Admin.tab === 'users') await renderUsers(host);
      else if (Admin.tab === 'chats') await renderChats(host);
      else if (Admin.tab === 'files') await renderFiles(host);
      else if (Admin.tab === 'audit') await renderAudit(host);
      else if (Admin.tab === 'broadcast') await renderBroadcast(host);
      else if (Admin.tab === 'data') await renderData(host);
      else if (Admin.tab === 'settings') await renderSettings(host);
    } catch (e) {
      host.innerHTML = `<p class="badge bad">${esc(e.message || T('conn.error'))}</p>`;
    }
  };

  /* ── Обзор ─────────────────────────────────────────────────────────────── */
  async function renderOverview(host) {
    const o = await api('/api/v1/admin/overview');
    Admin.ctx.overview = o;
    const mb = (b) => size(b);
    host.innerHTML = `
      <div class="adm-grid">
        <div class="adm-card"><small>${esc(T('admin.total'))}</small><b>${o.users.total}</b>
          <em>${esc(T('admin.online'))}: ${o.users.online} · ${esc(T('admin.blocked'))}: ${o.users.blocked}</em></div>
        <div class="adm-card"><small>${esc(T('admin.admins'))}</small><b>${o.users.admins}</b>
          <em>${esc(T('admin.sessions'))}: ${o.sessions.active} · ${esc(T('admin.devices'))}: ${o.sessions.devices}</em></div>
        <div class="adm-card"><small>${esc(T('admin.chats'))}</small><b>${o.chats.total}</b>
          <em>${esc(T('admin.groups'))}: ${o.chats.groups}</em></div>
        <div class="adm-card"><small>${esc(T('admin.messages'))}</small><b>${o.messages.total}</b>
          <em>${esc(T('admin.messages24'))}: ${o.messages.last_24h}</em></div>
        <div class="adm-card"><small>${esc(T('admin.filesOnServer'))}</small><b>${o.files.on_server}</b>
          <em>${esc(T('admin.filesBytes'))}: ${mb(o.files.bytes_on_server)} · ${esc(T('admin.expired'))}: ${o.files.expired_pending}</em></div>
        <div class="adm-card"><small>${esc(T('admin.filesLocalOnly'))}</small><b>${o.files.local_only}</b>
          <em>${esc(T('admin.audit24'))}: ${o.audit.events_24h}</em></div>
      </div>
      <div class="adm-kv"><span>${esc(T('admin.disk'))}</span>
        <b>${mb(o.disk.free)} ${esc(T('admin.diskFree'))} / ${mb(o.disk.total)}</b></div>
      <div class="adm-kv"><span>${esc(T('admin.tab.settings'))}</span>
        <b>${o.registration_open ? '✓ ' + esc(T('admin.registration')) : '✕ ' + esc(T('admin.registration'))}</b></div>
      <p class="muted small">Encryption ${esc(o.server.version)} · ${esc(o.server.uptime_note)}</p>`;
  }

  /* ── Пользователи ──────────────────────────────────────────────────────── */
  async function renderUsers(host) {
    const q = Admin.ctx.q || '';
    const filter = Admin.ctx.filter || 'all';
    const data = await api(`/api/v1/admin/users?q=${encodeURIComponent(q)}&filter=${filter}&limit=100`);
    Admin.ctx.users = data.users;
    host.innerHTML = `
      <div class="adm-toolbar">
        <input id="admUserQ" placeholder="${esc(T('admin.searchUsers'))}" value="${esc(q)}">
        <button class="btn small" id="admUserGo">${esc(T('admin.search'))}</button>
      </div>
      <div class="adm-chips">
        ${[['all', T('admin.filter.all')], ['online', T('admin.filter.online')], ['blocked', T('admin.filter.blocked')],
           ['admins', T('admin.filter.admins')]]
          .map(([k, l]) => `<button class="chip ${filter === k ? 'active' : ''}" data-admf="${k}">${esc(l)}</button>`).join('')}
      </div>
      <div id="admUsers">
        ${data.users.length ? data.users.map(userCard).join('') : `<p class="muted small">${esc(T('admin.noUsers'))}</p>`}
      </div>`;
    $('admUserGo').onclick = () => { Admin.ctx.q = $('admUserQ').value.trim(); Admin.render(); };
    $('admUserQ').onkeydown = (e) => { if (e.key === 'Enter') { Admin.ctx.q = e.target.value.trim(); Admin.render(); } };
    host.querySelectorAll('[data-admf]').forEach((b) => {
      b.onclick = () => { Admin.ctx.filter = b.dataset.admf; Admin.render(); };
    });
    bindUserActions(host);
  }

  function userCard(u) {
    const badges = [];
    if (u.is_admin) badges.push(`<span class="adm-badge adm-admin">${esc(T('admin.role.admin'))}</span>`);
    if (u.blocked) badges.push(`<span class="adm-badge adm-blocked">${esc(T('admin.blocked'))}</span>`);
    if (u.online) badges.push(`<span class="adm-badge adm-online">● ${esc(T('admin.online'))}</span>`);
    return `<div class="adm-user ${u.blocked ? 'is-blocked' : ''}" data-uid="${u.id}">
      <div class="adm-user-head">
        <b>${esc(u.display_name || u.username)}</b> <span class="muted small">@${esc(u.username)}</span>
        ${badges.join(' ')}
      </div>
      <div class="adm-user-meta">
        ${esc(T('admin.lastSeen'))}: ${when(u.last_seen)} ·
        ${esc(T('admin.messagesCount'))}: ${u.messages} ·
        ${esc(T('admin.sessions'))}: ${u.sessions} · ${esc(T('admin.devices'))}: ${u.devices}
        ${u.blocked_reason ? `<br><span class="muted small">${esc(T('admin.blockReason'))}: ${esc(u.blocked_reason)}</span>` : ''}
      </div>
      <div class="adm-actions">
        <button class="btn small" data-act="detail">${esc(T('admin.details'))}</button>
        ${u.blocked
          ? `<button class="btn small" data-act="unblock">${esc(T('admin.unblock'))}</button>`
          : `<button class="btn small" data-act="block">${esc(T('admin.block'))}</button>`}
        <button class="btn small" data-act="logout">${esc(T('admin.logout'))}</button>
        ${u.is_admin
          ? `<button class="btn small" data-act="demote">${esc(T('admin.removeAdmin'))}</button>`
          : `<button class="btn small" data-act="promote">${esc(T('admin.makeAdmin'))}</button>`}
        <button class="btn small danger" data-act="delete">${esc(T('admin.delete'))}</button>
      </div>
    </div>`;
  }

  function bindUserActions(host) {
    host.querySelectorAll('.adm-user').forEach((card) => {
      const uid = Number(card.dataset.uid);
      const u = Admin.ctx.users.find((x) => x.id === uid) || { id: uid };
      card.querySelectorAll('[data-act]').forEach((btn) => {
        btn.onclick = () => userAction(btn.dataset.act, u);
      });
    });
  }

  async function userAction(act, u) {
    try {
      if (act === 'detail') {
        const d = await api(`/api/v1/admin/users/${u.id}`);
        modal(`@${esc(d.user.username)}`, `
          ${kv(T('admin.role'), esc(d.user.role))}
          ${kv(T('admin.joined'), when(d.user.created_at))}
          ${kv(T('admin.lastSeen'), when(d.user.last_seen))}
          ${kv(T('admin.messagesCount'), d.user.messages)}
          <h3>${esc(T('admin.devices'))}</h3>
          ${(d.devices || []).map((x) => `<div class="list-row"><div class="grow"><b>${esc(x.name || x.id)}</b><br>
            <small class="muted">${esc(x.platform || '')} · ${when(x.last_seen)}${x.revoked_at ? ' · отозвано' : ''}</small></div></div>`).join('') || `<p class="muted small">—</p>`}
          <h3>${esc(T('admin.sessions'))}</h3>
          ${(d.sessions || []).slice(0, 8).map((s) => `<div class="list-row"><div class="grow">
            <small class="muted">${esc(s.ip || '')} · ${when(s.created_at)}${s.revoked_at ? ' · ✕' : ''}</small></div></div>`).join('') || `<p class="muted small">—</p>`}
          <h3>${esc(T('admin.files')) || 'Files'}</h3>
          <p class="muted small">${esc(T('admin.filesNote'))}</p>`, { actions: false });
        return;
      }
      if (act === 'block') {
        modal(T('admin.blockTitle'), `<p>${esc(T('admin.blockText'))}</p>
          <label>${esc(T('admin.blockReason'))}<input id="admReason" placeholder="${esc(T('admin.blockReason'))}"></label>
          <div class="modal-actions">
            <button class="btn" id="admCancel">${esc(T('common.cancel'))}</button>
            <button class="btn danger" id="admDo">${esc(T('admin.block'))}</button></div>`, { actions: false });
        $('admCancel').onclick = closeModal;
        $('admDo').onclick = async () => {
          await App.api.post(`/api/v1/admin/users/${u.id}/block`, { reason: $('admReason').value.trim() });
          toast(T('admin.blockedDone'), 'ok'); closeModal(); Admin.render();
        };
        return;
      }
      if (act === 'unblock') {
        await App.api.post(`/api/v1/admin/users/${u.id}/unblock`, {});
        toast(T('admin.unblockedDone'), 'ok'); Admin.render(); return;
      }
      if (act === 'logout') {
        await App.api.post(`/api/v1/admin/users/${u.id}/logout`, {});
        toast(T('admin.logoutDone'), 'ok'); return;
      }
      if (act === 'promote' || act === 'demote') {
        await App.api.post(`/api/v1/admin/users/${u.id}/role`, { role: act === 'promote' ? 'admin' : 'user' });
        toast(T('admin.roleChanged'), 'ok'); Admin.render(); return;
      }
      if (act === 'delete') {
        if (!await confirmDialog(T('admin.deleteTitle'), T('admin.deleteText'), T('admin.delete'), true)) return;
        await App.api.del(`/api/v1/admin/users/${u.id}`);
        toast(T('admin.deleted'), 'ok'); Admin.render(); return;
      }
    } catch (e) {
      toast(e.message || T('conn.error'), 'err');
    }
  }

  /* ── Группы ────────────────────────────────────────────────────────────── */
  async function renderChats(host) {
    const data = await api('/api/v1/admin/chats?type=group&limit=100');
    Admin.ctx.chats = data.chats;
    host.innerHTML = data.chats.length ? data.chats.map((c) => `
      <div class="adm-user">
        <div class="adm-user-head"><b>${esc(c.title || T('admin.chatTitle'))}</b>
          <span class="muted small">${esc(c.id)}</span></div>
        <div class="adm-user-meta">${esc(T('admin.members'))}: ${c.members} ·
          ${esc(T('admin.messagesInChat'))}: ${c.messages} · ${when(c.created_at)}</div>
        <div class="adm-actions">
          <button class="btn small danger" data-delchat="${esc(c.id)}">${esc(T('admin.deleteChat'))}</button>
        </div>
      </div>`).join('') : `<p class="muted small">${esc(T('admin.noChats'))}</p>`;
    host.querySelectorAll('[data-delchat]').forEach((b) => {
      b.onclick = async () => {
        if (!await confirmDialog(T('admin.deleteChat'), T('admin.deleteText'), T('common.delete'), true)) return;
        try {
          await App.api.del(`/api/v1/admin/chats/${b.dataset.delchat}`);
          toast(T('admin.chatDeleted'), 'ok'); Admin.render();
        } catch (e) { toast(e.message || T('conn.error'), 'err'); }
      };
    });
  }

  /* ── Файлы ─────────────────────────────────────────────────────────────── */
  async function renderFiles(host) {
    const filter = Admin.ctx.fileFilter || 'on_server';
    const data = await api(`/api/v1/admin/files?filter=${filter}&limit=100`);
    Admin.ctx.files = data.files;
    host.innerHTML = `
      <div class="adm-chips">
        ${[['on_server', T('admin.filesOnServer')], ['local_only', T('admin.filesLocalOnly')], ['all', T('admin.filter.all')]]
          .map(([k, l]) => `<button class="chip ${filter === k ? 'active' : ''}" data-admff="${k}">${esc(l)}</button>`).join('')}
      </div>
      <p class="adm-note">🔒 ${esc(T('admin.filesNote'))}</p>
      ${data.files.length ? data.files.map((f) => `
        <div class="adm-user">
          <div class="adm-user-head"><b>${esc(f.kind)}</b> <span class="muted small">${esc(f.id)}</span>
            ${f.local_only ? `<span class="adm-badge adm-local">🔒 ${esc(T('file.localOnlyBadge'))}</span>` : ''}</div>
          <div class="adm-user-meta">${esc(T('admin.fileOwner'))}: @${esc(f.owner || '—')} ·
            ${esc(T('admin.fileSize'))}: ${size(f.size)} ·
            ${esc(T('admin.fileTtl'))}: ${f.local_only ? '—' : when(f.expires_at)}</div>
          <div class="adm-actions">
            <button class="btn small danger" data-delfile="${esc(f.id)}">${esc(T('admin.fileDelete'))}</button>
          </div>
        </div>`).join('') : `<p class="muted small">${esc(T('admin.noFiles'))}</p>`}
      <button class="btn" id="admPurge" style="margin-top:10px">${esc(T('admin.purge'))}</button>`;
    host.querySelectorAll('[data-admff]').forEach((b) => {
      b.onclick = () => { Admin.ctx.fileFilter = b.dataset.admff; Admin.render(); };
    });
    host.querySelectorAll('[data-delfile]').forEach((b) => {
      b.onclick = async () => {
        try { await App.api.del(`/api/v1/admin/files/${b.dataset.delfile}`);
          toast(T('admin.fileDeleted'), 'ok'); Admin.render(); }
        catch (e) { toast(e.message || T('conn.error'), 'err'); }
      };
    });
    $('admPurge').onclick = async () => {
      try {
        const r = await App.api.post('/api/v1/admin/files/purge', {});
        toast(`${T('admin.purged')}: −${r.expired_removed + r.tombstones_removed}`, 'ok');
        Admin.render();
      } catch (e) { toast(e.message || T('conn.error'), 'err'); }
    };
  }

  /* ── Журнал ────────────────────────────────────────────────────────────── */
  async function renderAudit(host) {
    const data = await api('/api/v1/admin/audit?limit=120');
    Admin.ctx.audit = data.events;
    host.innerHTML = `<p class="adm-note">📋 ${esc(T('admin.auditNote'))}</p>` +
      (data.events.length ? data.events.map((e) => `
        <div class="adm-log">
          <span class="adm-log-time">${esc(new Date(e.at * 1000).toLocaleString(I18N.locale))}</span>
          <b>${esc(e.event)}</b>
          <span class="muted small">${e.username ? '@' + esc(e.username) : (e.user_id ? '#' + e.user_id : '')}
            ${e.ip ? '· ' + esc(e.ip) : ''} ${e.detail && Object.keys(e.detail).length ? '· ' + esc(JSON.stringify(e.detail)) : ''}</span>
        </div>`).join('') : `<p class="muted small">${esc(T('admin.auditEmpty'))}</p>`);
  }

  /* ── Рассылка ──────────────────────────────────────────────────────────── */
  async function renderBroadcast(host) {
    const data = await api('/api/v1/admin/announcements');
    Admin.ctx.announcements = data.announcements;
    host.innerHTML = `
      <h3>${esc(T('admin.broadcastTitle'))}</h3>
      <p class="muted small">${esc(T('admin.broadcastText'))}</p>
      <textarea id="admAnnText" rows="3" placeholder="${esc(T('admin.broadcastText'))}"></textarea>
      <div class="row-between" style="margin-top:8px">
        <span class="muted small">${esc(T('admin.broadcastLevel'))}</span>
        <select id="admAnnLevel">
          <option value="info">${esc(T('admin.level.info'))}</option>
          <option value="warning">${esc(T('admin.level.warning'))}</option>
          <option value="critical">${esc(T('admin.level.critical'))}</option>
        </select>
      </div>
      <button class="btn primary" id="admAnnSend" style="margin-top:10px">${esc(T('admin.send'))}</button>
      <h3>${esc(T('admin.activeAnn'))}</h3>
      ${data.announcements.filter((a) => a.active).map((a) => `
        <div class="adm-user">
          <div class="adm-user-head"><b>${esc(a.text)}</b>
            <span class="adm-badge adm-${esc(a.level)}">${esc(T('admin.level.' + (a.level || 'info')))}</span></div>
          <div class="adm-user-meta">@${esc(a.username || '—')} · ${when(a.at)}</div>
          <div class="adm-actions"><button class="btn small" data-offann="${a.id}">${esc(T('admin.turnOff'))}</button></div>
        </div>`).join('') || `<p class="muted small">${esc(T('admin.auditEmpty'))}</p>`}`;
    $('admAnnSend').onclick = async () => {
      const text = $('admAnnText').value.trim();
      if (!text) return toast(T('admin.broadcastText'), 'err');
      try {
        await App.api.post('/api/v1/admin/broadcast', { text, level: $('admAnnLevel').value });
        toast(T('admin.sent'), 'ok'); Admin.render();
      } catch (e) { toast(e.message || T('conn.error'), 'err'); }
    };
    host.querySelectorAll('[data-offann]').forEach((b) => {
      b.onclick = async () => {
        try { await App.api.del(`/api/v1/admin/announcements/${b.dataset.offann}`);
          toast(T('admin.turnOff'), 'ok'); Admin.render(); }
        catch (e) { toast(e.message || T('conn.error'), 'err'); }
      };
    });
  }

  /* ── Настройки сервера ─────────────────────────────────────────────────── */

  /* ── Данные и перенос на другой сервер ─────────────────────────────────── */
  async function renderData(host) {
    const d = await api('/api/v1/admin/backup/info');
    const st = d.stats || {};
    const total = (st.database_bytes || 0) + (st.files_bytes || 0) + (st.media_bytes || 0);
    host.innerHTML = `
      <h3>${esc(T('admin.data.title'))}</h3>
      <div class="adm-grid">
        <div class="adm-card"><small>${esc(T('admin.data.users'))}</small><b>${d.contents.users}</b></div>
        <div class="adm-card"><small>${esc(T('admin.data.chats'))}</small><b>${d.contents.chats}</b></div>
        <div class="adm-card"><small>${esc(T('admin.data.messages'))}</small><b>${d.contents.messages}</b></div>
        <div class="adm-card"><small>${esc(T('admin.data.size'))}</small><b>${esc(size(total))}</b>
          <em>${esc(T('admin.data.files'))}: ${st.files} · ${esc(T('admin.data.database'))}: ${esc(size(st.database_bytes))}</em></div>
      </div>
      <p class="adm-note">🔐 ${esc(d.note)}</p>
      <label style="margin-top:8px">${esc(T('admin.data.password'))}
        <input id="admBkPwd" type="password" autocomplete="new-password" placeholder="••••••••"></label>
      <label>${esc(T('admin.data.password2'))}
        <input id="admBkPwd2" type="password" autocomplete="new-password" placeholder="••••••••"></label>
      <div class="row-between" style="margin-top:8px">
        <button class="btn primary" id="admBkExport">${esc(T('admin.data.download'))}</button>
        <button class="btn ghost" id="admBkClean">${esc(T('admin.data.cleanup'))}</button>
      </div>
      <h3 style="margin-top:14px">${esc(T('admin.data.howTo'))}</h3>
      <ol class="adm-list">${(d.how_to || []).map((t) => `<li>${esc(t)}</li>`).join('')}</ol>
      <p class="muted small">${esc(T('admin.data.migrateNote'))}</p>`;

    $('admBkExport').onclick = async () => {
      const pwd = $('admBkPwd').value;
      const pwd2 = $('admBkPwd2').value;
      if (pwd.length < (d.min_password || 8)) return toast(T('admin.data.shortPassword'), 'err', 6000);
      if (pwd !== pwd2) return toast(T('admin.data.passwordMismatch'), 'err', 6000);
      const btn = $('admBkExport');
      btn.disabled = true;
      btn.textContent = T('admin.data.packing');
      try {
        const res = await fetch(App.serverBase + '/api/v1/admin/backup/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + App.api.access },
          body: JSON.stringify({ password: pwd }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err.error && err.error.message) || ('HTTP ' + res.status));
        }
        const blob = await res.blob();
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'encryption-backup-' + stamp + '.encbak';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
        $('admBkPwd').value = ''; $('admBkPwd2').value = '';
        toast(T('admin.data.downloaded'), 'ok', 8000);
      } catch (e) {
        toast(e.message || T('conn.error'), 'err', 7000);
      } finally {
        btn.disabled = false;
        btn.textContent = T('admin.data.download');
      }
    };

    $('admBkClean').onclick = async () => {
      if (!(await confirmDialog(T('admin.data.cleanup'), T('admin.data.cleanupAsk'), T('admin.data.cleanup'), true))) return;
      try {
        const r = await App.api.del('/api/v1/admin/backup/files');
        toast(T('admin.data.cleaned', { n: r.removed }), 'ok');
      } catch (e) { toast(e.message || T('conn.error'), 'err'); }
    };
  }

  async function renderSettings(host) {
    const d = await api('/api/v1/admin/settings');
    Admin.ctx.settings = d.settings;
    host.innerHTML = `
      <h3>${esc(T('admin.settingsTitle'))}</h3>
      <div class="row-between">
        <span>${esc(T('admin.registration'))}<br><small class="muted">${esc(T('admin.registrationHint'))}</small></span>
        <button class="switch ${d.settings.registration_open ? 'on' : ''}" id="admReg"></button>
      </div>
      <label style="margin-top:10px">${esc(T('admin.welcomeNote'))}
        <input id="admWelcome" value="${esc(d.settings.welcome_note || '')}" maxlength="500"></label>
      <button class="btn primary" id="admSave" style="margin-top:8px">${esc(T('settings.save'))}</button>
      <h3>${esc(T('admin.envTitle'))}</h3>
      ${kv('Версия', esc($('admBody') ? (Admin.ctx.overview ? Admin.ctx.overview.server.version : '—') : '—'))}
      ${kv('Администраторы', esc((d.env.admins || []).join(', ')))}
      ${kv('Хранение файлов', esc(d.env.file_ttl_hours + ' ч, макс. ' + d.env.max_file_mb + ' МБ'))}
      ${kv('Участников в группе', String(d.env.group_max_members))}`;
    $('admReg').onclick = (e) => {
      Admin.ctx.regOpen = !d.settings.registration_open;
      e.target.classList.toggle('on', Admin.ctx.regOpen);
    };
    $('admSave').onclick = async () => {
      const payload = { welcome_note: $('admWelcome').value.trim() };
      if (typeof Admin.ctx.regOpen === 'boolean') payload.registration_open = Admin.ctx.regOpen;
      try {
        await App.api.put('/api/v1/admin/settings', payload);
        toast(T('admin.saved'), 'ok'); Admin.render();
      } catch (e) { toast(e.message || T('conn.error'), 'err'); }
    };
  }
})();
