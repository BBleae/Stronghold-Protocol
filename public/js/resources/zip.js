import { checkAbort, matchesResource, readBoundedResponse, validateResourceUrl, verifyBytes } from './common.js';

const MAX_READ_BYTES = 16 * 1024 * 1024;

export function zipPathToUrl(name) {
  if (typeof name !== 'string' || !/^(assets|fonts)\//.test(name) || /[\\\x00-\x1f]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid ZIP resource path');
  return validateResourceUrl('/' + name.split('/').map(encodeURIComponent).join('/'));
}

/** zip.js owns ZIP parsing and decompression. We only apply the site's resource contract.
 * BlobReader seeks by range; bounded writes hold at most one trusted manifest file.
 */
export async function importResourceZip(blob, store, { signal, onProgress = () => {}, zipjs } = {}) {
  checkAbort(signal);
  zipjs ??= await import('/vendor/zip.module.js');
  if (blob.size > store.manifest.totalBytes * 1.1 + store.manifest.files.length * 2048 + 1024 * 1024) throw new Error('ZIP size / 大小超出资源清单限制');
  const expected = new Map(store.manifest.files.map(file => [file.url, file]));
  const seen = new Set();
  const status = await store.status();
  const source = new zipjs.BlobReader(blob);
  const readRange = source.readUint8Array.bind(source);
  // Also bound metadata reads when a malformed archive declares an enormous directory.
  source.readUint8Array = (offset, length) => {
    checkAbort(signal);
    if (length > MAX_READ_BYTES) throw new Error('ZIP metadata size / 大小超出限制');
    return readRange(offset, length);
  };
  const reader = new zipjs.ZipReader(source, {
    useWebWorkers: false, checkCrc32: true, strictness: 'strict', checkOverlappingEntry: true,
  });
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      checkAbort(signal);
      const url = zipPathToUrl(entry.filename);
      const trusted = expected.get(url);
      if (!trusted) throw new Error(`Unknown ZIP resource / 清单外文件: ${entry.filename}`);
      if (seen.has(url)) throw new Error(`Duplicate ZIP resource path: ${entry.filename}`);
      seen.add(url);
      if (entry.directory || entry.symlink || entry.encrypted) throw new Error('Unsupported ZIP resource entry');
      if (entry.uncompressedSize !== trusted.size || !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0 || entry.compressedSize > trusted.size * 1.1 + 65536) throw new Error(`ZIP resource size / 大小不符: ${entry.filename}`);
      const data = new Uint8Array(trusted.size);
      let size = 0;
      await entry.getData(new WritableStream({
        write(chunk) {
          checkAbort(signal);
          if (size + chunk.length > data.length) throw new Error(`ZIP resource size / 大小超出限制: ${entry.filename}`);
          data.set(chunk, size); size += chunk.length;
        },
      }), { signal });
      if (size !== data.length) throw new Error(`ZIP resource size / 大小不符: ${entry.filename}`);
      await store.put(trusted, data, { signal });
      if (!status.present.has(url)) { status.present.add(url); status.count++; status.bytes += size; }
      onProgress({ ...status, complete: status.count === status.total, phase: 'import', file: url });
    }
    if (!seen.size) throw new Error('Empty ZIP resource pack');
    status.complete = status.count === status.total;
    return status;
  } catch (error) {
    if (error.name === 'AbortError' || error.name === 'QuotaExceededError') throw error;
    throw new Error(`ZIP resource import: ${error.message}${error.reason ? ` (${error.reason})` : ''}`, { cause: error });
  } finally {
    await reader.close();
  }
}

/** ZIP entry name of a manifest URL ('/assets/a%20b.png' → 'assets/a b.png'), as tools/resource-pack.mjs writes it. */
export const resourceZipName = url => decodeURIComponent(url.slice(1));

/** Write the complete local resources as the pack `npm run resources:pack` makes (stored entries, same names), so a
 * player can hand it to friends straight from the site. `writable`: the save dialog's file stream; none ⇒ a Blob.
 * Every file is read back from the cache and checked against the manifest first.
 */
export async function exportResourceZip(store, { writable = null, signal, onProgress = () => {}, zipjs } = {}) {
  checkAbort(signal);
  zipjs ??= await import('/vendor/zip.module.js');
  const status = await store.status();
  if (!status.complete) throw new Error('资源还没有全部保存：先在线下载或导入，再导出');
  const cache = await store.caches.open(store.cacheName);
  const writer = new zipjs.ZipWriter(writable ?? new zipjs.BlobWriter('application/zip'), {
    level: 0, useWebWorkers: false, lastModDate: new Date('2020-01-01T00:00:00Z'), extendedTimestamp: false,
  });
  let count = 0, bytes = 0;
  try {
    for (const file of store.manifest.files) {
      checkAbort(signal);
      const cached = await cache.match(file.url);
      if (!matchesResource(cached, file)) throw new Error(`本地资源已被浏览器清理（${file.url}），请重新下载后再导出`);
      const data = await readBoundedResponse(cached, file.size, signal);
      await verifyBytes(file, data);
      await writer.add(resourceZipName(file.url), new zipjs.Uint8ArrayReader(data), { signal });
      count++; bytes += file.size;
      onProgress({ ...status, count, bytes, phase: 'export', file: file.url });
    }
    return await writer.close();
  } catch (error) {
    await writable?.abort?.(error).catch(() => {});
    throw error;
  }
}
