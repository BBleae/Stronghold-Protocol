import { CACHE_PREFIX, checkAbort, matchesResource, readBoundedResponse, resourceResponse, validateManifest, verifyBytes } from './common.js';

export class ResourceStore {
  constructor(manifest, { caches = globalThis.caches, fetcher = globalThis.fetch?.bind(globalThis) } = {}) {
    this.manifest = validateManifest(manifest);
    this.caches = caches;
    this.fetcher = fetcher;
    this.cacheName = CACHE_PREFIX + manifest.version;
  }
  async put(file, bytes, { signal } = {}) {
    checkAbort(signal);
    await verifyBytes(file, bytes);
    checkAbort(signal);
    const cache = await this.caches.open(this.cacheName);
    await cache.put(file.url, resourceResponse(file, bytes));
  }
  async status() {
    const cache = await this.caches.open(this.cacheName);
    const cachedUrls = new Set((await cache.keys()).map(request => new URL(request.url).pathname));
    const candidates = this.manifest.files.filter(file => cachedUrls.has(file.url));
    const present = new Set();
    let bytes = 0;
    // Batches keep startup responsive with several thousand entries.
    for (let i = 0; i < candidates.length; i += 24) {
      await Promise.all(candidates.slice(i, i + 24).map(async file => {
        if (matchesResource(await cache.match(file.url), file)) { present.add(file.url); bytes += file.size; }
      }));
    }
    return { present, bytes, count: present.size, total: this.manifest.files.length, totalBytes: this.manifest.totalBytes, complete: present.size === this.manifest.files.length };
  }
  async reuse({ signal, onProgress = () => {} } = {}) {
    const status = await this.status();
    const oldNames = (await this.caches.keys()).filter(name => name.startsWith(CACHE_PREFIX) && name !== this.cacheName);
    for (const name of oldNames) {
      checkAbort(signal);
      const old = await this.caches.open(name);
      for (const file of this.manifest.files) {
        if (status.present.has(file.url)) continue;
        checkAbort(signal);
        const cached = await old.match(file.url);
        if (!matchesResource(cached, file)) continue;
        try {
          const data = await readBoundedResponse(cached, file.size, signal);
          await this.put(file, data, { signal });
        } catch (error) {
          if (error.name === 'AbortError' || error.name === 'QuotaExceededError') throw error;
          continue; // A damaged old entry must be downloaded again.
        }
        status.present.add(file.url); status.count++; status.bytes += file.size;
        onProgress({ ...status, complete: status.count === status.total, phase: 'reuse', file: file.url });
      }
    }
    status.complete = status.count === status.total;
    return status;
  }
  async download({ signal, onProgress = () => {} } = {}) {
    const status = await this.reuse({ signal, onProgress });
    onProgress({ ...status, phase: 'download' });
    for (const file of this.manifest.files) {
      checkAbort(signal);
      if (status.present.has(file.url)) continue;
      // A failed request leaves earlier files committed; retry simply resumes here.
      const response = await this.fetcher(file.url, { signal, cache: 'no-store' });
      const data = await readBoundedResponse(response, file.size, signal);
      await this.put(file, data, { signal });
      status.present.add(file.url); status.count++; status.bytes += file.size;
      onProgress({ ...status, complete: status.count === status.total, phase: 'download', file: file.url });
    }
    status.complete = status.count === status.total;
    return status;
  }
  async clear() {
    const names = await this.caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX)).map(name => this.caches.delete(name)));
  }
}
