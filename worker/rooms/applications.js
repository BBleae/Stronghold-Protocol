import { randomBytes } from 'node:crypto';
import { ACCOUNT_LIMITS, AccountError, requireId } from '../../shared/account-protocol.js';
export class ApplicationQueue {
  // `released`: a flag of the former eager seat release, dropped from stored items.
  constructor({snapshot=[],now=Date.now}={}) {
    this.items=structuredClone(snapshot).map(({released,...item})=>item);
    this.now=now;
  }
  expire() {
    const now=this.now();
    for(const item of this.items) if(['pending','approved'].includes(item.status) && item.expiresAt<=now) {item.status='expired';delete item.ticket;}
    // Ended applications stay listed ten minutes, so their applicant sees how they ended.
    this.items=this.items.filter(item=>item.expiresAt>now-600000);
  }
  list(accountId=null) {this.expire();return this.items.filter(x=>!accountId || x.accountId===accountId).map(x=>({...x}));}
  snapshot() {this.expire();return structuredClone(this.items);}
  reservedCount() {return this.list().filter(x=>x.status==='approved').length;}
  apply({accountId,name}) {
    requireId(accountId);this.expire();
    const previous=this.items.find(x=>x.accountId===accountId && ['pending','approved'].includes(x.status));
    if(previous) return {...previous};
    if(this.items.filter(x=>x.status==='pending').length>=20) throw new AccountError('TOO_MANY_APPLICATIONS',429);
    const item={id:randomBytes(16).toString('hex'),accountId,name:String(name || '博士').slice(0,80),
      status:'pending',createdAt:this.now(),expiresAt:this.now()+ACCOUNT_LIMITS.applicationMs};
    this.items.push(item);return {...item};
  }
  decide(actor,id,decision,room) {
    this.expire();
    if(actor!==room.hostId) throw new AccountError('NOT_HOST',403);
    if(room.inMatch) throw new AccountError('ROOM_STARTED',409);
    const item=this.items.find(x=>x.id===id);
    if(!item || item.status!=='pending') throw new AccountError('APPLICATION_EXPIRED',409);
    if(!['approved','rejected'].includes(decision)) throw new AccountError('INVALID_DECISION');
    if(decision==='approved') {
      if(room.freeSeats<=this.reservedCount()) throw new AccountError('ROOM_FULL',409);
      item.ticket=randomBytes(16).toString('hex');item.expiresAt=this.now()+ACCOUNT_LIMITS.reservationMs;
    }
    item.status=decision;return {...item};
  }
  cancel(accountId,id) {
    const item=this.items.find(x=>x.id===id && x.accountId===accountId);
    if(!item) throw new AccountError('APPLICATION_NOT_FOUND',404);
    if(item.status==='joined')throw new AccountError('ALREADY_JOINED',409);
    if(['pending','approved'].includes(item.status)) {item.status='cancelled';delete item.ticket;}
    return {...item};
  }
  consume(accountId,ticket) {
    this.expire();
    const item=this.items.find(x=>x.accountId===accountId && x.status==='approved' && x.ticket===ticket);
    if(!item) return false;
    item.status='joined';delete item.ticket;return true;
  }
  invalidate() {
    for(const item of this.items) if(['pending','approved'].includes(item.status)) {item.status='expired';delete item.ticket;}
  }
}
