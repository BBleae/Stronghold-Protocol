// Install as an app (PWA): public/manifest.webmanifest, its icons, the page's links and js/ui/install.js's choice per browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMode, INSTALL_HELP } from '../public/js/ui/install.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = (p) => path.join(ROOT, 'public', p);
/** [width, height] from a PNG's IHDR chunk. */
function pngSize(file) {
  const b = readFileSync(file);
  assert.equal(b.toString('latin1', 1, 4), 'PNG', `${file} is a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test('the manifest meets the install criteria (name, start_url, display, 192 and 512 px icons) for a landscape game', () => {
  const m = JSON.parse(readFileSync(pub('manifest.webmanifest'), 'utf8'));
  assert.ok(m.name && m.short_name);
  assert.equal(m.start_url, '/');
  assert.equal(m.scope, '/');
  assert.ok(['fullscreen', 'standalone'].includes(m.display));
  assert.equal(m.orientation, 'landscape');
  assert.notEqual(m.prefer_related_applications, true);
  assert.equal(m.launch_handler?.client_mode, 'focus-existing', 'a second launch focuses the running game instead of opening another');
  const purposes = (icon) => (icon.purpose || 'any').split(/\s+/);
  for (const size of [192, 512]) {
    assert.ok(m.icons.some((i) => i.sizes === `${size}x${size}` && i.type === 'image/png' && purposes(i).includes('any')), `a ${size}px icon`);
  }
  assert.ok(m.icons.some((i) => purposes(i).includes('maskable')), 'a maskable icon for Android');
  for (const icon of m.icons) {
    assert.ok(existsSync(pub(icon.src)), `${icon.src} exists`);
    if (icon.type === 'image/png') assert.equal(pngSize(pub(icon.src)).join('x'), icon.sizes, `${icon.src} is ${icon.sizes}`);
  }
});

test('the page links the manifest and the iOS home-screen icon', () => {
  const page = readFileSync(pub('index.html'), 'utf8');
  assert.match(page, /<link rel="manifest" href="\/manifest\.webmanifest" \/>/);
  assert.match(page, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png" \/>/);
  assert.deepEqual(pngSize(pub('icons/apple-touch-icon.png')), [180, 180]);
});

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  macSafari16: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  winFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  androidQQBrowser: 'Mozilla/5.0 (Linux; U; Android 14; zh-cn; V2309A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/109.0.5414.86 MQQBrowser/15.4 Mobile Safari/537.36',
  androidWeChat: 'Mozilla/5.0 (Linux; Android 14; V2309A Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.120 Mobile Safari/537.36 XWEB/1220067 MMWEBSDK/20240404 MicroMessenger/8.0.49.2600(0x28003133) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN',
  iosWeChat: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50(0x18003237) NetType/WIFI Language/zh_CN',
  iosQQ: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 QQ/9.0.60.611 V1_IPH_SQ_9.0.60_1_APP_A Pixel/1179 Core/WKWebView Device/Apple(iPhone 15 Pro) NetType/WIFI QBWebViewType/1',
};

test('the install button offers the way each browser installs, and nothing where it cannot or already is an app', () => {
  const cases = [
    [{ ua: UA.winEdge, canPrompt: true }, 'prompt'],
    [{ ua: UA.macChrome, canPrompt: true }, 'prompt'],
    [{ ua: UA.androidChrome, canPrompt: true }, 'prompt'],
    [{ ua: UA.macChrome }, null],                          // until Chrome finds the site installable
    [{ ua: UA.winFirefox }, null],
    [{ ua: UA.androidChrome }, 'android'],                 // the browser menu always offers 添加到主屏幕
    [{ ua: UA.androidQQBrowser }, 'android'],              // QQ 浏览器 is a browser, not QQ's in-app view
    [{ ua: UA.iphone }, 'ios'],
    [{ ua: UA.macSafari, maxTouchPoints: 5 }, 'ios'],      // iPadOS presents itself as a Mac
    [{ ua: UA.macSafari }, 'mac-safari'],
    [{ ua: UA.macSafari16 }, null],                        // 添加到程序坞 needs Safari 17
    [{ ua: UA.androidWeChat, canPrompt: true }, 'inapp'],
    [{ ua: UA.iosWeChat }, 'inapp'],
    [{ ua: UA.iosQQ }, 'inapp'],
    [{ ua: UA.iphone, standalone: true }, null],
    [{ ua: UA.winEdge, canPrompt: true, standalone: true }, null],
  ];
  for (const [env, want] of cases) assert.equal(installMode(env), want, JSON.stringify(env));
  for (const mode of ['ios', 'mac-safari', 'android', 'inapp']) assert.ok(INSTALL_HELP[mode]?.title && INSTALL_HELP[mode].text, `${mode} has help`);
});
