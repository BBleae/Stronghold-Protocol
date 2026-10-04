// The resource cache in real Chrome: service worker lifecycle, boot, migration, downloads and the dialog.
// Opt-in like every browser suite: SP_RESOURCES_E2E=1 (Chrome from CHROME_PATH or the default install path).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, unzipSync } from 'fflate';
import { buildResourceManifest, writeResourcePack } from '../../tools/resource-pack.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const chrome = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const enabled = process.env.SP_RESOURCES_E2E === '1' && existsSync(chrome);

// The game's boot as main.js does it, plus a toast host so the page shows the resource toasts.
const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
  <link rel="stylesheet" href="/css/theme.css" /><link rel="stylesheet" href="/css/components.css" />
  <link rel="stylesheet" href="/css/devices.css" /><link rel="stylesheet" href="/css/resources.css" />
  <script type="importmap">{"imports":{"preact":"/vendor/preact.module.js","preact/hooks":"/vendor/hooks.module.js"}}</script>
  </head><body><div id="boot">Loading</div><script type="module">
  import { render } from "/vendor/preact.module.js";
  import { html } from "/js/ui/components.js";
  import { ToastHost } from "/js/ui/toasts.js";
  import { prepareResources, installResourceManager } from "/js/resources/index.js";
  const toasts = document.createElement("div");
  document.body.append(toasts);
  render(html\`<\${ToastHost} />\`, toasts);
  const start = performance.now();
  await prepareResources();
  window.bootMs = performance.now() - start;
  window.gameReady = true;
  document.querySelector("#boot").remove();
  installResourceManager();
  </script></body></html>`;

/** A site version: its public/ tree, manifest and resource ZIP. */
async function siteVersion(files) {
  const dir = await mkdtemp(join(tmpdir(), 'stronghold-browser-resources-'));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, 'public', name)), { recursive: true });
    await writeFile(join(dir, 'public', name), text);
  }
  const manifest = await buildResourceManifest({ root: dir });
  const { path: pack } = await writeResourcePack({ root: dir, manifest });
  return { dir, manifest, pack };
}

