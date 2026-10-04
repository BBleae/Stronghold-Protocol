// Resource service worker: answers resource files from the local resource cache, everything else from the network.
// It needs no manifest: the page (js/resources/store.js) only stores verified files and removes the ones a new site
// version changed. It never stores anything itself: no code, documents, API responses or manifests.
import { cachedResponse, resourceKeys } from './js/resources/service.js';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const request = event.request;
  const keys = resourceKeys(request, self.location.origin);
  if (!keys) return;
  event.respondWith(cachedResponse(keys).then(response => response ?? fetch(request)));
});
