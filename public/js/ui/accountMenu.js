import { useEffect,useState } from '../../vendor/hooks.module.js';
import { html,Button,Panel,MicroLabel,DifficultyTag } from './components.js';
import { account,accountRequest,loadAccount } from '../account.js';
import { net } from '../net.js';
import { store } from '../store.js';
import { toast } from './toasts.js';

export function useAccountPoll(path,interval=10000) {
  const [data,setData]=useState(null),[error,setError]=useState(''),[revision,setRevision]=useState(0);
  useEffect(()=>{
    let dead=false,busy=false;
    const refresh=async()=>{
      if(document.hidden || busy) return;
      busy=true;
      try {const value=await accountRequest(path);if(!dead){setData(value);setError('');}}
      catch(e){if(!dead)setError(e.message);}finally{busy=false;}
    };
    refresh();const id=setInterval(refresh,interval);
    document.addEventListener('visibilitychange',refresh);
    return()=>{dead=true;clearInterval(id);document.removeEventListener('visibilitychange',refresh);};
  },[path,interval,revision]);
  return {data,error,refresh:()=>setRevision(x=>x+1)};
}
const run=fn=>Promise.resolve().then(fn).catch(e=>toast(e.message,'warn'));
export function AccountMenu() {
  const [active,setActive]=useState(account.activeSeat),[busy,setBusy]=useState(false);
  useEffect(()=>{if(account.user) accountRequest('/api/me/active-match').then(r=>setActive(r.activeSeat)).catch(()=>{});},[]);
  if(!account.enabled)return null;
  const resume=async()=>{setBusy(true);try{await net.resumeActive();}finally{setBusy(false);}};
  return html`<div class="account-actions">
    ${account.user ? html`
      ${active ? html`<${Button} size="sm" icon="play" loading=${busy} onClick=${()=>run(resume)}>继续对局<//>` : null}
      <${Button} variant="secondary" size="sm" icon="book" onClick=${()=>store.patch('ui',{accountPage:'history'})}>对局记录<//>
      <${Button} variant="secondary" size="sm" icon="signal" onClick=${()=>store.patch('ui',{accountPage:'statistics'})}>个人统计<//>
      <${Button} variant="ghost" size="sm" onClick=${()=>run(async()=>{await accountRequest('/api/auth/logout',{});net.close();await loadAccount();location.reload();})}>退出登录<//>
    ` : html`<${Button} size="sm" disabled=${!account.loginReady} onClick=${()=>location.assign('/api/auth/github/start')}>${account.loginReady?'GitHub 登录':'登录尚未配置'}<//>`}
  </div>`;
}
export function PublicRooms() {
  const [cursor,setCursor]=useState('');
  const rooms=useAccountPoll('/api/rooms?cursor='+encodeURIComponent(cursor)),[application,setApplication]=useState(net.application),[busy,setBusy]=useState(false);
  useEffect(()=>net.on('application',setApplication),[]);
  useEffect(()=>{
    if(!application || !['pending','approved'].includes(application.status))return;
    let dead=false;
    const update=async()=>{
      if(document.hidden)return;
      try{
        const r=await accountRequest('/api/rooms/'+application.code+'/applications');
        const item=r.items.find(x=>x.id===application.id);
        if(!item || dead)return;
        if(item.status==='approved'){
          setApplication({...item,code:application.code,status:'connecting'});
          try {await net.joinApproved({code:application.code,ticket:item.ticket});}
          catch(e){setApplication({...item,code:application.code,status:'retry'});throw e;}
        } else if(item.status!=='pending') setApplication({...item,code:application.code});
      }catch(e){if(!dead)toast(e.message,'warn');}
    };
    const id=setInterval(update,3000);update();
    return()=>{dead=true;clearInterval(id);};
  },[application?.id,application?.status]);
  const apply=async code=>{setBusy(true);try{await net.request('room.join',{code});}finally{setBusy(false);}};
  return html`<${Panel} class="public-rooms">
    <div class="account-row"><div><${MicroLabel} tone="mint">ACTIVE ALLIANCES<//><h2>在线大厅</h2></div>
      <${Button} variant="ghost" size="sm" icon="refresh" onClick=${()=>{setCursor('');rooms.refresh();}}>刷新<//></div>
    ${rooms.error?html`<p class="t-lo" role="alert">${rooms.error}</p>`:null}
    ${application?html`<div class="account-row"><span>${application.code} · ${({pending:'等待房主审批',approved:'已获批准',connecting:'正在加入',retry:'连接失败，请重试',rejected:'申请已被拒绝',expired:'申请已过期',cancelled:'已取消'})[application.status] || application.status}</span>
      ${application.status==='retry'?html`<${Button} size="sm" onClick=${()=>setApplication({...application,status:'approved'})}>重试加入<//>`:null}
      ${application.status==='pending'?html`<${Button} size="sm" variant="ghost" onClick=${()=>run(async()=>{await accountRequest('/api/rooms/'+application.code+'/applications',{action:'cancel',id:application.id});net.application=null;setApplication(null);})}>取消申请<//>`:null}</div>`:null}
    <div class="public-rooms__list">
      ${rooms.data?.items?.length?rooms.data.items.map(room=>html`<div class="account-row public-room" key=${room.roomId}>
        <div><b>${room.hostName}</b><div class="t-lo"><span class="num">${room.roomId}</span> · ${room.connectedHumans} 人在线 · ${room.occupied}/${room.capacity}</div></div>
        <${DifficultyTag} difficulty=${room.difficulty} />
        <${Button} size="sm" variant="secondary" disabled=${busy || !!application && ['pending','connecting'].includes(application.status) || !account.user || room.inMatch || room.occupied>=room.capacity}
          onClick=${()=>run(()=>apply(room.roomId))}>${room.inMatch?'进行中':room.occupied>=room.capacity?'已满员':'申请加入'}<//>
      </div>`):html`<p class="t-lo">${rooms.data?'当前没有有真人在线的公开大厅':'正在查找在线大厅…'}</p>`}
    </div>
    <div class="account-row">
      ${cursor?html`<${Button} variant="ghost" size="sm" onClick=${()=>setCursor('')}>返回首页<//>`:null}
      ${rooms.data?.nextCursor?html`<${Button} variant="ghost" size="sm" onClick=${()=>setCursor(rooms.data.nextCursor)}>下一页<//>`:null}
    </div>
  <//>`;
}
export function Applications({code}) {
  const state=useAccountPoll('/api/rooms/'+code+'/applications',3000);
  if(!state.data?.host)return null;
  const action=async(body,path='applications')=>{await accountRequest('/api/rooms/'+code+'/'+path,body);state.refresh();};
  return html`<${Panel} class="room-applications">
    <div class="account-row"><span>加入申请</span><${Button} size="sm" variant="ghost"
      onClick=${()=>run(()=>action({public:!state.data.public},'visibility'))}>${state.data.public?'公开大厅 · 点击设为私密':'私密大厅 · 点击公开'}<//></div>
    ${state.error?html`<p role="alert">${state.error}</p>`:null}
    ${state.data.items.filter(x=>x.status==='pending').map(item=>html`<div class="account-row" key=${item.id}>
      <span>${item.name}</span>
      <${Button} size="sm" onClick=${()=>run(()=>action({action:'approve',id:item.id}))}>同意<//>
      <${Button} size="sm" variant="ghost" onClick=${()=>run(()=>action({action:'reject',id:item.id}))}>拒绝<//>
    </div>`)}
  <//>`;
}
