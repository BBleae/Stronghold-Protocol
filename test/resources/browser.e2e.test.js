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

test('browser installs only matching files from a local ZIP without upload, serves cached audio Range, clears and resumes downloads, and reopens manager', { skip: !enabled, timeout: 60000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'stronghold-browser-resources-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, 'public/assets'), { recursive: true });
  await writeFile(join(fixture, 'public/assets/a.mp3'), 'abcdef');
  await writeFile(join(fixture, 'public/assets/b.png'), 'image');
  const manifest = await buildResourceManifest({ root: fixture });
  const pack = await writeResourcePack({ root: fixture, manifest });
  await writeFile(pack.path, zipSync({
    'assets/': new Uint8Array(),
    'README.txt': new TextEncoder().encode('unused'),
    'assets/audio/sfx/player/p_atk/p_atk_archet_s.mp3': new TextEncoder().encode('unused'),
    ...unzipSync(await readFile(pack.path)),
  }));
  const hits = [];
  let offlineAssets = false, corrupt = false, noManifest = false, holdDownload = false;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    hits.push({ path: pathname, method: request.method });
    try {
      if (pathname === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
          <link rel="stylesheet" href="/css/theme.css" /><link rel="stylesheet" href="/css/components.css" /><link rel="stylesheet" href="/css/devices.css" />
          <script type="importmap">{"imports":{"preact":"/vendor/preact.module.js","preact/hooks":"/vendor/hooks.module.js"}}</script>
          </head><body><div id="boot">Loading</div><script type="module">import {prepareResources,installResourceManager} from "/js/resources/index.js"; await prepareResources(); window.gameReady=true;document.querySelector("#boot").remove();await installResourceManager();</script></body></html>`);
        return;
      }
      if (pathname === '/resource-manifest.json' && noManifest) { response.writeHead(404).end(); return; }
      if (pathname.startsWith('/assets/')) {
        if (offlineAssets) { response.writeHead(503).end(); return; }
        if (holdDownload && pathname === '/assets/b.png') return; // cancelled by the client on entering a match
        if (corrupt && pathname === '/assets/b.png') { response.end('WRONG'); return; }
      }
      const resource = pathname === '/resource-manifest.json' || pathname.startsWith('/assets/');
      const path = pathname.startsWith('/shared/') ? join(root, pathname) : join(resource ? fixture : root, 'public', pathname);
      response.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.json') ? 'application/json' : pathname.endsWith('.css') ? 'text/css' : 'application/octet-stream');
      response.end(await readFile(path));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function assertDownloadComplete() {
    await page.waitForSelector('[data-action="export"]:not(:disabled)');
    assert.equal(await page.$eval('[data-action="download"]', node => node.disabled), true,
      'complete resources cannot be downloaded again');
    assert.equal(await page.$eval('[data-action="download"]', node => node.textContent.trim()), '资源已全部保存');
    // Even a stale/enabled control must not start another operation.
    const stayedIdle = await page.$eval('[data-action="download"]', async node => {
      node.disabled = false;
      node.click();
      node.disabled = true;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return !document.querySelector('[data-action="cancel"]');
    });
    assert.equal(stayedIdle, true, 'completed download handler stays idle');
  }
  await page.goto(base);
  await page.waitForSelector('.resource-dialog[role="dialog"]');
  assert.equal(await page.$eval('#boot', node => getComputedStyle(node).display), 'none');
  assert.equal(await page.evaluate(() => window.__spResourcesPreparing), true);
  assert.equal(await page.evaluate(() => !!window.gameReady), false);
  await page.waitForSelector('[data-action="import"]:not(:disabled)');
  await (await page.$('input[type=file]')).uploadFile(pack.path);
  await page.waitForFunction(() => document.querySelector('.resource-message')?.textContent.includes('全部资源已保存'));
  await assertDownloadComplete();
  assert.deepEqual(hits.filter(hit => hit.path.startsWith('/assets/') || hit.method !== 'GET'), []);
  await page.click('[data-action="continue"]');
  await page.waitForFunction(() => window.gameReady);
  assert.equal(await page.evaluate(() => !!window.__spResourcesPreparing), false);
  await page.evaluate(async () => {
    const { store } = await import('/js/store.js');
    store.set({ session: { entered: true }, room: { inMatch: true } });
  });
  await page.waitForSelector('#resource-manager-open', { hidden: true, timeout: 1500 });
  for (const phase of ['INFO_CHECK', 'BAND_DRAFT', 'BATTLE_CHECK', 'PREP', 'COMBAT', 'UNITE', 'SETTLE', 'RESULT']) {
    await page.evaluate(async phase => {
      const { store } = await import('/js/store.js');
      store.set({ room: null, match: { public: { phase } } });
    }, phase);
    assert.equal(await page.$('#resource-manager-open'), null, `resource entry stays hidden during ${phase}`);
  }
  await page.evaluate(async () => {
    const { store, emptyMatch } = await import('/js/store.js');
    store.set({ room: { inMatch: false }, match: emptyMatch() });
  });
  await page.waitForSelector('#resource-manager-open', { visible: true });
  offlineAssets = true;
  const cached = await page.evaluate(async () => {
    const response = await fetch('/assets/a.mp3', { headers: { Range: 'bytes=2-4' } });
    return { status: response.status, contentType: response.headers.get('Content-Type'), body: await response.text() };
  });
  assert.deepEqual(cached, { status: 206, contentType: 'audio/mpeg', body: 'cde' });
  await page.click('#resource-manager-open');
  await page.waitForSelector('[data-action="clear"]:not(:disabled)');
  await assertDownloadComplete();
  await page.click('[data-action="clear"]');
  await page.waitForFunction(() => document.querySelector('.resource-stat')?.textContent.startsWith('0 / 2'));
  await page.waitForSelector('[data-action="download"]:not(:disabled)');
  assert.equal(await page.$eval('[data-action="download"]', node => node.textContent.trim()), '在线下载 / 继续下载');
  offlineAssets = false; corrupt = true;
  await page.waitForSelector('[data-action="download"]:not(:disabled)');
  await page.click('[data-action="download"]');
  await page.waitForFunction(() => document.querySelector('.resource-message')?.textContent.includes('校验失败'));
  assert.ok(await page.$eval('.resource-stat', node => node.textContent.startsWith('1 / 2')));
  corrupt = false;
  await page.waitForSelector('[data-action="download"]:not(:disabled)');
  await page.click('[data-action="download"]');
  await page.waitForFunction(() => document.querySelector('.resource-message')?.textContent.includes('全部资源已保存'));
  assert.equal(hits.filter(hit => hit.path === '/assets/a.mp3').length, 1);
  assert.equal(hits.filter(hit => hit.path === '/assets/b.png').length, 2);
  await assertDownloadComplete();
  await page.click('[data-action="continue"]');
  await page.reload();
  await page.waitForFunction(() => window.gameReady);
  assert.equal(await page.$('.resource-dialog'), null);
  // complete: 导出 ZIP gives the pack back (no save dialog here: built in memory and downloaded) — it imports again
  await page.evaluate(() => {
    window.showSaveFilePicker = undefined;
    URL.createObjectURL = blob => { window.__exported = blob; return 'blob:exported'; };
  });
  await page.click('#resource-manager-open');
  await page.waitForSelector('[data-action="export"]:not(:disabled)');
  await page.click('[data-action="export"]');
  await page.waitForFunction(() => document.querySelector('.resource-message')?.textContent.includes('已导出'));
  const exported = await page.evaluate(async () => {
    const zipjs = await import('/vendor/zip.module.js');
    const reader = new zipjs.ZipReader(new zipjs.BlobReader(window.__exported));
    const names = (await reader.getEntries()).map(e => e.filename);
    await reader.close();
    return names;
  });
  assert.deepEqual(exported.sort(), ['assets/a.mp3', 'assets/b.png']);
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
  await page.click('#resource-manager-open');
  await page.waitForSelector('[data-action="clear"]:not(:disabled)');
  await page.click('[data-action="clear"]');
  await page.waitForFunction(() => document.querySelector('.resource-stat')?.textContent.startsWith('0 / 2'));
  holdDownload = true;
  await page.waitForSelector('[data-action="download"]:not(:disabled)');
  await page.click('[data-action="download"]');
  await page.waitForFunction(() => document.querySelector('.resource-stat')?.textContent.startsWith('1 / 2'));
  await page.evaluate(async () => {
    const { store } = await import('/js/store.js');
    store.set({ session: { entered: true }, room: { inMatch: true } });
  });
  await page.waitForSelector('.resource-dialog', { hidden: true });
  await page.waitForSelector('#resource-manager-open', { hidden: true });
  assert.equal(await page.evaluate(() => !!window.__spResourcesPreparing), false);
  holdDownload = false;
  await page.evaluate(async () => {
    const { store, emptyMatch } = await import('/js/store.js');
    store.set({ room: null, match: emptyMatch() });
    await (await import('/js/resources/index.js')).installResourceManager();
  });
  await page.waitForSelector('#resource-manager-open', { visible: true });
  assert.equal((await page.$$('#resource-manager-open')).length, 1);
  await page.click('#resource-manager-open');
  await page.waitForFunction(() => document.querySelector('.resource-stat')?.textContent.startsWith('1 / 2'));
  await page.click('[data-action="continue"]');
  assert.deepEqual(errors, []);
  const skipping = await browser.createBrowserContext();
  const skipped = await skipping.newPage();
  await skipped.goto(base);
  await skipped.waitForSelector('.resource-dialog[role="dialog"]');
  await skipped.click('[data-action="continue"]');
  await skipped.waitForFunction(() => window.gameReady);
  await skipped.reload();
  await skipped.waitForFunction(() => window.gameReady);
  assert.equal(await skipped.$('.resource-dialog'), null);
  await skipped.click('#resource-manager-open');
  await skipped.waitForSelector('.resource-dialog[role="dialog"]');
  await skipped.waitForFunction(() => document.querySelector('.resource-stat')?.textContent.startsWith('0 / 2'));
  assert.equal(await skipped.$eval('[data-action="export"]', node => node.disabled), true, 'nothing to export yet');
  await skipping.close();
  noManifest = true;
  const fresh = await browser.createBrowserContext();
  const plain = await fresh.newPage();
  await plain.goto(base);
  await plain.waitForFunction(() => window.gameReady);
  assert.equal(await plain.$('.resource-dialog'), null);
  await fresh.close();
});
