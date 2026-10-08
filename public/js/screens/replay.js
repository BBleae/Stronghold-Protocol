import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Panel, MicroLabel, Spinner } from '../ui/components.js';
import { store, useStore } from '../store.js';
import { accountRequest } from '../account.js';
import { verifyReplayChunks, createReplayRunner } from '../battle/replay-runner.js';
import { useFieldView } from '../ui/fieldHost.js';
import { useGameData } from '../ui/gameComponents.js';
import { t, N_ } from '../../../shared/i18n.js';

/**
 * A replay battle button's label: `第 N 回合 · names`. A round with several 联防 fields (5–8 players, a remake extension:
 * fieldId 'u', 'u2', …) names them `联防 1`, `联防 2` … (fieldId 'u' → 1, 'uN' → N); a round with one 联防 field (every
 * match of 1–4 players) reads as before.
 * @param {{ round: number, players?: string[], kind?: string, fieldId?: string }} b one recorded battle
 * @param {any[]} battles every recorded battle of the match
 * @param {(playerId: string) => string} nameOf
 */
export function replayBattleLabel(b, battles, nameOf) {
  const names = (b?.players || []).map(nameOf).join(' / ');
  const unite = b?.kind === 'unite' && (battles || []).filter((x) => x?.round === b.round && x?.kind === 'unite').length > 1;
  const no = !unite ? 0 : b.fieldId === 'u' ? 1 : Number(/^u(\d+)$/.exec(String(b.fieldId))?.[1]) || 0;
  return no ? t('第 {round} 回合 · 联防 {no} · {names}', { round: b?.round, no, names }) : t('第 {round} 回合 · {names}', { round: b?.round, names });
}

