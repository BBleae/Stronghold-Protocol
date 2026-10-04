import { checkAbort, matchesResource, readBoundedResponse, sha256Hex, verifyBytes } from './common.js';
import { addFile } from './store.js';

const MAX_READ_BYTES = 16 * 1024 * 1024;

/** zip.js owns ZIP parsing and decompression. Only manifest entries are extracted and validated.
 * BlobReader seeks by range; bounded writes hold at most one trusted manifest file.
 * Unrelated entries are skipped without path or content validation. Matching names with another
 * size or hash (a pack of another site version) are skipped and counted; malformed matching entries still fail.
 */
export async function importResourceZip(blob, store, { signal, onProgress = () => {}, zipjs } = {}) {
  checkAbort(signal);
  zipjs ??= await import('/vendor/zip.module.js');
  // Against the live manifest: a pack of the current site imports whole even after a deploy during a long session.
  const status = await store.reconcile(signal);
  const expected = new Map(store.manifest.files.map(file => [decodeURIComponent(file.url.slice(1)), file]));
  const seen = new Set();
  let imported = 0, skipped = 0;
  const source = new zipjs.BlobReader(blob);
  const readRange = source.readUint8Array.bind(source);
  // Also bound metadata reads when a malformed archive declares an enormous directory.
  source.readUint8Array = (offset, length) => {
    checkAbort(signal);
    if (length > MAX_READ_BYTES) throw new Error('ZIP 目录过大');
    return readRange(offset, length);
  };
  const reader = new zipjs.ZipReader(source, {
    // Unused names and duplicate entries must not reject an otherwise usable pack.
    useWebWorkers: false, strictness: 'balanced', filenameValidation: 'tolerant',
  });
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      checkAbort(signal);
      const trusted = expected.get(entry.filename);
      if (entry.directory) continue;
      if (!trusted) { skipped++; continue; }
      const url = trusted.url;
      if (seen.has(url)) throw new Error(`ZIP 中有重复的资源：${entry.filename}`);
      seen.add(url);
      if (entry.symlink || entry.encrypted) throw new Error(`不支持链接或加密的 ZIP 条目：${entry.filename}`);
      if (entry.uncompressedSize !== trusted.size) { skipped++; continue; }
      if (!Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0 || entry.compressedSize > trusted.size * 1.1 + 65536) throw new Error(`ZIP 条目大小不符：${entry.filename}`);

      const data = new Uint8Array(trusted.size);
      let size = 0;
      await entry.getData(new WritableStream({
        write(chunk) {
          checkAbort(signal);
          if (size + chunk.length > data.length) throw new Error(`ZIP 条目大小超出清单：${entry.filename}`);
          data.set(chunk, size); size += chunk.length;
        },
      }), { signal, strictness: 'strict', checkCrc32: true, checkOverlappingEntry: true });
      if (size !== data.length) throw new Error(`ZIP 条目大小不符：${entry.filename}`);
      if (await sha256Hex(data) !== trusted.sha256) { skipped++; continue; } // same size, other content
      await store.put(trusted, data, { signal });
      imported++;
      addFile(status, trusted);
      onProgress({ ...status });
    }
    if (!imported) throw new Error('ZIP 中没有与本站清单匹配的资源（资源包版本不同）');
    return { ...status, imported, skipped };
  } catch (error) {
    if (error.name === 'AbortError' || error.name === 'QuotaExceededError') throw error;
    throw new Error(`ZIP 导入失败：${error.message}${error.reason ? `（${error.reason}）` : ''}`, { cause: error });
  } finally {
    await reader.close();
    await store.save(status);
  }
}

/**
 * Write the complete local resources as the pack `npm run resources:pack` makes (stored entries, the same names), so a
 * player can hand it to friends straight from the site. `writable`: the save dialog's file stream; none ⇒ a Blob.
 * Against the live manifest; every file is read back from the cache and checked against it first.
 * @returns {Promise<{ name: string, blob?: Blob }>} the pack's file name (and the Blob without `writable`)
 */
export async function exportResourceZip(store, { writable = null, signal, onProgress = () => {}, zipjs } = {}) {
  checkAbort(signal);
  zipjs ??= await import('/vendor/zip.module.js');
  const status = await store.reconcile(signal);
  if (!status.complete) throw new Error('资源还没有全部保存：先在线下载或导入，再导出');
  const writer = new zipjs.ZipWriter(writable ?? new zipjs.BlobWriter('application/zip'), {
    level: 0, useWebWorkers: false, lastModDate: new Date('2020-01-01T00:00:00Z'), extendedTimestamp: false,
  });
  let count = 0, bytes = 0;
  try {
    for (const file of store.manifest.files) {
      checkAbort(signal);
      const cached = await store.cache.match(file.url);
      if (!matchesResource(cached, file)) throw new Error(`本地资源已被浏览器清理（${file.url}），请重新下载后再导出`);
      const data = await readBoundedResponse(cached, file.size, signal);
      await verifyBytes(file, data);
      await writer.add(decodeURIComponent(file.url.slice(1)), new zipjs.Uint8ArrayReader(data), { signal });
      count++; bytes += file.size;
      onProgress({ ...status, count, bytes, complete: false });
    }
    const blob = await writer.close();
    return { name: `stronghold-resources-${store.manifest.version.slice(0, 12)}.zip`, ...(writable ? {} : { blob }) };
  } catch (error) {
    await writable?.abort?.(error).catch(() => {});
    throw error;
  }
}
