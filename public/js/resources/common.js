// Shared by the page, resource service worker, and local build tool. No code/API cache.
export const CACHE_PREFIX = 'stronghold-resources-v1-';
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const RESOURCE_TYPES = Object.freeze({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', css: 'text/css; charset=utf-8',
  atlas: 'text/plain; charset=utf-8', obj: 'text/plain; charset=utf-8', json: 'application/json', skel: 'application/octet-stream',
});

export function resourceType(url) { return RESOURCE_TYPES[url.split('.').pop().toLowerCase()]; }

export function validateResourceUrl(url) {
  if (typeof url !== 'string' || !/^\/(assets|fonts)\//.test(url) || /[?#\\\x00-\x1f]/.test(url)) throw new Error('Invalid resource path');
  let decoded;
  try { decoded = decodeURIComponent(url); } catch { throw new Error('Invalid resource path encoding'); }
  if (/[?#\\\x00-\x1f]/.test(decoded) || decoded.split('/').slice(1).some(part => !part || part === '.' || part === '..') || !resourceType(decoded)) {
    throw new Error('Invalid resource path or unsupported resource type');
  }
  return url;
}

export function validateManifest(manifest) {
  if (!manifest || manifest.format !== 1 || !/^[a-f0-9]{64}$/.test(manifest.version) || !Array.isArray(manifest.files) || manifest.files.length > 20000) throw new Error('Invalid resource manifest');
  let total = 0;
  const urls = new Set();
  for (const file of manifest.files) {
    validateResourceUrl(file.url);
    if (urls.has(file.url)) throw new Error('Duplicate resource URL');
    urls.add(file.url);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES) throw new Error('Invalid resource size');
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.type !== 'string' || file.type !== resourceType(decodeURIComponent(file.url))) throw new Error('Invalid resource manifest hash or MIME type');
    total += file.size;
  }
  if (!Number.isSafeInteger(total) || manifest.totalBytes !== total) throw new Error('Invalid manifest total size');
  return manifest;
}

export function checkAbort(signal) { if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError'); }

export async function verifyBytes(file, data) {
  if (data.byteLength !== file.size) throw new Error(`Resource size / 大小不符: ${file.url}`);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(n => n.toString(16).padStart(2, '0')).join('');
  if (hash !== file.sha256) throw new Error(`Resource integrity hash / 校验失败: ${file.url}`);
}

export function resourceResponse(file, data) {
  return new Response(data, { headers: {
    'Content-Type': file.type, 'Content-Length': String(file.size), 'Accept-Ranges': 'bytes',
    'X-Resource-SHA256': file.sha256, 'X-Content-Type-Options': 'nosniff',
  } });
}

export function matchesResource(response, file) {
  return response?.status === 200 && response.headers.get('X-Resource-SHA256') === file.sha256 && response.headers.get('Content-Length') === String(file.size);
}

/** Read at most one manifest file, never a whole download/ZIP bundle. */
export async function readBoundedResponse(response, size, signal) {
  if (!response.ok || response.status === 206) throw new Error(`Resource download failed: HTTP ${response.status}`);
  if (!response.body) { if (size === 0) return new Uint8Array(); throw new Error('Missing resource body'); }
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
      if (offset + value.byteLength > size) throw new Error('Resource size / 大小超出清单限制');
      result.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== size) throw new Error('Resource size / 大小不符');
    return result;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function rangeResponse(response, range) {
  const data = await response.arrayBuffer();
  const length = data.byteLength;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  let start, end;
  if (match && (match[1] || match[2])) {
    start = match[1] ? Number(match[1]) : Math.max(0, length - Number(match[2]));
    end = match[1] && match[2] ? Math.min(length - 1, Number(match[2])) : length - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= length) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${length}`, 'Accept-Ranges': 'bytes' } });
  }
  const headers = new Headers(response.headers);
  headers.set('Content-Range', `bytes ${start}-${end}/${length}`);
  headers.set('Content-Length', String(end - start + 1));
  headers.set('Accept-Ranges', 'bytes');
  return new Response(data.slice(start, end + 1), { status: 206, headers });
}
