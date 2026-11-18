// 오프라인에서도 앱이 열리도록 화면 파일을 기기에 저장해 둔다.
// 화면 파일을 고치면 VERSION 을 올린다 (그래야 휴대폰이 새 파일을 받는다).
const VERSION = 'v5';
const SDK = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.10.0/+esm';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'voice.js', 'focus.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(async (c) => {
    await c.addAll(SHELL);
    try { await c.add(SDK); } catch (_) { /* 처음 켤 때 인터넷이 없으면 다음에 받는다 */ }
  }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.hostname === 'api.anthropic.com') return;   // AI 호출은 건드리지 않는다
  const cdn = url.hostname === 'cdn.jsdelivr.net';
  if (url.origin !== location.origin && !cdn) return;
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: !cdn });
    // 저장본을 먼저 보여 주고, 인터넷이 되면 뒤에서 새 파일로 바꿔 둔다
    const fresh = fetch(e.request).then((res) => { if (res.ok) c.put(e.request, res.clone()); return res; }).catch(() => null);
    return hit || (await fresh) || new Response('오프라인이에요.', { status: 503 });
  }));
});
