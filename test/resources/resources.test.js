import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Zip, ZipPassThrough, zipSync, unzipSync } from 'fflate';
import { buildResourceManifest, validateManifest, writeResourcePack } from '../../tools/resource-pack.mjs';
import { ResourceStore } from '../../public/js/resources/store.js';
import { importResourceZip } from '../../public/js/resources/zip.js';
import { cachedResponse, resourceKeys } from '../../public/js/resources/service.js';

const zipjs = await import('@zip.js/zip.js');
const ORIGIN = 'https://game.test';
const sha = data => createHash('sha256').update(data).digest('hex');
const bytes = s => new TextEncoder().encode(s);
const entry = (url, text) => ({ url, size: bytes(text).length, sha256: sha(text), type: 'audio/mpeg' });
const manifest = (files, version = 'a'.repeat(64)) => ({ format: 1, version, files, totalBytes: files.reduce((n, f) => n + f.size, 0) });
const absolute = request => new URL(typeof request === 'string' ? request : request.url, ORIGIN).href;

// Cache Storage is not exposed in Node; keep real Request/Response semantics at this boundary.
class MemoryCache {
  values = new Map();
  constructor(log) { this.log = log; }
  async match(key) { this.log.push('match'); return this.values.get(absolute(key))?.clone(); }
  async put(key, response) {
    this.log.push(`put ${new URL(absolute(key)).pathname}`);
    const body = await response.arrayBuffer();
    this.values.set(absolute(key), new Response(body, { status: response.status, headers: response.headers }));
  }
  async delete(key) { return this.values.delete(absolute(key)); }
  async keys() { this.log.push('keys'); return [...this.values.keys()].map(url => new Request(url)); }
}
class MemoryCaches {
  values = new Map();
  log = [];
  async open(name) {
    if (!this.values.has(name)) this.values.set(name, new MemoryCache(this.log));
    return this.values.get(name);
  }
  async keys() { return [...this.values.keys()]; }
  async delete(name) { return this.values.delete(name); }
  async match(key) {
    for (const cache of this.values.values()) {
      const response = await cache.match(key);
      if (response) return response;
    }
    return undefined;
  }
  /** URL path → body text of every entry of one cache. */
  async contents(name) {
    const out = {};
    for (const [url, response] of this.values.get(name).values) out[new URL(url).pathname] = await response.clone().text();
    return out;
  }
}

/** A site: it serves its current manifest and no resource files; records every request. */
function site(files, version = 'a'.repeat(64)) {
  const server = { manifest: manifest(files.map(([url, text]) => entry(url, text)), version), requests: [] };
  server.deploy = (next, nextVersion) => {
    server.manifest = manifest(next.map(([url, text]) => entry(url, text)), nextVersion);
  };
  server.fetcher = async url => {
    server.requests.push(url);
    return url === '/resource-manifest.json' ? Response.json(server.manifest) : new Response('missing', { status: 404 });
  };
  return server;
}

/** The store of a site that serves `siteManifest`. */
const storeOf = (siteManifest, caches = new MemoryCaches()) =>
  new ResourceStore(siteManifest, { caches, fetcher: async () => Response.json(siteManifest) });

/** Import a resource ZIP of these [url, text] files, as a player does. */
const importFiles = (store, files, options = {}) => importResourceZip(
  new Blob([zipSync(Object.fromEntries(files.map(([url, text]) => [url.slice(1), bytes(text)])))]), store, { zipjs, ...options });

test('the build validates manifests: resource paths only, no traversal, unique URLs, consistent sizes', () => {
  const good = manifest([entry('/assets/audio/a.mp3', 'abc')]);
  assert.deepEqual(validateManifest(good), good);
  for (const path of ['/js/main.js', '/assets/a.html', '/assets/a.js', '/assets/../a.png', '/assets/%2e%2e/a.png', '/assets/a.png?x', '//evil.test/a.png', '/assets/a\\b.png']) {
    assert.throws(() => validateManifest(manifest([entry(path, 'abc')])), /resource|path|manifest/i, path);
  }
  assert.throws(() => validateManifest({ ...good, totalBytes: 4 }), /size|total/i);
  assert.throws(() => validateManifest(manifest([good.files[0], good.files[0]])), /duplicate/i);
});

