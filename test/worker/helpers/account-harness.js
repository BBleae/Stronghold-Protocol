import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// `ratelimits`: rate limiting bindings (name -> { namespace_id, simple: { limit, period } }); `productionLimits` are
// the Worker's own (wrangler.jsonc), for a harness that runs the whole Worker.
export const productionLimits = Object.freeze({
  RESERVE_LIMIT: { namespace_id: '1001', simple: { limit: 8, period: 60 } },
  CONNECT_LIMIT: { namespace_id: '1002', simple: { limit: 40, period: 60 } },
  STATUS_LIMIT: { namespace_id: '1003', simple: { limit: 120, period: 60 } },
  AUTH_LIMIT: { namespace_id: '1004', simple: { limit: 10, period: 60 } },
  APPLICATION_LIMIT: { namespace_id: '1005', simple: { limit: 30, period: 60 } },
  API_LIMIT: { namespace_id: '1006', simple: { limit: 600, period: 60 } },
});
export async function createAccountHarness(source, {durableObjects={},bindings={},assets,ratelimits={}}={}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-accounts-'));
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  let mf;
  try {
    const bundle = await build({ stdin: { contents: source, resolveDir: root }, bundle: true,
      format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'], write: false });
    const options = convertV4MiniflareOptions({
      workers: [{ name: 'account-tests', script: bundle.outputFiles[0].text, modules: true,
        compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
        bindings,ratelimits,...(assets?{assets:{directory:assets,binding:'ASSETS',run_worker_first:true,routerConfig:{has_user_worker:true,invoke_user_worker_ahead_of_assets:true}}}:{}),
        durableObjects: { TEST: { className: 'TestObject', useSQLite: true },...durableObjects } }] });
    options.resourcePersistencePath = path.join(dir, 'storage');
    const start = async () => { mf = new Miniflare(options); await mf.ready; };
    await start();
    return {
      fetch: (body) => mf.dispatchFetch('https://test.example/', { method: 'POST', body: JSON.stringify(body) }),
      request:(url,init)=>mf.dispatchFetch(url,init),
      url:()=>mf.ready,
      // Evict a Durable Object of the worker as the platform does (its accepted WebSockets hibernate and stay open).
      evict:(className,name)=>mf.unsafeEvictDurableObject('account-tests',className,{name,webSockets:'hibernate'}),
      async restart() {
        // Keep the browser origin stable so live clients can exercise automatic reconnection.
        options.port = Number(new URL(await mf.ready).port);
        await mf.dispose(); await start();
      },
      async dispose() { await mf.dispose(); await rm(dir, { recursive: true, force: true }); },
    };
  } catch (error) { await mf?.dispose(); await rm(dir, { recursive: true, force: true }); throw error; }
}
