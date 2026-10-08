import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('Workers static build preserves public routes and publishes the manifest resources, without private source or ZIPs', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sp-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'public/index.html': '<html lang="zh-CN"><body><script type="module" src="/js/main.js"></script></body></html>',
    'public/assets/a.png': 'image', 'public/assets/local/x.png': 'local client art', 'public/fonts/f.woff2': 'font',
    'public/js/main.js': 'code', 'public/.secret': 'secret',
    'public/dev/recording.json': 'private dev data', 'public/bundle.zip': 'archive',
    'shared/protocol.js': 'export {}', 'data/config.json': '{}', 'data/assets.json': JSON.stringify({ chars: { a: '/assets/a.png' } }),
    'data/local-assets.json': JSON.stringify(LOCAL),
    'server/sim/Battle.js': 'export {}', 'server/sim/nodeData.js': 'private loader',
    'server/private.js': 'secret',
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  const { copyRuntimeAssets } = await import('../tools/build-worker.mjs');
  const { buildResourceManifest } = await import('../tools/resource-pack.mjs');
  const manifest = await buildResourceManifest({ root, output: false });
  const out = path.join(root, 'dist/client');
  await copyRuntimeAssets({ root, out, rulesVersion: '0123456789abcdef0123', manifest });
  assert.equal(await readFile(path.join(out, 'js/main.js'), 'utf8'), 'code');
  // the resource files the manifest lists: what the in-site download and /stronghold-resources.zip provide
  assert.equal(await readFile(path.join(out, 'assets/a.png'), 'utf8'), 'image');
  assert.equal(await readFile(path.join(out, 'fonts/f.woff2'), 'utf8'), 'font');
  // the local client extraction too, with the manifest of it the game prefers
  assert.equal(await readFile(path.join(out, 'assets/local/x.png'), 'utf8'), 'local client art');
  assert.deepEqual(JSON.parse(await readFile(path.join(out, 'data/local-assets.json'), 'utf8')), LOCAL);
  assert.match(await readFile(path.join(out, 'index.html'), 'utf8'), /data-sp-runtime="cloudflare"/);
  assert.match(await readFile(path.join(out, 'index.html'), 'utf8'), /data-sp-rules="0123456789abcdef0123"/, 'the page knows its rules version');
  assert.match(await readFile(path.join(out, 'index.html'), 'utf8'), /src="\/js\/worker-entry.js"/);
  assert.match(await readFile(path.join(out, 'data.js'), 'utf8'), /getSimData/);
  await access(path.join(out, 'sim/Battle.js'));
  await access(path.join(out, 'data/config.json'));
  for (const name of ['.secret', 'dev/recording.json', 'bundle.zip', 'sim/nodeData.js', 'server/private.js']) {
    await assert.rejects(access(path.join(out, name)), { code: 'ENOENT' });
  }
  // without resource files the site has no local art; a listed file the manifest lacks fails the build
  await copyRuntimeAssets({ root, out });
  assert.equal(JSON.parse(await readFile(path.join(out, 'data/local-assets.json'), 'utf8')).source, 'none');
  const partial = { ...manifest, files: manifest.files.filter((file) => file.url !== '/assets/local/x.png') };
  await assert.rejects(copyRuntimeAssets({ root, out, manifest: partial }), /local-assets\.json lists 1 files the resource manifest lacks/);
});

const LOCAL = { version: 1, source: 'local-client', count: 1, groups: { 'ui/battle': { x: { path: '/assets/local/x.png', w: 1, h: 1 } } } };

