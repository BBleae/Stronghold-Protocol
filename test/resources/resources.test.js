import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Zip, ZipPassThrough, zipSync, unzipSync } from 'fflate';

const common = await import('../../public/js/resources/common.js').catch(() => ({}));
const storeModule = await import('../../public/js/resources/store.js').catch(() => ({}));
const zipModule = await import('../../public/js/resources/zip.js').catch(() => ({}));
const packModule = await import('../../tools/resource-pack.mjs').catch(() => ({}));
const sha = data => createHash('sha256').update(data).digest('hex');
const bytes = s => new TextEncoder().encode(s);
const entry = (url, text) => ({ url, size: bytes(text).length, sha256: sha(text), type: 'audio/mpeg' });
const manifest = (files, version = 'a'.repeat(64)) => ({ format: 1, version, files, totalBytes: files.reduce((n, f) => n + f.size, 0) });
const absolute = request => new URL(typeof request === 'string' ? request : request.url, 'https://game.test').href;

// Cache Storage is not exposed in Node; retain real Request/Response semantics at this boundary.
class MemoryCache {
  values = new Map();
  async match(key) { return this.values.get(absolute(key))?.clone(); }
  async put(key, response) { this.values.set(absolute(key), new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers })); }
  async keys() { return [...this.values.keys()].map(url => new Request(url)); }
}
class MemoryCaches {
  values = new Map();
  async open(name) { if (!this.values.has(name)) this.values.set(name, new MemoryCache()); return this.values.get(name); }
  async keys() { return [...this.values.keys()]; }
  async delete(name) { return this.values.delete(name); }
}

test('resource manifests reject executable paths, traversal, duplicate URLs and inconsistent sizes', () => {
  assert.equal(typeof common.validateManifest, 'function', 'manifest validation must be implemented');
  const good = manifest([entry('/assets/audio/a.mp3', 'abc')]);
  assert.deepEqual(common.validateManifest(good), good);
  for (const path of ['/js/main.js', '/assets/a.html', '/assets/a.js', '/assets/../a.png', '/assets/%2e%2e/a.png', '/assets/a.png?x', '//evil.test/a.png', '/assets/a\\b.png']) {
    assert.throws(() => common.validateManifest(manifest([entry(path, 'abc')])), /resource|path|manifest/i, path);
  }
  assert.throws(() => common.validateManifest({ ...good, totalBytes: 4 }), /size|total/i);
  assert.throws(() => common.validateManifest(manifest([good.files[0], good.files[0]])), /duplicate/i);
});

test('manifest build is deterministic, excludes programs and unrelated public files, and emits a local-only ZIP', async t => {
  assert.equal(typeof packModule.buildResourceManifest, 'function', 'resource builder must be implemented');
  const root = await mkdtemp(join(tmpdir(), 'stronghold-resources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'public/assets/audio'), { recursive: true });
  await mkdir(join(root, 'public/fonts'), { recursive: true });
  await writeFile(join(root, 'public/assets/audio/a.mp3'), 'abc');
  await writeFile(join(root, 'public/fonts/a.woff2'), 'font');
  await writeFile(join(root, 'public/assets/no.js'), 'private');
  await writeFile(join(root, 'public/index.html'), 'private');
  const first = await packModule.buildResourceManifest({ root });
  const second = await packModule.buildResourceManifest({ root, output: false });
  assert.deepEqual(first, second);
  assert.deepEqual(first.files.map(f => f.url), ['/assets/audio/a.mp3', '/fonts/a.woff2']);
  assert.equal(first.totalBytes, 7);
  assert.equal(first.files[0].sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(first.files[0].type, 'audio/mpeg');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'public/resource-manifest.json'), 'utf8')), first);
  const result = await packModule.writeResourcePack({ root, manifest: first });
  assert.ok(result.path.startsWith(join(root, '.cache')));
  const packed = unzipSync(await readFile(result.path));
  assert.deepEqual(Object.keys(packed).sort(), ['assets/audio/a.mp3', 'fonts/a.woff2']);
  assert.equal(new TextDecoder().decode(packed['assets/audio/a.mp3']), 'abc');
  const packedStore = new storeModule.ResourceStore(first, { caches: new MemoryCaches() });
  await zipModule.importResourceZip(new Blob([await readFile(result.path)]), packedStore, { zipjs: await import('@zip.js/zip.js') });
  assert.equal((await packedStore.status()).complete, true);
  await assert.rejects(packModule.writeResourcePack({ root, manifest: first, output: join(root, 'public/resources.zip') }), /public|deploy/i);
  await writeFile(join(root, 'public/assets/audio/a.mp3'), 'changed');
  assert.notEqual((await packModule.buildResourceManifest({ root, output: false })).version, first.version);
});

