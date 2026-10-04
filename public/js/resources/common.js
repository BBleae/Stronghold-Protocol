// Helpers shared by the resource store (store.js) and the ZIP import (zip.js).

/**
 * Every resource cache name starts with this. The page keeps one such cache, keyed by URL; each entry names its content
 * with X-Resource-SHA256, so a changed file invalidates only itself. Earlier releases named their caches per site
 * version ('stronghold-resources-v1-<version>'); store.js adopts them in place.
 */
export const CACHE_PREFIX = 'stronghold-resources';

export function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError');
}

export async function sha256Hex(data) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...digest].map(n => n.toString(16).padStart(2, '0')).join('');
}

export async function verifyBytes(file, data) {
  if (data.byteLength !== file.size) throw new Error(`大小不符：${file.url}`);
  if (await sha256Hex(data) !== file.sha256) throw new Error(`校验失败：${file.url}`);
}

/** The cache entry of a verified file. */
export function resourceResponse(file, data) {
  return new Response(data, { headers: {
    'Content-Type': file.type,
    'Content-Length': String(file.size),
    'X-Resource-SHA256': file.sha256,
    'X-Content-Type-Options': 'nosniff',
  } });
}

/** Is this cache entry the manifest's version of the file? */
export function matchesResource(response, file) {
  return response?.status === 200
    && response.headers.get('X-Resource-SHA256') === file.sha256
    && response.headers.get('Content-Length') === String(file.size);
}

/** Read at most one manifest file, never a whole download/ZIP bundle. */
export async function readBoundedResponse(response, size, signal) {
  if (!response.ok || response.status === 206) throw new Error(`HTTP ${response.status}`);
  if (!response.body) {
    if (size === 0) return new Uint8Array();
    throw new Error('响应没有内容');
  }
  const reader = response.body.getReader();
  const result = new Uint8Array(size);
  let offset = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      checkAbort(signal);
      const { value, done } = await reader.read();
      checkAbort(signal);
      if (done) break;
      if (offset + value.byteLength > size) throw new Error('大小超出清单');
      result.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== size) throw new Error('大小不符');
    return result;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