test('Workers static assets (_headers): each path gets one Cache-Control; resource files keep a day, pack parts for good, the rest revalidates', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sp-headers-'));
  let mf;
  // workerd holds the asset directory open until disposed
  t.after(async () => { await mf?.dispose(); await rm(root, { recursive: true, force: true }); });
  const files = ['public/index.html', 'public/js/main.js', 'public/css/theme.css', 'public/vendor/preact.module.js',
    'public/resource-sw.js', 'public/resource-manifest.json', 'public/assets/char/a.png', 'public/assets/spine/a.atlas',
    'public/assets/spine/a.skel', 'public/fonts/fonts.css', 'data/config.json'];
  for (const name of files) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), name.endsWith('.html') ? '<html lang="zh-CN"><body></body></html>' : name.endsWith('.json') ? '{}' : 'x');
  }
  await writeFile(path.join(root, 'data/assets.json'), JSON.stringify({ chars: { a: '/assets/char/a.png' },
    spine: { a: { atlas: '/assets/spine/a.atlas', skel: '/assets/spine/a.skel' } } }));
  const { copyRuntimeAssets } = await import('../tools/build-worker.mjs');
  const { buildResourceManifest } = await import('../tools/resource-pack.mjs');
  const manifest = await buildResourceManifest({ root, output: false });
  const { out } = await copyRuntimeAssets({ root, out: path.join(root, 'dist/client'), manifest });
  await mkdir(path.join(out, 'pack/abc'), { recursive: true });
  await writeFile(path.join(out, 'pack/abc/part-000.bin'), 'PK');
  // The workers-shared asset worker that serves Static Assets in production, with its _headers handling.
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'headers', modules: true, compatibilityDate: '2026-10-01',
    script: 'export default { fetch(request, env) { return env.ASSETS.fetch(request); } }',
    assets: { directory: out, binding: 'ASSETS', routerConfig: { has_user_worker: true } } }] }));
  const revalidate = 'public, max-age=0, must-revalidate';
  const day = 'public, max-age=86400';
  const expected = {
    '/': revalidate, '/js/main.js': revalidate, '/css/theme.css': revalidate, '/vendor/preact.module.js': revalidate,
    '/data/config.json': revalidate, '/resource-sw.js': revalidate, '/resource-manifest.json': revalidate,
    '/assets/char/a.png': day, '/assets/spine/a.atlas': day, '/assets/spine/a.skel': day, '/fonts/fonts.css': day,
    '/pack/abc/part-000.bin': 'public, max-age=31536000, immutable',
  };
  for (const [url, cacheControl] of Object.entries(expected)) {
    const response = await mf.dispatchFetch(`https://game.example${url}`);
    assert.equal(response.status, 200, url);
    assert.equal(response.headers.get('Cache-Control'), cacheControl, url);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff', url);
    if (url.endsWith('.atlas')) assert.equal(response.headers.get('Content-Type'), 'text/plain; charset=utf-8');
    if (url.endsWith('.skel')) assert.equal(response.headers.get('Content-Type'), 'application/octet-stream');
    await response.arrayBuffer();
  }
});

test('Workers static build publishes the language packs (index, UI and game texts) and the 自选 kit list on the page', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sp-packs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const meta = { type: 'lang', lang: 'en', name: 'English', englishName: 'English', version: '0.2.0', app: '>=0.2.0' };
  const files = {
    'public/index.html': '<html lang="zh-CN"><body><script type="module" src="/js/main.js"></script></body></html>',
    'public/i18n/en.json': JSON.stringify({ _meta: meta, '开始': 'Start' }),
    'data/config.json': '{}', 'data/backups.json': '{"units":{}}', 'data/i18n/en.json': '{"version":1}',
    // a folder pack: only the files its manifest names are published
    'packs/extra/pack.json': JSON.stringify({ ...meta, lang: 'pt', name: 'Português', englishName: 'Portuguese', files: { ui: 'ui.json' } }),
    'packs/extra/ui.json': JSON.stringify({ '开始': 'Iniciar' }), 'packs/extra/notes.txt': 'not named',
    'server/sim/content/kits/index.js': "export const KITTED_CHARS = ['char_609_acguad', 'char_112_siege'];",
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  const { copyRuntimeAssets } = await import('../tools/build-worker.mjs');
  const out = path.join(root, 'dist/client');
  await copyRuntimeAssets({ root, out });
  // what a Node server answers at /packs/index.json (server/packs.js), as a static file
  const index = JSON.parse(await readFile(path.join(out, 'packs/index.json'), 'utf8'));
  const byId = Object.fromEntries(index.packs.map((p) => [p.id, p]));
  assert.deepEqual(byId.en.files, { ui: '/i18n/en.json', data: '/data/i18n/en.json' });
  assert.deepEqual(byId.extra.files, { ui: '/packs/extra/ui.json' });
  for (const url of [byId.en.files.ui, byId.en.files.data, byId.extra.files.ui, '/data/backups.json']) await access(path.join(out, ...url.split('/')));
  await assert.rejects(access(path.join(out, 'packs/extra/notes.txt')), { code: 'ENOENT' });
  // the menu's 干员调配 offers the operators a 自选 slot may field before the page meets a room (worker-entry.js)
  assert.match(await readFile(path.join(out, 'index.html'), 'utf8'), /data-sp-diy-kitted="char_609_acguad,char_112_siege"/);
});

test('missingAssets lists the files data/assets.json references that are not on disk', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sp-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { missingAssets } = await import('../tools/build-worker.mjs');
  assert.deepEqual(await missingAssets({ root }), ['data/assets.json']);
  await mkdir(path.join(root, 'data'), { recursive: true });
  await mkdir(path.join(root, 'public/assets/voice/cn'), { recursive: true });
  await writeFile(path.join(root, 'public/assets/voice/cn/a.mp3'), 'x');
  await writeFile(path.join(root, 'data/assets.json'), JSON.stringify({ hash: 'x', chars: { a: { avatar: '/assets/char/a.png' } },
    audio: { voice: { cn: { a: { select: ['/assets/voice/cn/a.mp3'] } } } }, fonts: { css: '/fonts/fonts.css' } }));
  assert.deepEqual(await missingAssets({ root }), ['/assets/char/a.png']);
});
