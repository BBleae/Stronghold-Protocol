import { createReadStream } from 'node:fs';
import { mkdir, readdir, writeFile, open, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Zip, ZipPassThrough } from 'fflate';
import { resourceType, validateManifest } from '../public/js/resources/common.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** root is the repository root; output defaults to public/resource-manifest.json; false means no write. */
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
  const path = resolve(output ?? join(root, '.cache', `stronghold-resources-${manifest.version}.zip`));
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

// node tools/resource-pack.mjs [--manifest-only] [--out=DIR]   (DIR: where the ZIP goes, default .cache; not public/)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await buildResourceManifest();
  console.log(`Resources: ${manifest.files.length} files, ${(manifest.totalBytes / 1048576).toFixed(1)} MiB, version ${manifest.version}`);
  const outDir = process.argv.find(a => a.startsWith('--out='))?.slice(6);
  const output = outDir ? join(resolve(outDir), `stronghold-resources-${manifest.version.slice(0, 12)}.zip`) : undefined;
  if (!process.argv.includes('--manifest-only')) console.log(`Local ZIP: ${(await writeResourcePack({ manifest, output })).path}`);
}