test('resource cache in a real browser', { skip: !enabled, timeout: 240000 }, async t => {
  const v1 = await siteVersion({ 'assets/audio/a.mp3': 'abcdef', 'assets/b.png': 'image', 'fonts/f.woff2': 'font' });
  const v2 = await siteVersion({ 'assets/audio/a.mp3': 'abcdef', 'assets/b.png': 'image-2', 'assets/c.png': 'added' });
  t.after(() => Promise.all([v1, v2].map(v => rm(v.dir, { recursive: true, force: true }))));
  // The pack a player gets: unrelated entries must not disturb the import.
  await writeFile(v1.pack, zipSync({
    'assets/': new Uint8Array(),
    'README.txt': new TextEncoder().encode('unused'),
    'assets/audio/sfx/player/p_atk/p_atk_archet_s.mp3': new TextEncoder().encode('unused'),
    ...unzipSync(await readFile(v1.pack)),
  }));

  // The server: what it deploys, and the faults a test turns on.
  const server = {
    site: v1, hits: [], stalled: [],
    manifest: 'ok', // 'ok' | 'stall' | 404
    assetsDown: false, // every /assets/ request answers 503
    busyOnce: new Set(), // paths answering 503 once
    hold: new Set(), // paths never answered
    deployOn: null, // { path, site }: the request for path deploys site first
  };
  const http = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    server.hits.push({ path, method: request.method });
    response.setHeader('Cache-Control', 'no-store');
    try {
      if (path === '/' || path === '/blank') {
        response.setHeader('Content-Type', 'text/html');
        response.end(path === '/' ? PAGE : '<!doctype html><title>blank</title>');
        return;
      }
      if (server.deployOn?.path === path) {
        server.site = server.deployOn.site;
        server.deployOn = null;
      }
      if (path === '/resource-manifest.json') {
        if (server.manifest === 'stall') { server.stalled.push(response); return; }
        if (server.manifest === 404) { response.writeHead(404).end(); return; }
      }
      if (path.startsWith('/assets/') || path.startsWith('/media/')) {
        if (server.assetsDown) { response.writeHead(503).end(); return; }
        if (server.hold.has(path)) return;
        if (server.busyOnce.delete(path)) { response.writeHead(503).end(); return; }
      }
      if (path.startsWith('/media/')) {
        // The site's extension-less audio route (mp3 only in these fixtures).
        response.setHeader('Content-Type', 'audio/mpeg');
        response.end(await readFile(join(server.site.dir, 'public/assets/audio', `${path.slice('/media/'.length)}.mp3`)));
        return;
      }
      const resource = path === '/resource-manifest.json' || path.startsWith('/assets/') || path.startsWith('/fonts/');
      const file = path.startsWith('/shared/') ? join(root, path) : join(resource ? server.site.dir : root, 'public', decodeURIComponent(path));
      response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.json') ? 'application/json' : path.endsWith('.css') ? 'text/css' : 'application/octet-stream');
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise(done => http.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { http.close(done); http.closeAllConnections(); }));
  const base = `http://127.0.0.1:${http.address().port}`;
  const hitsOf = prefix => server.hits.filter(hit => hit.path.startsWith(prefix)).map(hit => hit.path);
  function releaseManifest() {
    server.manifest = 'ok';
    for (const response of server.stalled.splice(0)) {
      if (response.destroyed) continue; // the page navigated away meanwhile
      response.setHeader('Content-Type', 'application/json');
      void readFile(join(server.site.dir, 'public/resource-manifest.json')).then(body => response.end(body));
    }
  }

  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const errors = [];
  async function newPage() {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    return { context, page };
  }
  const text = (page, selector) => page.$eval(selector, node => node.textContent.trim());
  const waitText = (page, selector, part, timeout = 30000) => page.waitForFunction(
    (selector, part) => [...document.querySelectorAll(selector)].some(node => node.textContent.includes(part)), { timeout }, selector, part);
  const fetchText = (page, url) => page.evaluate(async url => {
    const response = await fetch(url);
    return { status: response.status, type: response.headers.get('Content-Type'), body: await response.text() };
  }, url);
  async function reload(page, cdp, hard = false) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      hard ? cdp.send('Page.reload', { ignoreCache: true }) : page.reload({ waitUntil: 'domcontentloaded' }),
    ]);
    await page.waitForFunction(() => window.gameReady, { timeout: 5000 });
  }
  const setRoute = (page, inMatch) => page.evaluate(async inMatch => {
    const { store, emptyMatch } = await import('/js/store.js');
    store.set(inMatch ? { session: { entered: true }, room: { inMatch: true } } : { room: null, match: emptyMatch() });
  }, inMatch);

  await t.test('first visit imports the pack locally; then the worker answers cached files and /media/ audio with the site down', async () => {
    const { context, page } = await newPage();
    await page.goto(base);
    await page.waitForSelector('.resource-dialog[role="dialog"]');
    assert.equal(await page.$eval('#boot', node => getComputedStyle(node).display), 'none');
    assert.equal(await page.evaluate(() => window.__spResourcesPreparing), true);
    assert.equal(await page.evaluate(() => !!window.gameReady), false, 'a first visit waits for the choice');
    await page.waitForSelector('[data-action="import"]:not(:disabled)');
    const before = server.hits.length;
    await (await page.$('input[type=file]')).uploadFile(v1.pack);
    await waitText(page, '.resource-message', '全部资源已保存');
    assert.deepEqual(server.hits.slice(before).filter(hit => hit.path.startsWith('/assets/') || hit.method !== 'GET'), [], 'nothing uploaded or downloaded');
    assert.equal(await page.$eval('[data-action="download"]', node => node.disabled), true);
    assert.equal(await text(page, '[data-action="download"]'), '资源已全部保存');
    assert.equal(await page.$eval('[data-action="pack"]', node => node.getAttribute('href')), '/stronghold-resources.zip');
    // Even a stale enabled control must not start another operation.
    assert.equal(await page.$eval('[data-action="download"]', async node => {
      node.disabled = false;
      node.click();
      node.disabled = true;
      await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
      return !document.querySelector('[data-action="cancel"]');
    }), true);
    await page.click('[data-action="continue"]');
    await page.waitForFunction(() => window.gameReady);
    assert.equal(await page.evaluate(() => !!window.__spResourcesPreparing), false);
    await page.waitForFunction(() => navigator.serviceWorker.controller);

    server.assetsDown = true;
    assert.deepEqual(await fetchText(page, '/assets/audio/a.mp3'), { status: 200, type: 'audio/mpeg', body: 'abcdef' });
    assert.deepEqual(await fetchText(page, '/media/a'), { status: 200, type: 'audio/mpeg', body: 'abcdef' }, 'the extension-less audio alias');
    // A cold worker answers from the cache without waiting for a manifest (stalled here).
    server.manifest = 'stall';
    const cdp = await page.createCDPSession();
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    assert.deepEqual(await fetchText(page, '/fonts/f.woff2'), { status: 200, type: 'font/woff2', body: 'font' });
    assert.deepEqual(hitsOf('/assets/').concat(hitsOf('/media/'), hitsOf('/fonts/')), [], 'no network for cached files');

    // An installed player's boot does not wait for the manifest, the worker or a scan.
    await reload(page, cdp);
    assert.ok(await page.evaluate(() => window.bootMs < 1000), 'boot did not wait');
    assert.equal(await page.$('.resource-dialog'), null);
    assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller));
    // A hard reload bypasses the worker: no stall, no dialog, files come from the network.
    server.assetsDown = false;
    await reload(page, cdp, true);
    assert.ok(await page.evaluate(() => window.bootMs < 1000), 'boot did not wait');
    assert.equal(await page.$('.resource-dialog'), null);
    assert.equal(await page.evaluate(() => navigator.serviceWorker.controller), null);
    assert.equal((await fetchText(page, '/assets/b.png')).body, 'image');
    assert.deepEqual(hitsOf('/assets/'), ['/assets/b.png']);
    releaseManifest();
    await context.close();
  });

  await t.test('a redeployed site keeps unchanged files: earlier version-keyed caches are adopted, only changed files download', async () => {
    const { context, page } = await newPage();
    await page.goto(`${base}/blank`);
    // An installation by an earlier release: one cache per site version, the second one partial.
    const legacy = `stronghold-resources-v1-${v1.manifest.version}`;
    const files = await Promise.all([v1, v2].map(v => Promise.all(v.manifest.files.map(async file =>
      ({ ...file, text: await readFile(join(v.dir, 'public', decodeURIComponent(file.url)), 'utf8') })))));
    await page.evaluate(async (legacy, v1files, added) => {
      const put = async (name, file) => (await caches.open(name)).put(file.url, new Response(file.text, { headers: {
        'Content-Type': file.type, 'Content-Length': String(file.size), 'Accept-Ranges': 'bytes', 'X-Resource-SHA256': file.sha256 } }));
      for (const file of v1files) await put(legacy, file);
      await put(`stronghold-resources-v1-${'f'.repeat(64)}`, added);
      localStorage.setItem('stronghold-resource-mode', 'install');
    }, legacy, files[0], files[1].find(file => file.url === '/assets/c.png'));
    server.site = v2;
    server.hits.length = 0;
    await page.goto(base);
    await page.waitForFunction(() => window.gameReady);
    assert.equal(await page.$('.resource-dialog'), null);
    await waitText(page, '.toast__text', '本地资源缺少 1 个文件');
    assert.deepEqual(await page.evaluate(() => caches.keys()), [legacy], 'the earlier cache is the cache now; the other one was merged and deleted');
    await page.click('#resource-manager-open');
    await waitText(page, '.resource-stat', '2 / 3');
    await page.click('[data-action="download"]');
    await waitText(page, '.resource-message', '全部资源已保存');
    assert.deepEqual(hitsOf('/assets/'), ['/assets/b.png'], 'only the changed file');
    assert.deepEqual(await page.evaluate(() => caches.keys()), [legacy]);
    await page.click('[data-action="continue"]');
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    server.assetsDown = true;
    assert.equal((await fetchText(page, '/assets/b.png')).body, 'image-2');
    assert.equal((await fetchText(page, '/assets/c.png')).body, 'added');
    server.assetsDown = false;
    await context.close();
  });

  await t.test('downloads retry a failing file, survive a redeploy midway, pause when a match starts, and the dialog fits', async () => {
    server.site = v1;
    const { context, page } = await newPage();
    await page.goto(base);
    await page.waitForSelector('[data-action="download"]:not(:disabled)');
    server.hits.length = 0;
    server.busyOnce.add('/assets/b.png');
    await page.click('[data-action="download"]');
    await waitText(page, '.resource-message', '全部资源已保存');
    assert.equal(hitsOf('/assets/b.png').length, 2, 'one 503, then the retry');
    await page.click('[data-action="continue"]');
    await page.waitForFunction(() => window.gameReady);

    await page.click('#resource-manager-open');
    await page.waitForSelector('[data-action="clear"]:not(:disabled)');
    await page.click('[data-action="clear"]');
    await waitText(page, '.resource-stat', '0 / 3');
    server.deployOn = { path: '/assets/b.png', site: v2 };
    await page.click('[data-action="download"]');
    await waitText(page, '.resource-message', '全部资源已保存');
    assert.match(await text(page, '.resource-stat'), /^3 \/ 3/, 'the new site version, complete');

    await page.click('[data-action="clear"]');
    await waitText(page, '.resource-stat', '0 / 3');
    server.hold.add('/assets/c.png');
    await page.click('[data-action="download"]');
    await waitText(page, '.resource-stat', '2 / 3');
    await setRoute(page, true);
    await page.waitForSelector('.resource-dialog', { hidden: true });
    await page.waitForSelector('#resource-manager-open', { hidden: true });
    await waitText(page, '.toast__text', '已暂停');
    server.hold.clear();
    await setRoute(page, false);
    await page.click('#resource-manager-open');
    await waitText(page, '.resource-stat', '2 / 3');
    assert.equal(await page.evaluate(() => localStorage.getItem('stronghold-resource-mode')), 'install');
    await page.click('[data-action="continue"]');

    for (const viewport of [{ width: 1920, height: 1080 }, { width: 844, height: 390, isMobile: true, hasTouch: true }]) {
      await page.setViewport(viewport);
      await page.waitForSelector('#resource-manager-open', { visible: true });
      await page.click('#resource-manager-open');
      await page.waitForSelector('[data-action="import"]:not(:disabled)');
      const layout = await page.$eval('.resource-dialog', dialog => {
        const box = dialog.getBoundingClientRect();
        const footer = dialog.querySelector('[data-action="continue"]').getBoundingClientRect();
        const body = dialog.querySelector('.modal__body');
        return { fits: box.x >= 0 && box.y >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
          noHorizontalScroll: body.scrollWidth <= body.clientWidth,
          footerVisible: footer.bottom <= innerHeight && footer.top >= 0 };
      });
      assert.deepEqual(layout, { fits: true, noHorizontalScroll: true, footerVisible: true }, `manager fits ${viewport.width}×${viewport.height}`);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.resource-dialog', { hidden: true });
      assert.equal(await page.evaluate(() => document.activeElement.id), 'resource-manager-open');
    }
    await context.close();
  });

  await t.test('a first visit can skip; a site without a manifest boots without the dialog', async () => {
    server.site = v1;
    const skipping = await newPage();
    await skipping.page.goto(base);
    await skipping.page.waitForSelector('.resource-dialog[role="dialog"]');
    await skipping.page.click('[data-action="continue"]');
    await skipping.page.waitForFunction(() => window.gameReady);
    await skipping.page.reload();
    await skipping.page.waitForFunction(() => window.gameReady);
    assert.equal(await skipping.page.$('.resource-dialog'), null);
    await skipping.page.click('#resource-manager-open');
    await waitText(skipping.page, '.resource-stat', '0 / 3');
    await skipping.context.close();

    server.manifest = 404;
    const plain = await newPage();
    await plain.page.goto(base);
    await plain.page.waitForFunction(() => window.gameReady);
    assert.equal(await plain.page.$('.resource-dialog'), null);
    await waitText(plain.page, '.toast__text', '本地资源缓存不可用');
    server.manifest = 'ok';
    await plain.context.close();
  });

  assert.deepEqual(errors, []);
});