test('manifest build is deterministic, excludes programs and unrelated public files, and packs the ZIP the import accepts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stronghold-resources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'public/assets/audio'), { recursive: true });
  await mkdir(join(root, 'public/fonts'), { recursive: true });
  await writeFile(join(root, 'public/assets/audio/a.mp3'), 'abc');
  await writeFile(join(root, 'public/fonts/a.woff2'), 'font');
  await writeFile(join(root, 'public/assets/no.js'), 'private');
  await writeFile(join(root, 'public/index.html'), 'private');
  const first = await buildResourceManifest({ root });
  const second = await buildResourceManifest({ root, output: false });
  assert.deepEqual(first, second);
  assert.deepEqual(first.files.map(f => f.url), ['/assets/audio/a.mp3', '/fonts/a.woff2']);
  assert.equal(first.totalBytes, 7);
  assert.equal(first.files[0].sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(first.files[0].type, 'audio/mpeg');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'public/resource-manifest.json'), 'utf8')), first);
  const result = await writeResourcePack({ root, manifest: first });
  assert.equal(result.path, join(root, '.cache', `stronghold-resources-${first.version.slice(0, 12)}.zip`), 'named by its resource version');
  const packed = unzipSync(await readFile(result.path));
  assert.deepEqual(Object.keys(packed).sort(), ['assets/audio/a.mp3', 'fonts/a.woff2']);
  assert.equal(new TextDecoder().decode(packed['assets/audio/a.mp3']), 'abc');
  const store = storeOf(first);
  await importResourceZip(new Blob([await readFile(result.path)]), store, { zipjs });
  assert.equal((await store.check()).complete, true);
  await assert.rejects(writeResourcePack({ root, manifest: first, output: join(root, 'public/resources.zip') }), /public|deploy/i);
  await writeFile(join(root, 'public/assets/audio/a.mp3'), 'changed');
  assert.notEqual((await buildResourceManifest({ root, output: false })).version, first.version);
});

test('a new site version drops only the files it changed; one cache; its ZIP completes the installation', async () => {
  const caches = new MemoryCaches();
  const v1 = [['/assets/a.mp3', 'abc'], ['/assets/b.mp3', 'old']];
  const v2 = [['/assets/a.mp3', 'abc'], ['/assets/b.mp3', 'new'], ['/assets/c.mp3', 'add']];
  const server = site(v1);
  assert.equal((await importFiles(await ResourceStore.load({ caches, fetcher: server.fetcher }), v1)).complete, true);
  server.deploy(v2, 'b'.repeat(64));
  const store = await ResourceStore.load({ caches, fetcher: server.fetcher });
  const before = await store.check();
  assert.deepEqual([before.count, before.total, before.complete], [1, 3, false], 'the changed file no longer counts');
  assert.deepEqual(await caches.keys(), ['stronghold-resources']);
  const { '/resource-cache-status.json': status, ...files } = await caches.contents('stronghold-resources');
  assert.deepEqual(files, { '/assets/a.mp3': 'abc' }, 'the worker no longer answers the changed file');
  assert.deepEqual(JSON.parse(status), { version: 'b'.repeat(64), count: 1, bytes: 3 });
  assert.equal((await importFiles(store, v2)).complete, true);
  assert.deepEqual(server.requests.filter(url => url !== '/resource-manifest.json'), [], 'only the manifest comes from the site');
});

/** Store an entry the way the version-keyed caches of earlier releases did (Accept-Ranges included). */
const legacyPut = async (caches, name, url, text) => (await caches.open(name)).put(url, new Response(text, { headers: {
  'Content-Type': 'audio/mpeg', 'Content-Length': String(bytes(text).length), 'Accept-Ranges': 'bytes', 'X-Resource-SHA256': sha(text) } }));
const copies = caches => caches.log.filter(op => op.startsWith('put '));

