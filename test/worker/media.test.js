import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/index.js';

/** Static assets that record the paths asked for and pass Range through. */
function assetsOf(files) {
  const asked = [];
  return { asked, async fetch(request) {
    const path = new URL(request.url).pathname;
    asked.push(path);
    const body = files[path];
    if (body == null) return new Response('not found', { status: 404 });
    const range = request.headers.get('Range');
    return new Response(request.method === 'HEAD' ? null : body, { status: range ? 206 : 200,
      headers: { 'Content-Type': 'audio/mpeg', ...(range ? { 'Content-Range': range } : {}) } });
  } };
}

const get = (path, env, init) => worker.fetch(new Request(`https://game.example${path}`, init), env);

test('/media/: the extension-less audio alias answers the first static audio file in shared/media.js order', async () => {
  const env = { ASSETS: assetsOf({ '/assets/audio/bgm/act1.mp3': 'mp3', '/assets/audio/sfx/hit.ogg': 'ogg', '/assets/audio/a%20b.mp3': 'space' }) };
  const bgm = await get('/media/bgm/act1', env);
  assert.equal(bgm.status, 200);
  assert.equal(await bgm.text(), 'mp3');
  assert.equal(await (await get('/media/sfx/hit', env)).text(), 'ogg');
  assert.equal(await (await get('/media/a%20b', env)).text(), 'space');
  // an explicit extension is tried first
  env.ASSETS.asked.length = 0;
  assert.equal(await (await get('/media/sfx/hit.ogg', env)).text(), 'ogg');
  assert.deepEqual(env.ASSETS.asked, ['/assets/audio/sfx/hit.ogg']);
  // Range and HEAD reach the static asset
  const part = await get('/media/bgm/act1', env, { headers: { Range: 'bytes=0-1' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('Content-Range'), 'bytes=0-1');
  assert.equal((await get('/media/bgm/act1', env, { method: 'HEAD' })).status, 200);
});

test('/media/: missing files, dot segments and other methods are refused without escaping /assets/audio', async () => {
  const env = { ASSETS: assetsOf({ '/assets/secret.mp3': 'no' }) };
  assert.equal((await get('/media/bgm/none', env)).status, 404);
  for (const path of ['/media/', '/media/bgm/', '/media/%2E%2E%2Fsecret', '/media/.hidden', '/media/x.', '/media/bgm//act1']) {
    assert.equal((await get(path, env)).status, 404, path);
  }
  assert.ok(env.ASSETS.asked.every((p) => p.startsWith('/assets/audio/') && !p.includes('..')), env.ASSETS.asked.join(' '));
  assert.equal((await get('/media/bgm/act1', env, { method: 'POST' })).status, 405);
});
