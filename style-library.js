// StyleLibrary: the list of imported styles. Keeps each file's bytes (re-read on load, so reader fixes reach old
// imports), a summary for the list, favourites and per-style settings. No DOM.
//   new StyleLibrary(backend, read)   read(bytes, fileName) -> Style (StyleFiles.read by default)
//   await open()                      loads the list
//   await add(fileName, bytes, folder) -> { entry, duplicate }   throws the reader's Error for files it can't read
//   await addMany(files, onProgress)  files: [{ name, folder, bytes() -> Promise<Uint8Array> }]
//                                     -> { added: [entry], duplicates: [name], failed: [{ name, error }] }
//   list({ search, favorites, meter }) entries sorted by name
//   meters()                          the meters in the library, e.g. ['3/4', '4/4', '7/8']
//   totalBytes()                      the size of all the style files kept
//   await load(id) -> { entry, style }
//   await remove(id), setFavorite(id, on), setSettings(id, settings)
//   await clear()                     removes every style
//   Entry { id, name, fileName, folder, source, format, meter, tempo, sections: [ids], size, added, favorite,
//           settings, warnings: count }
// The same file imported twice (same bytes) is kept once: the id is a hash of the content.
// Backends: { list() -> [entry], bytes(id) -> Uint8Array, put(entry, bytes), update(entry), remove(id), clear() }, all
// returning Promises. memoryBackend() for tests, localBackend(storage) (base64 in localStorage, small) and
// idbBackend(indexedDB) for the page; StyleLibrary.openBest(window) picks IndexedDB when it works.
// Loaded as a classic script (window.Arranger.StyleLibrary) or with require() in Node (tests).
(function () {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const StyleFiles = isNode ? require('./style-files.js') : window.Arranger.StyleFiles;

  // FNV-1a over the bytes, plus the length: 'h1a2b3c4d-4718'.
  function contentId(bytes) {
    let h = 0x811C9DC5;
    for (let k = 0; k < bytes.length; k++) { h ^= bytes[k]; h = Math.imul(h, 0x01000193) >>> 0; }
    return 'h' + h.toString(16).padStart(8, '0') + '-' + bytes.length;
  }
  const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[._~-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const copy = (e) => JSON.parse(JSON.stringify(e));

  class StyleLibrary {
    constructor(backend, read) {
      this.backend = backend;
      this.read = read || StyleFiles.read;
      this.entries = {};
    }
    async open() {
      const all = await this.backend.list();
      this.entries = {};
      all.forEach((e) => { this.entries[e.id] = e; });
      return this;
    }
    get size() { return Object.keys(this.entries).length; }
    totalBytes() { return Object.keys(this.entries).reduce((sum, id) => sum + (this.entries[id].size || 0), 0); }

    async add(fileName, bytes, folder) {
      const id = contentId(bytes);
      if (this.entries[id]) return { entry: this.entries[id], duplicate: true };
      const style = this.read(bytes, fileName);           // throws for files that aren't styles
      const entry = {
        id, name: style.name, fileName, folder: folder || '', source: style.source, format: style.format,
        meter: style.timeSig[0] + '/' + style.timeSig[1], tempo: Math.round(style.tempo), sections: style.order.slice(),
        size: bytes.length, added: Date.now(), favorite: false, settings: {}, warnings: style.warnings.length,
      };
      await this.backend.put(entry, bytes);
      this.entries[id] = entry;
      return { entry, duplicate: false };
    }

    async addMany(files, onProgress) {
      const out = { added: [], duplicates: [], failed: [] };
      for (let k = 0; k < files.length; k++) {
        const f = files[k];
        try {
          const r = await this.add(f.name, await f.bytes(), f.folder);
          if (r.duplicate) out.duplicates.push(f.name); else out.added.push(r.entry);
        } catch (e) { out.failed.push({ name: f.name, error: e && e.message ? e.message : String(e) }); }
        if (onProgress) onProgress(k + 1, files.length);
      }
      return out;
    }

    list(filter) {
      const f = filter || {};
      const words = f.search ? norm(f.search).split(' ') : [];
      return Object.keys(this.entries).map((id) => this.entries[id])
        .filter((e) => !f.favorites || e.favorite)
        .filter((e) => !f.meter || e.meter === f.meter)
        .filter((e) => {
          if (!words.length) return true;
          const hay = norm(`${e.name} ${e.fileName} ${e.folder} ${e.meter} ${e.source}`);
          return words.every((w) => hay.indexOf(w) >= 0);
        })
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id));
    }
    meters() {
      const set = {};
      Object.keys(this.entries).forEach((id) => { set[this.entries[id].meter] = true; });
      return Object.keys(set).sort((a, b) => {
        const [an, ad] = a.split('/').map(Number), [bn, bd] = b.split('/').map(Number);
        return ad - bd || an - bn;
      });
    }

    async load(id) {
      const entry = this.entries[id];
      if (!entry) throw new Error('That style is no longer in the library.');
      const bytes = await this.backend.bytes(id);
      if (!bytes) throw new Error('The style\'s file is missing from storage.');
      return { entry, style: this.read(bytes, entry.fileName) };
    }
    async remove(id) {
      if (!this.entries[id]) return;
      await this.backend.remove(id);
      delete this.entries[id];
    }
    async clear() {
      await this.backend.clear();
      this.entries = {};
    }
    async setFavorite(id, on) { return this.change(id, (e) => { e.favorite = !!on; }); }
    async setSettings(id, settings) { return this.change(id, (e) => { e.settings = copy(settings || {}); }); }
    async change(id, fn) {
      const e = this.entries[id];
      if (!e) return null;
      fn(e);
      await this.backend.update(e);
      return e;
    }
  }

  // ---------- backends ----------
  function memoryBackend() {
    const meta = {}, files = {};
    return {
      kind: 'memory',
      list: async () => Object.keys(meta).map((id) => copy(meta[id])),
      bytes: async (id) => (files[id] ? files[id].slice() : null),
      put: async (e, b) => { meta[e.id] = copy(e); files[e.id] = Uint8Array.from(b); },
      update: async (e) => { if (meta[e.id]) meta[e.id] = copy(e); },
      remove: async (id) => { delete meta[id]; delete files[id]; },
      clear: async () => { Object.keys(meta).forEach((id) => { delete meta[id]; delete files[id]; }); },
    };
  }

  // localStorage: the list under one key, each file under its own as base64. Holds roughly 50-100 styles.
  function localBackend(storage, prefix) {
    const P = prefix || 'arranger-lib';
    const readList = () => { try { return JSON.parse(storage.getItem(P) || '[]'); } catch (e) { return []; } };
    const writeList = (l) => storage.setItem(P, JSON.stringify(l));
    const b64 = (bytes) => {
      let s = '';
      for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(k, k + 0x8000)));
      return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'latin1').toString('base64');
    };
    const unb64 = (s) => {
      const bin = typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('latin1');
      const out = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
      return out;
    };
    return {
      kind: 'localStorage',
      list: async () => readList(),
      bytes: async (id) => { const s = storage.getItem(P + ':' + id); return s ? unb64(s) : null; },
      put: async (e, bytes) => {
        storage.setItem(P + ':' + e.id, b64(bytes));                 // throws when storage is full
        try { writeList(readList().filter((x) => x.id !== e.id).concat([e])); } catch (err) { storage.removeItem(P + ':' + e.id); throw err; }
      },
      update: async (e) => writeList(readList().map((x) => (x.id === e.id ? e : x))),
      remove: async (id) => { storage.removeItem(P + ':' + id); writeList(readList().filter((x) => x.id !== id)); },
      clear: async () => { readList().forEach((x) => storage.removeItem(P + ':' + x.id)); writeList([]); },
    };
  }

  // IndexedDB: 'meta' (entries) and 'files' (bytes), so opening the list doesn't read every file.
  function idbBackend(idb, name) {
    const DB = name || 'arranger';
    let dbp = null;
    const db = () => dbp || (dbp = new Promise((resolve, reject) => {
      const req = idb.open(DB, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB failed'));
      req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
    }));
    const run = (stores, mode, fn) => db().then((d) => new Promise((resolve, reject) => {
      const tx = d.transaction(stores, mode);
      let result;
      fn(tx, (r) => { result = r; });
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    }));
    const get = (req, set, map) => { req.onsuccess = () => set(map ? map(req.result) : req.result); };
    return {
      kind: 'IndexedDB',
      list: () => run(['meta'], 'readonly', (tx, set) => get(tx.objectStore('meta').getAll(), set)),
      bytes: (id) => run(['files'], 'readonly', (tx, set) => get(tx.objectStore('files').get(id), set, (r) => (r ? new Uint8Array(r) : null))),
      put: (e, bytes) => run(['meta', 'files'], 'readwrite', (tx) => {
        tx.objectStore('files').put(Uint8Array.from(bytes).buffer, e.id);
        tx.objectStore('meta').put(copy(e));
      }),
      update: (e) => run(['meta'], 'readwrite', (tx) => { tx.objectStore('meta').put(copy(e)); }),
      remove: (id) => run(['meta', 'files'], 'readwrite', (tx) => { tx.objectStore('meta').delete(id); tx.objectStore('files').delete(id); }),
      clear: () => run(['meta', 'files'], 'readwrite', (tx) => { tx.objectStore('meta').clear(); tx.objectStore('files').clear(); }),
    };
  }

  // The page's library: IndexedDB if it opens, else localStorage, else memory (nothing kept after a reload).
  StyleLibrary.openBest = async function (win) {
    const w = win || (typeof window !== 'undefined' ? window : {});
    const tries = [];
    if (w.indexedDB) tries.push(() => idbBackend(w.indexedDB));
    try { if (w.localStorage) tries.push(() => localBackend(w.localStorage)); } catch (e) { /* blocked */ }
    tries.push(() => memoryBackend());
    for (let k = 0; k < tries.length; k++) {
      try { return await new StyleLibrary(tries[k]()).open(); } catch (e) { /* next */ }
    }
    return new StyleLibrary(memoryBackend()).open();
  };
  StyleLibrary.contentId = contentId;
  StyleLibrary.memoryBackend = memoryBackend;
  StyleLibrary.localBackend = localBackend;
  StyleLibrary.idbBackend = idbBackend;

  if (isNode) module.exports = StyleLibrary;
  else (window.Arranger = window.Arranger || {}).StyleLibrary = StyleLibrary;
}());