test('the version-keyed caches of earlier releases are adopted in place, merged and deleted', async () => {
  const caches = new MemoryCaches();
  const old = `stronghold-resources-v1-${'c'.repeat(64)}`;
  await legacyPut(caches, old, '/assets/a.mp3', 'abc');
  await legacyPut(caches, old, '/assets/b.mp3', 'old');
  await legacyPut(caches, old, '/assets/gone.mp3', 'x');
  await legacyPut(caches, `stronghold-resources-v1-${'d'.repeat(64)}`, '/assets/b.mp3', 'new');
  await legacyPut(caches, `stronghold-resources-v1-${'d'.repeat(64)}`, '/assets/c.mp3', 'add');
  await caches.open('application-unrelated');
  const live = [['/assets/a.mp3', 'abc'], ['/assets/b.mp3', 'new'], ['/assets/c.mp3', 'add']];
  const server = site(live, 'e'.repeat(64));
  const store = await ResourceStore.load({ caches, fetcher: server.fetcher });
  caches.log.length = 0;
  const status = await store.check();
  assert.equal(status.complete, true);
  assert.deepEqual(await caches.keys(), [old, 'application-unrelated'], 'the fullest cache stays, the other is gone');
  const { '/resource-cache-status.json': _, ...files } = await caches.contents(old);
  assert.deepEqual(files, { '/assets/a.mp3': 'abc', '/assets/b.mp3': 'new', '/assets/c.mp3': 'add' });
  assert.deepEqual(copies(caches), ['put /assets/b.mp3', 'put /assets/c.mp3', 'put /resource-cache-status.json'], 'only what it lacked');
  // New files go to the adopted cache too.
  server.deploy([...live, ['/assets/d.mp3', 'more']], 'f'.repeat(64));
  assert.equal((await importFiles(store, [['/assets/d.mp3', 'more']])).complete, true);
  assert.deepEqual(await caches.keys(), [old, 'application-unrelated']);
});

test('a complete later installation stays in place: it is not copied into an older partial cache', async () => {
  const caches = new MemoryCaches();
  const partial = `stronghold-resources-v1-${'c'.repeat(64)}`;
  const complete = `stronghold-resources-v1-${'d'.repeat(64)}`;
  const files = [['/assets/a.mp3', 'abc'], ['/assets/b.mp3', 'def'], ['/assets/c.mp3', 'ghi']];
  await legacyPut(caches, partial, '/assets/a.mp3', 'abc');
  for (const [url, text] of files) await legacyPut(caches, complete, url, text);
  const server = site(files);
  const store = await ResourceStore.load({ caches, fetcher: server.fetcher });
  caches.log.length = 0;
  assert.equal((await store.check()).complete, true);
  assert.deepEqual(await caches.keys(), [complete]);
  assert.deepEqual(copies(caches), ['put /resource-cache-status.json'], 'no file copied');
});

test('checking an unchanged installation reads one status entry instead of scanning the cache', async () => {
  const caches = new MemoryCaches();
  const files = Array.from({ length: 50 }, (_, i) => [`/assets/f${i}.mp3`, `body ${i}`]);
  const server = site(files);
  await importFiles(await ResourceStore.load({ caches, fetcher: server.fetcher }), files);
  caches.log.length = 0;
  const status = await (await ResourceStore.load({ caches, fetcher: server.fetcher })).check();
  assert.deepEqual([status.count, status.complete], [50, true]);
  assert.deepEqual(caches.log, ['match']);
});

test('only files that match the manifest enter the cache', async () => {
  const a = entry('/assets/a.mp3', 'abc');
  const store = storeOf(manifest([a]));
  await store.reconcile();
  await assert.rejects(store.put(a, bytes('abd')), /校验失败/);
  await assert.rejects(store.put(a, bytes('toolong')), /大小/);
  assert.equal((await store.reconcile()).count, 0);
});

test('a page loaded before a deploy brings the cache to the live version, never back to its own', async () => {
  const caches = new MemoryCaches();
  const server = site([['/assets/a.mp3', 'abc'], ['/assets/b.mp3', 'old']]);
  const stale = await ResourceStore.load({ caches, fetcher: server.fetcher });
  const v2 = [['/assets/a.mp3', 'abc'], ['/assets/b.mp3', 'new']];
  server.deploy(v2, 'b'.repeat(64));
  // A page of the new version installs it; then the old page checks.
  await importFiles(await ResourceStore.load({ caches, fetcher: server.fetcher }), v2);
  const status = await stale.check();
  assert.deepEqual([status.version, status.complete], ['b'.repeat(64), true]);
  const { '/resource-cache-status.json': _, ...files } = await caches.contents('stronghold-resources');
  assert.deepEqual(files, { '/assets/a.mp3': 'abc', '/assets/b.mp3': 'new' });

  // A ZIP of the live site imported into the old page imports whole, for the live version.
  server.deploy([['/assets/a.mp3', 'abc'], ['/assets/b.mp3', 'newer']], 'c'.repeat(64));
  const imported = await importFiles(stale, [['/assets/a.mp3', 'abc'], ['/assets/b.mp3', 'newer']]);
  assert.deepEqual([imported.version, imported.complete, imported.imported, imported.skipped], ['c'.repeat(64), true, 2, 0]);
});

