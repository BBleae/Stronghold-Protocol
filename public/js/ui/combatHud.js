// Combat HUD (research 06 §11.3/§11.7, research 09 §3.1 / §6.3): DP counter at the right edge and the bottom-centre
// pills.
//   Client-side combat (`client` prop, DESIGN §14 — the official behaviour):
//     * own normal battle over: "⌛ 作战结束，等待队友完成作战" with each teammate's live progress (kills / total, ✓);
//     * observing a teammate (team row → 前往查看): "👁 name" + 返回战场;
//     * 联防 / 最终攻势: the ‹ › pill switches the camera LEFT half / 全景 / RIGHT half ("你自己" / name / "全景"); it
//       replaces the observing pill on such a field watched with 前往查看 (a 联防 leaker, an eliminated spectator — the
//       official non-helper pill "‹ 👁 helper# ›"), with 返回战场 beside the arrows (DESIGN §20.15);
//     * there is NO view switcher during normal combat;
//     * several 联防 fields (more than 4 alive, a remake extension): ‹ 联防阵地 N › above the ‹ › pill cycles them
//       (g.watch) for a viewer who may switch (battle/observe.js uniteSwitchFields: not a helper while its own field
//       runs); with one 联防 field it never shows.
//   Server-run combat (legacy streaming mode): the ‹ 自己 › switcher cycling the live fields of m.public.fields (several
//   联防 fields read 联防阵地 1 / 2 …, gameLogic fieldLabel).

import { html, Icon, PlayerName } from './components.js';
import { DpCounter } from './hud.js';
import { GIcon } from './gameComponents.js';
import { switcherLabel, cycleField, fieldLabel } from './gameLogic.js';
import { t } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/** Whether the teammates' progress list of `n` pills is dense (more than the 3 teammates of a 4-player room). */
export const progressDense = (n) => Number(n) > 3;

/** Teammates' progress under the waiting pill (css/screens/game.css .chud__progress / .chud__prog); the 4–7 teammates
 *  of a 5–8-player room get shorter pills (`chud__progress--dense`), so they keep to two rows over the field. */
function ProgressList({ list }) {
  if (!Array.isArray(list) || !list.length) return null;
  return html`<div class=${cx('chud__progress', progressDense(list.length) && 'chud__progress--dense')} role="list" aria-label=${t('队友作战进度')}>
    ${list.map((p) => html`<span key=${p.playerId} role="listitem" class=${cx('chud__prog', p.done && 'is-done')}>
      <b><${PlayerName} name=${p.name} /></b>
      ${p.done
        ? html`<span class="chud__prog__ok" aria-label=${t('作战结束')}>✓</span>`
        : html`<span class="num">${p.killed != null && p.total != null ? `${p.killed}/${p.total}` : '•••'}</span>`}
    </span>`)}
  </div>`;
}

/**
 * @param {{ pub:any, myId:string, watching:string|null, hud:any, myDone:boolean, onWatch:(fieldId:string)=>void, spectating?: boolean,
 *   spectator?: boolean, client?: null | { progress?: any[]|null, observing?: { name: string }|null, onBack?: () => void,
 *                     layers?: Array<{ key: string, label: string, self: boolean, watch: boolean }>, layer?: string, onLayer?: (k: string) => void,
 *                     uniteFields?: { list: string[], current: string|null, onPick: (fieldId: string) => void } | null } }} props
 *   client.uniteFields: several 联防 fields the viewer may switch between (battle/observe.js uniteSwitchFields), the one on
 *   screen and the pick (g.watch); null / fewer than two: no switcher
 */
export function CombatHud({ pub, myId, watching, hud, myDone, onWatch, spectating = false, spectator = false, client = null }) {
  // `spectator`: a spectator (store.js isSpectator — a spectator seat, community report #26, or a public match's)
  // watches like an eliminated player, under its own caption
  if (client) return ClientHud({ pub, myId, hud, myDone, spectating, spectator, client });
  const fields = (Array.isArray(pub?.fields) ? pub.fields : []).filter((f) => f && f.live !== false);
  // the watched field may already have finished (not live): still name it
  const label = switcherLabel(pub, watching, myId, spectating);
  const canCycle = fields.length > 1;
  return html`<div class="chud">
    <${DpCounter} dp=${hud?.dp} />
    <div class="chud__bottom">
      ${myDone ? html`<div class="chud__msg" role="status"><${Icon} name="hourglass" /><span>${t('作战结束，等待队友完成作战')}</span></div>` : null}
      ${spectating ? (spectator ? html`<div class="chud__msg" role="status"><${GIcon} name="eye" /><span>${t('观战中')}</span></div>`
        : html`<div class="chud__msg chud__msg--dead" role="status"><${Icon} name="close" /><span>${t('你已被淘汰，正在观战')}</span></div>`) : null}
      ${fields.length ? html`<div class=${cx('vswitch', !canCycle && 'is-single')}>
        <button type="button" class="vswitch__arrow" disabled=${!canCycle} aria-label=${t('上一个战场')}
          onClick=${() => { const n = cycleField(fields, watching, -1); if (n && n !== watching) onWatch(n); }}><${Icon} name="chevronLeft" /></button>
        <span class="vswitch__label">${label}</span>
        <button type="button" class="vswitch__arrow" disabled=${!canCycle} aria-label=${t('下一个战场')}
          onClick=${() => { const n = cycleField(fields, watching, 1); if (n && n !== watching) onWatch(n); }}><${Icon} name="chevronRight" /></button>
      </div>` : null}
    </div>
  </div>`;
}

