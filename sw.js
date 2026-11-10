const CACHE = 'concept-quiz-v13';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'notes.js', 'cloze.js', 'fsrs.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
const DATA = ['questions.json', 'questions.enc']; // どちらか一方だけがある
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(async c => { await c.addAll(FILES); await Promise.all(DATA.map(f => c.add(f).catch(() => {}))); }).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
// 保存済みを先に返し、裏で最新を取り直す(次に開いたとき反映)
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, {ignoreSearch: true});
    const net = fetch(e.request).then(r => { if (r && r.ok) c.put(e.request, r.clone()); return r; });
    if (hit) { net.catch(() => {}); return hit; }
    return net;
  }));
});
