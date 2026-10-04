import { useEffect,useRef,useState } from '../../vendor/hooks.module.js';
import { html,Button,Panel,MicroLabel,Spinner } from '../ui/components.js';
import { store,useStore } from '../store.js';
import { accountRequest } from '../account.js';
import { verifyReplayChunks,createReplayRunner } from '../battle/replay-runner.js';
import { useFieldView } from '../ui/fieldHost.js';
import { useGameData } from '../ui/gameComponents.js';

export function ReplayScreen() {
  const gd=useGameData();
  const matchId=useStore(s=>s.ui.replayMatchId),host=useRef(null),runner=useRef(null);
  const {view}=useFieldView(host);
  const [loaded,setLoaded]=useState(null),[error,setError]=useState(''),[selected,setSelected]=useState(0),[state,setState]=useState({});
  useEffect(()=>{
    let dead=false;
    (async()=>{
      const facts=await accountRequest('/api/matches/'+matchId),manifest=facts.manifest;
      const replay=await verifyReplayChunks(manifest,index=>accountRequest('/api/matches/'+matchId+'/replay/'+index));
      if(replay.rulesVersion!==manifest.rulesVersion || !/^[a-f0-9]{20}$/.test(manifest.rulesVersion))throw new Error('缺少本局对应的回放版本');
      const engine=await import('/replay-engines/'+manifest.rulesVersion+'/engine.js');
      if(engine.rulesVersion!==manifest.rulesVersion)throw new Error('回放版本不匹配');
      await engine.ready();
      if(!dead)setLoaded({facts,replay,engine});
    })().catch(e=>{if(!dead)setError(e.message==='REPLAY_INCOMPLETE'?'回放数据不完整，无法播放':e.message);});
    return()=>{dead=true;};
  },[matchId]);
  useEffect(()=>{
    if(!view || !loaded)return;
    const r=createReplayRunner({engine:loaded.engine,onField:meta=>{
      const stage=loaded.engine.stage?.(meta.stageId) || gd.stage(meta.stageId);if(stage)view.setStage(stage);
      view.enterBattle(meta);view.setCamera(meta.kind==='hidden'?'boss':meta.kind || 'normal',{rect:meta.rect});
      view.raw?.setLocalFeed?.({on:true,speed:r.state().speed});},
      onFrame:frame=>{view.pushEvents(frame.events);view.pushSnapshot(frame.snapshot);}});
    runner.current=r;
    let previous=performance.now(),raf;
    const frame=now=>{if(!document.hidden)r.advance((now-previous)/1000);previous=now;setState(r.state());raf=requestAnimationFrame(frame);};
    raf=requestAnimationFrame(frame);
    return()=>{cancelAnimationFrame(raf);r.dispose();runner.current=null;};
  },[view,loaded]);
  useEffect(()=>{const battle=loaded?.replay.battles[selected];if(battle?.complete){view?.raw?.setPaused?.(false);runner.current?.select(battle);}},[selected,loaded,view]);
  const battle=loaded?.replay.battles[selected];
  return html`<div class="screen replay-screen">
    <header class="topbar"><div class="topbar__left"><${Button} variant="ghost" icon="chevronLeft" onClick=${()=>store.patch('ui',{accountPage:'history'})}>返回记录<//></div>
      <div class="topbar__center"><${MicroLabel} tone="mint">SIMULATION REPLAY<//><h1 class="topbar__title">对局回放</h1></div></header>
    <main class="account-body"><div class="replay-toolbar">
      ${loaded?.replay.battles.map((b,i)=>html`<${Button} size="sm" key=${i} variant=${selected===i?'primary':'ghost'} onClick=${()=>{runner.current?.pause();setSelected(i);}}>
        第 ${b.round} 回合 · ${(b.players || []).map(id=>loaded.facts.result.players?.find(p=>p.playerId===id)?.name || id).join(' / ')}<//>`)}
    </div>${error?html`<${Panel}><p role="alert">${error}</p><//>`:!loaded?html`<${Spinner}/>`:!loaded.replay.battles.length?html`<p class="t-lo">本局没有进入战斗阶段</p>`:null}
    ${battle && !battle.complete?html`<p class="t-lo" role="status">此战场录制不完整，无法播放。结算结果仍保存在对局记录中。</p>`:null}
    <div ref=${host} class="replay-field" style=${battle?.complete?'':'visibility:hidden'}></div>
    <div class="replay-toolbar">
      <${Button} disabled=${!battle?.complete} onClick=${()=>{const r=runner.current;view?.raw?.setPaused?.(!!state.playing);state.playing?r?.pause():r?.play();}}>${state.playing?'暂停':'播放'}<//>
      <${Button} variant="ghost" disabled=${!battle?.complete} onClick=${()=>{view?.raw?.setPaused?.(false);runner.current?.select(battle);}}>从头播放<//>
      ${[0.5,1,2,4].map(speed=>html`<${Button} size="sm" variant=${state.speed===speed?'primary':'ghost'} onClick=${()=>{runner.current?.setSpeed(speed);view?.raw?.setLocalFeed?.({on:true,speed});}}>${speed}×<//>`)}
      <span class="num">${Math.floor(state.seconds || 0)} / ${Math.ceil(state.duration || 0)} 秒</span>
    </div></main></div>`;
}
