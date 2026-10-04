// The resource cache in real Chrome: service worker lifecycle, boot, ZIP import, migration and the dialog.
// Opt-in like every browser suite: SP_RESOURCES_E2E=1 (Chrome from CHROME_PATH or the default install path).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

// The game's boot as main.js does it, with index.html's font stylesheet. The app, with its toast host, mounts after
// the resources are prepared.
const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
  <link rel="stylesheet" href="/fonts/fonts.css" />
  <link rel="stylesheet" href="/css/theme.css" /><link rel="stylesheet" href="/css/components.css" />
  <link rel="stylesheet" href="/css/devices.css" /><link rel="stylesheet" href="/css/resources.css" />
  <script type="importmap">{"imports":{"preact":"/vendor/preact.module.js","preact/hooks":"/vendor/hooks.module.js"}}</script>
  </head><body><div id="boot">Loading</div><script type="module">
  import { render } from "/vendor/preact.module.js";
  import { html } from "/js/ui/components.js";
  import { ToastHost } from "/js/ui/toasts.js";
  import { prepareResources, installResourceManager } from "/js/resources/index.js";
  const start = performance.now();
  await prepareResources();
  window.bootMs = performance.now() - start;
  const app = document.createElement("div");
  document.body.append(app);
  render(html\`<\${ToastHost} />\`, app);
  window.gameReady = true;
  document.querySelector("#boot").remove();
  installResourceManager();
  </script></body></html>`;

/**
 * A site version: its resource files (all of them referenced by its data/assets.json), manifest and resource ZIP. The
 * site serves only the manifest.
 */
async function siteVersion(files) {
  const dir = await mkdtemp(join(tmpdir(), 'stronghold-browser-resources-'));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, 'public', name)), { recursive: true });
    await writeFile(join(dir, 'public', name), text);
  }
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data/assets.json'), JSON.stringify(Object.keys(files).filter(name => name.startsWith('assets/')).map(name => '/' + name)));
  const manifest = await buildResourceManifest({ root: dir });
  const { path: pack } = await writeResourcePack({ root: dir, manifest });
  return { dir, manifest, pack };
}

const sha256 = text => createHash('sha256').update(text).digest('hex');

/** A site version for tests that put the files into the cache themselves. */
async function manifestOnlySite(files) {
  const dir = await mkdtemp(join(tmpdir(), 'stronghold-browser-resources-'));
  const entries = files.map(({ url, text }) => ({ url, size: Buffer.byteLength(text), sha256: sha256(text), type: 'image/png' }));
  const manifest = {
    format: 1,
    version: sha256(JSON.stringify(entries)),
    files: entries,
    totalBytes: entries.reduce((sum, file) => sum + file.size, 0),
  };
  await mkdir(join(dir, 'public'));
  await writeFile(join(dir, 'public/resource-manifest.json'), JSON.stringify(manifest));
  return { dir, manifest };
}

