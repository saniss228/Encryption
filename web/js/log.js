/* ============================================================================
 * Журнал работы клиента: что происходит на устройстве и почему что-то не вышло.
 *
 * Задачи журнала:
 *   • ошибка не «исчезает» — видно, где она случилась (модуль, действие, стек);
 *   • видно цепочку: нажатие → запрос к серверу → ответ → отрисовка;
 *   • журнал можно сохранить файлом и посмотреть без консоли браузера
 *     (в приложении для телефона консоли нет).
 *
 * Приватность: в журнал НЕ попадают текст сообщений, ключи, пароли и
 * расшифрованные файлы — только идентификаторы, размеры, коды и время.
 * ========================================================================== */
(function (global) {
  'use strict';

  const MAX_MEM = 600;                 // записей в памяти
  const MAX_STORE = 250;               // записей в localStorage (переживают перезапуск)
  const STORE_KEY = 'enc_log';
  const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

  const mem = [];
  let minLevel = 'info';
  let seq = 0;

  /**
   * Подробность. По умолчанию журнал подробный: именно он нужен, когда что-то
   * не работает, а консоли на телефоне нет. Отключить можно в настройках
   * («Диагностика → Подробный журнал») или ключом ?debug=0 в адресе.
   */
  function detailed() {
    try {
      if (/[?&]debug=0/.test(location.search)) return false;
      if (/[?&]debug=1/.test(location.search)) return true;
      return localStorage.getItem('enc_log_debug') !== '0';
    } catch (e) { return true; }
  }
  minLevel = detailed() ? 'debug' : 'info';

  function ts() {
    const d = new Date();
    const p = (n, w) => String(n).padStart(w || 2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
  }

  /** Аккуратно приводим данные к строке: без секретов и без «[object Object]». */
  function brief(v, depth) {
    depth = depth || 0;
    if (v === null || v === undefined) return String(v);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (typeof v === 'string') return v.length > 200 ? v.slice(0, 200) + '…(' + v.length + ')' : v;
    if (depth > 2) return '…';
    if (Array.isArray(v)) {
      const head = v.slice(0, 5).map((x) => brief(x, depth + 1)).join(', ');
      return '[' + head + (v.length > 5 ? ', …+' + (v.length - 5) : '') + ']';
    }
    if (typeof v === 'object') {
      const keys = Object.keys(v).slice(0, 8);
      return '{' + keys.map((k) => k + ': ' + brief(v[k], depth + 1)).join(', ') +
        (Object.keys(v).length > keys.length ? ', …' : '') + '}';
    }
    return String(v);
  }

  function push(level, category, message, data) {
    if ((LEVELS[level] || 20) < (LEVELS[minLevel] || 20)) return;
    const rec = {
      n: ++seq, t: ts(), ms: Date.now(), level: level, cat: category || 'app',
      msg: String(message || ''),
    };
    if (data !== undefined) rec.data = brief(data);
    mem.push(rec);
    while (mem.length > MAX_MEM) mem.shift();
    try {
      const arr = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      arr.push(rec);
      while (arr.length > MAX_STORE) arr.shift();
      localStorage.setItem(STORE_KEY, JSON.stringify(arr));
    } catch (e) { /* переполнение хранилища не должно ломать работу */ }
    return rec;
  }

  const L = {
    get entries() { return mem.slice(); },
    setLevel(level) { if (LEVELS[level]) minLevel = level; },
    get level() { return minLevel; },
    isDetailed() { return detailed(); },
    setDetailed(on) {
      try { localStorage.setItem('enc_log_debug', on ? '1' : '0'); } catch (e) {}
      minLevel = on ? 'debug' : 'info';
      L.info('log', on ? 'включён подробный журнал' : 'подробный журнал выключен');
    },
    debug(cat, msg, data) { return push('debug', cat, msg, data); },
    info(cat, msg, data) { return push('info', cat, msg, data); },
    warn(cat, msg, data) { return push('warn', cat, msg, data); },

    /** Ошибка: сохраняем текст, место вызова и стек — по ним ищем причину. */
    error(cat, msg, err, data) {
      const extra = Object.assign({}, data || {});
      if (err) {
        extra['ошибка'] = (err.name ? err.name + ': ' : '') + (err.message || String(err));
        if (err.code) extra['код'] = err.code;
        if (err.stack) extra['стек'] = String(err.stack).split('\n').slice(0, 4).join(' | ');
      }
      return push('error', cat, msg, Object.keys(extra).length ? extra : undefined);
    },

    /* ── Обёртки: снимаем «что было до и после» ─────────────────────────── */

    /** Замер длительности: const done = Log.step('api','отправка'); … done(ok). */
    step(cat, what) {
      const t0 = (global.performance && performance.now) ? performance.now() : Date.now();
      return function done(ok, data) {
        const t1 = (global.performance && performance.now) ? performance.now() : Date.now();
        const ms = Math.round(t1 - t0);
        const extra = Object.assign({ 'мс': ms }, data || {});
        if (ok === false) push('warn', cat, what + ' — не удалось', extra);
        else push('debug', cat, what, extra);
        return ms;
      };
    },

    /** Оборачиваем запрос к серверу: метод, путь, код ответа, длительность. */
    wrapRequest(api) {
      const call = (method, original) => function (path, ...rest) {
        const t0 = Date.now();
        const done = (status, err) => {
          const ms = Date.now() - t0;
          const line = method + ' ' + path;
          if (err) L.error('api', line, err, { 'мс': ms });
          else if (typeof status === 'number' && status >= 400) L.warn('api', line + ' → ' + status, { 'мс': ms });
          else L.debug('api', line + ' → ok', { 'мс': ms });
        };
        let res;
        try {
          res = original.call(this, path, ...rest);
        } catch (e) {                      // именно так проявляется «api.delete is not a function»
          done(0, e);
          throw e;
        }
        if (res && typeof res.then === 'function') {
          return res.then(
            (r) => { done(r && r.status ? r.status : 200); return r; },
            (e) => { done(0, e); throw e; },
          );
        }
        done(200);
        return res;
      };
      ['get', 'post', 'patch', 'put', 'del'].forEach((m) => {
        if (typeof api[m] === 'function') api[m] = call(m.toUpperCase(), api[m]);
      });
      return api;
    },

    /* ── Выгрузка ───────────────────────────────────────────────────────── */

    /** Текст журнала для файла: сначала сводка, затем записи. */
    dump() {
      const head = [
        'Encryption — журнал работы клиента',
        'Время выгрузки: ' + new Date().toLocaleString(),
        'Устройство: ' + (global.AndroidNative && AndroidNative.getPlatform
          ? AndroidNative.getPlatform() + ' ' + (AndroidNative.getAppVersion ? AndroidNative.getAppVersion() : '')
          : 'браузер'),
        'Подробный режим: ' + (detailed() ? 'да' : 'нет'),
        'Записей: ' + mem.length,
        'Секретов в журнале нет: тексты сообщений, ключи и пароли не записываются.',
        '─'.repeat(70),
      ].join('\n');
      const body = mem.map((r) => {
        const lvl = r.level === 'error' ? 'ОШИБКА' : r.level === 'warn' ? 'ВНИМАНИЕ' : r.level === 'debug' ? 'подробно' : 'событие';
        const data = r.data ? ' · ' + r.data : '';
        return r.t + ' [' + lvl + '] ' + r.cat + ': ' + r.msg + data;
      }).join('\n');
      return head + '\n' + body + '\n';
    },

    download() {
      const text = L.dump();
      const d0 = new Date();
      const stamp0 = d0.getFullYear() + String(d0.getMonth() + 1).padStart(2, '0') + String(d0.getDate()).padStart(2, '0') +
        '-' + String(d0.getHours()).padStart(2, '0') + String(d0.getMinutes()).padStart(2, '0');
      const name0 = 'encryption-журнал-' + stamp0 + '.txt';
      // В приложении для телефона скачивание ссылкой не работает — сохраняем через систему
      if (global.AndroidNative && global.AndroidNative.saveToDownloads) {
        try {
          const bytes = new TextEncoder().encode(text);
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          }
          global.AndroidNative.saveToDownloads(btoa(bin), name0, 'text/plain');
          L.info('log', 'журнал сохранён в «Загрузки»');
          return true;
        } catch (e) { L.error('log', 'не удалось сохранить журнал на устройстве', e); return false; }
      }
      try {
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const d = new Date();
        const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') +
          '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
        a.href = url; a.download = 'encryption-журнал-' + stamp + '.txt';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        L.info('log', 'журнал сохранён файлом');
        return true;
      } catch (e) { L.error('log', 'не удалось сохранить журнал', e); return false; }
    },

    clear() {
      mem.length = 0;
      try { localStorage.removeItem(STORE_KEY); } catch (e) {}
      push('info', 'log', 'журнал очищен');
    },
  };

  /* ── Что перехватываем автоматически ──────────────────────────────────── */

  // 1. Необработанные ошибки и отклонённые промисы: без этого ошибка видна
  //    только в консоли, которой на телефоне нет.
  global.addEventListener('error', (e) => {
    const where = (e.filename || '') + (e.lineno ? ':' + e.lineno + (e.colno ? ':' + e.colno : '') : '');
    L.error('js', 'необработанная ошибка' + (where ? ' (' + where + ')' : ''), e.error || e.message);
  });
  global.addEventListener('unhandledrejection', (e) => {
    L.error('js', 'обещание завершилось ошибкой', e.reason);
  });

  // 2. Ошибки, которые код пишет в консоль.
  ['error', 'warn'].forEach((lvl) => {
    const orig = console[lvl] ? console[lvl].bind(console) : function () {};
    console[lvl] = function (...args) {
      try { L[lvl]('console', args.map((a) => brief(a)).join(' ')); } catch (e) {}
      return orig(...args);
    };
  });

  // 3. Настройки — через журнал, чтобы видеть, что и когда менялось.
  global.Log = L;
  push('info', 'log', 'клиент запущен', { 'версия': (global.APP_VERSION || '—') });
})(window);
