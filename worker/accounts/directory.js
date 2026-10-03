import { DurableObject } from 'cloudflare:workers';
import { AccountError, pageLimit } from '../../shared/account-protocol.js';

/** Small site-wide identity/session index; no game events or battle frames. */
export class SiteDirectory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS users (github_id TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, profile TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS auth_records (key TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS auth_expiry ON auth_records(expires_at)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS rooms (room_id TEXT PRIMARY KEY, value TEXT NOT NULL, visible INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS archives (match_id TEXT PRIMARY KEY)');
  }
  resolveGithubUser({id, login, name, avatarUrl}) {
    if (!/^\d{1,20}$/.test(id) || typeof login !== 'string' || login.length > 80) throw new AccountError('INVALID_PROFILE');
    const displayName = typeof name === 'string' ? name.trim().slice(0, 80) : '';
    return this.ctx.storage.transactionSync(() => {
      const old = this.sql.exec('SELECT account_id FROM users WHERE github_id=?', id).toArray()[0];
      const profile = {accountId: old?.account_id || crypto.randomUUID(), githubId: id, githubLogin: login, name: displayName || login, avatarUrl};
      this.sql.exec('INSERT INTO users VALUES (?,?,?) ON CONFLICT(github_id) DO UPDATE SET profile=excluded.profile',
        id, profile.accountId, JSON.stringify(profile));
      return profile;
    });
  }
  async saveOAuth(key, value) { return this.saveRecord('oauth', key, value); }
  async saveSession(key, value) { return this.saveRecord('session', key, value); }
  async saveRecord(kind, key, value) {
    if (!/^[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(value.expiresAt)) throw new AccountError('INVALID_AUTH_RECORD');
    this.sql.exec('INSERT INTO auth_records VALUES (?,?,?,?)', kind + ':' + key, kind, JSON.stringify(value), value.expiresAt);
    // A single periodic cleanup alarm, never scheduled past an already pending one.
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm == null) await this.ctx.storage.setAlarm(Date.now() + 600000);
  }
  consumeOAuth(key) {
    return this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec('DELETE FROM auth_records WHERE key=? RETURNING value, expires_at', 'oauth:' + key).toArray()[0];
      return row && row.expires_at > Date.now() ? JSON.parse(row.value) : null;
    });
  }
  getSession(key) {
    const row = this.sql.exec('SELECT value, expires_at FROM auth_records WHERE key=?', 'session:' + key).toArray()[0];
    return row && row.expires_at > Date.now() ? JSON.parse(row.value) : null;
  }
  revokeSession(key) { this.sql.exec('DELETE FROM auth_records WHERE key=?', 'session:' + key); }
  registerArchive(matchId) {this.sql.exec('INSERT OR IGNORE INTO archives VALUES (?)',matchId);}
  backupCatalog({cursor='',kind='profiles',limit=100}={}) {
    if(typeof cursor!=='string' || cursor.length>128 || !Number.isInteger(limit) || limit<1 || limit>100)throw new AccountError('INVALID_PAGE');
    const profiles=kind==='profiles';
    const rows=profiles?this.sql.exec('SELECT account_id AS id,profile FROM users WHERE account_id>? ORDER BY account_id LIMIT ?',cursor,limit+1).toArray()
      :this.sql.exec('SELECT match_id AS id FROM archives WHERE match_id>? ORDER BY match_id LIMIT ?',cursor,limit+1).toArray();
    return {items:rows.slice(0,limit).map(r=>profiles?JSON.parse(r.profile):r.id),nextCursor:rows.length>limit?rows[limit-1].id:null};
  }
  restoreProfile(profile,dryRun=true) {
    const existing=this.sql.exec('SELECT account_id,github_id FROM users WHERE account_id=? OR github_id=?',profile.accountId,profile.githubId).toArray();
    if(existing.some(r=>r.account_id!==profile.accountId || r.github_id!==profile.githubId))throw new AccountError('IDENTITY_CONFLICT',409);
    if(!dryRun) this.sql.exec('INSERT INTO users VALUES (?,?,?) ON CONFLICT(github_id) DO UPDATE SET profile=excluded.profile',profile.githubId,profile.accountId,JSON.stringify(profile));
    return {ok:true};
  }
  revokeAllSessions() {this.sql.exec('DELETE FROM auth_records');}
  publishRoom(room) {
    if(!/^[A-Z]{4}$/.test(room.roomId) || !Number.isSafeInteger(room.expiresAt)) throw new AccountError('INVALID_ROOM');
    const visible=!!room.public && room.connectedHumans>0;
    this.sql.exec('INSERT INTO rooms VALUES (?,?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET value=excluded.value,visible=excluded.visible,updated_at=excluded.updated_at,expires_at=excluded.expires_at WHERE excluded.updated_at>=rooms.updated_at',
      room.roomId,JSON.stringify(room),visible?1:0,room.updatedAt,room.expiresAt);
    this.sql.exec('DELETE FROM rooms WHERE expires_at<?',Date.now()-600000);
  }
  listRooms({cursor='',limit=20}={}) {
    pageLimit(limit);
    if(typeof cursor!=='string' || (cursor && !/^[A-Z]{4}$/.test(cursor))) throw new AccountError('INVALID_CURSOR');
    const rows=this.sql.exec('SELECT room_id,value FROM rooms WHERE visible=1 AND expires_at>? AND room_id>? ORDER BY room_id LIMIT ?',Date.now(),cursor,limit+1).toArray();
    return {items:rows.slice(0,limit).map(r=>JSON.parse(r.value)),nextCursor:rows.length>limit?rows[limit-1].room_id:null};
  }
  async alarm() {
    this.sql.exec('DELETE FROM auth_records WHERE expires_at<=?', Date.now());
    const remaining = this.sql.exec('SELECT MIN(expires_at) AS at FROM auth_records').one().at;
    if (remaining != null) await this.ctx.storage.setAlarm(Math.min(remaining, Date.now() + 600000));
  }
}
