// sw.js — кэширование оболочки и шрифтов для офлайна и установки как PWA.
// Данные расписания НЕ кэшируются здесь: они живут в localStorage и
// загружаются приложением напрямую с официального сайта.

const VERSION = 'metro-spb-v11';
const FONT_CACHE = 'metro-spb-fonts-v2';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './parser.js',
  './data.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

const FONT_ORIGINS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== VERSION && k !== FONT_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Шрифты Google — cache-first в отдельном кэше (работают офлайн после первой загрузки).
  if (FONT_ORIGINS.includes(url.origin)) {
    e.respondWith(
      caches.open(FONT_CACHE).then((cache) =>
        cache.match(req).then((hit) =>
          hit || fetch(req).then((res) => {
            if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
            return res;
          }).catch(() => hit)
        )
      )
    );
    return;
  }

  // Прочие чужие домены (CORS-прокси для расписания) — не вмешиваемся.
  if (url.origin !== self.location.origin) return;

  // Оболочка — cache-first, с навигационным откатом на index.html.
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => {
        if (req.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 504, statusText: 'offline' });
      });
    })
  );
});
