// The complete resource pack as one download: /stronghold-resources.zip.
//
// The build (tools/build-worker.mjs writePackParts) writes the ZIP `npm run resources:pack` makes, cut into parts below
// the 25 MiB Static Assets file limit, plus /pack/index.json { name, version, size, parts: [{ url, size }] }. This
// route serves the parts back to back as one file — one Worker request per download (the parts are static assets:
// free), with Range support so browsers resume and download tools fetch it over several connections. Whole parts are
// piped by the runtime (FixedLengthStream), not copied through JavaScript; Static Assets answer a Range request with
// the whole file, so the at most two parts a range cuts are read and trimmed here (pipeSlice).

export const PACK_PATH = '/stronghold-resources.zip';
export const PACK_INDEX = '/pack/index.json';

/**
 * The byte range a Range header asks for (one range; others ⇒ the whole file), or 'invalid' when unsatisfiable.
 * @param {string|null} header @param {number} size
 * @returns {{ start: number, end: number }|null|'invalid'} inclusive end; null = the whole file
 */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') { const n = Number(m[2]); if (n === 0) return 'invalid'; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return start > end || start >= size ? 'invalid' : { start, end };
}

/**
 * The part slices covering bytes start..end (inclusive) of the concatenation.
 * @param {{ url: string, size: number }[]} parts
 * @returns {{ url: string, from: number, to: number, whole: boolean }[]} inclusive offsets inside each part
 */
export function packSlices(parts, start, end) {
  const out = [];
  let offset = 0;
  for (const p of parts) {
    const first = offset, last = offset + p.size - 1;
    offset += p.size;
    if (last < start || first > end) continue;
    const from = Math.max(start, first) - first, to = Math.min(end, last) - first;
    out.push({ url: p.url, from, to, whole: from === 0 && to === p.size - 1 });
  }
  return out;
}

/** Write bytes from..to (inclusive) of a body that starts at byte 0, then stop reading it. */
export async function pipeSlice(body, writable, from, to) {
  const reader = body.getReader();
  const writer = writable.getWriter();
  let pos = 0;
  try {
    while (pos <= to) {
      const { done, value } = await reader.read();
      if (done) throw new Error('pack part ended early');
      const start = Math.max(from - pos, 0), end = Math.min(to - pos + 1, value.length);
      if (end > start) await writer.write(value.subarray(start, end));
      pos += value.length;
    }
  } finally {
    writer.releaseLock();
    reader.cancel().catch(() => {});
  }
}

const fail = (status, text, headers = {}) => new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });

/** GET / HEAD /stronghold-resources.zip */
export async function servePack(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'GET only', { Allow: 'GET, HEAD' });
  const origin = new URL(request.url).origin;
  const indexResponse = env.ASSETS ? await env.ASSETS.fetch(new Request(origin + PACK_INDEX)) : null;
  if (!indexResponse?.ok) return fail(404, '这次部署没有生成完整资源包');
  const index = await indexResponse.json();
  const parts = Array.isArray(index?.parts) ? index.parts : [];
  const size = parts.reduce((n, p) => n + p.size, 0);
  if (!parts.length || size !== index.size) return fail(500, 'resource pack index is inconsistent');
  const etag = `"${index.version}"`;
  const range = request.headers.get('If-Range') && request.headers.get('If-Range') !== etag ? null : parseRange(request.headers.get('Range'), size);
  if (range === 'invalid') return fail(416, 'range not satisfiable', { 'Content-Range': `bytes */${size}` });
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const length = end - start + 1;
  const headers = {
    'Content-Type': 'application/zip', 'Content-Length': String(length), 'Accept-Ranges': 'bytes', ETag: etag,
    'Content-Disposition': `attachment; filename="${index.name}"`, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  };
  if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
  const { readable, writable } = typeof FixedLengthStream === 'function' ? new FixedLengthStream(length) : new TransformStream();
  const pump = (async () => {
    for (const s of packSlices(parts, start, end)) {
      const response = await env.ASSETS.fetch(new Request(origin + s.url, s.whole ? {} : { headers: { Range: `bytes=${s.from}-${s.to}` } }));
      if (!response.ok || !response.body) throw new Error(`pack part ${s.url}: HTTP ${response.status}`);
      if (s.whole || response.status === 206) await response.body.pipeTo(writable, { preventClose: true });
      else await pipeSlice(response.body, writable, s.from, s.to);
    }
    await writable.close();
  })().catch((error) => writable.abort(error).catch(() => {}));
  void pump;
  return new Response(readable, { status: range ? 206 : 200, headers });
}
