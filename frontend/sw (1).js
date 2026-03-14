/**
 * GuardianGrid Service Worker
 * ─────────────────────────────────────────────────────────────────────
 * Reliability Phase 3 Fix:
 *   - Cache app shell for offline use
 *   - Background sync: flush queued alerts when connectivity returns
 *   - Intercept /api/alert POSTs when offline → store in IDB queue
 *
 * Pipeline Stage Protected: Alert Transmission
 * Scenario: Network dead zone, phone in tunnel, rural area
 */

const CACHE_NAME = 'guardiangrid-v1';
const OFFLINE_QUEUE_KEY = 'gg-offline-alerts';
const API_BASE = self.location.origin;

// App shell files to cache (local only, no CDN)
const PRECACHE = [
  '/',
  '/index.html',
  '/tracking.html',
];

// ── INSTALL ──────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Pre-caching app shell');
      return cache.addAll(PRECACHE).catch(e => console.warn('[SW] Pre-cache partial fail:', e));
    })
  );
  self.skipWaiting();
});

// ── ACTIVATE ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
  console.log('[SW] Active');
});

// ── FETCH ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Intercept alert POSTs when offline — queue them
  if (url.pathname.endsWith('/api/alert') && event.request.method === 'POST') {
    event.respondWith(handleAlertFetch(event.request));
    return;
  }

  // App shell: cache-first
  if (PRECACHE.some(p => event.request.url.includes(p.replace(/^\//, '')))) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
    return;
  }

  // API calls: network-first, fallback to cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request.clone()).catch(() =>
        new Response(JSON.stringify({ ok: false, error: 'offline', queued: true }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
  }
});

// ── BACKGROUND SYNC ───────────────────────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'flush-alert-queue') {
    event.waitUntil(flushQueue());
  }
});

// ── HANDLE ALERT FETCH ────────────────────────────────────────────────────────
async function handleAlertFetch(request) {
  try {
    // Try to reach the server
    const response = await fetch(request.clone(), { signal: AbortSignal.timeout(5000) });
    if (response.ok) return response;
    throw new Error('Server error ' + response.status);
  } catch (_) {
    // Offline — queue the alert in cache
    const body = await request.clone().json().catch(() => ({}));
    await queueAlert(body);
    console.log('[SW] Alert queued offline:', body.alertId);
    // Register background sync
    if (self.registration.sync) {
      await self.registration.sync.register('flush-alert-queue');
    } else {
      // Fallback: attempt flush via setTimeout if background sync unavailable
      setTimeout(flushQueue, 30000);
    }
    return new Response(JSON.stringify({ ok: true, queued: true, alertId: body.alertId }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ── QUEUE HELPERS (IndexedDB via simple key-value in Cache API) ────────────────
async function getQueue() {
  try {
    const cache = await caches.open('gg-queue');
    const r = await cache.match('/queue');
    if (!r) return [];
    return await r.json();
  } catch (_) { return []; }
}

async function queueAlert(alert) {
  const queue = await getQueue();
  queue.push({ ...alert, queuedAt: new Date().toISOString() });
  const cache = await caches.open('gg-queue');
  await cache.put('/queue', new Response(JSON.stringify(queue), {
    headers: { 'Content-Type': 'application/json' },
  }));
}

async function clearQueue() {
  const cache = await caches.open('gg-queue');
  await cache.delete('/queue');
}

async function flushQueue() {
  const queue = await getQueue();
  if (!queue.length) return;

  console.log('[SW] Flushing', queue.length, 'queued alerts');
  try {
    const res = await fetch(API_BASE + '/api/alert/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alerts: queue }),
    });
    if (res.ok) {
      await clearQueue();
      console.log('[SW] Queue flushed successfully');
      // Notify all clients
      const clients = await self.clients.matchAll();
      clients.forEach(c => c.postMessage({ type: 'QUEUE_FLUSHED', count: queue.length }));
    }
  } catch (e) {
    console.warn('[SW] Flush failed, will retry:', e.message);
  }
}
