// Real-server browser E2E of the fork's collab 自选 picks (DESIGN §F6, the maintainer's decision of 2026-10-08): the
// 自选编队 picker lists the 7 collab 6★ upstream leaves out, and one of them — 结城理 (char_4217_makoto: S1, PUM-Y) — goes
// the whole way like test/ui/diy.e2e.test.js's 推进之王: slotted with real clicks and synced, sold by the level-5 shop
// with 「自选」 and his 拉特兰 bond, bought, deployed (the detail card), and fielded by the browser's own battle with his
// operator kit and his Spine model; when his <替身> comes out in that battle the view draws the persona of his skill
// (render/units.js FORMS char_4217_makoto, the kit's 'persona' fx).
//
//   SP_E2E=1 node --test test/ui/diy-collab.e2e.test.js
//
// The server is test/e2e/fastServer.mjs with its starter-kit hooks (no starter operators, the 调度中心 at level 5, the
// tier-5 DIY slot in the first shop slot). Screenshots: test/e2e/out/diy-collab-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client, ROOT, sleep, hasChrome, startRealServer, problemsOf } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome() && existsSync(path.join(ROOT, 'public/assets'));
const SLOT = 'chess_char_5_diy1_a';
const MAKOTO = 'char_4217_makoto';
const PICK = { charId: MAKOTO, skillIndex: 0, uniEquipId: 'uniequip_002_makoto' };
const COLLAB = ['char_456_ash', 'char_1029_yato2', 'char_1048_orchd2', 'char_4123_ela', 'char_4141_marcil', 'char_4182_oblvns', MAKOTO];

