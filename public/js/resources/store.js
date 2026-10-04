// The local resource cache as the page manages it. The service worker (public/resource-sw.js) only reads it.
//
// The site hosts no resource files: players import them from a resource ZIP (zip.js), checked against the site's
// manifest. One Cache Storage cache holds them, keyed by URL. An entry belongs to the current site version when its
// X-Resource-SHA256 and size match the manifest; reconcile() removes the others. A status entry in the same cache
// records the site version the cache was last reconciled against and how much of it is present, so that a page load
// of an unchanged site needs no scan of thousands of entries.
//
// The cache only ever follows the live site version: reconcile() fetches the manifest before it changes anything, and
// imports start with it. Cache Storage is shared by every page of the site; the caller runs one operation at a time
// across all of them (js/resources/index.js).
import { CACHE_PREFIX, checkAbort, matchesResource, resourceResponse, verifyBytes } from './common.js';

const MANIFEST_URL = '/resource-manifest.json';
const STATUS_KEY = '/resource-cache-status.json';

/** The site's current resource manifest (tools/resource-pack.mjs). Revalidated, so an unchanged one costs a 304. */
async function fetchManifest(fetcher = globalThis.fetch.bind(globalThis), signal) {
  const response = await fetcher(MANIFEST_URL, { cache: 'no-cache', signal });
  if (!response.ok) throw new Error(`资源清单不可用（HTTP ${response.status}）`);
  return response.json();
}

/**
 * How much of a site version the cache holds. `present` (the URLs) is only known after a scan.
 * @returns {{ version: string, count: number, bytes: number, total: number, totalBytes: number, complete: boolean,
 *   present?: Set<string> }}
 */
function cacheStatus(manifest, count, bytes, present) {
  const total = manifest.files.length;
  return { version: manifest.version, count, bytes, total, totalBytes: manifest.totalBytes, complete: count === total, present };
}

/** Count one more stored file of the status's version. */
export function addFile(status, file) {
  if (status.present.has(file.url)) return;
  status.present.add(file.url);
  status.count++;
  status.bytes += file.size;
  status.complete = status.count === status.total;
}

export class ResourceStore {
  constructor(manifest, { caches = globalThis.caches, fetcher = globalThis.fetch.bind(globalThis) } = {}) {
    this.manifest = manifest;
    this.caches = caches;
    this.fetcher = fetcher;
    // The cache the last check() or reconcile() found; put() and save() write into it. A cache deleted meanwhile
    // (the player clears the site's data) takes the files and the status entry written later with it.
    this.cache = null;
  }

  static async load(options = {}) {
    return new ResourceStore(await fetchManifest(options.fetcher), options);
  }

  /** Names of the existing resource caches. */
  async #cacheNames() {
    return (await this.caches.keys()).filter(name => name.startsWith(CACHE_PREFIX));
  }

  /** The cache's status: its status entry when that is of the store's site version, else reconcile(). */
  async check() {
    const names = await this.#cacheNames();
    if (!names.length) return cacheStatus(this.manifest, 0, 0);
    if (names.length === 1) {
      const cache = await this.caches.open(names[0]);
      const saved = await cache.match(STATUS_KEY);
      const status = saved && await saved.json();
      if (status?.version === this.manifest.version) {
        this.cache = cache;
        return cacheStatus(this.manifest, status.count, status.bytes);
      }
    }
    return this.reconcile();
  }

  /**
   * Bring the cache to the live site version: fetch the manifest (a 304 when unchanged), keep the entries it lists,
   * delete every other one, and record the result.
   * Earlier releases kept one cache per site version. The fullest resource cache stays the cache; the others hand
   * over the files it lacks and are deleted. So an earlier installation is adopted in place, never copied whole.
   */
  async reconcile(signal) {
    this.manifest = await fetchManifest(this.fetcher, signal);
    const files = new Map(this.manifest.files.map(file => [file.url, file]));
    const names = await this.#cacheNames();
    if (!names.length) names.push(CACHE_PREFIX);
    const existing = await Promise.all(names.map(async name => {
      const cache = await this.caches.open(name);
      return { name, cache, requests: await cache.keys() };
    }));
    const [home, ...others] = existing.sort((a, b) => b.requests.length - a.requests.length);
    const status = cacheStatus(this.manifest, 0, 0, new Set());
    // In batches: thousands of entries, each read is a round trip to the storage process.
    for (let i = 0; i < home.requests.length; i += 32) {
      await Promise.all(home.requests.slice(i, i + 32).map(async request => {
        const file = files.get(new URL(request.url).pathname);
        if (file && matchesResource(await home.cache.match(request), file)) addFile(status, file);
        else await home.cache.delete(request);
      }));
    }
    for (const other of others) {
      for (const request of other.requests) {
        const file = files.get(new URL(request.url).pathname);
        if (!file || status.present.has(file.url)) continue;
        const response = await other.cache.match(request);
        if (!matchesResource(response, file)) continue;
        await home.cache.put(file.url, response);
        addFile(status, file);
      }
      await this.caches.delete(other.name);
    }
    this.cache = home.cache;
    await this.save(status);
    return status;
  }

  /** Record a status, so that the next check() of the same site version needs no scan. */
  async save(status) {
    const body = JSON.stringify({ version: status.version, count: status.count, bytes: status.bytes });
    await this.cache.put(STATUS_KEY, new Response(body, { headers: { 'Content-Type': 'application/json' } }));
  }

  /** Verify a file against the manifest and store it. */
  async put(file, bytes, { signal } = {}) {
    checkAbort(signal);
    await verifyBytes(file, bytes);
    checkAbort(signal);
    await this.cache.put(file.url, resourceResponse(file, bytes));
  }

  /** Delete every resource cache. */
  async clear() {
    for (const name of await this.#cacheNames()) await this.caches.delete(name);
    this.cache = null;
  }
}
