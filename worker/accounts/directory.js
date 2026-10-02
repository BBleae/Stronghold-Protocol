import { DurableObject } from 'cloudflare:workers';
import { AccountError } from '../../shared/account-protocol.js';

/** Small site-wide identity/session index; no game events or battle frames. */
export class SiteDirectory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS users (github_id TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, profile TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS auth_records (key TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS auth_expiry ON auth_records(expires_at)');
  }
  resolveGithubUser({id, login, avatarUrl}) {
    if (!/^\d{1,20}$/.test(id) || typeof login !== 'string' || login.length > 80) throw new AccountError('INVALID_PROFILE');
    return this.ctx.storage.transactionSync(() => {
      const old = this.sql.exec('SELECT account_id FROM users WHERE github_id=?', id).toArray()[0];
      const profile = {accountId: old?.account_id || crypto.randomUUID(), githubId: id, name: login, avatarUrl};
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
  async alarm() {
    this.sql.exec('DELETE FROM auth_records WHERE expires_at<=?', Date.now());
    const remaining = this.sql.exec('SELECT MIN(expires_at) AS at FROM auth_records').one().at;
    if (remaining != null) await this.ctx.storage.setAlarm(Math.min(remaining, Date.now() + 600000));
  }
}
