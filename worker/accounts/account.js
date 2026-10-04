import { DurableObject } from 'cloudflare:workers';
import { requireId, AccountError } from '../../shared/account-protocol.js';
import { aggregateStats } from '../../shared/history.js';
import { validatePreferencePatch } from '../../public/js/preferenceSchema.js';
export class AccountDurableObject extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS history (match_id TEXT PRIMARY KEY, ended_at INTEGER NOT NULL, mode TEXT NOT NULL, difficulty TEXT NOT NULL, fact TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS history_time ON history(ended_at DESC,match_id DESC)');
  }
  async setProfile(profile) { await this.ctx.storage.put('profile', profile); }
  async getProfile() { return (await this.ctx.storage.get('profile')) || null; }
  async getPreferences() { return (await this.ctx.storage.get('preferences')) ?? null; }
  async savePreferences(patch, initialize = false) {
    validatePreferencePatch(patch);
    return this.ctx.storage.transaction(async tx => {
      const current = await tx.get('preferences');
      // First-login migration is atomic: a stale device never replaces an existing account profile.
      if (initialize && current != null) return current;
      const next = { ...current, ...patch };
      await tx.put('preferences', next);
      return next;
    });
  }
  async getActiveSeat() { return (await this.ctx.storage.get('activeSeat')) || null; }
  async getApplication() {const value=await this.ctx.storage.get('application');return value?.expiresAt>Date.now()?value:null;}
  async claimApplication(value) {
    return this.ctx.storage.transaction(async tx=>{
      const active=await tx.get('activeSeat'), pending=await tx.get('application');
      if(active) return {ok:false,error:'ALREADY_SEATED'};
      if(pending && pending.expiresAt>Date.now() && pending.roomId!==value.roomId) return {ok:false,error:'APPLICATION_PENDING'};
      await tx.put('application',value);return {ok:true};
    });
  }
  async clearApplication(roomId,id=null) {
    return this.ctx.storage.transaction(async tx=>{
      const pending=await tx.get('application');
      if(pending?.roomId===roomId && (!id || pending.id===id)) await tx.delete('application');
    });
  }
  applyMatch(fact) {
    requireId(fact.matchId);
    const sql=this.ctx.storage.sql;
    const old=sql.exec('SELECT fact FROM history WHERE match_id=?',fact.matchId).toArray()[0];
    if(old) {
      if(old.fact!==JSON.stringify(fact)) throw new AccountError('HISTORY_CONFLICT',409);
      return {ok:true};
    }
    sql.exec('INSERT INTO history VALUES (?,?,?,?,?)',fact.matchId,fact.endedAt,fact.mode,fact.difficulty,JSON.stringify(fact));
    return {ok:true};
  }
  listMatches({cursor='',limit=20,mode='',difficulty='',status=''}={}) {
    if(!Number.isSafeInteger(limit) || limit<1 || limit>50 || typeof cursor!=='string' || cursor.length>128) throw new AccountError('INVALID_PAGE');
    const sql=this.ctx.storage.sql,anchor=cursor?sql.exec('SELECT ended_at FROM history WHERE match_id=?',cursor).toArray()[0]:null;
    if(cursor && !anchor)throw new AccountError('INVALID_CURSOR');
    const rows=sql.exec(`SELECT fact FROM history WHERE (?='' OR mode=?) AND (?='' OR difficulty=?)
      AND (?='' OR json_extract(fact,'$.status')=?) AND (?='' OR ended_at<? OR (ended_at=? AND match_id<?))
      ORDER BY ended_at DESC,match_id DESC LIMIT ?`,mode,mode,difficulty,difficulty,status,status,cursor,anchor?.ended_at ?? 0,anchor?.ended_at ?? 0,cursor,limit+1).toArray().map(x=>JSON.parse(x.fact));
    const items=rows.slice(0,limit);
    return {items,nextCursor:rows.length>limit?items.at(-1).matchId:null};
  }
  getStats({mode='',difficulty=''}={}) {
    const rows=this.ctx.storage.sql.exec('SELECT fact FROM history WHERE (?=\'\' OR mode=?) AND (?=\'\' OR difficulty=?)',mode,mode,difficulty,difficulty).toArray();
    return aggregateStats(rows.map(r=>JSON.parse(r.fact)));
  }
  // The seat is a pointer: its room decides whether it is still held (worker/accounts/routes.js seatOf), so it has no
  // expiry of its own. Seats stored earlier carry an unused expiresAt.
  async claimSeat({claimId, seat}) {
    requireId(claimId); requireId(seat.roomId); requireId(seat.roomGeneration);
    return this.ctx.storage.transaction(async tx => {
      const active = await tx.get('activeSeat');
      if (active && active.claimId !== claimId) return {ok: false, error: 'ALREADY_SEATED'};
      if (active) return {ok: true, seat: active};
      const value = {...seat, claimId};
      await tx.put('activeSeat', value);
      return {ok: true, seat: value};
    });
  }
  async releaseSeat({claimId}) {
    return this.ctx.storage.transaction(async tx => {
      const active = await tx.get('activeSeat');
      if (!active || active.claimId !== claimId) return {ok: false};
      await tx.delete('activeSeat'); return {ok: true};
    });
  }
}
