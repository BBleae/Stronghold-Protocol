// FORK (docs/design/fork.md §F10): the Node server's /resource-manifest.json is the manifest tools/resource-pack.mjs
// writes for the same tree — the resource packs work alike on both deployments.
// Run: node --test test/resources/node-manifest.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAssetIndex } from '../../server/http/assetIndex.js';
import { createResourceManifest } from '../../server/http/resourceManifest.js';
import { buildResourceManifest } from '../../tools/resource-pack.mjs';

test('the Node resource manifest equals the pack tool\'s for the same files, and follows a changed file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-resman-'));
  const write = (rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
  write('public/assets/char/a.png', 'png');
  write('public/assets/voice/cn/char_1/cn_021.mp3', 'ID3');
  write('public/assets/local/scene/m01/scene.bin', 'scene');
  write('public/assets/空 格/b.webp', 'webp');
  write('public/assets/readme.txt', 'not a resource');
  write('public/fonts/fonts.css', '@font-face{}');
  const idx = createAssetIndex({ publicDir: path.join(root, 'public'), delayMs: 0 });
  try {
    const resources = createResourceManifest(idx);
    idx.start();
    const view = await resources.get();
    const expected = await buildResourceManifest({ root, output: false });
    assert.deepEqual(JSON.parse(view.body.toString()), expected);
    assert.equal(view.hash, expected.version.slice(0, 16));
    assert.equal(await resources.get(), view, 'unchanged index: the same body');
    write('public/assets/char/a.png', 'png2');
    await idx.refresh();
    const next = JSON.parse((await resources.get()).body.toString());
    assert.deepEqual(next, await buildResourceManifest({ root, output: false }));
    assert.notEqual(next.version, expected.version);
    assert.equal(await createResourceManifest(null).get(), null, 'no index (SP_ASSET_INDEX=0): no manifest');
  } finally {
    idx.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
