// Build an allowlisted public tree and bundle the existing game engine for Workers.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
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

export async function copyRuntimeAssets({ root = ROOT, out = path.join(root, 'dist/client') } = {}) {
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
  await copyTree(path.join(root, 'public'), out, name => name !== 'dev' && !name.startsWith('dev/') && !/\.(zip|log|map)$/i.test(name));
  await copyTree(path.join(root, 'data'), path.join(out, 'data'), (name, dir) => !dir && name.endsWith('.json'));
  await copyTree(path.join(root, 'shared'), path.join(out, 'shared'), (name, dir) => dir || name.endsWith('.js'));
  await copyTree(path.join(root, 'server/sim'), path.join(out, 'sim'), (name, dir) => dir || (name.endsWith('.js') && !name.toLowerCase().endsWith('nodedata.js')));
  await fs.writeFile(path.join(out, 'data.js'), SHIM);
  try { await fs.access(path.join(out, 'data/local-assets.json')); }
  catch { await fs.writeFile(path.join(out, 'data/local-assets.json'), JSON.stringify({ version: 1, source: 'none', count: 0, groups: {} })); }
  let html = await fs.readFile(path.join(out, 'index.html'), 'utf8');
  html = html.replace('<html ', '<html data-sp-runtime="cloudflare" ');
  html = html.replace('src="/js/main.js"', 'src="/js/worker-entry.js"');
  // Local fonts and system fallbacks keep the resource gate independent of Google Fonts reachability.
  html = html.replace(/\s*<link[^>]+https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '');
  html = html.replace('</head>', '  <link rel="stylesheet" href="/css/resources.css" />\n</head>');
  await fs.writeFile(path.join(out, 'index.html'), html);
  await fs.writeFile(path.join(out, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
  Cache-Control: no-cache
/assets/*
  Cache-Control: public, max-age=86400
/fonts/*
  Cache-Control: public, max-age=86400
/vendor/*
  Cache-Control: public, max-age=86400
/assets/*.atlas
  Content-Type: text/plain; charset=utf-8
/assets/*.skel
  Content-Type: application/octet-stream
/resource-manifest.json
  Cache-Control: no-cache
/resource-sw.js
  Cache-Control: no-cache
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
  if (count > 20000) throw new Error(`Static asset count ${count} exceeds the free plan limit`);
  return { out, count };
}

export async function buildWorker({ root = ROOT } = {}) {
  vendor();
  const { buildResourceManifest } = await import('./resource-pack.mjs');
  const manifest = await buildResourceManifest({ root });
  const assets = await copyRuntimeAssets({ root });
  await bundleWorker({ root });
  console.log(`Workers build: ${assets.count} static files; resource version ${manifest.version}, ${(manifest.totalBytes / 1024 / 1024).toFixed(1)} MiB`);
  return { assets, manifest };
}

export async function bundleWorker({ root = ROOT, outfile = path.join(root, 'dist/worker/index.mjs') } = {}) {
  const replacements = new Map([
    [path.join(root, 'server/data-node.js'), path.join(root, 'worker/data-loader.js')],
    [path.join(root, 'server/sim/nodeData.js'), path.join(root, 'worker/sim-data-loader.js')],
  ]);
  // The Node/browser content loader intentionally catches missing optional modules. Its import(path)
  // cannot be discovered by a bundler. Enumerate the same supported modules with literal imports.
  const contentImports = new Map([
    [path.join(root, 'server/sim/content/index.js'), [
      ...[1, 2, 3, 4, 5, 6].map(t => `./kits/tier${t}.js`),
      ...['tokens', 'devices', 'enemies', 'bosses', 'bonds', 'garrisons', 'items', 'bands', 'choices'].map(n => `./${n}.js`),
    ]],
    [path.join(root, 'server/sim/content/bands.js'), ['./bands/battle.js', './bands/meta.js']],
    [path.join(root, 'server/sim/content/bonds.js'), ['./bonds/core.js', './bonds/addon.js', './support/meta.js']],
  ]);
  const result = await build({
    entryPoints: [path.join(root, 'worker/entry.js')],
    outfile,
    bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
    external: ['node:*', 'cloudflare:*'], minify: true, keepNames: true, metafile: true,
    plugins: [{ name: 'worker-data-loaders', setup(builder) {
      builder.onResolve({ filter: /(?:data-node|nodeData)\.js$/ }, args => {
        const replacement = replacements.get(path.resolve(args.resolveDir, args.path));
        return replacement ? { path: replacement } : undefined;
      });
      builder.onLoad({ filter: /[\\/]content[\\/](?:index|bands|bonds)\.js$/ }, async args => {
        const imports = contentImports.get(args.path);
        if (!imports) return;
        const source = await fs.readFile(args.path, 'utf8');
        if (!source.includes('import(path)')) throw new Error(`Content import boundary changed: ${args.path}`);
        const registry = `const workerContentImports = {${imports.map(name => `${JSON.stringify(name)}: () => import(${JSON.stringify(name)})`).join(',')}};\n`;
        return { contents: registry + source.replace('import(path)', 'workerContentImports[path]()'), loader: 'js' };
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
