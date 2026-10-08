// Build an allowlisted public tree and bundle the existing game engine for Workers.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { vendor } from './vendor.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIM = "import { getSimData } from './sim/simdata.js';\nexport function getData() { return getSimData() || {}; }\nexport function resetData() {}\n";

async function copyTree(source, target, allow, prefix = '') {
  let entries;
  try { entries = await fs.readdir(source, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const relative = prefix + entry.name;
    if (entry.name.startsWith('.') || entry.isSymbolicLink() || !allow(relative, entry.isDirectory())) continue;
    const destination = path.join(target, entry.name);
    if (entry.isDirectory()) await copyTree(path.join(source, entry.name), destination, allow, relative + '/');
    else if (entry.isFile()) {
      await fs.mkdir(target, { recursive: true });
      await fs.copyFile(path.join(source, entry.name), destination);
    }
  }
}

/** The operators a 自选 slot may field (server/sim/content/kits/index.js KITTED_CHARS), or null for a tree without it. */
async function diyKitted(root) {
  const file = path.join(root, 'server/sim/content/kits/index.js');
  try { await fs.access(file); } catch { return null; }
  const list = (await import(pathToFileURL(file).href)).KITTED_CHARS;
  if (!Array.isArray(list) || list.some((id) => !/^[A-Za-z0-9_]+$/.test(id))) throw new Error('KITTED_CHARS: unexpected operator ids');
  return list;
}

/** data/local-assets.json, or null when this machine has no local client extraction. */
async function readLocalAssets(root) {
  try { return JSON.parse(await fs.readFile(path.join(root, 'data/local-assets.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** The /assets/ files a data/local-assets.json lists (decoded). */
function localAssetPaths(local) {
  const urls = new Set();
  (function walk(value) {
    if (typeof value === 'string') { if (value.startsWith('/assets/')) urls.add(decodeURIComponent(value)); }
    else if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v);
  })(local);
  return [...urls];
}

/** The deployed commit (Workers Builds: WORKERS_CI_COMMIT_SHA; else git), shown by /healthz and the settings. */
export function buildId({ root = ROOT, env = process.env } = {}) {
  const sha = env.WORKERS_CI_COMMIT_SHA || spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim();
  return /^[0-9a-f]{7,40}$/.test(sha || '') ? sha.slice(0, 7) : 'local';
}

/**
 * The public tree in <root>/dist/client. The game's resource files (public/assets, public/fonts) are published as the
 * resource manifest (tools/resource-pack.mjs) lists them, the local client extraction (public/assets/local) included.
 */
export async function copyRuntimeAssets({ root = ROOT, out = path.join(root, 'dist/client'), buildTag = 'local', rulesVersion = 'development-v1', manifest = null } = {}) {
  root = path.resolve(root);
  out = path.resolve(out);
  if (out !== path.join(root, 'dist', 'client')) throw new Error('Build output must be <root>/dist/client');
  // Validate the actual destination before recursively removing a generated tree.
  try {
    const resolved = await fs.realpath(out);
    if (resolved !== out) throw new Error('Refusing to replace a linked build output');
    await fs.rm(out, { recursive: true, force: true });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(out, { recursive: true });
  // Dev pages, ZIPs, logs and source maps stay out; resource files are copied from the manifest below.
  const unpublished = /^(dev|assets|fonts)(\/|$)/;
  await copyTree(path.join(root, 'public'), out, (name) => !unpublished.test(name) && !/\.(zip|log|map)$/i.test(name));
  for (const file of manifest?.files ?? []) {
    const name = decodeURIComponent(file.url.slice(1)).split('/');
    await fs.mkdir(path.join(out, ...name.slice(0, -1)), { recursive: true });
    await fs.copyFile(path.join(root, 'public', ...name), path.join(out, ...name));
  }
  // data/*.json, and data/i18n/<code>.json: the game-text overlays of the language packs (shared/i18nData.js)
  await copyTree(path.join(root, 'data'), path.join(out, 'data'), (name, dir) => (dir ? name === 'i18n' : /^(?:i18n\/)?[^/]+\.json$/.test(name)));
  await writePackTree({ root, out });
  await copyTree(path.join(root, 'shared'), path.join(out, 'shared'), (name, dir) => dir || name.endsWith('.js'));
  await copyTree(path.join(root, 'server/sim'), path.join(out, 'sim'), (name, dir) => dir || (name.endsWith('.js') && !name.toLowerCase().endsWith('nodedata.js')));
  await fs.writeFile(path.join(out, 'data.js'), SHIM);
  // data/local-assets.json lists the local client extraction (public/assets/local), which the game prefers where it
  // exists (official 3D board, module icons, emotes, guide…). It is published when the manifest publishes every file it
  // lists; a build without resource files says there is none, and one that lacks a listed file fails.
  const local = await readLocalAssets(root);
  const published = new Set((manifest?.files ?? []).map((file) => decodeURIComponent(file.url)));
  const missingLocal = localAssetPaths(local).filter((url) => !published.has(url));
  if (manifest && local && missingLocal.length) {
    throw new Error(`data/local-assets.json lists ${missingLocal.length} files the resource manifest lacks, e.g. ${missingLocal[0]}`);
  }
  if (!manifest || !local) {
    await fs.writeFile(path.join(out, 'data/local-assets.json'), JSON.stringify({ version: 1, source: 'none', count: 0, groups: {} }));
  }
  let html = await fs.readFile(path.join(out, 'index.html'), 'utf8');
  // data-sp-rules: the rules version of the page's own simulation (/sim/), compared with a battle's (battle/runner.js)
  // SP_NODE_CLIENT=1 (the node-protocol compatibility deployment, worker/lobby-gateway.js): the page keeps the plain
  // Node client (main.js, no runtime flag) — its /ws carries the whole lobby and there is no account system to boot.
  const nodeClient = process.env.SP_NODE_CLIENT === '1';
  // data-sp-diy-kitted: the operators a 自选 slot may field (the kit registry's KITTED_CHARS, what the room Worker's
  // welcome.diyKitted says): a room Worker's page meets a room only when it enters one, and its menu's 干员调配 offers
  // them from here (worker-entry.js). A Node server sends them in the welcome of every page.
  const kitted = nodeClient ? null : await diyKitted(root);
  html = html.replace('<html ', `<html ${nodeClient ? '' : 'data-sp-runtime="cloudflare" '}data-sp-build="${buildTag}" data-sp-rules="${rulesVersion}" `
    + (kitted ? `data-sp-diy-kitted="${kitted.join(',')}" ` : ''));
  if (!nodeClient) html = html.replace('src="/js/main.js"', 'src="/js/worker-entry.js"');
  // Local fonts and system fallbacks keep the resource gate independent of Google Fonts reachability.
  html = html.replace(/\s*<link[^>]+https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '');
  html = html.replace('</head>', '  <link rel="stylesheet" href="/css/resources.css" />\n</head>');
  await fs.writeFile(path.join(out, 'index.html'), html);
  await fs.writeFile(path.join(out, '_headers'), `# Every rule whose path matches applies, and the values of a header set by several of them are joined:
# each header is set by one rule per path. A path without a Cache-Control rule gets the platform default
# "public, max-age=0, must-revalidate": pages, code, /vendor (it must match the code importing it), data,
# the resource manifest and service worker revalidate on every use. Resource files may be a day old; the parts of
# the resource ZIP are named by its version (/pack/index.json is only read by the Worker).
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
/assets/*
  Cache-Control: public, max-age=86400
/fonts/*
  Cache-Control: public, max-age=86400
/pack/*
  Cache-Control: public, max-age=31536000, immutable
/assets/*.atlas
  Content-Type: text/plain; charset=utf-8
/assets/*.skel
  Content-Type: application/octet-stream
`);
  let count = 0;
  async function check(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await check(file);
      else {
        count++;
        if ((await fs.stat(file)).size > 25 * 1024 * 1024) throw new Error(`Static asset exceeds 25 MiB: ${file}`);
      }
    }
  }
  await check(out);
  if (count > 100000) throw new Error(`Static asset count ${count} exceeds the Workers Paid limit`);
  return { out, count };
}

/**
 * The content packs (docs/PACKS.md) as static files: the Node server answers /packs/index.json from its live registry
 * (server/packs.js) and serves /packs/<id>/<file> from the pack folders; the Worker publishes the index of this checkout's
 * packs (tools/packs.mjs writes the same body for a static host) and every file a folder pack's manifest names. The
 * single-file language packs' files are public/i18n/<code>.json and data/i18n/<code>.json, published with their folders.
 * Without the index the client's language menu offers only Chinese (public/js/ui/lang.js).
 */
async function writePackTree({ root, out }) {
  const { scanPacks, packIndexOf } = await import('../server/packs.js');
  const { PACKS_URL, PACK_INDEX_FILE } = await import('../shared/packs.js');
  const { packs } = scanPacks({ publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data'), packsDir: path.join(root, 'packs') });
  const dir = path.join(out, ...PACKS_URL.split('/').filter(Boolean));
  for (const pack of packs) {
    if (pack.layout !== 'folder') continue;
    for (const file of Object.values(pack.files)) {
      const target = path.join(dir, pack.id, ...file.rel.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(file.abs, target);
    }
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, PACK_INDEX_FILE), JSON.stringify(packIndexOf(packs)));
}

/** Files data/assets.json references (`/assets/…`) that are not under public/ (the whole manifest when it is missing). */
export async function missingAssets({ root = ROOT } = {}) {
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(path.join(root, 'data/assets.json'), 'utf8')); }
  catch { return ['data/assets.json']; }
  const urls = new Set();
  (function walk(value) {
    if (typeof value === 'string') { if (value.startsWith('/assets/')) urls.add(value); }
    else if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v);
  })(manifest);
  const missing = [];
  for (const url of urls) {
    try { await fs.access(path.join(root, 'public', ...decodeURIComponent(url.slice(1)).split('/'))); }
    catch { missing.push(url); }
  }
  return missing;
}

export async function buildWorker({ root = ROOT } = {}) {
  vendor();
  // The game's art and audio are not in the repository. A deployment without them is a site of placeholders with an
  // empty resource manager: download what is missing first (tools/fetch-assets.mjs only fetches missing files), and
  // never deploy without assets.
  const missing = process.env.SP_SKIP_ASSETS === '1' ? [] : await missingAssets({ root });
  if (missing.length) {
    console.log(`Workers build: ${missing.length} game asset files missing — running tools/fetch-assets.mjs`);
    const run = spawnSync(process.execPath, [path.join(root, 'tools/fetch-assets.mjs')], { cwd: root, stdio: 'inherit' });
    if (run.status !== 0) throw new Error('tools/fetch-assets.mjs failed: the game assets could not be downloaded — retry the deploy');
  }
  const { buildReplayVersions, retainedRecovery } = await import('./build-replay.mjs');
  const versions = await buildReplayVersions({ root, bundle: bundleWorker });
  if (!versions.archived) {
    console.warn(`Workers build: rules version ${versions.current} is not archived. Fine for \`wrangler dev\`; deploy only with \`npm run deploy:worker\`.`);
  }
  const { buildResourceManifest } = await import('./resource-pack.mjs');
  const manifest = await buildResourceManifest({ root });
  if (!manifest.files.some((file) => file.url.startsWith('/assets/'))) {
    throw new Error('No game assets under public/assets: run `npm run assets` before deploying (SP_SKIP_ASSETS=1 skips the download, not this check)');
  }
  const buildTag = buildId({ root });
  const assets = await copyRuntimeAssets({ root, buildTag, rulesVersion: versions.current, manifest });
  const pack = await writePackParts({ root, manifest });
  // Every archived replay engine stays published: an old match replays with its own rules (static assets are cheap).
  const published = [...new Set([...versions.entries.map((v) => v.id), versions.current])];
  for (const id of published) {
    const target = path.join(assets.out, 'replay-engines', id);
    await fs.mkdir(target, { recursive: true });
    await fs.copyFile(path.join(root, '.replay-engines', id, 'engine.js'), path.join(target, 'engine.js'));
    if ((await fs.stat(path.join(target, 'engine.js'))).size > 25 * 1024 * 1024) throw new Error('Replay engine exceeds the 25 MiB static asset limit: ' + id);
    assets.count++;
  }
  if (assets.count + pack.parts.length + 1 > 100000) throw new Error('Static assets exceed the 100,000 file limit');
  // The current version restores through the main bundle; a few older ones through their own recovery engine.
  const recovery = retainedRecovery(versions.entries, versions.current);
  await bundleWorker({ root, buildTag, rulesVersion: versions.current, versionModules: recovery, publishedVersions: published });
  const bundleBytes = await fs.readFile(path.join(root, 'dist/worker/index.mjs'));
  const compressed = gzipSync(bundleBytes).length;
  // Cloudflare's September 2026 limit is 64 MiB uncompressed; gzip is informational.
  if (bundleBytes.length > 64 * 1024 * 1024) throw new Error('Worker exceeds the 64 MiB uncompressed limit: lower RECOVERY_RETAINED in tools/build-replay.mjs');
  console.log(`Worker ${(bundleBytes.length / 1024 / 1024).toFixed(2)} MiB uncompressed / gzip ${(compressed / 1024 / 1024).toFixed(2)} MiB; `
    + `rules version ${versions.current}, recovery for ${recovery.length} older version(s), ${published.length} replay engine(s)`);
  console.log(`Workers build: ${assets.count} static files; resource version ${manifest.version}, `
    + `${manifest.files.length} files, ${(manifest.totalBytes / 1024 / 1024).toFixed(1)} MiB`);
  console.log(`Workers build: commit ${buildTag}; resource ZIP ${pack.size} bytes in ${pack.parts.length} parts`);
  return { assets, manifest, pack };
}

/**
 * The complete resource pack (tools/resource-pack.mjs) for /stronghold-resources.zip (worker/pack.js): cut into parts
 * below the 25 MiB Static Assets file limit under <out>/pack/<version>/, with <out>/pack/index.json. The ZIP itself is
 * kept in .cache (outside the deployment) and reused while the resources do not change.
 */
export async function writePackParts({ root = ROOT, out = path.join(root, 'dist/client'), manifest, partSize = 24 * 1024 * 1024 } = {}) {
  const { writeResourcePack } = await import('./resource-pack.mjs');
  const short = manifest.version.slice(0, 12);
  const name = `stronghold-resources-${short}.zip`;
  const zipPath = path.join(root, '.cache', name);
  try { if (!(await fs.stat(zipPath)).size) throw new Error('empty'); }
  catch { await writeResourcePack({ root, manifest, output: zipPath }); }
  const dir = path.join(out, 'pack', short);
  await fs.mkdir(dir, { recursive: true });
  const parts = [];
  const file = await fs.open(zipPath, 'r');
  try {
    const buffer = Buffer.alloc(partSize);
    for (let n = 0; ; n++) {
      let filled = 0;
      while (filled < partSize) {
        const { bytesRead } = await file.read(buffer, filled, partSize - filled, null);
        if (!bytesRead) break;
        filled += bytesRead;
      }
      if (!filled) break;
      const part = `part-${String(n).padStart(3, '0')}.bin`;
      await fs.writeFile(path.join(dir, part), buffer.subarray(0, filled));
      parts.push({ url: `/pack/${short}/${part}`, size: filled });
      if (filled < partSize) break;
    }
  } finally { await file.close(); }
  const size = parts.reduce((n, p) => n + p.size, 0);
  const index = { name, version: manifest.version, size, parts };
  await fs.writeFile(path.join(out, 'pack', 'index.json'), JSON.stringify(index));
  return index;
}

export async function bundleWorker({ root = ROOT, outfile = path.join(root, 'dist/worker/index.mjs'),
  buildTag = 'local', entry = 'worker/entry.js', rulesVersion = 'development-v1', versionModules = [], publishedVersions = [] } = {}) {
  const replacements = new Map([
    [path.join(root, 'server/data-node.js'), path.join(root, 'worker/data-loader.js')],
    [path.join(root, 'server/sim/nodeData.js'), path.join(root, 'worker/sim-data-loader.js')],
  ]);
  // The Node/browser content loaders intentionally catch missing optional modules. Their dynamic imports cannot be
  // discovered by a bundler: enumerate the same supported modules with literal imports. content/index.js loads the kit
  // registry and the domain modules by path (import(path)); kits/index.js one file per kit (import(`./ops/${file}`)) over
  // its three lists, read from the module itself so a new kit file needs no change here.
  const { KIT_FILES, STANDIN_KIT_FILES, OPERATOR_KIT_FILES } = await import(pathToFileURL(path.join(root, 'server/sim/content/kits/index.js')).href);
  const contentImports = new Map([
    [path.join(root, 'server/sim/content/index.js'), { call: 'import(path)', key: 'path', imports: [
      './kits/index.js',
      ...['tokens', 'devices', 'enemies', 'bosses', 'bonds', 'garrisons', 'items', 'bands', 'choices'].map(n => `./${n}.js`),
    ] }],
    [path.join(root, 'server/sim/content/kits/index.js'), { call: 'import(`./ops/${file}`)', key: '`./ops/${file}`',
      imports: [...KIT_FILES.flat(), ...STANDIN_KIT_FILES, ...OPERATOR_KIT_FILES].map(file => `./ops/${file}`) }],
    [path.join(root, 'server/sim/content/bands.js'), { call: 'import(path)', key: 'path', imports: ['./bands/battle.js', './bands/meta.js'] }],
    [path.join(root, 'server/sim/content/bonds.js'), { call: 'import(path)', key: 'path', imports: ['./bonds/core.js', './bonds/addon.js', './support/meta.js'] }],
  ]);
  const result = await build({
    entryPoints: [path.join(root, entry)],
    outfile,
    bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
    external: ['node:*', 'cloudflare:*'], minify: true, keepNames: true, metafile: true,
    define: { __SP_BUILD__: JSON.stringify(buildTag), __SP_RULES_VERSION__: JSON.stringify(rulesVersion) },
    plugins: [{ name: 'worker-data-loaders', setup(builder) {
      // Keep immutable recovery bundles, but initialize only the version a room restores.
      // Eagerly initializing every historical engine exceeds the Worker startup CPU budget.
      builder.onLoad({ filter: /\.mjs$/ }, async (args) => {
        if (!versionModules.some((v) => path.resolve(v.file || path.join(root, '.replay-engines', v.id, 'recovery.mjs')) === args.path)) return;
        let source = await fs.readFile(args.path, 'utf8');
        // Restoration compares only view/RNG. Avoid cloning the entire event history
        // in old exportMatch implementations just to discard that clone immediately.
        const eventDefault = /referenceEvents:([A-Za-z_$][\w$]*)=!1/g;
        if ([...source.matchAll(eventDefault)].length !== 1) throw new Error('Unsupported recovery event export: ' + args.path);
        source = source.replace(eventDefault, 'referenceEvents:$1=!0');
        const exports = source.match(/export\{([^}]+)\};\s*$/);
        if (!exports) throw new Error('Unsupported retained recovery exports: ' + args.path);
        // minified names may contain `$` (export{YM as create,$M as restore})
        const pairs = exports[1].split(',').map((s) => {
          const m = s.trim().match(/^([\w$]+) as ([\w$]+)$/);
          if (!m) throw new Error(`Unsupported recovery export "${s.trim()}": ${args.path}`);
          return `${m[2]}:${m[1]}`;
        });
        const body = source.slice(0, exports.index) + `return {${pairs.join(',')}};`;
        return { loader: 'js', contents: `let cached,pending;export async function prepare(){return cached || (pending ||= (async()=>{${body}})().then(value=>cached=value));}export function restore(...args){if(!cached)throw new Error('Recovery engine not prepared');return cached.restore(...args);}` };
      });
      // worker/match-versions.js of this build: the retained recovery engines and the published replay versions
      if (versionModules.length || publishedVersions.length) builder.onLoad({ filter: /[\\/]worker[\\/]match-versions\.js$/ }, () => {
        const file = (v) => JSON.stringify(v.file || path.join(root, '.replay-engines', v.id, 'recovery.mjs'));
        const restores = versionModules.map((v, i) => `${JSON.stringify(v.id)}: r${i}`).join(', ');
        const preparers = versionModules.map((v, i) => `${JSON.stringify(v.id)}: p${i}`).join(', ');
        return { loader: 'js', contents: [
          ...versionModules.map((v, i) => `import { restore as r${i}, prepare as p${i} } from ${file(v)};`),
          `export const retainedMatchVersions = { ${restores} };`,
          `const preparers = { ${preparers} };`,
          'export async function prepareMatchVersion(id) { await preparers[id]?.(); }',
          `export const publishedRulesVersions = ${JSON.stringify(publishedVersions)};`,
        ].join('\n') };
      });
      builder.onResolve({ filter: /(?:data-node|nodeData)\.js$/ }, args => {
        const replacement = replacements.get(path.resolve(args.resolveDir, args.path));
        return replacement ? { path: replacement } : undefined;
      });
      builder.onLoad({ filter: /[\\/]content[\\/](?:index|bands|bonds|kits[\\/]index)\.js$/ }, async args => {
        const loader = contentImports.get(args.path);
        if (!loader) return;
        const source = await fs.readFile(args.path, 'utf8');
        // exactly one dynamic import per loader, in the form this build replaces
        if (source.split(loader.call).length !== 2) throw new Error(`Content import boundary changed: ${args.path}`);
        const registry = `const workerContentImports = {${loader.imports.map(name => `${JSON.stringify(name)}: () => import(${JSON.stringify(name)})`).join(',')}};\n`;
        return { contents: registry + source.replace(loader.call, `workerContentImports[${loader.key}]()`), loader: 'js' };
      });
    } }],
  });
  for (const output of Object.values(result.metafile.outputs)) {
    if (output.imports.some(entry => /^(node:)?fs(?:\/|$)/.test(entry.path))) throw new Error('Node filesystem leaked into Worker bundle');
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildWorker();
}