test('resource cache in a real browser', { skip: !enabled, timeout: 240000 }, async t => {
  const v1 = await siteVersion({
    'assets/audio/a.mp3': 'abcdef', 'assets/b.png': 'image', 'fonts/f.woff2': 'font',
    'fonts/fonts.css': "@font-face { font-family: 'Probe'; src: url('/fonts/f.woff2') format('woff2'); }",
  });
  const v2 = await siteVersion({ 'assets/audio/a.mp3': 'abcdef', 'assets/b.png': 'image-2', 'assets/c.png': 'added' });
  t.after(() => Promise.all([v1, v2].map(v => rm(v.dir, { recursive: true, force: true }))));
  // The ZIP a player has: unrelated entries must not disturb the import.
  await writeFile(v1.pack, zipSync({
    'assets/': new Uint8Array(),
    'README.txt': new TextEncoder().encode('unused'),
    'assets/audio/sfx/player/p_atk/p_atk_archet_s.mp3': new TextEncoder().encode('unused'),
    ...unzipSync(await readFile(v1.pack)),
  }));
  const notZip = join(v1.dir, 'not-a-zip.zip');
  await writeFile(notZip, 'not a zip');

  // The site: code and the resource manifest, no resource files. A test can stall or remove the manifest.
  const server = { site: v1, hits: [], stalled: [], manifest: 'ok' }; // manifest: 'ok' | 'stall' | 404
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
      if (path === '/resource-manifest.json') {
        if (server.manifest === 'stall') { server.stalled.push(response); return; }
        if (server.manifest === 404) { response.writeHead(404).end(); return; }
        response.setHeader('Content-Type', 'application/json');
        response.end(await readFile(join(server.site.dir, 'public/resource-manifest.json')));
        return;
      }
      if (/^\/(assets|fonts|media)\//.test(path)) { response.writeHead(404).end(); return; }
      const file = path.startsWith('/shared/') ? join(root, path) : join(root, 'public', decodeURIComponent(path));
      response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'application/octet-stream');
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise(done => http.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { http.close(done); http.closeAllConnections(); }));
  const base = `http://127.0.0.1:${http.address().port}`;
  /** The resource requests that reached the site since hit number `since`. */
  const resourceHits = since => server.hits.slice(since).map(hit => hit.path).filter(path => /^\/(assets|fonts|media)\//.test(path));
  function releaseManifest() {
    server.manifest = 'ok';
    for (const response of server.stalled.splice(0)) {
      if (response.destroyed) continue; // the page navigated away or gave up meanwhile
      response.setHeader('Content-Type', 'application/json');
      void readFile(join(server.site.dir, 'public/resource-manifest.json')).then(body => response.end(body));
    }
  }
  // Every case starts on the first site version with its manifest answered, whatever the case before left.
  t.beforeEach(() => {
    server.site = v1;
    releaseManifest();
  });

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
  /** A returning player: the first visit is over and the resource worker runs. */
  async function returningPlayer(page) {
    await page.goto(`${base}/blank`);
    await page.evaluate(async () => {
      localStorage.setItem('stronghold-resource-mode', 'visited');
      await navigator.serviceWorker.register('/resource-sw.js', { type: 'module', scope: '/' });
      await navigator.serviceWorker.ready;
    });
  }
  const text = (page, selector) => page.$eval(selector, node => node.textContent.trim());
  // Polled on a timer: a tab in the background gets no animation frames.
  const waitText = (page, selector, part, timeout = 30000) => page.waitForFunction(
    (selector, part) => [...document.querySelectorAll(selector)].some(node => node.textContent.includes(part)),
    { timeout, polling: 100 }, selector, part);
  const fetchText = (page, url) => page.evaluate(async url => {
    const response = await fetch(url);
    return { status: response.status, type: response.headers.get('Content-Type'), body: await response.text() };
  }, url);
  const importZip = async (page, path) => (await page.$('input[type=file]')).uploadFile(path);
  /** Rules of the page's /fonts/fonts.css; 0 when it did not load. */
  const fontRules = page => page.evaluate(() =>
    [...document.styleSheets].find(sheet => sheet.href?.endsWith('/fonts/fonts.css'))?.cssRules.length ?? 0);
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
  // A second page (tab) of the same browser profile. Only the front tab is visible: bring a page to the front before
  // clicking in it.
  async function samePage(context) {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    return page;
  }
  async function clickIn(page, selector) {
    await page.bringToFront();
    await page.click(selector);
  }

  await t.test('a first visit imports a ZIP on this device and starts over with it; the worker answers every resource itself', async () => {
    const { context, page } = await newPage();
    await page.goto(base);
    await page.waitForSelector('.resource-dialog[role="dialog"]');
    assert.equal(await page.$eval('#boot', node => getComputedStyle(node).display), 'none');
    assert.equal(await page.evaluate(() => window.__spResourcesPreparing), true);
    assert.equal(await page.evaluate(() => !!window.gameReady), false, 'a first visit waits for the choice');
    await page.waitForSelector('[data-action="import"]:not(:disabled)');
    const words = await text(page, '.resource-dialog');
    assert.match(words, /原版美术与音频需要导入本地资源 ZIP.*只在本机读取/);
    assert.doesNotMatch(words, /下载|按需加载|发给朋友/);
    assert.equal(await page.$('[data-action="download"], [data-action="pack"], a[href$=".zip"]'), null);
    assert.equal(await text(page, '[data-action="continue"]'), '暂时跳过（使用占位图）');
    assert.equal(await fontRules(page), 0, 'the site has no fonts');
    const before = server.hits.length;
    await importZip(page, v1.pack);
    await waitText(page, '.resource-message', '全部资源已导入。');
    assert.deepEqual(server.hits.slice(before).filter(hit => /^\/(assets|fonts|media)\//.test(hit.path) || hit.method !== 'GET'), [],
      'nothing uploaded or downloaded');
    assert.equal(await text(page, '[data-action="continue"]'), '资源已就绪，进入游戏');

    const start = server.hits.length;
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('[data-action="continue"]')]);
    await page.waitForFunction(() => window.gameReady);
    assert.equal(await page.$('.resource-dialog'), null);
    assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'the page started over under the worker');
    assert.equal(await fontRules(page), 1, 'the fonts of the ZIP');
    assert.deepEqual(await fetchText(page, '/assets/audio/a.mp3'), { status: 200, type: 'audio/mpeg', body: 'abcdef' });
    assert.deepEqual(await fetchText(page, '/media/a'), { status: 200, type: 'audio/mpeg', body: 'abcdef' }, 'the extension-less audio alias');
    assert.equal((await fetchText(page, '/assets/missing.png')).status, 404);
    assert.equal((await fetchText(page, '/media/missing')).status, 404);
    // A cold worker answers from the cache without waiting for a manifest (stalled here).
    server.manifest = 'stall';
    const cdp = await page.createCDPSession();
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    assert.deepEqual(await fetchText(page, '/fonts/f.woff2'), { status: 200, type: 'font/woff2', body: 'font' });

    // An installed player's boot does not wait for the manifest, the worker or a scan.
    await reload(page, cdp);
    assert.ok(await page.evaluate(() => window.bootMs < 1000), 'boot did not wait');
    assert.equal(await page.$('.resource-dialog'), null);
    assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller));
    assert.deepEqual(resourceHits(start), [], 'the worker answered every resource request itself');
    // A hard reload bypasses the worker: no stall and no dialog. The worker takes the page over at once; only what the
    // page asked for before went to the site, which has no resource files.
    await reload(page, cdp, true);
    assert.ok(await page.evaluate(() => window.bootMs < 1000), 'boot did not wait');
    assert.equal(await page.$('.resource-dialog'), null);
    await page.waitForFunction(() => navigator.serviceWorker.controller, { timeout: 5000 });
    assert.equal((await fetchText(page, '/assets/b.png')).body, 'image');
    assert.deepEqual(resourceHits(start), ['/fonts/fonts.css']);
    releaseManifest();
    await context.close();
  });

  await t.test('an earlier installation is adopted in place, the new ZIP completes it, and stored files ask not to be evicted', async () => {
    const { context, page } = await newPage();
    await returningPlayer(page);
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
    await page.evaluateOnNewDocument(() => {
      const persist = navigator.storage.persist.bind(navigator.storage);
      window.persistRequests = 0;
      navigator.storage.persist = () => {
        window.persistRequests++;
        return persist();
      };
    });
    server.site = v2;
    const start = server.hits.length;
    await page.goto(base);
    await page.waitForFunction(() => window.gameReady);
    assert.equal(await page.$('.resource-dialog'), null);
    await page.click('#resource-manager-open');
    await waitText(page, '.resource-stat', '2 / 3');
    assert.deepEqual(await page.evaluate(() => caches.keys()), [legacy], 'the earlier cache is the cache now; the other one was merged and deleted');
    await importZip(page, v2.pack);
    await waitText(page, '.resource-message', '全部资源已导入。刷新页面后完全生效。');
    assert.match(await text(page, '.resource-stat'), /^3 \/ 3/);
    assert.deepEqual(await page.evaluate(() => caches.keys()), [legacy]);
    await page.click('[data-action="continue"]');
    await page.waitForSelector('.resource-dialog', { hidden: true });
    assert.equal((await fetchText(page, '/assets/b.png')).body, 'image-2');
    assert.equal((await fetchText(page, '/assets/c.png')).body, 'added');
    assert.equal((await fetchText(page, '/fonts/fonts.css')).status, 404, 'not part of the new version');
    assert.deepEqual(resourceHits(start), [], 'the worker answered every resource request itself');
    // Every boot that finds stored files asks the browser not to evict them.
    await page.reload();
    await page.waitForFunction(() => window.persistRequests > 0, { polling: 100, timeout: 10000 });
    await context.close();
  });

  await t.test('a failed import says why; a match start cancels an import and closes the dialog; the dialog fits', async () => {
    const { context, page } = await newPage();
    await returningPlayer(page);
    await page.goto(base);
    await page.waitForFunction(() => window.gameReady);
    await page.click('#resource-manager-open');
    await waitText(page, '.resource-stat', '0 / 4');
    await importZip(page, notZip);
    await waitText(page, '.resource-message', '未完成：ZIP 导入失败');
    assert.ok(await page.$eval('.resource-message', node => node.classList.contains('t-gold')));
    await waitText(page, '.toast__text', 'ZIP 导入失败');

    // The import waits for the manifest while the match starts.
    server.manifest = 'stall';
    await importZip(page, v1.pack);
    await waitText(page, '.spinner__label', '正在导入');
    await setRoute(page, true);
    await page.waitForSelector('.resource-dialog', { hidden: true });
    await page.waitForSelector('#resource-manager-open', { hidden: true });
    await waitText(page, '.toast__text', '已取消。已导入的文件会保留。');
    releaseManifest();
    await setRoute(page, false);
    await page.click('#resource-manager-open');
    await waitText(page, '.resource-stat', '0 / 4');
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

  await t.test('two pages that boot together adopt an earlier installation once and lose nothing', async () => {
    // An earlier release's installation: complete caches of two site versions, large enough that adopting them
    // takes a while. The live version changed 60 files and added one that is not installed.
    const older = Array.from({ length: 3000 }, (_, i) => ({ url: `/assets/f${i}.png`, text: `file ${i} `.repeat(20) }));
    const newer = older.map((file, i) => i < 60 ? { ...file, text: `${file.text}v2` } : file);
    const live = await manifestOnlySite([...newer, { url: '/assets/new.png', text: 'not installed' }]);
    t.after(() => rm(live.dir, { recursive: true, force: true }));
    const legacy = [older, newer].map((files, i) => ({
      name: `stronghold-resources-v1-${String(i + 1).repeat(64)}`,
      files: files.map(file => ({ ...file, size: Buffer.byteLength(file.text), sha256: sha256(file.text) })),
    }));
    server.site = live;
    // When the second page starts its check inside the first page's adoption depends on the machine: try several.
    for (const delay of [50, 100, 150, 200, 300]) {
      const { context, page: first } = await newPage();
      await first.goto(`${base}/blank`);
      await first.evaluate(async legacy => {
        for (const { name, files } of legacy) {
          const cache = await caches.open(name);
          await Promise.all(files.map(file => cache.put(file.url, new Response(file.text, { headers: {
            'Content-Type': 'image/png', 'Content-Length': String(file.size), 'X-Resource-SHA256': file.sha256 } }))));
        }
        localStorage.setItem('stronghold-resource-mode', 'install');
      }, legacy);
      const second = await samePage(context);
      const boots = [first.goto(base)];
      await new Promise(done => setTimeout(done, delay));
      boots.push(second.goto(base));
      await Promise.all(boots);
      // Each page's dialog checks after the boot checks it queued behind.
      for (const page of [first, second]) {
        await page.waitForFunction(() => window.gameReady, { polling: 100 });
        await clickIn(page, '#resource-manager-open');
      }
      await Promise.all([first, second].map(page => waitText(page, '.resource-stat', '3000 / 3001')));
      const cached = await first.evaluate(async () => {
        const names = await caches.keys();
        const cache = await caches.open(names[0]);
        const files = (await cache.keys()).filter(request => new URL(request.url).pathname.startsWith('/assets/'));
        const status = await cache.match('/resource-cache-status.json');
        const changed = await cache.match('/assets/f0.png');
        return { caches: names.length, files: files.length, recorded: status && (await status.json()).count,
          changed: changed && await changed.text() };
      });
      const expected = { caches: 1, files: 3000, recorded: 3000, changed: newer[0].text };
      assert.deepEqual(cached, expected, `second page ${delay} ms after the first`);
      await context.close();
    }
  });

  await t.test('a clear in one page waits for an import in another; the status stays true to what is stored', async () => {
    const { context, page: importing } = await newPage();
    await returningPlayer(importing);
    const clearing = await samePage(context);
    for (const page of [importing, clearing]) {
      await page.goto(base);
      await page.waitForFunction(() => window.gameReady, { polling: 100 });
      await clickIn(page, '#resource-manager-open');
      await waitText(page, '.resource-stat', '0 / 4');
    }
    const storedFiles = () => clearing.evaluate(async () => {
      let count = 0;
      for (const name of await caches.keys()) {
        const requests = await (await caches.open(name)).keys();
        count += requests.filter(request => new URL(request.url).pathname !== '/resource-cache-status.json').length;
      }
      return count;
    });
    // The import holds the lock while it waits for the manifest.
    server.manifest = 'stall';
    await importing.bringToFront();
    await importZip(importing, v1.pack);
    await waitText(importing, '.spinner__label', '正在导入');
    await clickIn(clearing, '[data-action="clear"]');
    await waitText(clearing, '.spinner__label', '等待其他资源操作完成');
    // 取消 ends the wait.
    await clickIn(clearing, '[data-action="cancel"]');
    await waitText(clearing, '.resource-message', '已取消');
    await clickIn(clearing, '[data-action="clear"]');
    await waitText(clearing, '.spinner__label', '等待其他资源操作完成');
    releaseManifest();
    await waitText(importing, '.resource-message', '全部资源已导入');
    assert.match(await text(importing, '.resource-stat'), /^4 \/ 4/);
    await waitText(clearing, '.resource-message', '本地资源已清理');
    assert.match(await text(clearing, '.resource-stat'), /^0 \/ 4/);
    assert.equal(await storedFiles(), 0);
    assert.deepEqual(await clearing.evaluate(() => caches.keys()), [], 'no file and no status entry left');
    await context.close();
  });

  await t.test('a first visit can skip; a site without a manifest or a browser without the APIs boots and says so', async () => {
    const skipping = await newPage();
    await skipping.page.goto(base);
    await skipping.page.waitForSelector('[data-action="import"]:not(:disabled)');
    await skipping.page.evaluate(() => { window.samePage = true; });
    await skipping.page.click('[data-action="continue"]');
    await skipping.page.waitForFunction(() => window.gameReady);
    assert.ok(await skipping.page.evaluate(() => window.samePage), 'nothing stored: no reload');
    await skipping.page.reload();
    await skipping.page.waitForFunction(() => window.gameReady);
    assert.equal(await skipping.page.$('.resource-dialog'), null);
    await skipping.page.click('#resource-manager-open');
    await waitText(skipping.page, '.resource-stat', '0 / 4');
    await skipping.context.close();

    server.manifest = 404;
    const plain = await newPage();
    await plain.page.goto(base);
    await plain.page.waitForFunction(() => window.gameReady);
    assert.equal(await plain.page.$('.resource-dialog'), null);
    await waitText(plain.page, '.toast__text', '本地资源不可用：资源清单不可用（HTTP 404）');
    assert.equal(await plain.page.evaluate(() => localStorage.getItem('stronghold-resource-mode')), null, 'the next visit asks again');
    server.manifest = 'ok';
    await plain.context.close();

    const old = await newPage();
    await old.page.evaluateOnNewDocument(() => { delete Navigator.prototype.locks; });
    await old.page.goto(base);
    await old.page.waitForFunction(() => window.gameReady);
    await waitText(old.page, '.toast__text', '当前浏览器无法保存本地资源，游戏将使用占位图');
    assert.equal(await old.page.$('.resource-dialog, #resource-manager-open'), null);
    await old.context.close();
  });

  assert.deepEqual(errors, []);
});
