// The Android app (android/, docs/ANDROID.md) against the web client it hosts: the Java side keeps its own copies of
// a few web contracts — the /media/ audio extensions (shared/media.js), the user-agent mark the page reads
// (public/js/appShell.js), the default server — and nothing compiles them together, so they are compared here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIO_EXTS, MEDIA_PREFIX } from '../shared/media.js';
import { inApp, appBundled } from '../public/js/appShell.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JAVA = join(ROOT, 'android/app/src/main/java/ag/lunar/stronghold');
const read = (p) => readFileSync(p, 'utf8');
const bundled = read(join(JAVA, 'BundledAssets.java'));
const activity = read(join(JAVA, 'MainActivity.java'));
const strings = (src) => [...src.matchAll(/"([^"]*)"/g)].map((m) => m[1]);

test('BundledAssets resolves /media/… with the server\'s extensions, in the server\'s order', () => {
  const decl = /AUDIO_EXTS\s*=\s*\{([^}]*)\}/.exec(bundled);
  assert.ok(decl, 'AUDIO_EXTS in BundledAssets.java');
  assert.deepEqual(strings(decl[1]), [...AUDIO_EXTS]);
  assert.ok(bundled.includes(`"${MEDIA_PREFIX}"`), 'the /media/ prefix');
});

test('the WebView\'s user-agent mark is the one public/js/appShell.js reads', () => {
  const token = /UA_TOKEN\s*=\s*"([^"]+)"/.exec(activity)?.[1];
  assert.equal(token, 'StrongholdApp');
  assert.match(activity, /UA_TOKEN \+ "\/" \+ versionName\(\) \+ \(bundled\.count\(\) > 0 \? " bundled" : ""\)/);
  const ua = 'Mozilla/5.0 (Linux; Android 14; wv) Chrome/129.0 Mobile Safari/537.36';
  assert.equal(inApp(`${ua} ${token}/0.1.3`), true);
  assert.equal(appBundled(`${ua} ${token}/0.1.3`), false);
  assert.equal(appBundled(`${ua} ${token}/0.1.3 bundled`), true);
});

test('晴猫\'s server is the default, and tools/build-android.mjs takes its resources from it', () => {
  const list = /SERVERS\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(activity);
  assert.ok(list, 'SERVERS in MainActivity.java');
  const origins = strings(list[1]).filter((s) => /^https?:\/\//.test(s));
  assert.deepEqual(origins, ['https://stronghold.lunar.ag', 'https://xn--rlr.rinko.ai']);
  assert.match(read(join(ROOT, 'tools/build-android.mjs')), /DEFAULT_SERVER = 'https:\/\/stronghold\.lunar\.ag'/);
});

test('the bundled paths are the resource manifest\'s /assets and /fonts files, the ones BundledAssets answers', () => {
  const tool = read(join(ROOT, 'tools/build-android.mjs'));
  assert.ok(tool.includes(String.raw`/^\/(assets|fonts)\//`));
  // the client's resource manifest covers the same two trees (tools/resource-pack.mjs)
  assert.match(read(join(ROOT, 'tools/resource-pack.mjs')), /assets[\s\S]{0,200}fonts|fonts[\s\S]{0,200}assets/);
});

test('version and build number follow package.json', () => {
  const gradle = read(join(ROOT, 'android/app/build.gradle'));
  assert.match(gradle, /rootProject\.file\('\.\.\/package\.json'\)/);
  assert.match(gradle, /parts\[0\] \* 10000 \+ parts\[1\] \* 100 \+ parts\[2\]/);
  const { version } = JSON.parse(read(join(ROOT, 'package.json')));
  const [a, b, c] = version.split('.').map((p) => parseInt(p, 10));
  assert.ok(b < 100 && c < 100, `${version}: minor and patch fit in two digits each`);
  assert.ok(a * 10000 + b * 100 + c > 0);
});
