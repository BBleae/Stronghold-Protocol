import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

export async function createAccountHarness(source) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-accounts-'));
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  let mf;
  try {
    const bundle = await build({ stdin: { contents: source, resolveDir: root }, bundle: true,
      format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'], write: false });
    const options = convertV4MiniflareOptions({
      workers: [{ name: 'account-tests', script: bundle.outputFiles[0].text, modules: true,
        compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
        durableObjects: { TEST: { className: 'TestObject', useSQLite: true } } }] });
    options.resourcePersistencePath = path.join(dir, 'storage');
    const start = async () => { mf = new Miniflare(options); await mf.ready; };
    await start();
    return {
      fetch: (body) => mf.dispatchFetch('https://test.example/', { method: 'POST', body: JSON.stringify(body) }),
      async restart() { await mf.dispose(); await start(); },
      async dispose() { await mf.dispose(); await rm(dir, { recursive: true, force: true }); },
    };
  } catch (error) { await mf?.dispose(); await rm(dir, { recursive: true, force: true }); throw error; }
}
