// The local resource cache as the page manages it. The service worker (public/resource-sw.js) only reads it.
//
// One Cache Storage cache holds every resource file, keyed by URL. An entry belongs to the current site version when
// its X-Resource-SHA256 and size match the manifest; reconcile() removes the others. A status entry in the same cache
// records the site version the cache was last reconciled against and how much of it is present, so that a page load
// of an unchanged site needs no scan of thousands of entries.
import { CACHE_PREFIX, checkAbort, matchesResource, readBoundedResponse, resourceResponse, verifyBytes } from './common.js';

const MANIFEST_URL = '/resource-manifest.json';
const STATUS_KEY = '/resource-cache-status.json';
// A failing file is tried again after these pauses.
const RETRY_DELAYS_MS = [1000, 3000];
// More failed files than this in one pass means the problem is not the files: the pass stops and reports.
const MAX_FAILED_FILES = 20;

/** The site's current resource manifest (tools/resource-pack.mjs). Revalidated, so an unchanged one costs a 304. */
export async function fetchManifest(fetcher = globalThis.fetch.bind(globalThis), signal) {
  const response = await fetcher(MANIFEST_URL, { cache: 'no-cache', signal });
  if (!response.ok) throw new Error(`资源清单不可用（HTTP ${response.status}）`);
  return response.json();
}

/**
 * How much of a site version the cache holds. `present` (the URLs) is only known after a scan.
 * @returns {{ version: string, count: number, bytes: number, total: number, totalBytes: number, complete: boolean, present?: Set<string> }}
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

/** Some files could not be downloaded; the others are stored. */
export class DownloadError extends Error {
  constructor(failed) {
    const [{ file, error }] = failed;
    super(`${failed.length} 个文件下载失败，例如 ${file.url}（${error.message}）`);
    this.name = 'DownloadError';
    this.failed = failed;
  }
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    checkAbort(signal);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

const stopsDownload = error => error.name === 'AbortError' || error.name === 'QuotaExceededError';

export class ResourceStore {
  constructor(manifest, { caches = globalThis.caches, fetcher = globalThis.fetch.bind(globalThis) } = {}) {
    this.manifest = manifest;
    this.caches = caches;
    this.fetcher = fetcher;
    // Where new files go; reconcile() and check() switch to the cache that already exists.
    this.cacheName = CACHE_PREFIX;
  }

  static async load(options = {}) {
    return new ResourceStore(await fetchManifest(options.fetcher), options);
  }

  /** Names of the existing resource caches, oldest first. */
  async #cacheNames() {
    return (await this.caches.keys()).filter(name => name.startsWith(CACHE_PREFIX));
  }

  /** The cache's status for the current manifest: read from the status entry when it is of this site version, else by reconcile(). */
  async check() {
    const names = await this.#cacheNames();
    if (!names.length) return cacheStatus(this.manifest, 0, 0);
    if (names.length === 1) {
      const saved = await (await this.caches.open(names[0])).match(STATUS_KEY);
      const status = saved && await saved.json();
      if (status?.version === this.manifest.version) {
        this.cacheName = names[0];
        return cacheStatus(this.manifest, status.count, status.bytes);
      }
    }
    return this.reconcile();
  }

