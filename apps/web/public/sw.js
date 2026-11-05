// EUM 공장 PWA 서비스 워커: 화면 파일만 캐시하고, API·다운로드·실시간 통신은 절대 캐시하지 않습니다.
const CACHE = 'eum-shell-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  // 네트워크 우선, 실패하면(오프라인) 캐시된 화면을 보여 줍니다.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
        return res.clone();
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/'))),
  );
});
