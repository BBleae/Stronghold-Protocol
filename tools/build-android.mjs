#!/usr/bin/env node
// The Android app's resources (docs/ANDROID.md): the files of a game server's /resource-manifest.json — every
// /assets/… and /fonts/… file the site publishes — written to android/app/src/main/assets/game/<url path> with a
// manifest.json of what was bundled. The app answers the server's requests for those files from the APK while the
// server still lists the same sha256 (android/…/BundledAssets.java); the game's code always comes from the server.
//
//   node tools/build-android.mjs [--server=https://stronghold.lunar.ag] [--lite]
//
// A file already under public/ with the listed size and sha256 is linked (or copied); any other is downloaded from the
// server and checked. --lite writes no files (an APK that downloads everything, for trying the app quickly).

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'android/app/src/main/assets/game');
const DEFAULT_SERVER = 'https://stronghold.lunar.ag';
const PARALLEL = 8;

const arg = (name) => process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const value = (name, fallback) => { const a = arg(name); return a && a.includes('=') ? a.slice(a.indexOf('=') + 1) : fallback; };

async function sha256(file) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

async function localMatch(file, entry) {
  try {
    const st = await fs.stat(file);
    return st.isFile() && st.size === entry.size && (await sha256(file)) === entry.sha256;
  } catch {
    return false;
  }
}

async function download(server, entry, target) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(server + entry.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const sum = createHash('sha256').update(buf).digest('hex');
      if (sum !== entry.sha256) throw new Error(`sha256 ${sum} ≠ ${entry.sha256}`);
      await fs.writeFile(target, buf);
      return;
    } catch (err) {
      if (attempt >= 3) throw new Error(`${entry.url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function main() {
  const server = value('server', DEFAULT_SERVER).replace(/\/+$/, '');
  const lite = !!arg('lite');
  const res = await fetch(`${server}/resource-manifest.json`, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`${server}/resource-manifest.json: HTTP ${res.status}`);
  const manifest = await res.json();
  if (!Array.isArray(manifest.files)) throw new Error('resource manifest without files');

  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
  const bundled = [];
  let linked = 0, downloaded = 0;
  const failed = [];
  if (!lite) {
    const queue = manifest.files.filter((f) => /^\/(assets|fonts)\//.test(f.url) && !f.url.split('/').some((s) => s === '..'));
    const worker = async () => {
      for (let entry; (entry = queue.shift()); ) {
        const rel = decodeURIComponent(entry.url);
        const target = path.join(OUT, rel);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const local = path.join(ROOT, 'public', rel);
        try {
          if (await localMatch(local, entry)) {
            try { await fs.link(local, target); } catch { await fs.copyFile(local, target); }
            linked++;
          } else {
            await download(server, entry, target);
            downloaded++;
          }
          bundled.push({ url: entry.url, sha256: entry.sha256, size: entry.size, type: entry.type });
        } catch (err) {
          failed.push(err.message);
        }
        const done = linked + downloaded + failed.length;
        if (done % 500 === 0) console.log(`  ${done} / ${manifest.files.length}`);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
  }
  bundled.sort((a, b) => (a.url < b.url ? -1 : 1));
  await fs.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify({ format: 1, server, version: manifest.version, files: bundled }));
  const mib = (bundled.reduce((n, f) => n + f.size, 0) / 1048576).toFixed(1);
  console.log(`android: ${bundled.length} files (${mib} MiB) from ${server} — ${linked} from public/, ${downloaded} downloaded`);
  if (failed.length) {
    console.error(`android: ${failed.length} file(s) not bundled (the app downloads them):\n  ${failed.slice(0, 20).join('\n  ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
