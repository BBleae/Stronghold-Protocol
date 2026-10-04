import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseRange, packSlices, servePack, PACK_PATH } from '../../worker/pack.js';
import worker from '../../worker/index.js';

test('parseRange: one range of the file, suffix and open ranges; anything else is the whole file', () => {
  assert.equal(parseRange(null, 10), null);
  assert.equal(parseRange('bytes=0-1,4-5', 10), null);
  assert.deepEqual(parseRange('bytes=2-4', 10), { start: 2, end: 4 });
  assert.deepEqual(parseRange('bytes=7-', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=5-99', 10), { start: 5, end: 9 });
  assert.equal(parseRange('bytes=10-', 10), 'invalid');
  assert.equal(parseRange('bytes=4-2', 10), 'invalid');
  assert.equal(parseRange('bytes=-0', 10), 'invalid');
});

test('packSlices: the parts and offsets covering a byte range', () => {
  const parts = [{ url: '/a', size: 4 }, { url: '/b', size: 4 }, { url: '/c', size: 2 }];
  assert.deepEqual(packSlices(parts, 0, 9), [{ url: '/a', from: 0, to: 3, whole: true }, { url: '/b', from: 0, to: 3, whole: true }, { url: '/c', from: 0, to: 1, whole: true }]);
  assert.deepEqual(packSlices(parts, 3, 8), [{ url: '/a', from: 3, to: 3, whole: false }, { url: '/b', from: 0, to: 3, whole: true }, { url: '/c', from: 0, to: 0, whole: false }]);
  assert.deepEqual(packSlices(parts, 5, 6), [{ url: '/b', from: 1, to: 2, whole: false }]);
});

/** Static assets with Range support, like Workers Static Assets. */
function assetsOf(files, ranges = true) {
  return { async fetch(request) {
    const body = files[new URL(request.url).pathname];
    if (body == null) return new Response('not found', { status: 404 });
    const bytes = new TextEncoder().encode(body);
    const m = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get('Range') || '');
    if (!m || !ranges) return new Response(bytes);
    return new Response(bytes.slice(Number(m[1]), Number(m[2]) + 1), { status: 206 });
  } };
}

test('GET /stronghold-resources.zip: the parts back to back, ranges, HEAD, and no pack ⇒ 404', async () => {
  const index = { name: 'stronghold-resources-abc.zip', version: 'abc', size: 10, parts: [{ url: '/pack/abc/part-000.bin', size: 4 }, { url: '/pack/abc/part-001.bin', size: 4 }, { url: '/pack/abc/part-002.bin', size: 2 }] };
  const env = { ASSETS: assetsOf({ '/pack/index.json': JSON.stringify(index), '/pack/abc/part-000.bin': 'PK01', '/pack/abc/part-001.bin': '2345', '/pack/abc/part-002.bin': '67' }) };
  const get = (headers = {}, method = 'GET') => worker.fetch(new Request(`https://game.example${PACK_PATH}`, { method, headers }), env);
  const all = await get();
  assert.equal(all.status, 200);
  assert.equal(await all.text(), 'PK01234567');
  assert.equal(all.headers.get('Content-Length'), '10');
  assert.equal(all.headers.get('Content-Type'), 'application/zip');
  assert.match(all.headers.get('Content-Disposition'), /stronghold-resources-abc\.zip/);
  assert.equal(all.headers.get('Accept-Ranges'), 'bytes');
  const part = await get({ Range: 'bytes=3-8' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('Content-Range'), 'bytes 3-8/10');
  assert.equal(await part.text(), '123456');
  assert.equal((await get({ Range: 'bytes=3-8', 'If-Range': '"old"' })).status, 200, 'another version: the whole file');
  assert.equal((await get({ Range: 'bytes=20-' })).status, 416);
  const head = await get({}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Length'), '10');
  assert.equal((await get({}, 'POST')).status, 405);
  assert.equal((await servePack(new Request(`https://game.example${PACK_PATH}`), { ASSETS: assetsOf({}) })).status, 404);
  // Static Assets ignore Range (the whole part comes back): the cut parts are trimmed by the Worker
  const plain = { ASSETS: assetsOf({ '/pack/index.json': JSON.stringify(index), '/pack/abc/part-000.bin': 'PK01', '/pack/abc/part-001.bin': '2345', '/pack/abc/part-002.bin': '67' }, false) };
  for (const [range, want] of [['bytes=3-8', '123456'], ['bytes=5-6', '34'], ['bytes=0-0', 'P'], ['bytes=-3', '567']]) {
    const r = await worker.fetch(new Request(`https://game.example${PACK_PATH}`, { headers: { Range: range } }), plain);
    assert.equal(r.status, 206);
    assert.equal(await r.text(), want, range);
  }
});

test('build: writePackParts cuts the resource ZIP into parts and indexes them', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sp-pack-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'public/assets/audio'), { recursive: true });
  await writeFile(path.join(root, 'public/assets/audio/a.mp3'), 'a'.repeat(3000));
  await writeFile(path.join(root, 'public/assets/audio/b.mp3'), 'b'.repeat(3000));
  await mkdir(path.join(root, 'data'), { recursive: true });
  await writeFile(path.join(root, 'data/assets.json'), JSON.stringify({ audio: ['/assets/audio/a.mp3', '/assets/audio/b.mp3'] }));
  const { buildResourceManifest } = await import('../../tools/resource-pack.mjs');
  const { writePackParts } = await import('../../tools/build-worker.mjs');
  const manifest = await buildResourceManifest({ root, output: false });
  const out = path.join(root, 'dist/client');
  const index = await writePackParts({ root, out, manifest, partSize: 1024 });
  assert.ok(index.parts.length > 3);
  assert.deepEqual(JSON.parse(await readFile(path.join(out, 'pack/index.json'), 'utf8')), index);
  const zip = await readFile(path.join(root, '.cache', index.name));
  assert.equal(index.size, zip.length);
  const joined = Buffer.concat(await Promise.all(index.parts.map((p) => readFile(path.join(out, ...p.url.slice(1).split('/'))))));
  assert.ok(joined.equals(zip), 'the parts are the ZIP');
  assert.equal((await readdir(path.join(out, 'pack', manifest.version.slice(0, 12)))).length, index.parts.length);
});
