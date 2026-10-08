#!/usr/bin/env node
// tools/build-icons.mjs — render the app icons (public/icons/*.svg) into the PNGs that public/manifest.webmanifest and
// iOS (apple-touch-icon) use. The PNGs are committed; run this only after changing an SVG.
//
//   node tools/build-icons.mjs        (needs Chrome / Chromium: CHROME_PATH, like the browser suites)

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = path.join(ROOT, 'public/icons');
/** [source SVG, PNG, size] */
const RENDERS = Object.freeze([
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  ['icon-maskable.svg', 'icon-maskable-512.png', 512],
  ['icon-maskable.svg', 'apple-touch-icon.png', 180],
]);

const CHROMES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);

const executablePath = CHROMES.find((p) => existsSync(p));
if (!executablePath) {
  console.error('No Chrome found: set CHROME_PATH');
  process.exit(1);
}
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  for (const [svg, png, size] of RENDERS) {
    const src = 'data:image/svg+xml;base64,' + (await readFile(path.join(ICONS, svg))).toString('base64');
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(`<html><body style="margin:0;background:transparent"><img src="${src}" width="${size}" height="${size}" style="display:block"></body></html>`);
    await page.waitForFunction(() => globalThis.document.images[0].complete);
    await writeFile(path.join(ICONS, png), await page.screenshot({ type: 'png', omitBackground: true }));
    console.log(`public/icons/${png} (${size}×${size}) ← ${svg}`);
  }
} finally {
  await browser.close();
}
