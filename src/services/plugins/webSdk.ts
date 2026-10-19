/**
 * webSdk.ts — SDK deplao.* cho UI plugin (chạy trong iframe), phục vụ tại
 * deplao-plugin://<id>/__deplao/sdk.js. Bản copy cho bundler: packages/plugin-sdk/web.js
 * (sinh bằng `node scripts/sync-plugin-sdk.js`, test kiểm tra hai bản giống nhau).
 *
 * Giao thức JSON-RPC 2.0 qua postMessage với app cha:
 *   plugin → app  { jsonrpc:'2.0', id, method, params }
 *   app → plugin  { jsonrpc:'2.0', id, result } | { jsonrpc:'2.0', id, error:{ code, message, data } }
 *   app → plugin  { jsonrpc:'2.0', method:'event'|'context.changed'|'theme.changed'|'settings.changed'|'command', params }
 *
 * Viết bằng ES2017 thuần, không dấu backtick (nằm trong template literal của TS).
 */
export const WEB_SDK_VERSION = '1.0.0';

export const WEB_SDK_JS = String.raw`/*! Deplao plugin SDK (web) v${'1.0.0'} */
(function () {
  'use strict';
  if (window.deplao && window.deplao.__sdk) return;
  var host = window.parent;
  if (!host || host === window) {
    console.warn('[deplao] SDK chỉ chạy bên trong Deplao');
  }
  var nextId = 1;
  var pending = {};
  var eventHandlers = {};
  var listeners = { ready: [], context: [], theme: [], settings: [], command: [] };
  var state = { ready: false, init: null, context: null, theme: null, settings: null };

  function post(msg) {
    try { host.postMessage(msg, '*'); } catch (e) { /* host đóng */ }
  }

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: '2.0', id: id, method: method, params: params === undefined ? {} : params });
    });
  }

  function emit(kind, payload) {
    var list = listeners[kind] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (e) { console.error('[deplao] listener lỗi', e); }
    }
  }

  function on(kind, cb) {
    listeners[kind].push(cb);
    return function () {
      var i = listeners[kind].indexOf(cb);
      if (i >= 0) listeners[kind].splice(i, 1);
    };
  }

  function typeMatches(pattern, type) {
    if (pattern === '*') return true;
    if (pattern.slice(-2) === '.*') return type.indexOf(pattern.slice(0, -1)) === 0;
    return pattern === type;
  }

  function dispatchEvent(ev) {
    var type = String(ev && ev.type || '');
    Object.keys(eventHandlers).forEach(function (pattern) {
      if (!typeMatches(pattern, type)) return;
      eventHandlers[pattern].forEach(function (h) {
        try { h(ev); } catch (e) { console.error('[deplao] event handler lỗi', e); }
      });
    });
  }

  function applyTheme(t) {
    if (!t) return;
    state.theme = t;
    var root = document.documentElement;
    root.setAttribute('data-theme', t.mode || 'light');
    var vars = t.vars || {};
    Object.keys(vars).forEach(function (k) { root.style.setProperty(k, vars[k]); });
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== host) return;
    var m = ev.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.id && pending[m.id]) {
      var p = pending[m.id];
      delete pending[m.id];
      if (m.error) {
        var err = new Error(m.error.message || 'Lỗi');
        err.code = m.error.code;
        if (m.error.data) { err.status = m.error.data.status; err.details = m.error.data.details; }
        p.reject(err);
      } else {
        p.resolve(m.result);
      }
      return;
    }
    switch (m.method) {
      case 'event': dispatchEvent(m.params); break;
      case 'context.changed': state.context = m.params; emit('context', m.params); break;
      case 'theme.changed': applyTheme(m.params); emit('theme', m.params); break;
      case 'settings.changed': state.settings = m.params; emit('settings', m.params); break;
      case 'command': emit('command', m.params); break;
    }
  });

  function api(method, params) {
    return call(method, params).then(function (res) {
      var data = res && res.data;
      if (res && res.pagination && data && typeof data === 'object') {
        try { Object.defineProperty(data, 'pagination', { value: res.pagination, enumerable: false }); } catch (e) { /* ignore */ }
      }
      return data;
    });
  }

  function resubscribe() {
    return call('events.subscribe', { types: Object.keys(eventHandlers) });
  }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(file);
    });
  }

  var special = {
    __sdk: '1.0.0',
    call: api,
    api: {
      call: api,
      request: function (method, path, opts) {
        opts = opts || {};
        return api('api.request', { method: method, path: path, query: opts.query, body: opts.body });
      }
    },
    storage: {
      get: function (key) { return call('storage.get', { key: key }); },
      set: function (key, value) { return call('storage.set', { key: key, value: value }); },
      delete: function (key) { return call('storage.delete', { key: key }); },
      list: function (prefix, limit) { return call('storage.list', { prefix: prefix || '', limit: limit || 100 }); }
    },
    settings: {
      get: function () { return call('settings.get'); },
      onChange: function (cb) { return on('settings', cb); }
    },
    log: {
      debug: function (m) { return call('log.debug', { message: String(m) }); },
      info: function (m) { return call('log.info', { message: String(m) }); },
      warn: function (m) { return call('log.warn', { message: String(m) }); },
      error: function (m) { return call('log.error', { message: String(m) }); }
    },
    events: {
      on: function (type, handler) {
        (eventHandlers[type] = eventHandlers[type] || []).push(handler);
        resubscribe().catch(function (e) { console.error('[deplao] events.on', e); });
        return function () {
          var list = eventHandlers[type] || [];
          var i = list.indexOf(handler);
          if (i >= 0) list.splice(i, 1);
          if (!list.length) delete eventHandlers[type];
          resubscribe().catch(function () { /* ignore */ });
        };
      },
      emit: function (name, data) { return call('events.emit', { name: name, data: data }); }
    },
    workflow: {
      trigger: function (type, payload) { return call('workflow.trigger', { type: type, payload: payload }); }
    },
    backend: {
      call: function (name, params) { return call('backend.call', { name: name, params: params }); }
    },
    media: {
      upload: function (file, name) {
        return fileToBase64(file).then(function (b64) {
          return call('media.upload', { name: name || file.name || 'file', mime: file.type || '', dataBase64: b64 });
        });
      }
    },
    system: {
      info: function () { return call('system.info'); }
    },
    ui: {
      context: function () { return state.context; },
      theme: function () { return state.theme; },
      onContext: function (cb) { return on('context', cb); },
      onTheme: function (cb) { return on('theme', cb); },
      onCommand: function (cb) { return on('command', cb); },
      openConversation: function (accountId, threadId) { return call('ui.openConversation', { accountId: accountId, threadId: threadId }); },
      insertComposerText: function (text) { return call('ui.insertComposerText', { text: String(text) }); },
      toast: function (message, kind) { return call('ui.toast', { message: String(message), kind: kind || 'info' }); },
      navigate: function (pageId) { return call('ui.navigate', { pageId: pageId }); },
      openExternal: function (url) { return call('ui.openExternal', { url: String(url) }); }
    },
    ready: function (cb) {
      if (state.ready) { try { cb(state.init); } catch (e) { console.error(e); } return function () {}; }
      return on('ready', cb);
    }
  };

  window.deplao = new Proxy(special, {
    get: function (target, ns) {
      if (typeof ns !== 'string') return undefined;
      if (ns in target) return target[ns];
      return new Proxy({}, {
        get: function (_t, fn) {
          if (typeof fn !== 'string' || fn === 'then') return undefined;
          return function (params) { return api(fn, params); };
        }
      });
    }
  });

  call('ui.ready', { sdk: '1.0.0', href: String(location.href) }).then(function (init) {
    state.init = init || {};
    state.context = state.init.context || null;
    state.settings = state.init.settings || null;
    applyTheme(state.init.theme);
    state.ready = true;
    emit('ready', state.init);
  }).catch(function (e) { console.error('[deplao] ui.ready lỗi', e); });
})();
`;
