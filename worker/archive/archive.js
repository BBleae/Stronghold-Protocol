import { DurableObject } from 'cloudflare:workers';
import { AccountError, requireId } from '../../shared/account-protocol.js';
import { hash } from '../accounts/auth.js';
export class MatchArchive extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);this.sql=ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS chunks (idx INTEGER PRIMARY KEY, hash TEXT NOT NULL, text TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS archive_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  facts() {const row=this.sql.exec("SELECT value FROM archive_meta WHERE key='facts'").toArray()[0];return row?JSON.parse(row.value):null;}
  async appendChunk({index,text}) {
    if(!Number.isSafeInteger(index) || index<0 || index>10000 || typeof text!=='string' || text.length>64000) throw new AccountError('INVALID_CHUNK');
    const digest=await hash(text);
    const old=this.sql.exec('SELECT hash FROM chunks WHERE idx=?',index).toArray()[0];
    if(old && old.hash!==digest) throw new AccountError('ARCHIVE_CONFLICT',409);
    if(!old) {
      if(this.facts()) throw new AccountError('ARCHIVE_FINALIZED',409);
      this.sql.exec('INSERT INTO chunks VALUES (?,?,?)',index,digest,text);
    }
    return {index,hash:digest};
  }
  async finalize(facts) {
    requireId(facts.matchId);
    if(!Array.isArray(facts.participants) || !facts.participants.length || !Array.isArray(facts.manifest?.chunks)) throw new AccountError('INVALID_ARCHIVE');
    const old=this.facts();
    if(old) {
      if(JSON.stringify(old)!==JSON.stringify(facts)) throw new AccountError('ARCHIVE_CONFLICT',409);
      return {ok:true};
    }
    const chunks=this.sql.exec('SELECT idx,hash FROM chunks ORDER BY idx').toArray();
    if(chunks.length!==facts.manifest.chunks.length || chunks.some((c,i)=>c.idx!==i || c.hash!==facts.manifest.chunks[i].hash)) throw new AccountError('REPLAY_INCOMPLETE');
    this.sql.exec("INSERT INTO archive_meta VALUES ('facts',?)",JSON.stringify(facts));return {ok:true};
  }
  async read(accountId) {
    const facts=this.facts();
    if(!facts) throw new AccountError('ARCHIVE_NOT_READY',404);
    if(!facts.participants.includes(accountId)) throw new AccountError('FORBIDDEN',403);
    return facts;
  }
  async readChunk(accountId,index) {
    await this.read(accountId);
    const chunk=this.sql.exec('SELECT text,hash FROM chunks WHERE idx=?',index).toArray()[0];
    if(!chunk) throw new AccountError('REPLAY_INCOMPLETE',404);
    return {...chunk,index};
  }
  exportArchive() {
    const facts=this.facts();if(!facts)throw new AccountError('ARCHIVE_NOT_READY',404);
    return {facts,chunks:this.sql.exec('SELECT idx AS "index",text,hash FROM chunks ORDER BY idx').toArray()};
  }
  checkImport(facts,chunks) {
    const old=this.facts();
    if(old && JSON.stringify(old)!==JSON.stringify(facts))throw new AccountError('ARCHIVE_CONFLICT',409);
    for(const chunk of this.sql.exec('SELECT idx,hash FROM chunks').toArray())if(chunks[chunk.idx]?.hash!==chunk.hash)throw new AccountError('ARCHIVE_CONFLICT',409);
    return {ok:true};
  }
}
