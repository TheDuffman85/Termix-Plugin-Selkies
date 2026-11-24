/**
 * The script put first in every proxied Selkies page.
 *
 * A Termix plugin view is a sandboxed frame (allow-scripts, opaque origin),
 * and a frame inside it inherits that sandbox. The Selkies client was written
 * for a normal origin, so this script fixes up what an opaque origin breaks:
 *
 * - localStorage, sessionStorage and document.cookie throw: they are replaced
 *   with in-memory stand-ins (settings last until the tab is closed).
 * - The frame's real origin (window.origin) is "null", but location.origin
 *   still names the server. The client posts messages to itself addressed to
 *   location.origin, which an opaque origin never matches, and drops received
 *   messages whose origin isn't location.origin. Messages to this window
 *   addressed to its own origin go out as "*", and only messages this window
 *   sent itself (event.source === window) are relabelled on arrival; those
 *   from other frames keep their real origin.
 * - WebSockets can't be served under /plugin-api, only /plugin-ws: the
 *   stream socket URL the client builds from its page address is moved to
 *   this plugin's socket route. The client opens its socket inside blob
 *   workers, so every script blob gets the same fix as a prelude.
 * - Requests from an opaque origin are cross-origin, and Termix answers their
 *   CORS preflights itself, allowing only its own header list: the upload's
 *   X-Upload-* headers travel in a query parameter instead, and the proxy
 *   turns them back into headers.
 *
 * Plain ES5 on purpose: it runs before anything else and also inside workers.
 */
export const SHIM_PATH = "__termix/shim.js";

/** Query parameter carrying moved X-Upload-* headers, base64 JSON. */
export const MOVED_HEADERS_PARAM = "__termix_h";

