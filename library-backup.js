// LibraryBackup: the whole style library as one zip file, and back. No DOM.
//   backup(library, filter?) -> Promise<Uint8Array>    a zip with (filter: StyleLibrary.list's, e.g. { favorites: true }):
//     - library.json: { app: 'arranger', version: 1, exported, styles: [{ file, fileName, folder, favorite,
//       settings, added }] }
//     - each style file under styles/<folder>/<file name>, so the zip is also usable as a plain folder of styles
//   restore(library, zipBytes, onProgress) -> Promise<{ added, duplicates, failed, settings }>
//     Adds every style in the zip. With a library.json, favourites, per-style settings (tempo, beat groups) and the
//     date added come back too. A style that is already in the library keeps its own settings, but gets a
//     favourite star the backup had. Without a library.json (any zip of .sty / .stl files, e.g. a style pack),
//     its files are imported with their zip folder as the folder.
// Loaded as a classic script (window.Arranger.LibraryBackup) or with require() in Node (tests).
(function () {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const Zip = isNode ? require('./zip.js') : window.Arranger.Zip;

  const MANIFEST = 'library.json';
  const safe = (s) => String(s || '').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').trim();

  async function backup(library, filter) {
    const entries = library.list(filter);
    const files = [], styles = [], used = {};
    for (let k = 0; k < entries.length; k++) {
      const e = entries[k];
      const bytes = await library.backend.bytes(e.id);
      if (!bytes) continue;
      const dir = 'styles/' + (safe(e.folder) ? safe(e.folder) + '/' : '');
      const base = safe(e.fileName) || (e.id + (e.source === 'stl' ? '.stl' : '.sty'));
      let file = dir + base;
      // Two different styles with the same file name in a folder: number the second.
      for (let n = 2; used[file.toLowerCase()]; n++) file = dir + base.replace(/(\.[^.]*)?$/, (ext) => ` (${n})${ext || ''}`);
      used[file.toLowerCase()] = true;
      files.push({ name: file, data: bytes, date: new Date(e.added || Date.now()) });
      styles.push({ file, fileName: e.fileName, folder: e.folder || '', favorite: !!e.favorite, settings: e.settings || {}, added: e.added });
    }
    const manifest = { app: 'arranger', version: 1, exported: new Date().toISOString(), styles };
    files.unshift({ name: MANIFEST, data: new TextEncoder().encode(JSON.stringify(manifest, null, 1)), date: new Date() });
    return Zip.zip(files);
  }

  async function restore(library, bytes, onProgress) {
    const entries = await Zip.unzip(bytes);
    const byName = {};
    entries.forEach((x) => { byName[x.name] = x; });
    let manifest = null;
    if (byName[MANIFEST]) {
      try { manifest = JSON.parse(new TextDecoder().decode(byName[MANIFEST].data)); } catch (e) { throw new Error('The backup\'s library.json is damaged.'); }
      if (!manifest || manifest.app !== 'arranger' || !Array.isArray(manifest.styles)) throw new Error('This zip\'s library.json isn\'t an arranger backup.');
    }
    const items = [];
    if (manifest) {
      manifest.styles.forEach((s) => { if (byName[s.file]) items.push({ entry: byName[s.file], meta: s }); });
    } else {
      entries.filter((x) => /\.(sty|stl|sth|prs|bcs|sst)$/i.test(x.name)).forEach((x) => {
        const parts = x.name.split('/');
        items.push({ entry: x, meta: { fileName: parts[parts.length - 1], folder: parts.length > 1 ? parts[parts.length - 2] : '' } });
      });
    }
    if (!items.length) throw new Error('No styles in this zip.');
    const out = { added: [], duplicates: [], failed: [], settings: 0 };
    for (let k = 0; k < items.length; k++) {
      const { entry, meta } = items[k];
      try {
        const r = await library.add(meta.fileName || entry.name.split('/').pop(), entry.data, meta.folder || '');
        if (r.duplicate) {
          out.duplicates.push(meta.fileName);
          if (meta.favorite && !r.entry.favorite) await library.setFavorite(r.entry.id, true);
        } else {
          out.added.push(r.entry);
          const hasSettings = meta.settings && Object.keys(meta.settings).length;
          if (meta.favorite || meta.added) {
            await library.change(r.entry.id, (e) => {
              e.favorite = !!meta.favorite;
              if (meta.added) e.added = meta.added;
            });
          }
          // Settings go through setSettings: they belong to the style's music hash (and its copies).
          if (hasSettings) { await library.setSettings(r.entry.id, meta.settings); out.settings++; }
        }
      } catch (e) { out.failed.push({ name: meta.fileName || entry.name, error: e && e.message ? e.message : String(e) }); }
      if (onProgress) onProgress(k + 1, items.length);
    }
    return out;
  }

  const LibraryBackup = { backup, restore, MANIFEST };
  if (isNode) module.exports = LibraryBackup;
  else (window.Arranger = window.Arranger || {}).LibraryBackup = LibraryBackup;
}());