test('download retries missing files and reuses installed bytes across versions without refetching', async () => {
  assert.equal(typeof storeModule.ResourceStore, 'function', 'resource store must be implemented');
  const caches = new MemoryCaches();
  const a = entry('/assets/a.mp3', 'abc');
  const b = entry('/assets/b.mp3', 'new');
  const old = new storeModule.ResourceStore(manifest([a]), { caches });
  await old.put(a, bytes('abc'));
  const calls = [];
  const current = new storeModule.ResourceStore(manifest([a, b], 'b'.repeat(64)), { caches, fetcher: async url => {
    calls.push(url); return new Response('new');
  } });
  await current.download();
  assert.deepEqual(calls, ['/assets/b.mp3']);
  assert.equal((await current.status()).complete, true);
  await current.download();
  assert.deepEqual(calls, ['/assets/b.mp3']);
  assert.equal(await (await caches.open(current.cacheName)).match(a.url).then(r => r.text()), 'abc');
});

test('corrupt or oversized downloads never enter the cache; completed files survive retry', async () => {
  assert.equal(typeof storeModule.ResourceStore, 'function');
  const caches = new MemoryCaches();
  const a = entry('/assets/a.mp3', 'abc');
  const b = entry('/assets/b.mp3', 'new');
  let corrupt = true;
  const store = new storeModule.ResourceStore(manifest([a, b]), { caches, fetcher: async url => new Response(url === a.url ? 'abc' : corrupt ? 'bad' : 'new') });
  await assert.rejects(store.download(), /hash|integrity|校验/i);
  assert.equal((await store.status()).count, 1);
  corrupt = false;
  await store.download();
  assert.equal((await store.status()).count, 2);
  await assert.rejects(store.put(a, bytes('toolong')), /size|大小/i);
});

test('cancelled downloads preserve finished files, and clearing does not remove unrelated caches', async () => {
  assert.equal(typeof storeModule.ResourceStore, 'function');
  const caches = new MemoryCaches();
  const ctrl = new AbortController();
  const a = entry('/assets/a.mp3', 'abc');
  const store = new storeModule.ResourceStore(manifest([a, entry('/assets/b.mp3', 'def')]), { caches, fetcher: async () => new Response('abc') });
  await assert.rejects(store.download({ signal: ctrl.signal, onProgress: p => { if (p.count === 1) ctrl.abort(); } }), { name: 'AbortError' });
  assert.equal((await store.status()).count, 1);
  await caches.open('application-unrelated');
  await store.clear();
  assert.deepEqual(await caches.keys(), ['application-unrelated']);
});

test('ZIP imports use the trusted manifest, validate hashes, reject unknown/traversal paths and retain resumable valid files', async () => {
  assert.equal(typeof zipModule.importResourceZip, 'function', 'bounded ZIP import must be implemented');
  const a = entry('/assets/a.mp3', 'abc');
  const b = entry('/assets/b.mp3', 'def');
  const store = new storeModule.ResourceStore(manifest([a, b]), { caches: new MemoryCaches() });
  // Larger than the maximum EOCD search window, so range-based readers must seek
  // without buffering the complete archive. Tiny archives may legitimately fit in one read.
  const local = zipSync({ 'assets/a.mp3': bytes('abc'), 'assets/b.mp3': bytes('def') }, { comment: 'x'.repeat(65535) });
  class LocalFile extends Blob { async arrayBuffer() { throw new Error('must not read whole archive'); } }
  await zipModule.importResourceZip(new LocalFile([local]), store, { zipjs: await import('@zip.js/zip.js') });
  assert.equal((await store.status()).complete, true);
  for (const [name, content] of [['../assets/a.mp3', 'abc'], ['assets/unknown.mp3', 'abc'], ['assets/a.mp3', 'BAD'], ['assets/a.mp3', 'too big']]) {
    const fresh = new storeModule.ResourceStore(manifest([a]), { caches: new MemoryCaches() });
    await assert.rejects(zipModule.importResourceZip(new Blob([zipSync({ [name]: bytes(content) })]), fresh, { zipjs: await import('@zip.js/zip.js') }), /path|filename|unknown|hash|integrity|size|清单|校验|大小/i);
    assert.equal((await fresh.status()).count, 0);
  }
});

