// The arranger's service worker: keeps the page's own files on the device, so the installed app (manifest.json)
// opens and plays with no internet. Registered by ui/app.js on pianosnake.com / github.io only (and with ?sw for a
// test); nowhere else (the iPad over http, the MIDI Charmer AUv3, desktop Chrome on localhost) does anything change.
//
// Every same-origin GET is answered from the cache when it's there:
//   - A file with a version (?v=…, how index.html and the scripts ask for each other) never changes: cache only. When
//     a new version of a file is kept, its older ones are deleted.
//   - Everything else (the page itself, synth/lib/, defaults/, the manifest and icons) is checked in the background
//     each time, and the new copy is used the next time. A new index.html (or any page) is only kept once the
//     files it names are kept too, so an update can't leave a page offline that asks for files it doesn't have.
//   - Not in the cache: the network, and the answer is kept. No network, or not found there: any version of that file.
// Bump CACHE only when this file's own way of working changes (the files themselves update by themselves).
'use strict';

const CACHE = 'arranger-1';   // the cache's name: keep it (a new name empties the phone's copy)
const SCOPE = self.registration.scope;
// Kept at install, besides what index.html names (which includes the synth's frame and libraries, the built-in bank
// and styles).
const EXTRA = ['manifest.json', 'images/icon-192.png', 'images/icon-512.png'];

const versioned = (url) => /[?&]v=/.test(new URL(url).search);
const sameOrigin = (url) => new URL(url).origin === self.location.origin;
const keepable = (res) => res && res.ok && res.type === 'basic';

// The relative files a page names (src="…", href="…"), as full addresses: not data:, other sites or anchors.
function namedIn(html, base) {
  const out = [];
  const re = /\b(?:src|href)\s*=\s*"([^"#]+)"/gi;
  let m;
  while ((m = re.exec(html))) {
    const ref = m[1].trim();
    if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) continue;
    const url = new URL(ref, base).href;
    if (url.startsWith(SCOPE)) out.push(url);
  }
  return out;
}

// Keep one answer. A versioned file's older versions go.
async function keep(cache, url, res) {
  await cache.put(url, res);
  if (!versioned(url)) return;
  const path = new URL(url).pathname;
  const keys = await cache.keys();
  await Promise.all(keys.filter((k) => k.url !== url && new URL(k.url).pathname === path && versioned(k.url))
    .map((k) => cache.delete(k)));
}

// The same file as the one kept (by its ETag or date): not written again (the bank is 3 MB, checked each start).
function same(a, b) {
  if (!a || !b) return false;
  const tag = (r) => r.headers.get('etag'), date = (r) => r.headers.get('last-modified');
  return tag(a) ? tag(a) === tag(b) : !!date(a) && date(a) === date(b);
}

// Fetch a file and keep it. A page's named files are fetched and kept first (those not kept yet).
// 'no-cache': always asked of the server (a cheap 304 when nothing changed), never the browser's own short-term copy,
// which would hold an update back for up to 10 minutes on GitHub Pages.
async function refresh(cache, url, kept) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!keepable(res) || same(res, kept)) return res;
  if ((res.headers.get('content-type') || '').includes('text/html')) {
    const html = await res.clone().text();
    const missing = [];
    for (const ref of namedIn(html, url)) if (!(await cache.match(ref))) missing.push(ref);
    await Promise.all(missing.map((ref) => fetch(ref, { cache: 'no-cache' }).then((r) => (keepable(r) ? keep(cache, ref, r) : null))));
  }
  await keep(cache, url, res.clone());
  return res;
}

self.addEventListener('install', (ev) => {
  ev.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await refresh(cache, SCOPE);
    await Promise.all(EXTRA.map((f) => new URL(f, SCOPE).href).map(async (url) => {
      if (await cache.match(url)) return;
      try { const r = await fetch(url); if (keepable(r)) await keep(cache, url, r); } catch (e) { /* next time */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('arranger-') && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET' || !sameOrigin(req.url) || !req.url.startsWith(SCOPE)) return;
  if (req.headers.has('range')) return;
  // The page itself, however it was opened (/arranger/, index.html, ?sw): one copy. Only the page: a frame with an
  // address of its own would be a navigation too.
  const path = new URL(req.url).pathname, top = new URL(SCOPE).pathname;
  const url = req.mode === 'navigate' && (path === top || path === top + 'index.html') ? SCOPE : req.url;
  ev.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) {
      if (!versioned(url)) ev.waitUntil(refresh(cache, url, hit).catch(() => {}));
      return hit;
    }
    // Not kept: the network. If that fails, or the file is gone from the site (an old page, still open once after an
    // update, asked for a file the new version deleted: synth/sf-frame.html, 2026-11-27), any kept version of it.
    let res;
    try { res = await refresh(cache, url); } catch (e) { res = null; }
    if (res && res.ok) return res;
    const any = await cache.match(url, { ignoreSearch: true });
    if (any) return any;
    if (res) return res;
    throw new Error('offline: ' + url);
  })());
});