test('a cancelled import keeps the files it stored; a full disk stops it at once; clearing leaves unrelated caches alone', async () => {
  const files = [['/assets/a.mp3', 'abc'], ['/assets/b.mp3', 'def']];
  const siteManifest = manifest(files.map(([url, text]) => entry(url, text)));
  const caches = new MemoryCaches();
  const store = storeOf(siteManifest, caches);
  const ctrl = new AbortController();
  const onProgress = status => { if (status.count === 1) ctrl.abort(); };
  await assert.rejects(importFiles(store, files, { signal: ctrl.signal, onProgress }), { name: 'AbortError' });
  assert.equal((await store.check()).count, 1);

  // A disk without room for resource files.
  const attempts = [];
  class FullCaches extends MemoryCaches {
    async open(name) {
      const cache = await super.open(name);
      const put = cache.put.bind(cache);
      cache.put = async (key, response) => {
        if (!absolute(key).includes('/assets/')) return put(key, response);
        attempts.push(new URL(absolute(key)).pathname);
        throw new DOMException('full', 'QuotaExceededError');
      };
      return cache;
    }
  }
  await assert.rejects(importFiles(storeOf(siteManifest, new FullCaches()), files), { name: 'QuotaExceededError' });
  assert.deepEqual(attempts, ['/assets/a.mp3'], 'no next file');

  await caches.open('application-unrelated');
  await store.clear();
  assert.deepEqual(await caches.keys(), ['application-unrelated']);
  assert.equal((await store.check()).count, 0);
});

test('a cache deleted during an import takes its status entry along: the next check reports what is stored', async () => {
  const caches = new MemoryCaches();
  const files = [['/assets/a.mp3', 'abc'], ['/assets/b.mp3', 'def'], ['/assets/c.mp3', 'ghi']];
  const server = site(files);
  const store = await ResourceStore.load({ caches, fetcher: server.fetcher });
  // The player clears the site's data after the first file.
  const onProgress = status => { if (status.count === 1) void caches.delete('stronghold-resources'); };
  await importFiles(store, files, { onProgress });
  assert.deepEqual(await caches.keys(), [], 'nothing re-created under the name');
  const next = await ResourceStore.load({ caches, fetcher: server.fetcher });
  assert.equal((await next.check()).count, 0);
});

test('ZIP imports use the trusted manifest, validate hashes and read files by range', async () => {
  const a = entry('/assets/a.mp3', 'abc');
  const b = entry('/assets/b.mp3', 'def');
  const store = storeOf(manifest([a, b]));
  // Larger than the maximum EOCD search window, so range-based readers must seek
  // without buffering the complete archive. Tiny archives may legitimately fit in one read.
  const local = zipSync({ 'assets/a.mp3': bytes('abc'), 'assets/b.mp3': bytes('def') }, { comment: 'x'.repeat(65535) });
  class LocalFile extends Blob { async arrayBuffer() { throw new Error('must not read whole archive'); } }
  await importResourceZip(new LocalFile([local]), store, { zipjs });
  assert.equal((await store.check()).complete, true);
  for (const [name, content] of [['assets/a.mp3', 'BAD'], ['assets/a.mp3', 'too big']]) {
    const fresh = storeOf(manifest([a]));
    await assert.rejects(importResourceZip(new Blob([zipSync({ [name]: bytes(content) })]), fresh, { zipjs }), /清单/);
    assert.equal((await fresh.check()).count, 0);
  }
});