/**
 * ‹ 联防阵地 N › — several 联防 fields (more than 4 alive): cycles the fields the viewer may switch between; null with
 * fewer than two (one 联防 field: never shown).
 * @param {{ pub: any, myId: string, sw: { list: string[], current: string|null, onPick: (fieldId: string) => void } | null | undefined }} o
 */
export function UniteFieldSwitch({ pub, myId, sw }) {
  const list = sw && Array.isArray(sw.list) ? sw.list.filter((f) => typeof f === 'string' && f) : [];
  if (list.length < 2 || typeof sw.onPick !== 'function') return null;
  const items = list.map((fieldId) => ({ fieldId }));
  const fields = (Array.isArray(pub?.fields) ? pub.fields : []).filter((f) => f && typeof f === 'object');
  const cur = fields.find((f) => f.fieldId === sw.current) || null;
  const label = cur && list.includes(cur.fieldId) ? fieldLabel(cur, pub, myId) : t('联防阵地');
  const go = (d) => { const n = cycleField(items, sw.current, d); if (n && n !== sw.current) sw.onPick(n); };
  return html`<div class="vswitch chud__fields" data-testid="unite-fields">
    <button type="button" class="vswitch__arrow" aria-label=${t('上一个联防阵地')} onClick=${() => go(-1)}><${Icon} name="chevronLeft" /></button>
    <span class="vswitch__label">${label}</span>
    <button type="button" class="vswitch__arrow" aria-label=${t('下一个联防阵地')} onClick=${() => go(1)}><${Icon} name="chevronRight" /></button>
  </div>`;
}

function ClientHud({ pub = null, myId = '', hud, myDone, spectating, spectator = false, client }) {
  const layers = Array.isArray(client.layers) ? client.layers : [];
  const idx = Math.max(0, layers.findIndex((l) => l.key === (client.layer || 'ALL')));
  const cur = layers[idx] || null;
  const step = (d) => {
    if (!layers.length || !client.onLayer) return;
    const n = Math.min(layers.length - 1, Math.max(0, idx + d));
    if (n !== idx) client.onLayer(layers[n].key);
  };
  const observing = client.observing;
  const halves = layers.length > 0;
  return html`<div class="chud">
    <${DpCounter} dp=${hud?.dp} />
    <div class="chud__bottom">
      ${myDone && !observing ? html`<div class="chud__msg chud__wait" role="status"><${Icon} name="hourglass" /><span>${t('作战结束，等待队友完成作战')}</span></div>
        <${ProgressList} list=${client.progress} />` : null}
      ${spectating && !observing ? (spectator ? html`<div class="chud__msg" role="status"><${GIcon} name="eye" /><span>${t('观战中，可点击左侧成员头像前往查看')}</span></div>`
        : html`<div class="chud__msg chud__msg--dead" role="status"><${Icon} name="close" /><span>${t('你已被淘汰，可点击队友头像前往查看')}</span></div>`) : null}
      ${observing && !halves ? html`<div class="vswitch chud__observe is-single" role="status">
        <span class="vswitch__label"><${GIcon} name="eye" /><span>${observing.name}</span></span>
        ${client.onBack ? html`<button type="button" class="btn btn--secondary btn--sm chud__back" onClick=${() => client.onBack()}>
          <span class="btn__label">${t('返回战场')}</span></button>` : null}
      </div>` : null}
      ${client.uniteFields ? html`<${UniteFieldSwitch} pub=${pub} myId=${myId} sw=${client.uniteFields} />` : null}
      ${halves ? html`<div class=${cx('vswitch', 'chud__layers', observing && 'is-observing')}>
        <button type="button" class="vswitch__arrow" disabled=${idx <= 0} aria-label=${t('左侧战场')} onClick=${() => step(-1)}><${Icon} name="chevronLeft" /></button>
        <span class="vswitch__label">
          ${cur && cur.watch ? html`<${GIcon} name="eye" />` : null}<span>${cur ? cur.label : t('全景')}</span></span>
        <button type="button" class="vswitch__arrow" disabled=${idx >= layers.length - 1} aria-label=${t('右侧战场')} onClick=${() => step(1)}><${Icon} name="chevronRight" /></button>
        ${observing && client.onBack ? html`<button type="button" class="btn btn--secondary btn--sm chud__back" onClick=${() => client.onBack()}>
          <span class="btn__label">${t('返回战场')}</span></button>` : null}
      </div>` : null}
    </div>
  </div>`;
}
