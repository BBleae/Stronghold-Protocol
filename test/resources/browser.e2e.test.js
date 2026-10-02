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
  let offlineAssets = false, corrupt = false, noManifest = false;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    hits.push({ path: pathname, method: request.method });
    try {
      if (pathname === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><head></head><body><div id="boot">Loading</div><script type="module">import {prepareResources,installResourceManager} from "/js/resources/index.js"; await prepareResources(); window.gameReady=true;document.querySelector("#boot").remove();await installResourceManager();</script></body></html>');
        return;
      }
      if (pathname === '/resource-manifest.json' && noManifest) { response.writeHead(404).end(); return; }
      if (pathname.startsWith('/assets/')) {
        if (offlineAssets) { response.writeHead(503).end(); return; }
        if (corrupt && pathname === '/assets/b.png') { response.end('WRONG'); return; }
      }
      const resource = pathname === '/resource-manifest.json' || pathname.startsWith('/assets/');
      const path = join(resource ? fixture : root, 'public', pathname);
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
  await page.goto(base);
  await page.waitForSelector('.resource-dialog[open]');
  assert.equal(await page.$eval('#boot', node => getComputedStyle(node).display), 'none');
  assert.equal(await page.evaluate(() => window.__spResourcesPreparing), true);
  assert.equal(await page.evaluate(() => !!window.gameReady), false);
  await page.waitForSelector('[data-action="import"]:not(:disabled)');
  await (await page.$('input[type=file]')).uploadFile(pack.path);
  await page.waitForFunction(() => document.querySelector('.resource-message')?.textContent.includes('全部资源已保存'));
  assert.deepEqual(hits.filter(hit => hit.path.startsWith('/assets/') || hit.method !== 'GET'), []);
  await page.click('[data-action="continue"]');
  await page.waitForFunction(() => window.gameReady);
  assert.equal(await page.evaluate(() => !!window.__spResourcesPreparing), false);
  offlineAssets = true;
  const cached = await page.evaluate(async () => {
    const response = await fetch('/assets/a.mp3', { headers: { Range: 'bytes=2-4' } });
    return { status: response.status, contentType: response.headers.get('Content-Type'), body: await response.text() };
  });
  assert.deepEqual(cached, { status: 206, contentType: 'audio/mpeg', body: 'cde' });
  await page.click('#resource-manager-open');
  await page.waitForSelector('[data-action="clear"]:not(:disabled)');
  await page.click('[data-action="clear"]');
  await page.waitForFunction(() => document.querySelector('.resource-stat')?.textContent.startsWith('0 / 2'));
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
  await page.click('[data-action="continue"]');
  await page.reload();
  await page.waitForFunction(() => window.gameReady);
  assert.equal(await page.$('.resource-dialog'), null);
  assert.deepEqual(errors, []);
  const skipping = await browser.createBrowserContext();
  const skipped = await skipping.newPage();
  await skipped.goto(base);
  await skipped.waitForSelector('.resource-dialog[open]');
  await skipped.click('[data-action="continue"]');
  await skipped.waitForFunction(() => window.gameReady);
  await skipped.reload();
  await skipped.waitForFunction(() => window.gameReady);
  assert.equal(await skipped.$('.resource-dialog'), null);
  await skipped.click('#resource-manager-open');
  await skipped.waitForSelector('.resource-dialog[open]');
  await skipped.waitForFunction(() => document.querySelector('.resource-stat')?.textContent.startsWith('0 / 2'));
  await skipping.close();
  noManifest = true;
  const fresh = await browser.createBrowserContext();
  const plain = await fresh.newPage();
  await plain.goto(base);
  await plain.waitForFunction(() => window.gameReady);
  assert.equal(await plain.$('.resource-dialog'), null);
  await fresh.close();
});