test('ZIP imports skip unrelated files and directories without validating their paths or contents', async () => {
  const a = entry('/assets/a.mp3', 'abc');
  const b = entry('/fonts/%E5%AD%97%20font.woff2', 'font');
  b.type = 'font/woff2';
  const caches = new MemoryCaches();
  const store = storeOf(manifest([a, b]), caches);
  const archive = zipSync({
    'assets/audio/sfx/player/p_atk/p_atk_archet_s.mp3': bytes('unused'),
    'assets/': new Uint8Array(),
    'README.txt': bytes('instructions'),
    'assets/extra.js': bytes('unused'),
    '../assets/a.mp3': bytes('BAD'),
    'assets/../assets/a.mp3': bytes('BAD'),
    'assets\\a.mp3': bytes('BAD'),
    'assets/a.mp3': bytes('abc'),
    'fonts/字 font.woff2': bytes('font'),
  }, { level: 0 });
  // Corrupt an unused payload; extracting it would fail CRC validation.
  archive[30 + bytes('assets/audio/sfx/player/p_atk/p_atk_archet_s.mp3').length] ^= 0xff;
  const progress = [];
  const status = await importResourceZip(new Blob([archive]), store, { zipjs, onProgress: p => progress.push([p.count, p.bytes]) });
  assert.equal(status.complete, true);
  assert.deepEqual(progress, [[1, 3], [2, 7]]);
  const { '/resource-cache-status.json': _, ...files } = await caches.contents('stronghold-resources');
  assert.deepEqual(files, { [a.url]: 'abc', [b.url]: 'font' });
});

test('ZIP imports accept large unrelated payloads and repeated unrelated entries', async () => {
  const a = entry('/assets/a.mp3', 'abc');
  const store = storeOf(manifest([a]));
  const parts = [];
  const archive = new Zip((error, data) => { assert.ifError(error); parts.push(data); });
  for (const [name, data] of [
    ['README.txt', new Uint8Array(2 * 1024 * 1024)],
    ['assets/a.mp3', bytes('abc')],
    ['README.txt', bytes('duplicate unused file')],
  ]) {
    const file = new ZipPassThrough(name);
    archive.add(file); file.push(data, true);
  }
  archive.end();
  const status = await importResourceZip(new Blob(parts), store, { zipjs });
  assert.equal(status.complete, true);
  assert.equal(status.count, 1);
  assert.equal(status.bytes, 3);
});

test('ZIP imports report no matching resources without changing existing progress', async () => {
  const a = entry('/assets/a.mp3', 'abc');
  const store = storeOf(manifest([a]));
  await store.reconcile();
  await store.put(a, bytes('abc'));
  await assert.rejects(importResourceZip(new Blob([zipSync({ 'README.txt': bytes('unused') })]), store, { zipjs }), /没有.*匹配/);
  assert.equal((await store.check()).complete, true);
});

test('ZIP import rejects missing end records, forged sizes and duplicate entries', async () => {
  const a = entry('/assets/a.mp3', 'abc');
  const archive = zipSync({ 'assets/a.mp3': bytes('abc') });
  const fresh = () => storeOf(manifest([a]));
  await assert.rejects(importResourceZip(new Blob([archive.slice(0, -22)]), fresh(), { zipjs }), /ZIP/);
  const forged = archive.slice();
  new DataView(forged.buffer).setUint32(22, 10000000, true);
  await assert.rejects(importResourceZip(new Blob([forged]), fresh(), { zipjs }), /size|大小|ambiguous/i);
  const duplicateParts = [];
  const duplicate = new Zip((error, data) => { assert.ifError(error); duplicateParts.push(data); });
  for (let i = 0; i < 2; i++) { const file = new ZipPassThrough('assets/a.mp3'); duplicate.add(file); file.push(bytes('abc'), true); }
  duplicate.end();
  const pair = storeOf(manifest([a, entry('/assets/b.mp3', 'def')]));
  await assert.rejects(importResourceZip(new Blob(duplicateParts), pair, { zipjs }), /重复|duplicate|ambiguous/i);
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
  const store = storeOf(manifest([file]));
  await importResourceZip(new Blob(parts), store, { zipjs });
  assert.equal((await store.check()).complete, true);
});

