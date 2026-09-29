/* ============================================================================
 * Вложения в переписке: картинки, видео и голосовые сообщения.
 *
 * Правила:
 *   • картинка видна сразу в переписке (без нажатий) и открывается на весь экран;
 *   • видео показывается плеером прямо в чате; маленькие — подгружаются сами,
 *     большие открываются по нажатию (чтобы не тянуть гигабайты без спроса);
 *   • голосовое — обычный плеер: кнопка воспроизведения, полоса, время, скачать;
 *   • файл расшифровывается ТОЛЬКО на устройстве, после чего сервер удаляет свою
 *     копию и сообщение помечается «только локально» (как и раньше).
 * ========================================================================== */
(function (global) {
  'use strict';
  const M = {};
  const T = (k, v) => (window.I18N ? I18N.t(k, v) : k);
  const $ = (id) => document.getElementById(id);
  const esc = (s) => UI.esc(s);

  const SMALL_VIDEO = 25 * 1024 * 1024;   // до 25 МБ видео подгружаем сразу
  const cache = new Map();                // file_id → Promise<Blob>
  const urls = new Map();                 // file_id → готовая ссылка на blob (для перерисовки)
  let currentAudio = null;                // играющее сейчас голосовое
  let voiceNow = null;                    // {file_id, time, playing} — переживает перерисовку списка

  /** Скачать и расшифровать вложение на устройстве. */
  M.fetchBlob = function (m) {
    const att = m.attachment;
    if (!att) return Promise.reject(Object.assign(new Error(T('file.loadError')), { code: 'NO_ATT' }));
    if (cache.has(att.file_id)) return cache.get(att.file_id);
    const task = (async () => {
      const key = await Crypto.keyFromB64(att.key);
      const parts = [];
      let demoBlob = null;
      if (App.demo) demoBlob = await App.api.downloadBlob(att.file_id, att);
      for (let i = 0; i < att.chunks; i++) {
        let enc;
        if (demoBlob) {
          const cs = att.chunk_size || Crypto.FILE_CHUNK;
          enc = new Uint8Array(await demoBlob.slice(i * cs, Math.min((i + 1) * cs, demoBlob.size)).arrayBuffer());
        } else {
          const res = await fetch(`${App.api.base}/api/v1/files/${att.file_id}/chunk?index=${i}`, {
            headers: App.api.access ? { 'Authorization': 'Bearer ' + App.api.access } : {},
          });
          if (!res.ok) {
            let code = 'FILE_CHUNK';
            try {
              const j = await res.clone().json();
              code = (j && j.error && j.error.code) || (j && j.detail && j.detail.code) || code;
            } catch (e) { /* не JSON */ }
            throw Object.assign(new Error(T('file.loadError')), { code });
          }
          enc = new Uint8Array(await res.arrayBuffer());
        }
        const pt = await Crypto.decryptChunk(key, i, enc, new TextEncoder().encode('file|' + att.file_id));
        parts.push(pt);
      }
      return new Blob(parts, { type: att.mime || 'application/octet-stream' });
    })();
    cache.set(att.file_id, task);
    task.catch(() => cache.delete(att.file_id));
    return task;
  };

  /** Сообщить серверу, что файл доставлен: копия удаляется, остаётся «только локально». */
  M.markConsumed = async function (m, att, silent) {
    att = att || m.attachment;
    if (att) att.localOnly = true;
    m.localOnly = true;
    if (typeof App.markLocalOnly === 'function') return App.markLocalOnly(m, att, silent);
  };

  M.isLocalOnly = (m, att) => !!(m.localOnly || (att && att.localOnly));

  /** Готовая ссылка на уже скачанный файл (если он скачан в этой сессии). */
  M.readyUrl = (att) => (att ? urls.get(att.file_id) : null);
  M.remember = (att, url) => { if (att && url) urls.set(att.file_id, url); };

  // ── Разметка вложения в сообщении ────────────────────────────────────────
  M.attachmentHTML = function (m) {
    const att = m.attachment;
    if (!att) return '';
    const localOnly = M.isLocalOnly(m, att);
    const badge = localOnly
      ? `<div class="local-badge" title="${esc(m.out ? T('file.localOnlyOwnerNote') : T('file.localOnlyNote'))}">🔒 ${esc(T('file.localOnlyBadge'))}</div>`
      : '';
    const note = localOnly
      ? `<small class="local-note">${esc(m.out ? T('file.localOnlyOwnerNote') : T('file.localOnlyNote'))}</small>`
      : `<small>${UI.size(att.size)} • ${esc(T('file.attachmentNote'))}</small>`;
    const mid = esc(m.id);

    const wait = localOnly ? '' : `<div class="att-loading" data-att-load="${mid}">${esc(T('file.loading'))}</div>`;
    if (att.kind === 'image') {
      return `<div class="attachment" data-att-wrap="${mid}">
          <img class="att-img" data-att-img="${mid}" alt="${esc(att.name || '')}">${wait}
        </div>${badge}${note}`;
    }
    if (att.kind === 'video') {
      return `<div class="attachment" data-att-wrap="${mid}">
          <video class="att-video" data-att-video="${mid}" controls preload="metadata" playsinline></video>${wait}
        </div>${badge}${note}`;
    }
    if (att.kind === 'voice') {
      return `<div class="voice-card" data-voice-card="${mid}">
          <button class="voice-play" data-voice-play="${mid}" title="${esc(T('file.playVoice'))}">▶</button>
          <div class="voice-bar" data-voice-bar="${mid}"><i></i></div>
          <span class="voice-time" data-voice-time="${mid}">0:00</span>
          <button class="voice-dl" data-voice-dl="${mid}" title="${esc(T('file.saveToDevice'))}">⤓</button>
        </div>
        <small class="voice-hint" data-voice-hint="${mid}">${esc(T('file.voiceMessageShort'))} · ${esc(T('file.tapToPlay'))}</small>${badge}${note}`;
    }
    return `<div class="att-card" data-att-file="${mid}"><span class="att-icon">📄</span><div class="att-body"><b>${esc(att.name || 'file')}</b>${note}</div></div>${badge}`;
  };

  // ── Подключение элементов сообщения ──────────────────────────────────────
  M.bind = function (el, m) {
    const att = m.attachment;
    if (!att) return;
    const localOnly = M.isLocalOnly(m, att);
    const imgEl = el.querySelector('[data-att-img]');
    const vidEl = el.querySelector('[data-att-video]');
    const playBtn = el.querySelector('[data-voice-play]');
    const fileEl = el.querySelector('[data-att-file]');

    const ready = M.readyUrl(att);
    if (imgEl) {
      imgEl.onclick = () => M.open(m, att);
      if (ready) {
        imgEl.src = ready; imgEl.classList.add('loaded');
        const ld = el.querySelector('[data-att-load]'); if (ld) ld.classList.add('hidden');
      }
      else if (!localOnly) M.loadInto(el, m, imgEl, 'image');
    } else if (vidEl) {
      vidEl.onclick = () => { if (!vidEl.src) M.open(m, att); };
      // Маленькое видео подгружаем сразу — оно сразу играется в чате
      const small = !att.size || Number(att.size) <= SMALL_VIDEO;
      if (ready) {
        vidEl.src = ready;
        const ld2 = el.querySelector('[data-att-load]'); if (ld2) ld2.classList.add('hidden');
      }
      else if (!localOnly && small) M.loadInto(el, m, vidEl, 'video');
      else if (!localOnly) {
        const wrap = el.querySelector('[data-att-wrap]');
        if (wrap) {
          const hint = document.createElement('div');
          hint.className = 'att-fallback';
          hint.innerHTML = `<span>🎬</span><span>${esc(T('file.videoBig'))}</span>`;
          hint.onclick = () => M.open(m, att);
          wrap.appendChild(hint);
        }
      }
    } else if (playBtn) {
      M.bindVoice(el, m);
    } else if (fileEl) {
      fileEl.onclick = () => M.open(m, att);
    }
  };

  /** Загрузить изображение/видео в элемент (с индикатором «Загрузка…»). */
  M.loadInto = async function (el, m, mediaEl, kind) {
    const att = m.attachment;
    const loader = el.querySelector('[data-att-load]');
    try {
      const blob = await M.fetchBlob(m);
      const url = M.readyUrl(att) || URL.createObjectURL(blob);
      M.remember(att, url);
      mediaEl.src = url;
      mediaEl.classList.add('loaded');
      if (loader) loader.classList.add('hidden');
      if (kind === 'image') {
        mediaEl.onload = () => { mediaEl.classList.add('loaded'); };
      }
      // Своё сообщение не «выкупаем»: копия на сервере нужна получателю
      if (!m.out) await M.markConsumed(m, att, true);
      const msgEl = el.closest ? el.closest('.msg') : null;
      if (msgEl) msgEl.classList.add('local');
      M.showLocalBadge(el, m);
    } catch (e) {
      if (loader) loader.innerHTML = esc(e && e.code === 'LOCAL_ONLY' ? T('file.localOnlyBadge') : T('file.loadError'));
      if (e && e.code === 'LOCAL_ONLY') { att.localOnly = true; m.localOnly = true; M.showLocalBadge(el, m); }
    }
  };

  M.showLocalBadge = function (el, m) {
    if (el.querySelector('.local-badge')) return;
    const wrap = el.querySelector('[data-att-wrap]') || el.querySelector('[data-voice-card]');
    if (!wrap) return;
    const b = document.createElement('div');
    b.className = 'local-badge';
    b.textContent = '🔒 ' + T('file.localOnlyBadge');
    wrap.parentNode.insertBefore(b, wrap.nextSibling);
  };

  // ── Голосовой плеер ──────────────────────────────────────────────────────
  M.bindVoice = function (el, m) {
    const att = m.attachment;
    const btn = el.querySelector('[data-voice-play]');
    const bar = el.querySelector('[data-voice-bar]');
    const timeEl = el.querySelector('[data-voice-time]');
    const dl = el.querySelector('[data-voice-dl]');
    const localOnly = M.isLocalOnly(m, att);
    const fmt = (s) => {
      s = Math.max(0, Math.floor(s || 0));
      return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    };
    const audio = document.createElement('audio');
    audio.preload = 'none';
    // Ссылка на уже скачанное вложение годится и для «только локально»:
    // на сервере копии нет, но на устройстве она есть — слушать можно.
    const readyUrl = M.readyUrl(att);
    if (readyUrl) audio.src = readyUrl;

    const paint = () => {
      const total = audio.duration || 0;
      const cur = audio.currentTime || 0;
      timeEl.textContent = fmt(cur || total);
      bar.querySelector('i').style.width = total ? Math.round((cur / total) * 100) + '%' : '0%';
    };
    const setPlayIcon = (playing) => {
      btn.textContent = playing ? '⏸' : '▶';
      btn.classList.toggle('playing', playing);
      btn.title = playing ? T('file.pause') : T('file.playVoice');
    };

    // Список сообщений перерисовывается (например, пришла квитанция о прочтении) —
    // не обрываем звук: возвращаем позицию и продолжаем с того же места.
    const restore = voiceNow && voiceNow.file_id === att.file_id ? voiceNow : null;
    if (restore && (restore.time > 0 || restore.playing)) {
      if (restore.time > 0) { try { audio.currentTime = restore.time; } catch (e) { /* ещё нет метаданных */ } }
      if (restore.playing) {
        M.stopOthers(audio);
        const pr = audio.play();
        if (pr && pr.catch) pr.catch(() => { setPlayIcon(false); });
      } else {
        setPlayIcon(false);
      }
    }
    const remember2 = () => {
      voiceNow = { file_id: att.file_id, time: audio.currentTime || 0, playing: !audio.paused };
    };

    btn.onclick = async (e) => {
      e.stopPropagation();
      if (audio.src) {
        if (audio.paused) { M.stopOthers(audio); audio.play(); } else audio.pause();
        setPlayIcon(!audio.paused);
        remember2();
        return;
      }
      if (localOnly) { UI.toast(T('file.localOnlyNote'), '', 5000); return; }
      btn.textContent = '…';
      try {
        const blob = await M.fetchBlob(m);
        const url = M.readyUrl(att) || URL.createObjectURL(blob);
        M.remember(att, url);
        audio.src = url;
        M.stopOthers(audio);
        // Отмечаем состояние ДО запуска: список может перерисоваться прямо
        // во время await, и новый плеер должен подхватить воспроизведение.
        voiceNow = { file_id: att.file_id, time: 0, playing: true };
        await audio.play();
        setPlayIcon(true);
        remember2();
        audio.onloadedmetadata = paint;
        if (!m.out) { await M.markConsumed(m, att, true); M.showLocalBadge(el, m); }
      } catch (err) {
        btn.textContent = '▶';
        UI.toast(err && err.code === 'LOCAL_ONLY' ? T('file.localOnlyNote') : ((err && err.message) || T('file.loadError')), 'err', 5000);
      }
    };
    audio.onpause = () => { setPlayIcon(false); remember2(); };
    audio.onplay = () => { M.stopOthers(audio); setPlayIcon(true); remember2(); };
    audio.ontimeupdate = () => { paint(); remember2(); };
    audio.onended = () => {
      setPlayIcon(false); audio.currentTime = 0; paint();
      if (voiceNow && voiceNow.file_id === att.file_id) voiceNow = null;
    };
    bar.onclick = (e) => {
      e.stopPropagation();
      if (!audio.duration) return;
      const r = bar.getBoundingClientRect();
      audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * audio.duration;
      paint();
    };
    dl.onclick = (e) => {
      e.stopPropagation();
      if (audio.src) { M.saveUrl(audio.src, att.name || 'voice.webm'); return; }
      M.open(m, att);
    };
    el._voiceAudio = audio;
    paint();
  };

  M.stopOthers = function (except) {
    if (currentAudio && currentAudio !== except) { try { currentAudio.pause(); } catch (e) {} }
    currentAudio = except;
  };

  M.saveUrl = function (url, name) {
    const a = document.createElement('a');
    a.href = url; a.download = name || 'file';
    document.body.appendChild(a); a.click(); a.remove();
  };

  // ── Полноэкранный просмотр и скачивание ──────────────────────────────────
  M.open = async function (m, att) {
    att = att || m.attachment;
    if (!att) return;
    if (M.isLocalOnly(m, att)) {
      UI.modal(T('file.localOnlyBadge'),
        `<p>${esc(m.out ? T('file.localOnlyOwnerNote') : T('file.localOnlyNote'))}</p>`, { actions: false });
      return;
    }
    UI.modal(T('file.downloading', { name: att.name || '' }),
      `<div class="progress"><i id="dlProgress"></i></div>
       <p class="muted small">${esc(T('file.decryptNote'))}</p><div id="dlBody"></div>`, { actions: false });
    const tick = setInterval(() => {
      const p = $('dlProgress');
      if (p && p.style.width !== '95%') p.style.width = Math.min(95, (parseFloat(p.style.width) || 0) + 7) + '%';
    }, 220);
    try {
      const blob = await M.fetchBlob(m);
      clearInterval(tick);
      const p = $('dlProgress'); if (p) p.style.width = '100%';
      const url = M.readyUrl(att) || URL.createObjectURL(blob);
      M.remember(att, url);
      const body = $('dlBody');
      const note = `<p class="local-note">🔒 ${esc(T('file.localOnlyBadge'))}<br>${esc(T('file.savedNote'))}</p>`;
      if (att.kind === 'image') body.innerHTML = `<img src="${url}" style="max-width:100%;border-radius:12px">${note}`;
      else if (att.kind === 'video') body.innerHTML = `<video src="${url}" controls autoplay playsinline style="max-width:100%;border-radius:12px"></video>${note}`;
      else if (att.kind === 'voice') body.innerHTML = `<audio src="${url}" controls autoplay style="width:100%"></audio>${note}`;
      else body.innerHTML = `<a class="btn primary" href="${url}" download="${esc(att.name || 'file')}">${esc(T('file.saveToDevice'))}</a>${note}`;
      if (!m.out) await M.markConsumed(m, att, false);
    } catch (e) {
      clearInterval(tick);
      if (e && e.code === 'LOCAL_ONLY') {
        att.localOnly = true; m.localOnly = true;
        const body = $('dlBody');
        if (body) body.innerHTML = `<div class="local-badge">🔒 ${esc(T('file.localOnlyBadge'))}</div>
          <p class="local-note">${esc(m.out ? T('file.localOnlyOwnerNote') : T('file.localOnlyNote'))}</p>`;
        if (App.activeChatId === m.chatId) App.renderMessages && App.renderMessages(m.chatId);
        return;
      }
      const body = $('dlBody');
      if (body) body.innerHTML = `<p class="badge bad">${esc((e && e.message) || T('file.loadError'))}</p>`;
    }
  };

  global.Media = M;
})(typeof window !== 'undefined' ? window : self);