test('audio ranges handle closed, open and suffix ranges and reject unsatisfiable ranges', async () => {
  assert.equal(typeof common.rangeResponse, 'function', 'audio ranges must be implemented');
  for (const [range, want, header] of [['bytes=1-3', 'bcd', 'bytes 1-3/6'], ['bytes=3-', 'def', 'bytes 3-5/6'], ['bytes=-2', 'ef', 'bytes 4-5/6']]) {
    const response = await common.rangeResponse(new Response('abcdef', { headers: { 'Content-Type': 'audio/mpeg' } }), range);
    assert.equal(response.status, 206);
    assert.equal(await response.text(), want);
    assert.equal(response.headers.get('Content-Range'), header);
    assert.equal(response.headers.get('Content-Type'), 'audio/mpeg');
  }
  const invalid = await common.rangeResponse(new Response('abc'), 'bytes=9-');
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('Content-Range'), 'bytes */3');
});

test('ZIP import rejects missing end records, forged sizes and duplicate entries', async () => {
  const a = entry('/assets/a.mp3', 'abc');
  const archive = zipSync({ 'assets/a.mp3': bytes('abc') });
  const fresh = () => new storeModule.ResourceStore(manifest([a]), { caches: new MemoryCaches() });
  await assert.rejects(zipModule.importResourceZip(new Blob([archive.slice(0, -22)]), fresh(), { zipjs: await import('@zip.js/zip.js') }), /ZIP|incomplete/i);
  const forged = archive.slice();
  new DataView(forged.buffer).setUint32(22, 10000000, true);
  await assert.rejects(zipModule.importResourceZip(new Blob([forged]), fresh(), { zipjs: await import('@zip.js/zip.js') }), /size|大小|ambiguous/i);
  const duplicateParts = [];
  const duplicate = new Zip((error, data) => { assert.ifError(error); duplicateParts.push(data); });
  for (let i = 0; i < 2; i++) { const file = new ZipPassThrough('assets/a.mp3'); duplicate.add(file); file.push(bytes('abc'), true); }
  duplicate.end();
  const pair = new storeModule.ResourceStore(manifest([a, entry('/assets/b.mp3', 'def')]), { caches: new MemoryCaches() });
  await assert.rejects(zipModule.importResourceZip(new Blob(duplicateParts), pair, { zipjs: await import('@zip.js/zip.js') }), /duplicate|ambiguous/i);
});

test('streamed stored ZIP imports binary files containing ZIP signatures without mistaking them for boundaries', async () => {
  // MP3 frames in the full pack really contain PK local-header bytes. Stored streaming
  // entries have data descriptors, so scanning their payload for signatures truncates them.
  const payload = bytes('audio-prefix' + 'x'.repeat(18000) + 'PK\x03\x04' + '\0'.repeat(60) + 'PK\x07\x08' + 'audio-tail');
  const file = { url: '/assets/embedded.mp3', size: payload.length, sha256: sha(payload), type: 'audio/mpeg' };
  const parts = [];
  const archive = new Zip((error, data) => { assert.ifError(error); parts.push(data); });
  const streamed = new ZipPassThrough('assets/embedded.mp3');
  archive.add(streamed);
  streamed.push(payload, true);
  archive.end();
  const store = new storeModule.ResourceStore(manifest([file]), { caches: new MemoryCaches() });
  await zipModule.importResourceZip(new Blob(parts), store, { zipjs: await import('@zip.js/zip.js') });
  assert.equal((await store.status()).complete, true);
});