  /**
   * Scan the cache: keep the entries of the current manifest, delete every other one, and record the result.
   * The oldest resource cache stays the cache; any later one (version-keyed caches of earlier releases) hands over
   * the files the first lacks and is deleted. So an earlier installation is adopted in place, never copied whole.
   */
  async reconcile() {
    const manifest = this.manifest;
    const files = new Map(manifest.files.map(file => [file.url, file]));
    const [name = CACHE_PREFIX, ...others] = await this.#cacheNames();
    const cache = await this.caches.open(name);
    const status = cacheStatus(manifest, 0, 0, new Set());
    const requests = await cache.keys();
    // In batches: thousands of entries, each read is a round trip to the storage process.
    for (let i = 0; i < requests.length; i += 32) {
      await Promise.all(requests.slice(i, i + 32).map(async request => {
        const file = files.get(new URL(request.url).pathname);
        if (file && matchesResource(await cache.match(request), file)) addFile(status, file);
        else await cache.delete(request);
      }));
    }
    for (const otherName of others) {
      const other = await this.caches.open(otherName);
      for (const file of manifest.files) {
        if (status.present.has(file.url)) continue;
        const response = await other.match(file.url);
        if (!matchesResource(response, file)) continue;
        await cache.put(file.url, response);
        addFile(status, file);
      }
      await this.caches.delete(otherName);
    }
    this.cacheName = name;
    await this.save(status);
    return status;
  }

  /** Record a status, so that the next check() of the same site version needs no scan. */
  async save(status) {
    const cache = await this.caches.open(this.cacheName);
    const body = JSON.stringify({ version: status.version, count: status.count, bytes: status.bytes });
    await cache.put(STATUS_KEY, new Response(body, { headers: { 'Content-Type': 'application/json' } }));
  }

  /** Verify a file against the manifest and store it. */
  async put(file, bytes, { signal } = {}) {
    checkAbort(signal);
    await verifyBytes(file, bytes);
    checkAbort(signal);
    const cache = await this.caches.open(this.cacheName);
    await cache.put(file.url, resourceResponse(file, bytes));
  }

  /** Fetch the manifest again; true when the site version changed (the store then follows the new one). */
  async refreshManifest(signal) {
    const manifest = await fetchManifest(this.fetcher, signal);
    if (manifest.version === this.manifest.version) return false;
    this.manifest = manifest;
    return true;
  }

  /**
   * Download the files the cache lacks, a few at a time. A failing file is tried again after a pause; a file that
   * keeps failing is reported at the end while the others go on. When the site was redeployed meanwhile, the download
   * continues with the new manifest. Pausing (`signal`) or a full disk stops everything at once.
   */
  async download({ signal, onProgress = () => {}, concurrency = 6, retryDelays = RETRY_DELAYS_MS } = {}) {
    await this.refreshManifest(signal);
    while (true) {
      const status = await this.reconcile();
      onProgress({ ...status });
      const queue = this.manifest.files.filter(file => !status.present.has(file.url));
      const failed = [];
      let stop = null;
      const worker = async () => {
        while (queue.length && !stop && failed.length < MAX_FAILED_FILES) {
          const file = queue.shift();
          try {
            await this.#fetchFile(file, signal, retryDelays);
          } catch (error) {
            if (stopsDownload(error)) stop ??= error;
            else failed.push({ file, error });
            continue;
          }
          addFile(status, file);
          onProgress({ ...status });
        }
      };
      try {
        await Promise.all(Array.from({ length: concurrency }, worker));
      } finally {
        await this.save(status);
      }
      checkAbort(signal); // a pause wins over the errors of files that were in flight
      if (stop) throw stop;
      if (!failed.length) return status;
      // Files that keep failing are what a redeploy changed or removed: then start over with the new manifest.
      if (await this.refreshManifest(signal)) continue;
      throw new DownloadError(failed);
    }
  }

  async #fetchFile(file, signal, retryDelays) {
    for (let attempt = 0; ; attempt++) {
      try {
        // no-store: the bytes go to the resource cache, not a second time into the HTTP cache
        const response = await this.fetcher(file.url, { signal, cache: 'no-store' });
        await this.put(file, await readBoundedResponse(response, file.size, signal), { signal });
        return;
      } catch (error) {
        if (attempt === retryDelays.length || stopsDownload(error)) throw error;
      }
      await delay(retryDelays[attempt], signal);
    }
  }

  /** Delete every resource cache. */
  async clear() {
    for (const name of await this.#cacheNames()) await this.caches.delete(name);
    this.cacheName = CACHE_PREFIX;
  }
}
