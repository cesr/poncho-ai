// ---------------------------------------------------------------------------
// Isolate Polyfills – standard Web/Node.js API layer injected into V8 isolates.
//
// Wraps the __poncho_* internal bindings into standard APIs so agent code
// can use fetch(), fs.readFileSync(), Buffer, etc. naturally.
//
// Execution order in the isolate:
//   1. Runtime preamble (console capture)
//   2. Binding wrappers (__poncho_fs_read, __poncho_fetch, etc.)
//   3. This polyfill layer (standard APIs)
//   4. Library preamble (bundled npm packages)
//   5. User code
// ---------------------------------------------------------------------------

/**
 * Returns JavaScript source for the polyfill layer.
 * `hasNetwork` controls whether the fetch() polyfill is included.
 */
export function buildPolyfillPreamble(hasNetwork: boolean): string {
  return [
    POLYFILL_TEXT_ENCODING,
    POLYFILL_ATOB_BTOA,
    POLYFILL_BUFFER,
    POLYFILL_PATH,
    POLYFILL_FS,
    hasNetwork ? POLYFILL_FETCH : POLYFILL_FETCH_STUB,
    POLYFILL_TIMERS,
    POLYFILL_CRYPTO,
    POLYFILL_CONSOLE_EXTRAS,
    POLYFILL_BLOB,
    POLYFILL_STRUCTUREDCLONE,
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// TextEncoder / TextDecoder (V8 isolates don't have these)
// ---------------------------------------------------------------------------

const POLYFILL_TEXT_ENCODING = `
// --- TextEncoder / TextDecoder polyfill ---
(function() {
  if (typeof globalThis.TextEncoder === "undefined") {
    globalThis.TextEncoder = class TextEncoder {
      encode(str) {
        str = String(str);
        const buf = [];
        for (let i = 0; i < str.length; i++) {
          let code = str.charCodeAt(i);
          if (code < 0x80) {
            buf.push(code);
          } else if (code < 0x800) {
            buf.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
          } else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < str.length) {
            const next = str.charCodeAt(i + 1);
            if (next >= 0xDC00 && next <= 0xDFFF) {
              code = ((code - 0xD800) << 10) + (next - 0xDC00) + 0x10000;
              i++;
              buf.push(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 0x3F), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
            }
          } else {
            buf.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
          }
        }
        return new Uint8Array(buf);
      }
    };
  }

  if (typeof globalThis.TextDecoder === "undefined") {
    globalThis.TextDecoder = class TextDecoder {
      decode(input) {
        if (!input || input.length === 0) return "";
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        let result = "";
        for (let i = 0; i < bytes.length;) {
          const b = bytes[i];
          if (b < 0x80) {
            result += String.fromCharCode(b);
            i++;
          } else if ((b & 0xE0) === 0xC0) {
            result += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i + 1] & 0x3F));
            i += 2;
          } else if ((b & 0xF0) === 0xE0) {
            result += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F));
            i += 3;
          } else if ((b & 0xF8) === 0xF0) {
            const code = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
            const adjusted = code - 0x10000;
            result += String.fromCharCode(0xD800 + (adjusted >> 10), 0xDC00 + (adjusted & 0x3FF));
            i += 4;
          } else {
            result += "\\uFFFD";
            i++;
          }
        }
        return result;
      }
    };
  }
})();
`;

// ---------------------------------------------------------------------------
// Buffer
// ---------------------------------------------------------------------------

const POLYFILL_BUFFER = `
// --- Buffer polyfill ---
(function() {
  if (typeof globalThis.Buffer !== "undefined") return;

  class Buffer extends Uint8Array {
    static from(input, encodingOrOffset, length) {
      if (typeof input === "string") {
        const encoding = (encodingOrOffset || "utf-8").toLowerCase();
        if (encoding === "base64") {
          const bin = atob(input);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          return Object.setPrototypeOf(arr, Buffer.prototype);
        }
        if (encoding === "hex") {
          const arr = new Uint8Array(input.length / 2);
          for (let i = 0; i < input.length; i += 2)
            arr[i / 2] = parseInt(input.slice(i, i + 2), 16);
          return Object.setPrototypeOf(arr, Buffer.prototype);
        }
        // utf-8 default
        const encoded = new TextEncoder().encode(input);
        return Object.setPrototypeOf(encoded, Buffer.prototype);
      }
      if (input instanceof ArrayBuffer) {
        const arr = new Uint8Array(input, encodingOrOffset, length);
        return Object.setPrototypeOf(arr, Buffer.prototype);
      }
      if (ArrayBuffer.isView(input)) {
        const arr = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        return Object.setPrototypeOf(arr, Buffer.prototype);
      }
      if (Array.isArray(input)) {
        const arr = new Uint8Array(input);
        return Object.setPrototypeOf(arr, Buffer.prototype);
      }
      throw new TypeError("Buffer.from: unsupported input type");
    }

    static alloc(size, fill) {
      const arr = new Uint8Array(size);
      if (fill !== undefined) {
        const fillByte = typeof fill === "number" ? fill : (typeof fill === "string" ? fill.charCodeAt(0) : 0);
        arr.fill(fillByte);
      }
      return Object.setPrototypeOf(arr, Buffer.prototype);
    }

    static allocUnsafe(size) { return Buffer.alloc(size); }

    static concat(list, totalLength) {
      if (!totalLength) totalLength = list.reduce((s, b) => s + b.length, 0);
      const result = Buffer.alloc(totalLength);
      let offset = 0;
      for (const buf of list) {
        result.set(buf, offset);
        offset += buf.length;
      }
      return result;
    }

    static isBuffer(obj) { return obj instanceof Buffer || obj instanceof Uint8Array; }

    toString(encoding) {
      encoding = (encoding || "utf-8").toLowerCase();
      if (encoding === "base64") {
        let bin = "";
        for (let i = 0; i < this.length; i++) bin += String.fromCharCode(this[i]);
        return btoa(bin);
      }
      if (encoding === "hex") {
        return Array.from(this).map(b => b.toString(16).padStart(2, "0")).join("");
      }
      return new TextDecoder().decode(this);
    }

    toJSON() {
      return { type: "Buffer", data: Array.from(this) };
    }

    write(string, offset, length, encoding) {
      offset = offset || 0;
      const encoded = Buffer.from(string, encoding || "utf-8");
      const bytesToCopy = Math.min(encoded.length, length || this.length - offset);
      this.set(encoded.subarray(0, bytesToCopy), offset);
      return bytesToCopy;
    }

    copy(target, targetStart, sourceStart, sourceEnd) {
      targetStart = targetStart || 0;
      sourceStart = sourceStart || 0;
      sourceEnd = sourceEnd || this.length;
      const slice = this.subarray(sourceStart, sourceEnd);
      target.set(slice, targetStart);
      return slice.length;
    }

    equals(other) {
      if (this.length !== other.length) return false;
      for (let i = 0; i < this.length; i++) {
        if (this[i] !== other[i]) return false;
      }
      return true;
    }

    slice(start, end) {
      const sliced = Uint8Array.prototype.slice.call(this, start, end);
      return Object.setPrototypeOf(sliced, Buffer.prototype);
    }
  }

  globalThis.Buffer = Buffer;
})();
`;

// ---------------------------------------------------------------------------
// atob / btoa
// ---------------------------------------------------------------------------

const POLYFILL_ATOB_BTOA = `
// --- atob / btoa polyfill ---
(function() {
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const B64_LOOKUP = new Uint8Array(128);
  for (let i = 0; i < B64.length; i++) B64_LOOKUP[B64.charCodeAt(i)] = i;

  if (typeof globalThis.atob === "undefined") {
    globalThis.atob = function(input) {
      input = String(input).replace(/[\\s=]+/g, "");
      let output = "";
      let bits = 0, collected = 0;
      for (let i = 0; i < input.length; i++) {
        bits = (bits << 6) | B64_LOOKUP[input.charCodeAt(i)];
        collected += 6;
        if (collected >= 8) {
          collected -= 8;
          output += String.fromCharCode((bits >> collected) & 0xFF);
        }
      }
      return output;
    };
  }

  if (typeof globalThis.btoa === "undefined") {
    globalThis.btoa = function(input) {
      input = String(input);
      let output = "";
      for (let i = 0; i < input.length; i += 3) {
        const a = input.charCodeAt(i);
        const b = i + 1 < input.length ? input.charCodeAt(i + 1) : 0;
        const c = i + 2 < input.length ? input.charCodeAt(i + 2) : 0;
        output += B64[a >> 2];
        output += B64[((a & 3) << 4) | (b >> 4)];
        output += i + 1 < input.length ? B64[((b & 15) << 2) | (c >> 6)] : "=";
        output += i + 2 < input.length ? B64[c & 63] : "=";
      }
      return output;
    };
  }
})();
`;

// ---------------------------------------------------------------------------
// path module
// ---------------------------------------------------------------------------

const POLYFILL_PATH = `
// --- path module polyfill ---
(function() {
  const path = {
    sep: "/",
    join: function() {
      const parts = Array.from(arguments).filter(Boolean);
      return path.normalize(parts.join("/"));
    },
    resolve: function() {
      let resolved = "";
      for (let i = arguments.length - 1; i >= 0; i--) {
        const part = arguments[i];
        if (!part) continue;
        resolved = part + (resolved ? "/" + resolved : "");
        if (part.startsWith("/")) break;
      }
      return path.normalize(resolved.startsWith("/") ? resolved : "/" + resolved);
    },
    normalize: function(p) {
      const parts = p.split("/");
      const result = [];
      for (const part of parts) {
        if (part === "." || part === "") continue;
        if (part === ".." && result.length > 0 && result[result.length - 1] !== "..") {
          result.pop();
        } else {
          result.push(part);
        }
      }
      return (p.startsWith("/") ? "/" : "") + result.join("/");
    },
    basename: function(p, ext) {
      const base = p.split("/").filter(Boolean).pop() || "";
      if (ext && base.endsWith(ext)) return base.slice(0, -ext.length);
      return base;
    },
    dirname: function(p) {
      const parts = p.split("/").filter(Boolean);
      parts.pop();
      return (p.startsWith("/") ? "/" : "") + parts.join("/") || ".";
    },
    extname: function(p) {
      const base = path.basename(p);
      const dot = base.lastIndexOf(".");
      return dot > 0 ? base.slice(dot) : "";
    },
    isAbsolute: function(p) { return p.startsWith("/"); },
    parse: function(p) {
      return {
        root: p.startsWith("/") ? "/" : "",
        dir: path.dirname(p),
        base: path.basename(p),
        ext: path.extname(p),
        name: path.basename(p, path.extname(p)),
      };
    },
  };
  globalThis.__modules = globalThis.__modules || {};
  globalThis.__modules.path = path;
  globalThis.path = path;
})();
`;

// ---------------------------------------------------------------------------
// fs module (wraps __poncho_fs_* bindings)
// ---------------------------------------------------------------------------

const POLYFILL_FS = `
// --- fs module polyfill ---
(function() {
  function _b64ToUint8(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  function _uint8ToB64(u8) {
    let bin = "";
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    return btoa(bin);
  }

  function _toBuffer(data, encoding) {
    if (typeof data === "string") return Buffer.from(data, encoding || "utf-8");
    if (data instanceof Uint8Array) return data;
    return Buffer.from(String(data), "utf-8");
  }

  const fs = {
    // --- Async API ---
    readFile: async function(path, options) {
      const encoding = typeof options === "string" ? options : options?.encoding;
      if (!encoding || encoding === "buffer") {
        const b64 = await __poncho_fs_read_binary({ path });
        return Buffer.from(_b64ToUint8(b64));
      }
      return await __poncho_fs_read({ path });
    },

    writeFile: async function(path, data, options) {
      const encoding = typeof options === "string" ? options : options?.encoding;
      if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
        const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        await __poncho_fs_write_binary({ path, content: _uint8ToB64(u8) });
        return;
      }
      if (encoding === "base64") {
        await __poncho_fs_write_binary({ path, content: data });
        return;
      }
      await __poncho_fs_write({ path, content: String(data) });
    },

    readdir: async function(path) {
      return await __poncho_fs_list({ path: path || "/" });
    },

    mkdir: async function(path, options) {
      await __poncho_fs_mkdir({ path });
    },

    stat: async function(path) {
      const s = await __poncho_fs_stat({ path });
      return {
        isFile: function() { return s.isFile; },
        isDirectory: function() { return s.isDirectory; },
        size: s.size,
        mtime: new Date(s.mtime),
      };
    },

    unlink: async function(path) {
      await __poncho_fs_delete({ path });
    },

    rm: async function(path) {
      await __poncho_fs_delete({ path });
    },

    exists: async function(path) {
      return await __poncho_fs_exists({ path });
    },

    // --- Sync-style API (actually async under the hood, but works with await) ---
    readFileSync: function(path, options) {
      return fs.readFile(path, options);
    },

    writeFileSync: function(path, data, options) {
      return fs.writeFile(path, data, options);
    },

    readdirSync: function(path) { return fs.readdir(path); },
    mkdirSync: function(path, options) { return fs.mkdir(path, options); },
    statSync: function(path) { return fs.stat(path); },
    unlinkSync: function(path) { return fs.unlink(path); },
    existsSync: function(path) { return fs.exists(path); },
    rmSync: function(path) { return fs.rm(path); },

    promises: {},
  };

  // fs.promises mirrors the async API
  for (const key of Object.keys(fs)) {
    if (typeof fs[key] === "function" && key !== "promises") {
      fs.promises[key] = fs[key];
    }
  }

  globalThis.__modules = globalThis.__modules || {};
  globalThis.__modules.fs = fs;
  globalThis.__modules["fs/promises"] = fs.promises;
  globalThis.__modules["node:fs"] = fs;
  globalThis.__modules["node:fs/promises"] = fs.promises;
  globalThis.fs = fs;
})();
`;

// ---------------------------------------------------------------------------
// fetch() polyfill (standard Web API wrapping __poncho_fetch)
// ---------------------------------------------------------------------------

const POLYFILL_FETCH = `
// --- fetch polyfill ---
(function() {
  class Headers {
    constructor(init) {
      this._map = {};
      if (init) {
        const entries = typeof init.entries === "function"
          ? Array.from(init.entries())
          : Object.entries(init);
        for (const [k, v] of entries) this._map[k.toLowerCase()] = String(v);
      }
    }
    get(name) { return this._map[name.toLowerCase()] ?? null; }
    set(name, value) { this._map[name.toLowerCase()] = String(value); }
    has(name) { return name.toLowerCase() in this._map; }
    delete(name) { delete this._map[name.toLowerCase()]; }
    forEach(cb) { for (const [k, v] of Object.entries(this._map)) cb(v, k, this); }
    entries() { return Object.entries(this._map)[Symbol.iterator](); }
    keys() { return Object.keys(this._map)[Symbol.iterator](); }
    values() { return Object.values(this._map)[Symbol.iterator](); }
  }

  class Response {
    constructor(result, binary) {
      this.status = result.status;
      this.statusText = result.statusText || "";
      this.ok = result.status >= 200 && result.status < 300;
      this.headers = new Headers(result.headers);
      this._body = result.body;
      this._binary = binary;
      this._consumed = false;
    }

    _checkConsumed() {
      if (this._consumed) throw new TypeError("Body already consumed");
      this._consumed = true;
    }

    async text() {
      this._checkConsumed();
      if (this._binary) {
        // Decode base64 → binary string → UTF-8
        const bytes = _fetchB64ToUint8(this._body);
        return new TextDecoder().decode(bytes);
      }
      return this._body;
    }

    async json() {
      const text = await this.text();
      return JSON.parse(text);
    }

    async arrayBuffer() {
      this._checkConsumed();
      if (this._binary) {
        const bytes = _fetchB64ToUint8(this._body);
        return bytes.buffer;
      }
      return new TextEncoder().encode(this._body).buffer;
    }

    async blob() {
      const ab = await this.arrayBuffer();
      const type = this.headers.get("content-type") || "";
      return new Blob([ab], { type });
    }
  }

  function _fetchB64ToUint8(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  globalThis.fetch = async function(input, init) {
    const url = typeof input === "string" ? input : (input?.url || String(input));
    const method = init?.method || "GET";
    const headers = {};
    if (init?.headers) {
      const entries = typeof init.headers.entries === "function"
        ? Array.from(init.headers.entries())
        : Object.entries(init.headers);
      for (const [k, v] of entries) headers[k] = String(v);
    }
    const body = init?.body ? String(init.body) : undefined;

    // Always fetch as binary to preserve data integrity
    const result = await __poncho_fetch({ url, method, headers, body, binary: true });
    return new Response(result, true);
  };

  globalThis.Headers = Headers;
  globalThis.Response = Response;
})();
`;

const POLYFILL_FETCH_STUB = `
// --- fetch stub (network not configured) ---
(function() {
  globalThis.fetch = async function() {
    throw new Error(
      "fetch() is not available. Enable network access in poncho.config.js:\\n" +
      "  network: { allowedUrls: [\\"https://...\\"]}\\n" +
      "  // or: network: { dangerouslyAllowAll: true }"
    );
  };
})();
`;

// ---------------------------------------------------------------------------
// Timers (setTimeout / clearTimeout / setInterval / clearInterval)
// ---------------------------------------------------------------------------

const POLYFILL_TIMERS = `
// --- Timers polyfill ---
(function() {
  let __timerId = 0;
  const __timers = new Map();

  globalThis.setTimeout = function(fn, delay) {
    const id = ++__timerId;
    const ms = Math.max(0, Number(delay) || 0);
    const start = Date.now();
    __timers.set(id, { fn, ms, start, type: "timeout" });
    // In the isolate, setTimeout returns the id but the callback is
    // executed via a polling mechanism in the async wrapper.
    // For simple cases (delay=0), we can use a microtask.
    if (ms === 0) {
      Promise.resolve().then(() => {
        if (__timers.has(id)) {
          __timers.delete(id);
          fn();
        }
      });
    }
    return id;
  };

  globalThis.clearTimeout = function(id) {
    __timers.delete(id);
  };

  globalThis.setInterval = function(fn, delay) {
    const id = ++__timerId;
    const ms = Math.max(1, Number(delay) || 1);
    const wrapper = () => {
      if (!__timers.has(id)) return;
      fn();
      if (__timers.has(id)) {
        globalThis.setTimeout(wrapper, ms);
      }
    };
    __timers.set(id, { fn: wrapper, ms, type: "interval" });
    globalThis.setTimeout(wrapper, ms);
    return id;
  };

  globalThis.clearInterval = function(id) {
    __timers.delete(id);
  };

  // queueMicrotask if not available
  if (typeof globalThis.queueMicrotask === "undefined") {
    globalThis.queueMicrotask = function(fn) { Promise.resolve().then(fn); };
  }
})();
`;

// ---------------------------------------------------------------------------
// crypto (randomUUID, getRandomValues)
// ---------------------------------------------------------------------------

const POLYFILL_CRYPTO = `
// --- crypto polyfill ---
(function() {
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) return;

  function getRandomValues(arr) {
    for (let i = 0; i < arr.length; i++) {
      arr[i] = Math.floor(Math.random() * 256);
    }
    return arr;
  }

  function randomUUID() {
    const bytes = new Uint8Array(16);
    getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }

  globalThis.crypto = {
    getRandomValues,
    randomUUID,
    subtle: {
      async digest(algorithm, data) {
        // Simple SHA-256 not feasible in pure JS without a library.
        // Provide a helpful error for now.
        throw new Error("crypto.subtle.digest is not available in the sandbox. Use a bundled library instead.");
      },
    },
  };
})();
`;

// ---------------------------------------------------------------------------
// console extras (table, time, timeEnd)
// ---------------------------------------------------------------------------

const POLYFILL_CONSOLE_EXTRAS = `
// --- console extras ---
(function() {
  const __timeLabels = new Map();

  console.table = function(data) {
    try {
      if (Array.isArray(data)) {
        const keys = data.length > 0 && typeof data[0] === "object" ? Object.keys(data[0]) : null;
        if (keys) {
          const header = ["(index)", ...keys].join("\\t");
          const rows = data.map((row, i) => [i, ...keys.map(k => row[k] ?? "")].join("\\t"));
          console.log(header + "\\n" + rows.join("\\n"));
          return;
        }
      }
      console.log(JSON.stringify(data, null, 2));
    } catch { console.log(String(data)); }
  };

  console.time = function(label) {
    __timeLabels.set(label || "default", Date.now());
  };

  console.timeEnd = function(label) {
    label = label || "default";
    const start = __timeLabels.get(label);
    if (start !== undefined) {
      __timeLabels.delete(label);
      console.log(label + ": " + (Date.now() - start) + "ms");
    }
  };

  console.timeLog = function(label) {
    label = label || "default";
    const start = __timeLabels.get(label);
    if (start !== undefined) {
      console.log(label + ": " + (Date.now() - start) + "ms");
    }
  };

  console.assert = function(condition) {
    if (!condition) {
      const args = Array.from(arguments).slice(1);
      console.error("Assertion failed:", ...args);
    }
  };

  console.dir = function(obj) { console.log(obj); };
  console.count = (function() {
    const counts = {};
    return function(label) {
      label = label || "default";
      counts[label] = (counts[label] || 0) + 1;
      console.log(label + ": " + counts[label]);
    };
  })();
})();
`;

// ---------------------------------------------------------------------------
// Blob
// ---------------------------------------------------------------------------

const POLYFILL_BLOB = `
// --- Blob polyfill ---
(function() {
  if (typeof globalThis.Blob !== "undefined") return;

  class Blob {
    constructor(parts, options) {
      this.type = (options && options.type) || "";
      const chunks = [];
      if (parts) {
        for (const part of parts) {
          if (typeof part === "string") {
            chunks.push(new TextEncoder().encode(part));
          } else if (part instanceof ArrayBuffer) {
            chunks.push(new Uint8Array(part));
          } else if (ArrayBuffer.isView(part)) {
            chunks.push(new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
          } else if (part instanceof Blob) {
            chunks.push(part._data);
          }
        }
      }
      let totalLen = 0;
      for (const c of chunks) totalLen += c.length;
      this._data = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of chunks) {
        this._data.set(c, offset);
        offset += c.length;
      }
      this.size = this._data.length;
    }

    async arrayBuffer() { return this._data.buffer.slice(this._data.byteOffset, this._data.byteOffset + this._data.byteLength); }
    async text() { return new TextDecoder().decode(this._data); }
    slice(start, end, type) {
      const sliced = this._data.slice(start || 0, end || this._data.length);
      const blob = new Blob([], { type: type || this.type });
      blob._data = sliced;
      blob.size = sliced.length;
      return blob;
    }
  }

  globalThis.Blob = Blob;
})();
`;

// ---------------------------------------------------------------------------
// structuredClone
// ---------------------------------------------------------------------------

const POLYFILL_STRUCTUREDCLONE = `
// --- structuredClone polyfill ---
(function() {
  if (typeof globalThis.structuredClone !== "undefined") return;
  globalThis.structuredClone = function(value) {
    return JSON.parse(JSON.stringify(value));
  };
})();
`;
