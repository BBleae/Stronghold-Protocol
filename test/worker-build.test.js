import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('Workers static build preserves public routes without publishing private source or ZIPs', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sp-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'public/index.html': '<html lang="zh-CN"><body><script type="module" src="/js/main.js"></script></body></html>',
    'public/assets/a.png': 'image', 'public/.secret': 'secret',
    'public/dev/recording.json': 'private dev data', 'public/bundle.zip': 'archive',
    'shared/protocol.js': 'export {}', 'data/config.json': '{}',
    'server/sim/Battle.js': 'export {}', 'server/sim/nodeData.js': 'private loader',
    'server/private.js': 'secret',
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  const { copyRuntimeAssets } = await import('../tools/build-worker.mjs');
  const out = path.join(root, 'dist/client');
  await copyRuntimeAssets({ root, out });
  assert.equal(await readFile(path.join(out, 'assets/a.png'), 'utf8'), 'image');
  assert.match(await readFile(path.join(out, 'index.html'), 'utf8'), /data-sp-runtime="cloudflare"/);
  assert.match(await readFile(path.join(out, 'index.html'), 'utf8'), /src="\/js\/worker-entry.js"/);
  assert.match(await readFile(path.join(out, 'data.js'), 'utf8'), /getSimData/);
  await access(path.join(out, 'sim/Battle.js'));
  await access(path.join(out, 'data/config.json'));
  for (const name of ['.secret', 'dev/recording.json', 'bundle.zip', 'sim/nodeData.js', 'server/private.js']) {
    await assert.rejects(access(path.join(out, name)), { code: 'ENOENT' });
  }
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
