import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Panel, MicroLabel, Spinner } from '../ui/components.js';
import { store, useStore } from '../store.js';
import { accountRequest } from '../account.js';
import { verifyReplayChunks, createReplayRunner } from '../battle/replay-runner.js';
import { useFieldView } from '../ui/fieldHost.js';
import { useGameData } from '../ui/gameComponents.js';

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
        throw new Error('缺少本局对应的回放版本');
      const engine = await import('/replay-engines/' + manifest.rulesVersion + '/engine.js');
      if (engine.rulesVersion !== manifest.rulesVersion) throw new Error('回放版本不匹配');
      await engine.ready();
      if (!dead) setLoaded({ facts, replay, engine });
    })().catch((e) => {
      if (!dead) setError(e.message === 'REPLAY_INCOMPLETE' ? '回放数据不完整，无法播放' : e.message);
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
        view.raw?.setLocalFeed?.({ on: true, speed: 1 });
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
    if (runner && battle?.complete) runner.select(battle);
  }, [runner, battle]);
  return html`<div class="screen replay-screen">
    <header class="topbar"><div class="topbar__left"><${Button} variant="ghost" icon="chevronLeft" onClick=${() => store.patch('ui', { accountPage: 'history' })}>返回记录<//></div>
      <div class="topbar__center"><${MicroLabel} tone="mint">SIMULATION REPLAY<//><h1 class="topbar__title">对局回放</h1></div></header>
    <main class="account-body"><div class="replay-toolbar">
      ${loaded?.replay.battles.map(
        (b, i) => html`<${Button} size="sm" key=${i} variant=${selected === i ? 'primary' : 'ghost'} onClick=${() => {
          runner?.pause();
          setSelected(i);
        }}>
        第 ${b.round} 回合 · ${(b.players || []).map((id) => loaded.facts.result.players?.find((p) => p.playerId === id)?.name || id).join(' / ')}<//>`,
      )}
    </div>${error ? html`<${Panel}><p role="alert">${error}</p><//>` : !loaded ? html`<${Spinner}/>` : !loaded.replay.battles.length ? html`<p class="t-lo">本局没有进入战斗阶段</p>` : null}
    ${battle && !battle.complete ? html`<p class="t-lo" role="status">此战场录制不完整，无法播放。结算结果仍保存在对局记录中。</p>` : null}
    <div ref=${host} class="replay-field" style=${battle?.complete ? '' : 'visibility:hidden'}></div>
    <${ReplayControls} runner=${runner} battle=${battle}/></main></div>`;
}

/**
 * Play / restart / speed and the clock of the battle on screen. It follows the replay clock by itself
 * (runner.subscribe: a player's action, each whole replay second), so playing re-renders this bar only.
 */
function ReplayControls({ runner, battle }) {
  const [clock, setClock] = useState(null);
  useEffect(() => runner?.subscribe(setClock), [runner]);
  // an incomplete battle is never selected: the runner still holds the previous one
  const playable = !!(runner && clock && battle?.complete);
  return html`<div class="replay-toolbar">
    <${Button} disabled=${!playable} onClick=${() => (clock.playing ? runner.pause() : runner.play())}>${playable && clock.playing ? '暂停' : '播放'}<//>
    <${Button} variant="ghost" disabled=${!playable} onClick=${() => runner.select(battle)}>从头播放<//>
    ${[0.5, 1, 2, 4].map((speed) => html`<${Button} size="sm" variant=${clock?.speed === speed ? 'primary' : 'ghost'} onClick=${() => runner?.setSpeed(speed)}>${speed}×<//>`)}
    ${playable ? html`<span class="num">${clock.seconds} / ${clock.duration} 秒</span>` : null}
  </div>`;
}
