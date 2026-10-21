// Kenan's app shell on the device: opening the app needs no network round trip before its script runs.
// - The app document (exactly the root path, any query) is served from the cache and refreshed in the
//   background; the app's own update check offers a reload when the refreshed shell names a newer build.
// - Hashed assets (/assets/*) never change: cache first, network once.
// Everything else on this origin (the API, the event stream, other apps behind the same host) passes through.
const SHELL = 'kenan-shell-v1';
const ASSETS = 'kenan-assets-v1';
const base = new URL(self.registration.scope).pathname;
const ROOT = new URL(base, self.location.origin).href;

// Installing stores the current shell and its assets, so the very next open is already local.
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const response = await refreshShell();
    if (!response.ok) throw new Error(`Shell fetch failed: HTTP ${response.status}`);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== SHELL && key !== ASSETS).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

const isPage = response => (response.headers.get('content-type') ?? '').includes('text/html');
/** Assets the shell document loads. */
const referenced = html => new Set([...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g)].map(match => new URL(base + match[1], self.location.origin).href));

// A new shell replaces the cached one only once all its assets are cached, so an open never gets a shell whose
// script can't load (e.g. the network dropped between the two).
async function refreshShell() {
  const response = await fetch(ROOT, { cache: 'no-cache', credentials: 'same-origin' });
  if (!response.ok || !isPage(response)) return response;
  const keep = referenced(await response.clone().text());
  const fetched = await Promise.all([...keep].map(url => assetResponse(new Request(url)).catch(() => null)));
  if (!fetched.every(asset => asset?.ok && !isPage(asset))) return response;
  const shell = await caches.open(SHELL);
  await shell.put(ROOT, response.clone());
  // Keep only the assets the current shell uses; older builds stay on the server for pages still running them.
  const assets = await caches.open(ASSETS);
  for (const request of await assets.keys()) if (!keep.has(request.url)) await assets.delete(request);
  return response;
}

async function shellResponse(event) {
  const cached = await caches.match(ROOT, { cacheName: SHELL });
  const refreshed = refreshShell();
  if (!cached) return refreshed;
  event.waitUntil(refreshed.then(() => undefined, error => console.warn('Shell refresh failed; the cached shell stays:', error)));
  return cached;
}

async function assetResponse(request) {
  const assets = await caches.open(ASSETS);
  const cached = await assets.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // Only a real asset is kept forever: an HTML page in its place (an entrance error or fallback page) is never cached.
  if (response.ok && !isPage(response)) await assets.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && url.pathname === base) event.respondWith(shellResponse(event));
  else if (url.pathname.startsWith(base + 'assets/')) event.respondWith(assetResponse(request));
});

// Web Push (installed web apps, e.g. on an iPhone home screen): show each agent notification; tapping it opens its
// conversation. iOS revokes the subscription of a web app whose push doesn't show a notification, so every push shows one.
self.addEventListener('push', event => {
  const message = event.data ? event.data.json() : null;
  const title = message ? message.title : 'Kenan';
  event.waitUntil(self.registration.showNotification(title, {
    body: message ? message.body : 'Open Kenan for a new notification.',
    tag: message && message.id !== null ? `kenan-${message.id}` : undefined,
    icon: base + 'icon-192.png',
    badge: base + 'icon-192.png',
    requireInteraction: message ? message.level === 'urgent' : false,
    data: { conversationId: message ? message.conversationId : null },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const conversationId = event.notification.data && event.notification.data.conversationId;
  const url = conversationId ? `${ROOT}?conversationId=${encodeURIComponent(conversationId)}` : ROOT;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find(client => client.url.startsWith(ROOT));
    if (!open) return self.clients.openWindow(url);
    await open.focus();
    if (conversationId) open.postMessage({ type: 'kenan-open-conversation', conversationId });
  })());
});
