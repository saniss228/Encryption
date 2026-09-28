/* ============================================================================
 * Сетевой слой: REST + WebSocket, автообновление access-токена,
 * переподключение с экспоненциальной задержкой, очередь исходящих.
 * ========================================================================== */
(function (global) {
  'use strict';

  class ApiError extends Error {
    constructor(code, message, status, extra) {
      super(message || code || (window.I18N ? I18N.t('conn.error') : 'Error'));
      this.code = code; this.status = status; this.extra = extra || {};
    }
  }

  const T = (k, v) => (window.I18N ? I18N.t(k, v) : k);

  class Api {
    constructor(baseUrl) {
      this.base = (baseUrl || location.origin).replace(/\/+$/, '');
      this.access = null;
      this.refresh = null;
      this.device = null;
      this.ws = null;
      this.handlers = [];
      this.queue = [];
      this.connected = false;
      this.onConnection = null;
      this.pingTimer = null;
      this.retry = 0;
      this.stopped = false;
    }

    setTokens(tokens) {
      if (!tokens) return;
      this.access = tokens.access_token || this.access;
      this.refresh = tokens.refresh_token || this.refresh;
      Store.saveTokens({ access_token: this.access, refresh_token: this.refresh, session_id: tokens.session_id });
    }
    restoreTokens() {
      const t = Store.tokens();
      if (t) { this.access = t.access_token; this.refresh = t.refresh_token; }
      return !!t;
    }
    clearTokens() { this.access = null; this.refresh = null; Store.clearTokens(); }

    async request(method, path, body, opts) {
      opts = opts || {};
      const headers = { 'Accept': 'application/json' };
      if (body !== undefined && body !== null && !(body instanceof FormData) && !(body instanceof Blob)) {
        headers['Content-Type'] = 'application/json';
      }
      if (this.access && !opts.noAuth) headers['Authorization'] = 'Bearer ' + this.access;

      let res;
      const init = { method, headers, body: undefined };
      if (body !== undefined && body !== null) {
        init.body = (body instanceof FormData || body instanceof Blob || typeof body === 'string') ? body : JSON.stringify(body);
      }
      try {
        res = await fetch(this.base + path, init);
      } catch (e) {
        throw new ApiError('NETWORK', T('conn.noConnection'), 0);
      }

      if (res.status === 401 && this.refresh && !opts._retried) {
        const ok = await this.tryRefresh();
        if (ok) return this.request(method, path, body, Object.assign({}, opts, { _retried: true }));
      }

      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }

      if (!res.ok) {
        const err = (data && data.error) || {};
        // Служебные коды админ-панели показываем на языке интерфейса,
        // а текст от администратора (например, причину блокировки) — как есть
        const ERR_KEYS = {
          ADMIN_ONLY: 'admin.only', REGISTRATION_CLOSED: 'admin.regClosed',
          SELF_ACTION: 'admin.selfAction', TARGET_IS_ADMIN: 'admin.targetAdmin',
          ROOT_ADMIN: 'admin.rootAdmin',
        };
        const key = ERR_KEYS[err.code];
        const message = key && window.I18N ? I18N.t(key) : (err.message || (window.I18N ? I18N.t('conn.serverError') : 'Server error'));
        throw new ApiError(err.code || ('HTTP_' + res.status), message, res.status, err);
      }
      return data;
    }

    async tryRefresh() {
      try {
        const r = await this.request('POST', '/api/v1/auth/refresh', { refresh_token: this.refresh }, { noAuth: true, _retried: true });
        this.setTokens(r.tokens);
        return true;
      } catch (e) {
        this.clearTokens();
        return false;
      }
    }

    get(path, qs) { return this.request('GET', path + buildQuery(qs)); }
    post(path, body, qs) { return this.request('POST', path + buildQuery(qs), body); }
    patch(path, body, qs) { return this.request('PATCH', path + buildQuery(qs), body); }
    put(path, body, qs) { return this.request('PUT', path + buildQuery(qs), body); }
    del(path, qs) { return this.request('DELETE', path + buildQuery(qs)); }

    /* ── Realtime ─────────────────────────────────────────────────────── */
    on(handler) { this.handlers.push(handler); }
    emit(event) { this.handlers.forEach((h) => { try { h(event); } catch (e) { console.error(e); } }); }

    connectWS() {
      if (!this.access) return;
      this.stopped = false;
      const url = this.base.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(this.access);
      try { this.ws = new WebSocket(url); } catch (e) { return this.scheduleReconnect(); }

      this.ws.onopen = () => {
        this.retry = 0;
        this.connected = true;
        this.onConnection && this.onConnection(true);
        this.emit({ t: 'conn', online: true });
        this.flushQueue();
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.sendRaw({ t: 'ping' }), 25000);
      };
      this.ws.onmessage = (m) => {
        let ev; try { ev = JSON.parse(m.data); } catch (e) { return; }
        this.emit(ev);
      };
      this.ws.onclose = () => {
        this.connected = false;
        clearInterval(this.pingTimer);
        this.onConnection && this.onConnection(false);
        this.emit({ t: 'conn', online: false });
        this.scheduleReconnect();
      };
      this.ws.onerror = () => { try { this.ws.close(); } catch (e) {} };
    }

    scheduleReconnect() {
      if (this.stopped) return;
      this.retry = Math.min(this.retry + 1, 8);
      const delay = Math.min(1000 * Math.pow(2, this.retry - 1), 30000) + Math.random() * 500;
      setTimeout(() => { if (!this.stopped && this.access) this.connectWS(); }, delay);
    }

    disconnectWS() {
      this.stopped = true;
      clearInterval(this.pingTimer);
      try { this.ws && this.ws.close(); } catch (e) {}
      this.ws = null; this.connected = false;
    }

    /** Отправка в сокет; если связи нет — кладём в очередь. */
    sendRaw(obj) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(obj));
        return true;
      }
      this.queue.push(obj);
      return false;
    }
    flushQueue() {
      const q = this.queue.splice(0);
      q.forEach((o) => this.sendRaw(o));
    }

    /* ── Файлы (загрузка чанками) ─────────────────────────────────────── */
    async uploadBlob({ blob, chatId, kind, nameEnc, keyWrap, onProgress, chunkSize }) {
      const cs = chunkSize || Crypto.FILE_CHUNK;
      const sha = await Crypto.sha256(new Uint8Array(await blob.arrayBuffer()));
      const init = await this.post('/api/v1/files/init', {
        chat_id: chatId || null, size: blob.size, kind: kind || 'file',
        mime: blob.type || 'application/octet-stream', name_enc: nameEnc || '',
        key_wrap: keyWrap || '', chunk_size: cs, sha256: Crypto.b64(sha).slice(0, 44),
      });
      const total = init.chunks;
      for (let i = 0; i < total; i++) {
        const slice = blob.slice(i * cs, Math.min((i + 1) * cs, blob.size));
        await this.request('PUT', `/api/v1/files/${init.file_id}/chunk?index=${i}`, slice);
        onProgress && onProgress((i + 1) / Math.max(total, 1));
      }
      await this.post(`/api/v1/files/${init.file_id}/complete`, {});
      return init;
    }

    async downloadBlob(fileId, meta) {
      const parts = [];
      for (let i = 0; i < meta.chunks; i++) {
        const res = await fetch(`${this.base}/api/v1/files/${fileId}/chunk?index=${i}`, {
          headers: { 'Authorization': 'Bearer ' + this.access },
        });
        if (!res.ok) {
          // 410 LOCAL_ONLY: получатель (или вы сами с другого устройства) уже скачал файл,
          // копии на сервере нет — файл остался только на устройстве.
          let code = 'FILE_CHUNK';
          try {
            const j = await res.clone().json();
            code = (j && j.error && j.error.code) || (j && j.detail && j.detail.code) || code;
          } catch (e) { /* тело не JSON */ }
          throw new ApiError(code, code === 'LOCAL_ONLY' ? T('file.localOnlyNote') : T('file.loadError'), res.status);
        }
        parts.push(new Uint8Array(await res.arrayBuffer()));
      }
      return new Blob(parts, { type: meta.mime || 'application/octet-stream' });
    }
  }

  function buildQuery(qs) {
    if (!qs) return '';
    const parts = Object.entries(qs).filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    return parts.length ? '?' + parts.join('&') : '';
  }

  global.Api = Api;
  global.ApiError = ApiError;
  global.buildQuery = buildQuery;
})(typeof window !== 'undefined' ? window : self);
