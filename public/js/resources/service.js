// Request mapping of the resource service worker (public/resource-sw.js).
import { AUDIO_EXTS, MEDIA_PREFIX } from '../../../shared/media.js';
import { splitHashedPath } from '../../../shared/assetPaths.js';

/**
 * The cache keys that may answer a request, in order of preference; null when the request is not for a resource file.
 * Resource files live under /assets/ and /fonts/. Audio is also requested through the extension-less /media/ alias
 * (public/js/media.js), which names /assets/audio/<path><ext> with the extensions tried in shared/media.js order.
 * The query string is ignored, like the static asset host does, and so is the content-hash segment the Node server's
 * manifests put in a URL (shared/assetPaths.js): the cache keeps a file under its plain path.
 * @param {Request} request
 * @param {string} origin the site's origin
 * @returns {string[]|null}
 */
export function resourceKeys(request, origin) {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== origin) return null;
  const { path } = splitHashedPath(url.pathname);
  if (path.startsWith(MEDIA_PREFIX)) {
    const stem = '/assets/audio/' + path.slice(MEDIA_PREFIX.length);
    return AUDIO_EXTS.map(ext => stem + ext);
  }
  return /^\/(assets|fonts)\//.test(path) ? [path] : null;
}

/** The first cached response among the keys, or undefined. Looks in every cache: the page keeps one resource cache. */
export async function cachedResponse(keys, caches = globalThis.caches) {
  for (const key of keys) {
    const response = await caches.match(key);
    if (response) return response;
  }
  return undefined;
}
