import { CACHE_PREFIX, matchesResource, rangeResponse } from './common.js';

/** null means this request is outside the resource worker's scope. */
export async function handleResourceRequest(request, { manifest, caches = globalThis.caches, origin = globalThis.location?.origin, fetcher = globalThis.fetch?.bind(globalThis) }) {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== origin || !/^\/(assets|fonts)\//.test(url.pathname)) return null;
  const file = manifest.files.find(file => file.url === url.pathname);
  if (!file) return null;
  const cache = await caches.open(CACHE_PREFIX + manifest.version);
  const response = await cache.match(file.url);
  if (matchesResource(response, file)) {
    const range = request.headers.get('Range');
    return range ? rangeResponse(response, range) : response;
  }
  // On-demand mode uses normal networking, including the server's native Range support.
  return fetcher(request);
}
