// The Cloudflare page's first-visit resource dialog (public/js/resources, the fork's resource manager) shows ahead of
// the App, so it must speak the chosen language too: main.js sets the language up (ui/lang.js initLang, 0.2.0 i18n)
// before resources.prepareResources(). The real Workers bundle in miniflare with the real client in headless Chrome.
// Opt-in: SP_ACCOUNTS_E2E=1 (and Chrome), like the other suites that bundle the Worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, copyRuntimeAssets, bundleWorker } from '../../tools/build-worker.mjs';
import { createAccountHarness, productionLimits } from '../worker/helpers/account-harness.js';

const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

test(
  'the first-visit resource dialog follows the chosen language',
  { skip: process.env.SP_ACCOUNTS_E2E !== '1' || !existsSync(chrome), timeout: 120000 },
  async (t) => {
    await copyRuntimeAssets();
    await bundleWorker();
    const h = await createAccountHarness(
      `
    import worker,{RoomDurableObject,SiteDirectory,AccountDurableObject,MatchArchive} from './dist/worker/index.mjs';
    export {SiteDirectory as TestObject,RoomDurableObject,SiteDirectory,AccountDurableObject,MatchArchive};
    export default {async fetch(req,env){const u=new URL(req.url);
      if(u.pathname.startsWith('/api/') || u.pathname==='/ws') {
        const headers=new Headers(req.headers);if(headers.has('Origin'))headers.set('Origin','https://game.example');
        return worker.fetch(new Request('https://game.example'+u.pathname+u.search,{method:req.method,headers,
          body:['GET','HEAD'].includes(req.method)?undefined:req.body}),env);
      }
      return env.ASSETS.fetch(req);
    }};
  `,
      {
        durableObjects: Object.fromEntries(
          ['SiteDirectory', 'AccountDurableObject', 'RoomDurableObject', 'MatchArchive'].map((className, i) => [
            ['SITES', 'ACCOUNTS', 'ROOMS', 'MATCH_ARCHIVES'][i],
            { className, useSQLite: true },
          ]),
        ),
        ratelimits: productionLimits,
        assets: path.join(ROOT, 'dist/client'),
      },
    );
    t.after(() => h.dispose());
    const browser = await (
      await import('puppeteer-core')
    ).default.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
    t.after(() => browser.close());
    const base = String(await h.url()).replace('127.0.0.1', 'localhost');
    const firstVisit = async (query) => {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.goto(base + query);
      await page.waitForSelector('[data-action="continue"]');
      const text = await page.evaluate(() => document.body.innerText);
      await context.close();
      return text;
    };
    const en = await firstVisit('?lang=en');
    assert.ok(en.includes('Prepare Game Resources'), 'an English first visit reads the dialog in English');
    assert.ok(!en.includes('准备游戏资源'));
    assert.ok((await firstVisit('')).includes('准备游戏资源'), 'the default stays Chinese');
  },
);
