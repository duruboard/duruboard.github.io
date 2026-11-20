// 두루보드 서비스 워커: 화면 파일(같은 주소)만 보관하여 연결이 끊겨도 첫 화면이 열리게 함.
// 자료 요청(다른 주소)과 AI 요청은 가로채지 않으며, 받은 자료는 보관하지 않습니다.
const CACHE = 'duruboard-shell-v1';
const SHELL = ['./', 'index.html', 'app.js', 'style.css', 'vendor/chart.umd.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// 같은 주소의 GET 요청만: 먼저 네트워크(최신 화면), 실패하면 보관본
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/.well-known/') === 0) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(url.origin + url.pathname, copy));   // 판 번호(?v=)는 빼고 하나만 보관
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined)).then((r) => r || new Response('연결되어 있지 않습니다.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })))
  );
});
