import { createReadStream } from 'node:fs';
import { mkdir, readdir, writeFile, open, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Zip, ZipPassThrough } from 'fflate';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The Workers Static Assets file limit; the import also holds one whole file in memory (public/js/resources/zip.js).
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Content-Type per resource file extension; other files under public/assets and public/fonts are not resources. */
const RESOURCE_TYPES = Object.freeze({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', css: 'text/css; charset=utf-8',
  atlas: 'text/plain; charset=utf-8', obj: 'text/plain; charset=utf-8', json: 'application/json', skel: 'application/octet-stream',
});

function resourceType(url) {
  return RESOURCE_TYPES[url.split('.').pop().toLowerCase()];
}

function validateResourceUrl(url) {
  if (typeof url !== 'string' || !/^\/(assets|fonts)\//.test(url) || /[?#\\\x00-\x1f]/.test(url)) throw new Error(`Invalid resource path: ${url}`);
  let decoded;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    throw new Error(`Invalid resource path encoding: ${url}`);
  }
  const segments = decoded.split('/').slice(1);
  if (/[?#\\\x00-\x1f]/.test(decoded) || segments.some(part => !part || part === '.' || part === '..') || !resourceType(decoded)) {
    throw new Error(`Invalid resource path or type: ${url}`);
  }
}

/**
 * Check a manifest: resource paths only (no traversal, no programs), unique URLs, sizes within the static asset limit,
 * SHA-256 hashes, Content-Types matching the extensions, and the total. The page and the pack trust what passes.
 */
export function validateManifest(manifest) {
  if (manifest?.format !== 1 || !/^[a-f0-9]{64}$/.test(manifest.version) || !Array.isArray(manifest.files)) throw new Error('Invalid resource manifest');
  const urls = new Set();
  let total = 0;
  for (const file of manifest.files) {
    validateResourceUrl(file.url);
    if (urls.has(file.url)) throw new Error(`Duplicate resource URL: ${file.url}`);
    urls.add(file.url);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES) throw new Error(`Invalid resource size: ${file.url}`);
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`Invalid resource hash: ${file.url}`);
    if (file.type !== resourceType(decodeURIComponent(file.url))) throw new Error(`Invalid resource type: ${file.url}`);
    total += file.size;
  }
  if (manifest.totalBytes !== total) throw new Error('Invalid resource manifest total size');
  return manifest;
}

/**
 * The resources the site publishes and a player downloads or imports: every resource file under public/assets and
 * public/fonts — the fetched art and audio, the local client extraction (public/assets/local, listed in
 * data/local-assets.json, which the game prefers where it exists) and the fonts.
 * root is the repository root; output defaults to public/resource-manifest.json; false means no write.
 */
export async function buildResourceManifest({ root = repository, output = join(root, 'public/resource-manifest.json') } = {}) {
  const files = [];
  const publicRoot = join(root, 'public');
  async function walk(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const url = '/' + relative(publicRoot, path).split(sep).map(encodeURIComponent).join('/');
        const type = resourceType(url);
        if (!type) continue;
        const hash = createHash('sha256');
        let size = 0;
        for await (const chunk of createReadStream(path)) { hash.update(chunk); size += chunk.length; }
        files.push({ url, size, sha256: hash.digest('hex'), type });
      }
    }
  }
  await walk(join(publicRoot, 'assets'));
  await walk(join(publicRoot, 'fonts'));
  files.sort((a, b) => a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
  const manifest = validateManifest({ format: 1, version: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files, totalBytes: files.reduce((sum, file) => sum + file.size, 0) });
  if (output !== false) { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(manifest, null, 2) + '\n'); }
  return manifest;
}

/** Stored ZIP entries keep already-compressed assets fast and streamable. ZIP is never a deployment asset. */
export async function writeResourcePack({ root = repository, manifest, output } = {}) {
  manifest = validateManifest(manifest ?? await buildResourceManifest({ root }));
  // Same name as tools/build-worker.mjs writePackParts uses, so `npm run resources:pack` makes the ZIP a build reuses.
  const path = resolve(output ?? join(root, '.cache', `stronghold-resources-${manifest.version.slice(0, 12)}.zip`));
  const publicRoot = resolve(root, 'public');
  const withinPublic = relative(publicRoot, path);
  if (!withinPublic || (!withinPublic.startsWith('..' + sep) && withinPublic !== '..' && !isAbsolute(withinPublic))) throw new Error('Resource ZIP must remain outside the public deployment directory');
  await mkdir(dirname(path), { recursive: true });
  const partial = path + `.partial-${process.pid}`;
  const outputFile = await open(partial, 'w');
  let queued = [], zipError;
  const zip = new Zip((error, chunk) => { if (error) zipError = error; else queued.push(chunk); });
  async function flush() {
    if (zipError) throw zipError;
    for (const chunk of queued) {
      let written = 0;
      while (written < chunk.length) written += (await outputFile.write(chunk, written, chunk.length - written)).bytesWritten;
    }
    queued = [];
  }
  try {
    for (const file of manifest.files) {
      const name = decodeURIComponent(file.url.slice(1));
      const entry = new ZipPassThrough(name);
      entry.mtime = new Date('2020-01-01T00:00:00Z');
      zip.add(entry);
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of createReadStream(join(publicRoot, ...name.split('/')), { highWaterMark: 64 * 1024 })) {
        hash.update(chunk); size += chunk.length; entry.push(chunk); await flush();
      }
      if (size !== file.size || hash.digest('hex') !== file.sha256) throw new Error(`Resource changed while packing: ${file.url}`);
      entry.push(new Uint8Array(), true);
      await flush();
    }
    zip.end();
    await flush();
    await outputFile.close();
    await rename(partial, path);
    return { manifest, path };
  } catch (error) {
    await outputFile.close().catch(() => {});
    await rm(partial, { force: true });
    throw error;
  }
}

// node tools/resource-pack.mjs [--manifest-only]   (the ZIP goes to .cache/, never public/)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await buildResourceManifest();
  console.log(`Resources: ${manifest.files.length} files, ${(manifest.totalBytes / 1048576).toFixed(1)} MiB, version ${manifest.version}`);
  if (!process.argv.includes('--manifest-only')) console.log(`Local ZIP: ${(await writeResourcePack({ manifest })).path}`);
}
