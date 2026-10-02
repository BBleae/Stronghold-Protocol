import { validateManifest } from './js/resources/common.js';
import { handleResourceRequest } from './js/resources/service.js';

// The worker never stores code, documents, API responses, manifests, or WebSockets.
let manifestPromise;
function getManifest() {
  return manifestPromise ??= fetch('/resource-manifest.json', { cache: 'no-store' })
    .then(response => { if (!response.ok) throw new Error('Resource manifest unavailable'); return response.json(); })
    .then(validateManifest)
    .catch(error => { manifestPromise = undefined; throw error; });
}
self.addEventListener('install', event => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
self.addEventListener('message', event => {
  if (event.data?.type === 'resources:refresh') {
    manifestPromise = undefined;
    event.waitUntil(getManifest().then(manifest => event.ports[0]?.postMessage({ version: manifest.version })).catch(() => event.ports[0]?.postMessage({ error: true })));
  }
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || !/^\/(assets|fonts)\//.test(url.pathname)) return;
  event.respondWith(getManifest()
    .then(manifest => handleResourceRequest(request, { manifest }))
    .then(response => response ?? fetch(request))
    .catch(() => fetch(request)));
});
