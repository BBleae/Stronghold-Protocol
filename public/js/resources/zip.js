import { checkAbort } from './common.js';

const MAX_READ_BYTES = 16 * 1024 * 1024;

/** zip.js owns ZIP parsing and decompression. Only manifest entries are extracted and validated.
 * BlobReader seeks by range; bounded writes hold at most one trusted manifest file.
 */
export async function importResourceZip(blob, store, { signal, onProgress = () => {}, zipjs } = {}) {
  checkAbort(signal);
  zipjs ??= await import('/vendor/zip.module.js');
  const expected = new Map(store.manifest.files.map(file => [decodeURIComponent(file.url.slice(1)), file]));
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
    // Unused names and duplicate entries must not reject an otherwise usable pack.
    useWebWorkers: false, strictness: 'balanced', filenameValidation: 'tolerant',
  });
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      checkAbort(signal);
      const trusted = expected.get(entry.filename);
      if (!trusted || entry.directory) continue;
      const url = trusted.url;
      if (seen.has(url)) throw new Error(`Duplicate ZIP resource path: ${entry.filename}`);
      seen.add(url);
      if (entry.symlink || entry.encrypted) throw new Error('Unsupported ZIP resource entry');
      if (entry.uncompressedSize !== trusted.size || !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0 || entry.compressedSize > trusted.size * 1.1 + 65536) throw new Error(`ZIP resource size / 大小不符: ${entry.filename}`);
      const data = new Uint8Array(trusted.size);
      let size = 0;
      await entry.getData(new WritableStream({
        write(chunk) {
          checkAbort(signal);
          if (size + chunk.length > data.length) throw new Error(`ZIP resource size / 大小超出限制: ${entry.filename}`);
          data.set(chunk, size); size += chunk.length;
        },
      }), { signal, strictness: 'strict', checkCrc32: true, checkOverlappingEntry: true });
      if (size !== data.length) throw new Error(`ZIP resource size / 大小不符: ${entry.filename}`);
      await store.put(trusted, data, { signal });
      if (!status.present.has(url)) { status.present.add(url); status.count++; status.bytes += size; }
      onProgress({ ...status, complete: status.count === status.total, phase: 'import', file: url });
    }
    if (!seen.size) throw new Error('No matching ZIP resources / ZIP 中没有与本站清单匹配的资源');
    status.complete = status.count === status.total;
    return status;
  } catch (error) {
    if (error.name === 'AbortError' || error.name === 'QuotaExceededError') throw error;
    throw new Error(`ZIP resource import: ${error.message}${error.reason ? ` (${error.reason})` : ''}`, { cause: error });
  } finally {
    await reader.close();
  }
}
