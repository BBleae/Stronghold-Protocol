// public/js/screens/game/overlays.js — the match-ended plate, the solo pause plate and the spectator count.

import { Button, MicroLabel, html } from '../../ui/components.js';
import { emptyMatch, store, useStore } from '../../store.js';
import { localAsset } from '../../data.js';
import { quitMatch } from '../../ui/matchChrome.js';
import { t } from '../../../../shared/i18n.js';

/**
 * The spectator count of a match that can be watched (the room's state has one only then — the room Worker's public
 * spectating, worker/rooms/spectators.js): for its players while someone watches, for a spectator with its way out. The
 * only part a count update renders.
 */
export function SpectatorPresence({ spectating }) {
  const count = useStore((s) => s.room?.spectatorCount);
  if (count == null || (!count && !spectating)) return null;
  return html`<div class="spectator-presence" role="status" aria-live="polite">
    <span>${spectating ? t('正在观战 · {n} 人观战', { n: count }) : t('{n} 人观战', { n: count })}</span>
    ${spectating ? html`<${Button} size="sm" variant="ghost" onClick=${quitMatch}>${t('退出观战')}<//>` : null}
  </div>`;
}

/** The room went back to its lobby without a result (match aborted): offer the way back. */
export function MatchEnded() {
  return html`<div class="awayov" role="dialog" aria-label=${t('模拟已结束')}>
    <div class="awayov__box brackets">
      <${MicroLabel} tone="mint">SIMULATION CLOSED</${MicroLabel}>
      <h2>${t('本局模拟已结束')}</h2>
      <p class="t-lo">${t('同盟已返回等待室')}</p>
      <${Button} variant="primary" size="lg" icon="chevronLeft" onClick=${() => store.set({ match: emptyMatch() })}>${t('返回同盟')}<//>
    </div>
  </div>`;
}

/** Solo pause (m.public.paused): the field dims under the 暂停中 plate; 继续作战 resumes (g.pause off). */
export function PausedOverlay({ canResume, busy, onResume, onExit }) {
  const plate = localAsset('ui/battle', 'matte_pause');
  return html`<div class="pauseov" role="dialog" aria-label=${t('暂停中')} data-testid="paused">
    <div class="pauseov__box">
      <div class="pauseov__plate" style=${plate ? `--pause-plate:url("${plate}")` : ''}>
        <span class="pauseov__micro">PAUSED</span>
        <h2>${t('暂停中')}</h2>
      </div>
      <p class="pauseov__note">${t('作战已暂停，计时与敌人行动均已停止')}</p>
      <div class="pauseov__btns">
        ${onExit ? html`<${Button} variant="secondary" size="lg" icon="exit" onClick=${onExit}>${t('放弃模拟')}<//>` : null}
        ${canResume ? html`<${Button} variant="primary" size="lg" icon="play" loading=${busy} onClick=${onResume} data-autofocus>${t('继续作战')}<//>` : null}
      </div>
    </div>
  </div>`;
}