export function ReplayScreen() {
  const gd = useGameData();
  const matchId = useStore((s) => s.ui.replayMatchId),
    host = useRef(null);
  const { view } = useFieldView(host);
  const [loaded, setLoaded] = useState(null),
    [error, setError] = useState(''),
    [selected, setSelected] = useState(0);
  // the replay of the loaded match on the mounted field view
  const [runner, setRunner] = useState(null);
  useEffect(() => {
    let dead = false;
    (async () => {
      const facts = await accountRequest('/api/matches/' + matchId),
        manifest = facts.manifest;
      const replay = await verifyReplayChunks(manifest, (index) =>
        accountRequest('/api/matches/' + matchId + '/replay/' + index),
      );
      if (replay.rulesVersion !== manifest.rulesVersion || !/^[a-f0-9]{20}$/.test(manifest.rulesVersion))
        throw new Error(N_('缺少本局对应的回放版本'));
      const engine = await import('/replay-engines/' + manifest.rulesVersion + '/engine.js');
      if (engine.rulesVersion !== manifest.rulesVersion) throw new Error(N_('回放版本不匹配'));
      await engine.ready();
      if (!dead) setLoaded({ facts, replay, engine });
    })().catch((e) => {
      if (!dead) setError(e.message === 'REPLAY_INCOMPLETE' ? N_('回放数据不完整，无法播放') : e.message);
    });
    return () => {
      dead = true;
    };
  }, [matchId]);
  useEffect(() => {
    if (!view || !loaded) return undefined;
    const r = createReplayRunner({
      engine: loaded.engine,
      onField: (meta) => {
        const stage = loaded.engine.stage?.(meta.stageId) || gd.stage(meta.stageId);
        if (stage) view.setStage(stage);
        view.enterBattle(meta);
        view.setCamera(meta.kind === 'hidden' ? 'boss' : meta.kind || 'normal', { rect: meta.rect });
        view.raw?.setLocalFeed?.({ on: true, speed: r.state().speed });
      },
      onFrame: (frame) => {
        view.pushEvents(frame.events);
        view.pushSnapshot(frame.snapshot);
      },
    });
    // the replay follows real time; as its clock moves only ReplayControls renders
    let previous = performance.now();
    let raf = requestAnimationFrame(function frame(now) {
      r.advance((now - previous) / 1000);
      previous = now;
      raf = requestAnimationFrame(frame);
    });
    setRunner(r);
    return () => {
      cancelAnimationFrame(raf);
      r.dispose();
      setRunner(null);
    };
  }, [view, loaded]);
  const battle = loaded?.replay.battles[selected];
  useEffect(() => {
    if (!runner || !battle?.complete) return;
    view?.raw?.setPaused?.(false);
    runner.select(battle);
  }, [runner, battle, view]);
  return html`<div class="screen replay-screen">
    <header class="topbar"><div class="topbar__left"><${Button} variant="ghost" icon="chevronLeft" onClick=${() => store.patch('ui', { accountPage: 'history' })}>${t('返回记录')}<//></div>
      <div class="topbar__center"><${MicroLabel} tone="mint">SIMULATION REPLAY<//><h1 class="topbar__title">${t('对局回放')}</h1></div></header>
    <main class="account-body"><div class="replay-toolbar">
      ${loaded?.replay.battles.map(
        (b, i) => html`<${Button} size="sm" key=${i} variant=${selected === i ? 'primary' : 'ghost'} onClick=${() => {
          runner?.pause();
          setSelected(i);
        }}>
        ${replayBattleLabel(b, loaded.replay.battles, (id) => loaded.facts.result.players?.find((p) => p.playerId === id)?.name || id)}<//>`,
      )}
    </div>${error ? html`<${Panel}><p role="alert">${t(error)}</p><//>` : !loaded ? html`<${Spinner}/>` : !loaded.replay.battles.length ? html`<p class="t-lo">${t('本局没有进入战斗阶段')}</p>` : null}
    ${battle && !battle.complete ? html`<p class="t-lo" role="status">${t('此战场录制不完整，无法播放。结算结果仍保存在对局记录中。')}</p>` : null}
    <div ref=${host} class="replay-field" style=${battle?.complete ? '' : 'visibility:hidden'}></div>
    <${ReplayControls} runner=${runner} battle=${battle} view=${view}/></main></div>`;
}

/**
 * Play / restart / speed and the clock of the battle on screen. It follows the replay clock by itself
 * (runner.subscribe: a player's action, each whole replay second), so playing re-renders this bar only. The battle
 * picture's own clock (its animations and effects: render/app.js setPaused, setLocalFeed) follows the player's
 * choices: it stands still after 暂停 and runs at the replay's speed.
 */
function ReplayControls({ runner, battle, view }) {
  const [clock, setClock] = useState(null);
  useEffect(() => runner?.subscribe(setClock), [runner]);
  // an incomplete battle is never selected: the runner still holds the previous one
  const playable = !!(runner && clock && battle?.complete);
  const playPause = () => {
    view?.raw?.setPaused?.(clock.playing);
    if (clock.playing) runner.pause();
    else runner.play();
  };
  const restart = () => {
    view?.raw?.setPaused?.(false);
    runner.select(battle);
  };
  const setSpeed = (speed) => {
    runner?.setSpeed(speed);
    view?.raw?.setLocalFeed?.({ on: true, speed });
  };
  return html`<div class="replay-toolbar">
    <${Button} disabled=${!playable} onClick=${playPause}>${playable && clock.playing ? t('暂停') : t('播放')}<//>
    <${Button} variant="ghost" disabled=${!playable} onClick=${restart}>${t('从头播放')}<//>
    ${[0.5, 1, 2, 4].map((speed) => html`<${Button} size="sm" variant=${clock?.speed === speed ? 'primary' : 'ghost'} onClick=${() => setSpeed(speed)}>${speed}×<//>`)}
    ${playable ? html`<span class="num">${t('{seconds} / {duration} 秒', { seconds: clock.seconds, duration: clock.duration })}</span>` : null}
  </div>`;
}