describe('the fork\'s collab 自选 picks in the browser (real server)', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome and the assets)' }, () => {
  test('自选编队: the 7 collab picks are listed; 结城理 → level-5 shop card (自选, 拉特兰) → buy → deploy → the local battle fields him', { timeout: 6 * 60 * 1000 }, async () => {
    const srv = await startRealServer({ fast: { timerScale: 0.5, combatSpeed: 2, startRound: 1, kit: 0, level: 5, shop: [SLOT] } });
    const P = (await import('puppeteer-core')).default;
    const c = new Client(P, srv.base, 'diy-collab', { prefix: 'diy-collab' });
    try {
      await c.open();
      await c.enter('联动');
      // 1) 干员调配 → 自选编队: the picker lists the 7; slot 结城理 S1 + PUM-Y (real clicks), synced, stored
      await c.click('.lobby-screen [data-testid="loadout-open"]');
      await c.page.waitForSelector('.lo .lo-tab[data-tab="diy"]', { visible: true, timeout: 15000 });
      await c.click('.lo .lo-tab[data-tab="diy"]');
      await c.page.waitForSelector(`.diy-slot[data-slot="${SLOT}"] .diy-slot__fill`, { visible: true, timeout: 15000 });
      await c.click(`.diy-slot[data-slot="${SLOT}"] .diy-slot__fill`);
      await c.page.waitForSelector(`[data-testid="diy-picker"] .diy-opt[data-char="${MAKOTO}"]`, { visible: true, timeout: 8000 });
      const listed = await c.page.evaluate(() => [...document.querySelectorAll('[data-testid="diy-picker"] .diy-opt')].map((el) => el.dataset.char));
      for (const id of COLLAB) assert.ok(listed.includes(id), `${id} is a pick`);
      // the list is long: find him by name (the picker's search field), as a player would
      await c.click('[data-testid="diy-picker"] input[type="search"]');
      await c.page.keyboard.type('结城');
      await c.page.waitForFunction((id) => {
        const opts = [...document.querySelectorAll('[data-testid="diy-picker"] .diy-opt')];
        return opts.length > 0 && opts.every((el) => el.dataset.char === id);
      }, { timeout: 5000 }, MAKOTO);
      await c.click(`[data-testid="diy-picker"] .diy-opt[data-char="${MAKOTO}"]`);
      await c.page.waitForSelector('[data-testid="diy-picker"] .diy-choice[data-skill="0"]', { visible: true, timeout: 5000 });
      await c.click('[data-testid="diy-picker"] .diy-choice[data-skill="0"]');
      await c.click('[data-testid="diy-picker"] .diy-choice[data-module="uniequip_002_makoto"]');
      await c.shot('picker');
      await c.click('[data-testid="diy-confirm"]');
      await c.page.waitForFunction((slot, id) => document.querySelector(`.diy-slot[data-slot="${slot}"]`)?.dataset.char === id, { timeout: 4000 }, SLOT, MAKOTO);
      await c.page.waitForFunction(() => /已同步/.test(document.querySelector('[data-testid="diy-sync"]')?.textContent || ''), { timeout: 8000 });
      const card = await c.page.evaluate((slot) => document.querySelector(`.diy-slot[data-slot="${slot}"]`)?.textContent || '', SLOT);
      assert.ok(card.includes('结城理') && card.includes('已持有') && card.includes('PUM-Y'), card);
      const stored = await c.page.evaluate(() => JSON.parse(localStorage.getItem('sp.pref.diy') || 'null'));
      assert.deepEqual(stored, { v: 1, picks: { [SLOT]: PICK } });
      // (a pause before closing, as test/ui/diy.e2e.test.js's screenshot gives: the lobby animates back in as the overlay
      // closes, and a click aimed in its first frames lands beside the mode card)
      await c.shot('slotted');
      await c.page.keyboard.press('Escape');
      await c.page.waitForFunction(() => !document.querySelector('.lo'), { timeout: 3000 });
      await sleep(500);

      // 2) a solo 标准 match: the picks reach it
      await c.click('.mode-card', '独立模拟');
      await c.click('.diff-card', '标准模拟');
      await c.click('.create-box button', '开始独立模拟');
      await c.waitFor((s) => !!s.room, 'solo room');
      if (!(await c.st()).phase) await c.click('.room-bar__right button', '开始模拟', { timeout: 20000 });
      await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 30000);
      const diy = await c.page.evaluate(() => globalThis.__SP__.store.get().match.private?.diy ?? null);
      assert.deepEqual(diy, { [SLOT]: PICK }, 'the match received the pick');
      await c.click('.brief__foot .btn--primary', '准备就绪');
      await c.waitFor((s) => s.phase === 'BAND_DRAFT', 'band draft', 30000);
      await c.click('.dband', null, { nth: 1 });
      await c.click('.draft-detail__btns .btn--primary', '确认选择');
      await c.waitFor((s) => s.phase === 'PREP' && !s.ready && s.funds >= 4 && s.level >= 5, 'prep at 调度中心 level 5', 60000);
      await sleep(1800); // camera flight

      // 3) the shop card: 结城理, 「自选」, his 拉特兰 bond (subPower laterano); two taps buy it
      await c.page.waitForSelector('.scard .scard__diy', { visible: true, timeout: 10000 });
      const shopCard = await c.page.evaluate(() => {
        const el = document.querySelector('.scard .scard__diy')?.closest('.scard');
        return el ? { name: el.querySelector('.scard__name')?.textContent, badge: el.querySelector('.scard__diy')?.textContent, diy: el.querySelector('.scard__diy')?.dataset.diy, bonds: el.querySelector('.scard__bonds')?.textContent } : null;
      });
      assert.deepEqual([shopCard?.name, shopCard?.badge, shopCard?.diy], ['结城理', '自选', MAKOTO]);
      assert.ok(shopCard.bonds.includes('拉特兰'), `derived bond: ${shopCard.bonds}`);
      await c.shot('shop');
      await c.click('.scard', '结城理');
      await sleep(300);
      await c.click('.scard', '结城理');
      await c.waitFor((s) => s.hand > 0, 'bought', 8000);
      await sleep(900);
      const [piece] = (await c.handPieces('chess')).filter((p) => p.id === SLOT);
      assert.ok(piece, 'the slot\'s piece is in the hand');
      const handModel = await c.page.evaluate((uid) => globalThis.__SP_VIEW__?.raw?.debug?.views?.get(`p:${uid}`)?.info?.spine ?? null, piece.uid);
      assert.equal(handModel, MAKOTO, 'the hand draws the operator');

      // 4) deploy it; the detail card shows 结城理 with the pick's skill
      const tile = await c.freeTileFor(piece.uid);
      assert.ok(tile, 'a legal tile');
      await c.drag(await c.piecePoint(piece.uid), await c.tilePoint(tile.row, tile.col));
      await c.page.waitForSelector('.fwheel__dia', { timeout: 4000 });
      await c.swipe('RIGHT');
      await c.waitFor((s) => s.board > 0, 'placed', 8000);
      await sleep(600);
      let detail = null;
      for (const at of [0.72, 0.4, 0.88]) {
        const p = await c.piecePoint(piece.uid, at);
        if (!p) continue;
        await c.page.mouse.click(p.x, p.y, { button: 'right' });
        detail = await c.page.waitForSelector('.dpanel .dtag-diy', { timeout: 2500 }).then(() => c.page.evaluate(() => ({
          tag: document.querySelector('.dpanel .dtag-diy')?.textContent || '',
          name: document.querySelector('.dpanel .dhead__name')?.textContent || '',
          skill: document.querySelector('.dpanel .dskill')?.dataset.skill || '',
        })), () => null);
        if (detail) break;
      }
      assert.deepEqual(detail, { tag: '自选', name: '结城理', skill: 'skchr_makoto_1' });
      await c.shot('board');
      await c.page.keyboard.press('Escape');

      // 5) ready → the local battle fields 结城理 with his kit and model; his persona, if it comes out, on screen too
      await c.click('.readybtn');
      await c.waitFor((s) => s.phase === 'COMBAT', 'combat', 60000);
      const got = await c.page.waitForFunction((uid) => {
        const r = globalThis.__SP_RUNNER__;
        const e = r && [...r._entries.values()].find((x) => x.own && x.battle);
        if (!e) return false;
        const u = e.battle.allyUnits.find((x) => x.uid === uid);
        if (!u) return false;
        const views = globalThis.__SP_VIEW__?.raw?.debug?.views;
        const v = views ? [...views.values()].find((x) => x.info?.uid === uid && !String(x.id).startsWith('p:')) : null;
        if (!v || !v.spineReady) return false;
        const entry = (e.spec.players || []).flatMap((p) => p.units || []).find((x) => x.uid === uid) || null;
        return {
          authoritative: e.authoritative, spec: entry && { chessId: entry.chessId, diy: entry.diy ?? null },
          charId: u.def?.charId, skill: u.skill?.id ?? null, bonds: u.def?.bonds, generic: !!u.kit?.generic,
          viewSpine: v.info.spine, model: String(v._actorEntry?.skel || ''),
        };
      }, { timeout: 30000, polling: 150 }, piece.uid).then((h) => h.jsonValue());
      assert.equal(got.authoritative, true, 'the own normal battle is simulated by this browser');
      assert.deepEqual(got.spec, { chessId: SLOT, diy: PICK }, 'b.start spec carries the pick');
      assert.equal(got.charId, MAKOTO, 'the local sim fields 结城理');
      assert.equal(got.skill, 'skchr_makoto_1');
      assert.deepEqual(got.bonds, ['lateranoShip']);
      assert.equal(got.generic, false, 'his operator kit');
      assert.equal(got.viewSpine, MAKOTO);
      assert.match(got.model, /char_4217_makoto/, 'the battle view draws his Spine model');
      // the battle: when his <替身> comes out (the sim's form <俄耳甫斯> — whether an enemy reaches his x-1 in time is up to
      // the battle, so that wait is optional), the view must follow and draw it on its clips — a hard check, within the
      // event delivery and interpolation lag (the persona lasts 20 s of game time)
      const simForm = await c.page.waitForFunction((uid) => {
        const r = globalThis.__SP_RUNNER__;
        const e = r && [...r._entries.values()].find((x) => x.own && x.battle);
        const u = e?.battle?.allyUnits.find((x) => x.uid === uid);
        return u?.form === 'orpheus';
      }, { timeout: 60000, polling: 100 }, piece.uid).then(() => true, () => false);
      if (simForm) {
        const persona = await c.page.waitForFunction((uid) => {
          const views = globalThis.__SP_VIEW__?.raw?.debug?.views;
          const v = views ? [...views.values()].find((x) => x.info?.uid === uid && !String(x.id).startsWith('p:')) : null;
          return v && v.form === 'orpheus' ? { form: v.form, clip: v.actor?.current ?? null } : false;
        }, { timeout: 8000, polling: 100 }, piece.uid).then((h) => h.jsonValue(), () => null);
        assert.ok(persona, 'the sim switched to <俄耳甫斯>: the view follows (render/units.js FORMS char_4217_makoto, the \'persona\' fx)');
        assert.match(String(persona.clip), /^Doll_Skill_1_/, `the view plays <俄耳甫斯>'s clips (${persona.clip})`);
        await c.shot('persona');
      } else {
        console.log('[diy-collab] no <替身> came out in this battle (no enemy entered his x-1 in time): the persona check was not reached');
      }
      await c.waitFor((s) => (s.phase === 'PREP' && s.round >= 2) || !!s.result, 'next prep', 180000);
      assert.deepEqual(problemsOf([c]), []);
    } finally {
      if (c.problems.length) console.log(c.problems.slice(0, 20).join('\n'));
      await c.close();
      await srv.stop();
    }
  });
});