test('a pack of another deployment imports the files that match and skips the rest', async () => {
  const a = entry('/assets/a.mp3', 'abc');
  const b = entry('/assets/b.mp3', 'def');
  const c = entry('/assets/c.mp3', 'ghi');
  const caches = new MemoryCaches();
  const store = storeOf(manifest([a, b, c]), caches);
  // a matches; b has another hash; c has another size; unrelated names must not block either behavior.
  const pack = zipSync({ 'assets/a.mp3': bytes('abc'), 'assets/b.mp3': bytes('XYZ'),
    'assets/c.mp3': bytes('old-size'), 'assets/old.mp3': bytes('old'), '../unused.txt': bytes('unused') });
  const status = await importResourceZip(new Blob([pack]), store, { zipjs });
  assert.equal(status.imported, 1);
  assert.equal(status.skipped, 4);
  assert.equal(status.complete, false);
  const { '/resource-cache-status.json': _, ...files } = await caches.contents('stronghold-resources');
  assert.deepEqual(Object.keys(files), ['/assets/a.mp3']);
  // nothing matches at all: refused, so the player knows the pack is for another version
  const other = storeOf(manifest([b]));
  await assert.rejects(importResourceZip(new Blob([pack]), other, { zipjs }), /清单/);
});

test('the service worker maps same-origin GETs of resource files, and /media/ audio to the cached audio file', async () => {
  const keys = (url, init) => resourceKeys(new Request(url, init), ORIGIN);
  assert.deepEqual(keys(`${ORIGIN}/assets/char/a.png?v=2`), ['/assets/char/a.png']);
  assert.deepEqual(keys(`${ORIGIN}/fonts/fonts.css`), ['/fonts/fonts.css']);
  for (const url of ['https://evil.test/assets/a.mp3', `${ORIGIN}/js/main.js`, `${ORIGIN}/api/rooms`, `${ORIGIN}/resource-manifest.json`]) {
    assert.equal(keys(url), null, url);
  }
  assert.equal(keys(`${ORIGIN}/assets/a.mp3`, { method: 'POST' }), null);
  const caches = new MemoryCaches();
  const store = storeOf(manifest([{ ...entry('/assets/audio/bgm/b.ogg', 'ogg'), type: 'audio/ogg' }, entry('/assets/audio/bgm/a.mp3', 'mp3'),
    { ...entry('/assets/audio/bgm/a.ogg', 'ogg'), type: 'audio/ogg' }]), caches);
  await store.reconcile();
  for (const file of store.manifest.files) await store.put(file, bytes(file.url.endsWith('.mp3') ? 'mp3' : 'ogg'));
  const media = async path => (await cachedResponse(keys(`${ORIGIN}${path}`), caches))?.text();
  assert.equal(await media('/media/bgm/a'), 'mp3', 'extension order of shared/media.js: mp3 first');
  assert.equal(await media('/media/bgm/b'), 'ogg');
  assert.equal(await media('/media/bgm/none'), undefined);
});

test('the service worker answers cached files without any manifest; files the cache lacks are a 404, without the network', async t => {
  const caches = new MemoryCaches();
  const a = entry('/assets/a.mp3', 'abc');
  const store = storeOf(manifest([a]), caches);
  await store.reconcile();
  await store.put(a, bytes('abc'));
  const listeners = {};
  const network = [];
  const saved = { self: globalThis.self, caches: globalThis.caches, fetch: globalThis.fetch };
  t.after(() => Object.assign(globalThis, saved));
  globalThis.self = { location: new URL(ORIGIN), addEventListener: (type, fn) => { listeners[type] = fn; } };
  globalThis.caches = caches;
  globalThis.fetch = async request => { network.push(new URL(request.url).pathname); return new Response('network'); };
  await import('../../public/resource-sw.js');
  const request = async path => {
    let answer = null;
    listeners.fetch({ request: new Request(ORIGIN + path), respondWith: promise => { answer = promise; } });
    if (!answer) return null;
    const response = await answer;
    return [response.status, await response.text()];
  };
  assert.deepEqual(await request('/assets/a.mp3'), [200, 'abc']);
  for (const path of ['/assets/other.png', '/fonts/f.woff2', '/media/bgm/other']) {
    assert.deepEqual(await request(path), [404, ''], path);
  }
  assert.equal(await request('/js/main.js'), null, 'not answered by the worker');
  assert.deepEqual(network, [], 'no network request, no manifest');
});