test('service worker only serves same-origin manifest resources and supports cached audio ranges', async () => {
  const service = await import('../../public/js/resources/service.js').catch(() => ({}));
  assert.equal(typeof service.handleResourceRequest, 'function', 'resource service worker handler must be implemented');
  const a = entry('/assets/a.mp3', 'abc');
  const trusted = manifest([a]);
  const caches = new MemoryCaches();
  const store = new storeModule.ResourceStore(trusted, { caches });
  await store.put(a, bytes('abc'));
  const opts = { manifest: trusted, caches, origin: 'https://game.test', fetcher: async () => { throw new Error('cached resource should not use the network'); } };
  const result = await service.handleResourceRequest(new Request('https://game.test/assets/a.mp3', { headers: { Range: 'bytes=1-' } }), opts);
  assert.equal(result.status, 206);
  assert.equal(await result.text(), 'bc');
  for (const url of ['https://evil.test/assets/a.mp3', 'https://game.test/js/main.js', 'https://game.test/api/rooms', 'https://game.test/assets/unknown.mp3']) {
    assert.equal(await service.handleResourceRequest(new Request(url), opts), null);
  }
});

test('a complete local installation exports the pack the import accepts (Blob or a save-dialog stream)', async () => {
  const font = { ...entry('/fonts/x.woff2', 'font'), type: 'font/woff2' };
  const m = manifest([entry('/assets/voice/cn/a%20b.mp3', 'abc'), font]);
  const zipjs = await import('@zip.js/zip.js');
  const source = new storeModule.ResourceStore(m, { caches: new MemoryCaches() });
  await source.put(m.files[0], bytes('abc'));
  await assert.rejects(zipModule.exportResourceZip(source, { zipjs }), /全部保存/, 'only a complete installation');
  await source.put(font, bytes('font'));
  const blob = await zipModule.exportResourceZip(source, { zipjs });
  assert.deepEqual(Object.keys(unzipSync(new Uint8Array(await blob.arrayBuffer()))), ['assets/voice/cn/a b.mp3', 'fonts/x.woff2'], 'the CLI pack layout');
  const fromBlob = new storeModule.ResourceStore(m, { caches: new MemoryCaches() });
  await zipModule.importResourceZip(blob, fromBlob, { zipjs });
  assert.equal((await fromBlob.status()).complete, true);
  const chunks = [];
  let closed = false;
  await zipModule.exportResourceZip(source, { zipjs, writable: new WritableStream({ write(c) { chunks.push(c); }, close() { closed = true; } }) });
  assert.ok(closed, 'the file stream is closed (committed)');
  const fromStream = new storeModule.ResourceStore(m, { caches: new MemoryCaches() });
  await zipModule.importResourceZip(new Blob(chunks), fromStream, { zipjs });
  assert.equal((await fromStream.status()).complete, true);
});

test('a pack of another deployment imports the files that match and skips the rest', async () => {
  const a = entry('/assets/a.mp3', 'abc');
  const b = entry('/assets/b.mp3', 'def');
  const c = entry('/assets/c.mp3', 'ghi');
  const store = new storeModule.ResourceStore(manifest([a, b, c]), { caches: new MemoryCaches() });
  // a matches; b has other bytes of the same size; c is absent; old.mp3 is not on this site
  const pack = zipSync({ 'assets/a.mp3': bytes('abc'), 'assets/b.mp3': bytes('XYZ'), 'assets/old.mp3': bytes('old') });
  const status = await zipModule.importResourceZip(new Blob([pack]), store, { zipjs: await import('@zip.js/zip.js') });
  assert.equal(status.imported, 1);
  assert.equal(status.skipped, 2);
  assert.equal(status.complete, false);
  assert.deepEqual([...(await store.status()).present], ['/assets/a.mp3']);
  // nothing matches at all: refused, so the player knows the pack is for another version
  const other = new storeModule.ResourceStore(manifest([b]), { caches: new MemoryCaches() });
  await assert.rejects(zipModule.importResourceZip(new Blob([pack]), other, { zipjs: await import('@zip.js/zip.js') }), /清单/);
});