export const SHIM_SOURCE = String.raw`(function () {
  "use strict";
  var MARK = "/plugin-api/selkies/s/";
  var path = location.pathname;
  var at = path.indexOf(MARK);
  if (at < 0 || window.__termixSelkiesShim) return;
  window.__termixSelkiesShim = true;
  var token = path.slice(at + MARK.length).split("/")[0];
  var C = {
    host: location.host,
    prefix: path.slice(0, at + MARK.length + token.length + 1),
    target:
      (location.protocol === "http:" ? "ws:" : "wss:") + "//" + location.host +
      path.slice(0, at) + "/plugin-ws/selkies/stream",
    token: token
  };

  function rewrite(url, C) {
    try {
      var u = new URL(String(url));
      if (u.protocol !== "ws:" && u.protocol !== "wss:") return url;
      if (u.host !== C.host || u.pathname.indexOf(C.prefix) !== 0) return url;
      var sub = u.pathname.slice(C.prefix.length);
      if (sub.indexOf("api/") !== 0) return url;
      var out = new URLSearchParams();
      out.set("t", C.token);
      out.set("p", sub.slice(4).replace(/\/+$/, ""));
      new URLSearchParams(u.search).forEach(function (value, key) {
        if (key !== "t" && key !== "p") out.append(key, value);
      });
      return C.target + "?" + out.toString();
    } catch (e) {
      return url;
    }
  }

  function patchWebSocket(scope, C, rewrite) {
    var Native = scope.WebSocket;
    if (!Native || Native.__termix) return;
    function Moved(url, protocols) {
      var target = rewrite(url, C);
      return protocols === undefined ? new Native(target) : new Native(target, protocols);
    }
    Moved.prototype = Native.prototype;
    Moved.CONNECTING = 0;
    Moved.OPEN = 1;
    Moved.CLOSING = 2;
    Moved.CLOSED = 3;
    Moved.__termix = true;
    scope.WebSocket = Moved;
  }

  patchWebSocket(window, C, rewrite);

  // Workers: every script blob opens with the same socket fix.
  var prelude =
    "(function(){var C=" + JSON.stringify(C) + ";var rewrite=" + rewrite +
    ";(" + patchWebSocket + ")(self,C,rewrite);})();\n";
  var NativeBlob = window.Blob;
  var STRICT = /^(\s*(["'])use strict\2;?)/;
  function withPrelude(parts) {
    var list = Array.prototype.slice.call(parts);
    if (typeof list[0] === "string") {
      var match = STRICT.exec(list[0]);
      if (match) {
        return [match[1] + "\n", prelude, list[0].slice(match[1].length)].concat(list.slice(1));
      }
    }
    return [prelude].concat(list);
  }
  function ScriptBlob(parts, options) {
    if (parts && options && /javascript|ecmascript/i.test(options.type || "")) {
      parts = withPrelude(parts);
    }
    return arguments.length === 0 ? new NativeBlob() : new NativeBlob(parts, options);
  }
  ScriptBlob.prototype = NativeBlob.prototype;
  window.Blob = ScriptBlob;

  // A worker from a URL on this server: an opaque origin can only start
  // workers from blobs, so a blob loads the script.
  var NativeWorker = window.Worker;
  if (NativeWorker) {
    var LoadedWorker = function (url, options) {
      var u;
      try { u = new URL(String(url), location.href); } catch (e) { u = null; }
      if (u && (u.protocol === "http:" || u.protocol === "https:")) {
        var module = options && options.type === "module";
        var src = module ? "import " + JSON.stringify(u.href) + ";\n"
          : "importScripts(" + JSON.stringify(u.href) + ");\n";
        var blobUrl = URL.createObjectURL(new ScriptBlob([src], { type: "text/javascript" }));
        return new NativeWorker(blobUrl, options);
      }
      return options === undefined ? new NativeWorker(url) : new NativeWorker(url, options);
    };
    LoadedWorker.prototype = NativeWorker.prototype;
    window.Worker = LoadedWorker;
  }

  // Storage and cookies.
  function memoryStorage() {
    var data = {};
    var api = {
      getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[String(k)] = String(v); },
      removeItem: function (k) { delete data[String(k)]; },
      clear: function () { data = {}; },
      key: function (i) { var keys = Object.keys(data); return i >= 0 && i < keys.length ? keys[i] : null; }
    };
    Object.defineProperty(api, "length", { get: function () { return Object.keys(data).length; } });
    return api;
  }
  ["localStorage", "sessionStorage"].forEach(function (name) {
    try {
      var store = window[name];
      store.setItem("__termix__", "1");
      store.removeItem("__termix__");
    } catch (e) {
      try {
        Object.defineProperty(window, name, { configurable: true, enumerable: true, value: memoryStorage() });
      } catch (ignored) {}
    }
  });
  try {
    void document.cookie;
  } catch (e) {
    try {
      Object.defineProperty(document, "cookie", {
        configurable: true,
        get: function () { return ""; },
        set: function () {}
      });
    } catch (ignored) {}
  }

  // Messages from this window to itself. Its real origin is opaque, but
  // location.origin still names the server, and the client both addresses
  // its messages to location.origin and drops any whose origin differs.
  var opaque = window.origin === "null";
  var pageOrigin = location.origin;
  function ownOrigin(target) {
    return target === "null" || target === "/" ||
      (opaque && target === pageOrigin);
  }
  var nativePost = window.postMessage;
  window.postMessage = function (message, targetOrigin, transfer) {
    if (targetOrigin && typeof targetOrigin === "object") {
      if (ownOrigin(targetOrigin.targetOrigin)) {
        targetOrigin = Object.assign({}, targetOrigin, { targetOrigin: "*" });
      }
      return nativePost.call(window, message, targetOrigin);
    }
    if (ownOrigin(targetOrigin)) targetOrigin = "*";
    return transfer === undefined
      ? nativePost.call(window, message, targetOrigin)
      : nativePost.call(window, message, targetOrigin, transfer);
  };

  // Received: only a message this window sent itself is relabelled with the
  // page origin; messages from any other frame keep their own origin.
  function relabel(event) {
    if (!event || event.origin !== "null" || event.source !== window ||
        !pageOrigin || pageOrigin === "null") {
      return event;
    }
    try {
      Object.defineProperty(event, "origin", { configurable: true, value: pageOrigin });
      if (event.origin === pageOrigin) return event;
    } catch (e) {}
    var copy = Object.create(event);
    Object.defineProperty(copy, "origin", { value: pageOrigin });
    return copy;
  }
  function relabelling(listener) {
    if (typeof listener === "function") {
      return function (event) { return listener.call(this, relabel(event)); };
    }
    if (listener && typeof listener.handleEvent === "function") {
      return function (event) { return listener.handleEvent(relabel(event)); };
    }
    return listener;
  }
  var wrapped = typeof WeakMap === "function" ? new WeakMap() : null;
  var nativeAdd = window.addEventListener;
  var nativeRemove = window.removeEventListener;
  if (wrapped && nativeAdd && nativeRemove) {
    window.addEventListener = function (type, listener, options) {
      if (type === "message" && listener && (typeof listener === "function" || typeof listener === "object")) {
        var wrapper = wrapped.get(listener);
        if (!wrapper) {
          wrapper = relabelling(listener);
          wrapped.set(listener, wrapper);
        }
        return nativeAdd.call(window, type, wrapper, options);
      }
      return nativeAdd.apply(window, arguments);
    };
    window.removeEventListener = function (type, listener, options) {
      if (type === "message" && listener && wrapped.has(listener)) {
        return nativeRemove.call(window, type, wrapped.get(listener), options);
      }
      return nativeRemove.apply(window, arguments);
    };
  }
  var onMessage = null;
  try {
    Object.defineProperty(window, "onmessage", {
      configurable: true,
      enumerable: true,
      get: function () { return onMessage; },
      set: function (handler) {
        if (onMessage && nativeRemove) nativeRemove.call(window, "message", onMessage.__termixWrapper);
        onMessage = typeof handler === "function" ? handler : null;
        if (onMessage && nativeAdd) {
          onMessage.__termixWrapper = relabelling(onMessage);
          nativeAdd.call(window, "message", onMessage.__termixWrapper);
        }
      }
    });
  } catch (ignored) {}

  // Uploads: X-Upload-* headers ride a query parameter, without credentials.
  var XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR) {
    var open = XHR.open, send = XHR.send, setHeader = XHR.setRequestHeader;
    var sameHost = function (url) {
      try { return new URL(String(url), location.href).host === location.host; } catch (e) { return false; }
    };
    XHR.open = function (method, url) {
      this.__termix = { method: method, url: String(url), async: arguments.length < 3 ? true : !!arguments[2], headers: [], moved: null };
      return open.apply(this, arguments);
    };
    XHR.setRequestHeader = function (name, value) {
      var t = this.__termix;
      if (t && sameHost(t.url) && /^x-upload-/i.test(String(name))) {
        t.moved = t.moved || {};
        t.moved[String(name).toLowerCase()] = String(value);
        return;
      }
      if (t) t.headers.push([name, value]);
      return setHeader.call(this, name, value);
    };
    XHR.send = function (body) {
      var t = this.__termix;
      if (t && sameHost(t.url)) {
        if (t.moved) {
          var u = new URL(t.url, location.href);
          var json = JSON.stringify(t.moved);
          u.searchParams.set("${MOVED_HEADERS_PARAM}", btoa(unescape(encodeURIComponent(json))));
          open.call(this, t.method, u.href, t.async);
          for (var i = 0; i < t.headers.length; i++) setHeader.call(this, t.headers[i][0], t.headers[i][1]);
        }
        try { this.withCredentials = false; } catch (e) {}
      }
      return send.call(this, body);
    };
  }
})();
`;
