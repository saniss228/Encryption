/* ============================================================================
 * UI-хелперы: тосты, модалки, форматирование, аватары, диалоги.
 * ========================================================================== */
(function (global) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const qs = (sel, root) => (root || document).querySelector(sel);
  const qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const L = () => (window.I18N ? I18N.locale : 'ru');
  const t = (k, v) => (window.I18N ? I18N.t(k, v) : k);

  function toast(text, kind, ms) {
    const box = $('toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = esc(text);
    box.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, ms || 4200);
  }

  let modalOnClose = null;
  function modal(title, html, opts) {
    opts = opts || {};
    const body = $('modalBody');
    // У каждого окна есть крестик: закрыть можно кнопкой, клавишей Esc или щелчком по фону.
    body.innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2>` +
      `<button class="x-btn" id="modalClose" type="button" title="${esc(t('common.close'))}" aria-label="${esc(t('common.close'))}">✕</button></div>` +
      `<div class="modal-content">${html}</div>` +
      (opts.actions === false ? '' : `<div class="modal-actions" id="modalActions"></div>`);
    $('modal').classList.remove('hidden');
    $('modalBackdrop').classList.remove('hidden');
    modalOnClose = opts.onClose || null;
    const x = $('modalClose');
    if (x) x.onclick = () => closeModal();
    return body;
  }
  function closeModal() {
    $('modal').classList.add('hidden');
    $('modalBackdrop').classList.add('hidden');
    $('modalBody').innerHTML = '';
    if (modalOnClose) { const f = modalOnClose; modalOnClose = null; f(); }
  }
  function confirmDialog(title, text, okLabel, danger) {
    return new Promise((resolve) => {
      modal(title, `<p>${esc(text)}</p>`, { actions: false, onClose: () => resolve(false) });
      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      actions.innerHTML = `<button class="btn" id="dlgNo">${esc(t('common.cancel'))}</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" id="dlgYes">${esc(okLabel || t('common.continue'))}</button>`;
      $('modalBody').appendChild(actions);
      $('dlgNo').onclick = () => { modalOnClose = null; closeModal(); resolve(false); };
      $('dlgYes').onclick = () => { modalOnClose = null; closeModal(); resolve(true); };
    });
  }

  function initials(name) {
    const s = String(name || '?').trim();
    if (!s) return '?';
    const parts = s.split(/[\s_.-]+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }
  function avatarHTML(user, size) {
    const cls = 'avatar' + (size ? ' ' + size : '');
    const name = user && (user.display_name || user.username) || '?';
    if (user && user.avatar_url) return `<span class="${cls}"><img src="${esc(user.avatar_url)}" alt=""></span>`;
    return `<span class="${cls}" data-uid="${user && user.id || ''}">${esc(initials(name))}</span>`;
  }
  function fillAvatar(el, user) {
    if (!el) return;
    const name = user && (user.display_name || user.username) || '?';
    el.textContent = initials(name);
    const av = user && user.avatar_url;
    el.innerHTML = av ? `<img src="${esc(av)}" alt="">` : esc(initials(name));
    el.style.background = colorFor(name);
  }
  function colorFor(name) {
    let h = 0;
    for (let i = 0; i < String(name).length; i++) h = (h * 31 + String(name).charCodeAt(i)) % 360;
    return `linear-gradient(135deg, hsl(${h} 70% 52%), hsl(${(h + 40) % 360} 70% 42%))`;
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function timeHM(ts) {
    const d = new Date(ts * 1000);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function dayLabel(ts) {
    const d = new Date(ts * 1000), today = new Date();
    const same = (a, b) => a.toDateString() === b.toDateString();
    if (same(d, today)) return t('time.today');
    if (same(d, new Date(today.getTime() - 86400000))) return t('time.yesterday');
    return d.toLocaleDateString(L(), {
      day: 'numeric', month: 'long',
      year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
    });
  }
  function humanTime(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000), diff = Date.now() / 1000 - ts;
    if (diff < 60) return t('time.now');
    if (diff < 3600) return t('time.minAgo', { n: Math.floor(diff / 60) });
    if (diff < 86400) return timeHM(ts);
    return d.toLocaleDateString(L(), { day: 'numeric', month: 'short' });
  }
  function size(bytes) {
    bytes = Number(bytes) || 0;
    if (bytes < 1024) return bytes + ' ' + t('unit.b');
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' ' + t('unit.kb');
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1048576).toFixed(1) + ' ' + t('unit.mb');
    return (bytes / 1073741824).toFixed(2) + ' ' + t('unit.gb');
  }
  function countdown(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
    return (h ? h + ':' : '') + pad(m) + ':' + pad(s);
  }
  function ttlLabel(sec) {
    if (!sec) return t('common.off');
    const unit = (n, ru, en, es, de) => {
      const forms = { ru, en, es, de };
      const f = forms[L()] || forms.en;
      return n + ' ' + f;
    };
    if (sec < 60) return unit(sec, 'сек', 'sec', 's', 'Sek.');
    if (sec < 3600) return unit(Math.round(sec / 60), 'мин', 'min', 'min', 'Min.');
    if (sec < 86400) return unit(Math.round(sec / 3600), 'ч', 'h', 'h', 'Std.');
    if (sec < 7 * 86400) return unit(Math.round(sec / 86400), 'дн', 'd', 'd', 'Tg.');
    return unit(Math.round(sec / 604800), 'нед', 'w', 'sem', 'Wo.');
  }

  /* Простейший «QR»-подобный рендер кода привязки (визуальный ориентир). */
  function codeBlock(code, small) {
    return `<div class="code-box ${small ? 'small' : ''}">${esc(code)}</div>`;
  }

  function beep(kind) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = kind === 'in' ? 660 : 440;
      g.gain.value = 0.06;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      setTimeout(() => { o.stop(); ctx.close(); }, 140);
    } catch (e) {}
  }

  // Закрытие окон «накрест»: клавиша Esc и щелчок по затемнённому фону
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('modal').classList.contains('hidden')) { closeModal(); return; }
    if (window.Call && typeof Call.isOpen === 'function' && Call.isOpen()) Call.hangup();
  });
  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'modalBackdrop') closeModal();
  });

  global.UI = { $, qs, qsa, esc, toast, modal, closeModal, confirmDialog, avatarHTML, fillAvatar,
    initials, timeHM, dayLabel, humanTime, size, countdown, ttlLabel, codeBlock, beep, colorFor, t };
})(typeof window !== 'undefined' ? window : self);
