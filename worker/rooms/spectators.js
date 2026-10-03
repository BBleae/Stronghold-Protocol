import { sendSession } from '../../server/net.js';

// Read-only views live outside Match: retained rule engines and player/checkpoint
// membership are unchanged. A spectator never becomes a simulation authority.
export class Spectators {
  constructor(runtime) { this.rt=runtime; this.views=new Map(); }
  get room(){return this.rt.lobby.getRoom(this.rt.code);}
  sessions(){return [...this.rt.registry.all()].filter(s=>s.spectating && s.connected);}
  get count(){return this.sessions().length;}
  state(session){
    if(this.room) sendSession(session,{...this.room.toState(),spectatorCount:this.count,...(session.spectating?{spectating:true}:{})});
  }
  presence(){
    if(!this.room)return;
    for(const s of this.rt.lobby.memberSessions(this.room))this.state(s);
    for(const s of this.sessions())this.state(s);
  }
  join(session){
    const room=this.room;
    if(!this.rt.accounts || !this.rt.publicRoom || room?.mode!=='coop' || !room.match)return {error:'ROOM_NOT_FOUND'};
    if(this.rt.lobby.roomOf(session))return {error:'ROOM_STARTED'};
    session.spectating=true;this.views.delete(session.playerId);
    this.presence();this.sync(session,true);return {ok:true};
  }
  leave(session){session.spectating=false;delete session.watchField;this.views.delete(session.playerId);this.presence();return {ok:true};}
  hello(session){
    if(!this.room?.match || !this.rt.publicRoom){this.leave(session);sendSession(session,{t:'room.closed',reason:'ended'});return;}
    this.views.delete(session.playerId);this.presence();this.sync(session,true);
  }
  command(session,msg){
    if(msg.t==='room.leave' || msg.t==='g.leave')return this.leave(session);
    if(msg.t!=='g.watch')return {error:'NOT_IN_ROOM'};
    const match=this.room?.match;
    if(!match)return {error:'NOT_IN_ROOM'};
    const valid=match.fields.some(f=>f.fieldId===msg.fieldId) ||
      (!match.fields.length && msg.fieldId.startsWith('n:') && match.players.get(msg.fieldId.slice(2))?.alive);
    if(!valid)return {error:'BAD_TARGET'};
    session.watchField=msg.fieldId;this.views.delete(session.playerId);this.sync(session,true);return {ok:true};
  }
  broadcast(msg){for(const s of this.sessions())sendSession(s,msg);}
  sync(session,force=false){
    const match=this.room?.match;if(!match)return;
    const previous=this.views.get(session.playerId) || {};
    const pub=match.publicView(), publicKey=JSON.stringify({...pub,serverNow:0});
    if(force || previous.publicKey!==publicKey)sendSession(session,pub);
    let field=match.fields.find(f=>f.fieldId===session.watchField) || match.fields.find(f=>!f.done) || match.fields[0];
    let fieldKey=null;
    if(field?.cc){
      session.watchField=field.fieldId;fieldKey=field.battleId+':'+field.done;
      if(force || previous.fieldKey!==fieldKey){
        sendSession(session,match._startMsg(field,session.playerId,{watch:true}));
        // A late join needs the current shared boss pool even if it has not
        // changed recently enough to produce another room-wide b.pool frame.
        if(match.bossPool){
          const acked=Object.fromEntries(match.fields.filter(f=>f.cc).map(f=>[f.fieldId,
            f.mode==='server' && f.credit?Math.max(f.bossAcked,f.credit.cum):f.bossAcked]));
          sendSession(session,{t:'b.pool',hp:Math.max(0,match.bossPool.hp),max:match.bossPool.maxHp,
            teamLp:match.teamLp==null?null:Math.max(0,Math.round(match.teamLp)),acked});
        }
      }
    }else if(!match.fields.length){
      const target=match.players.get(session.watchField?.slice(2));
      const player=target?.alive?target:match.order.find(p=>p.alive && !p.left);
      if(player){
        const meta=match.prepFieldMeta(player);session.watchField=meta.fieldId;fieldKey=JSON.stringify(meta);
        if(force || previous.fieldKey!==fieldKey)sendSession(session,meta);
      }
    }
    this.views.set(session.playerId,{publicKey,fieldKey});
  }
  pump(){
    const sessions=this.sessions();if(!sessions.length)return;
    if(!this.room?.match || !this.rt.publicRoom){
      for(const s of sessions){this.leave(s);sendSession(s,{t:'room.closed',reason:'ended'});}return;
    }
    for(const s of sessions)this.sync(s);
  }
}
