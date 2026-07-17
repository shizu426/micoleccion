// sw.js — Service Worker para MiColección PWA
const CACHE_NAME = 'micoleccion-v3';
const CACHE_URLS = [
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600&display=swap',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js'
];

// Instalación: cachear archivos estáticos (ya no cacheamos index.html acá)
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.allSettled(CACHE_URLS.map(url => cache.add(url)));
    }).then(() => self.skipWaiting())
  );
});

// Activación: limpiar caches viejos
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // No interceptar peticiones a Firebase / APIs externas (siempre necesitan red)
  if (url.hostname.includes('firebase') ||
      url.hostname.includes('googleapis') ||
      url.hostname.includes('anilist') ||
      url.hostname.includes('mangadex') ||
      url.hostname.includes('jikan') ||
      url.hostname.includes('kitsu') ||
      url.hostname.includes('netlify')) {
    return; // dejar pasar sin interceptar
  }

  // Navegación (el index.html / la página en sí): Network First
  // Así, cada vez que entrás, intenta traer la versión más nueva del servidor.
  // Si no hay conexión, recién ahí usa la copia guardada en caché.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request).then(cached => cached || caches.match('/index.html')))
    );
    return;
  }

  // Resto de archivos estáticos (fuentes, SDKs): Cache First, con Network Fallback
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.status === 200 && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {});
    })
  );
});
