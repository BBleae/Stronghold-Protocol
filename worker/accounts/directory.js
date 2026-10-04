import { DurableObject } from 'cloudflare:workers';
import { randomInt } from 'node:crypto';
import { AccountError, pageLimit } from '../../shared/account-protocol.js';
import { nameKey } from './names.js';

/**
 * The site-wide identity and session index (one object): who an account is (its GitHub user, or its username and
 * password hash), which display names are taken, the login sessions, the public lobby and the archive catalog. It
 * holds no game events or battle frames, and it never derives a password hash (worker/accounts/passwords.js does, in
 * the Worker): every call here waits for the one before it, site-wide.
 */
export class SiteDirectory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS users (github_id TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, profile TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS auth_records (key TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS auth_expiry ON auth_records(expires_at)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS rooms (room_id TEXT PRIMARY KEY, value TEXT NOT NULL, visible INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS archives (match_id TEXT PRIMARY KEY)');
    // Password accounts: the username as typed, unique without regard to case (username_key: lower case), and the
    // password hash with its parameters (JSON).
    this.sql.exec('CREATE TABLE IF NOT EXISTS local_users (username_key TEXT PRIMARY KEY, username TEXT NOT NULL, account_id TEXT NOT NULL UNIQUE, password TEXT NOT NULL, created_at INTEGER NOT NULL)');
    // Display names: one (nickname key, discriminator) pair per account, no pair shared (names.js nameKey).
    this.sql.exec('CREATE TABLE IF NOT EXISTS display_names (name_key TEXT NOT NULL, disc TEXT NOT NULL, account_id TEXT NOT NULL UNIQUE, PRIMARY KEY (name_key, disc))');
    // What the GitHub OAuth app's credentials were last found to be, per configuration (worker/accounts/github.js).
    this.sql.exec('CREATE TABLE IF NOT EXISTS provider_status (fingerprint TEXT PRIMARY KEY, verdict TEXT NOT NULL, expires_at INTEGER NOT NULL)');
  }

  // ---- identities -------------------------------------------------------------------------------------------------

  /** The account of a GitHub user, created at its first login: its GitHub identity as this login brought it. */
  resolveGithubUser({ id, login, name, avatarUrl }) {
    if (!/^\d{1,20}$/.test(id) || typeof login !== 'string' || login.length > 80) throw new AccountError('INVALID_PROFILE');
    const githubName = typeof name === 'string' ? name.trim().slice(0, 80) : '';
    return this.ctx.storage.transactionSync(() => {
      const old = this.sql.exec('SELECT account_id FROM users WHERE github_id=?', id).toArray()[0];
      const identity = { accountId: old?.account_id || crypto.randomUUID(), githubId: id, githubLogin: login, name: githubName || login, avatarUrl };
      this.sql.exec('INSERT INTO users VALUES (?,?,?) ON CONFLICT(github_id) DO UPDATE SET profile=excluded.profile',
        id, identity.accountId, JSON.stringify(identity));
      return identity;
    });
  }

  /**
   * A new password account `accountId`: its username (USERNAME_TAKEN when another account has it, in any case), its
   * password hash and its first display name. Resolves with the nickname's discriminator.
   */
  registerLocal({ accountId, username, password, nickname }) {
    return this.ctx.storage.transactionSync(() => {
      const key = username.toLowerCase();
      if (this.sql.exec('SELECT 1 FROM local_users WHERE username_key=?', key).toArray().length) throw new AccountError('USERNAME_TAKEN', 409);
      const discriminator = this.#claim(accountId, nickname, null);
      this.sql.exec('INSERT INTO local_users VALUES (?,?,?,?,?)', key, username, accountId, JSON.stringify(password), Date.now());
      return discriminator;
    });
  }

  /** A password account by its username (in any case): { accountId, username, password }, or null. */
  localUser(username) {
    const row = this.sql.exec('SELECT account_id, username, password FROM local_users WHERE username_key=?', username.toLowerCase()).toArray()[0];
    return row ? { accountId: row.account_id, username: row.username, password: JSON.parse(row.password) } : null;
  }

  /** The stored password hash of a password account, or null. */
  passwordOf(accountId) {
    const row = this.sql.exec('SELECT password FROM local_users WHERE account_id=?', accountId).toArray()[0];
    return row ? JSON.parse(row.password) : null;
  }

  /** The same password hashed again under the current parameters (a login after they changed). */
  updatePassword(accountId, password) {
    this.sql.exec('UPDATE local_users SET password=? WHERE account_id=?', JSON.stringify(password), accountId);
  }

  /** A new password: every other session of the account ends, `sessionId` (the one that changed it) stays. */
  changePassword(accountId, password, sessionId) {
    this.ctx.storage.transactionSync(() => {
      this.updatePassword(accountId, password);
      this.#revokeSessions(accountId, sessionId);
    });
  }

  /** An administrator's new password for `username`: every session of the account ends. Resolves with the account. */
  resetPassword(username, password) {
    return this.ctx.storage.transactionSync(() => {
      const user = this.localUser(username);
      if (!user) throw new AccountError('ACCOUNT_NOT_FOUND', 404);
      this.updatePassword(user.accountId, password);
      this.#revokeSessions(user.accountId);
      return user.accountId;
    });
  }

  // ---- display names ----------------------------------------------------------------------------------------------

  /**
   * The account's display name becomes `nickname` with the discriminator this resolves with: the one the account has
   * when the nickname's key is unchanged, else `discriminator` when it is free under the new key, else a random free
   * one (NICKNAME_FULL when none is left). The account's former pair is free again.
   */
  claimName(accountId, nickname, discriminator = null) {
    return this.ctx.storage.transactionSync(() => this.#claim(accountId, nickname, discriminator));
  }

  #claim(accountId, nickname, discriminator) {
    const key = nameKey(nickname);
    const held = this.sql.exec('SELECT name_key, disc FROM display_names WHERE account_id=?', accountId).toArray()[0];
    if (held?.name_key === key) return held.disc;
    const taken = new Set(this.sql.exec('SELECT disc FROM display_names WHERE name_key=?', key).toArray().map((row) => row.disc));
    let disc = discriminator;
    if (disc == null || taken.has(disc)) {
      const free = [];
      for (let n = 0; n < 10000; n++) {
        const candidate = String(n).padStart(4, '0');
        if (!taken.has(candidate)) free.push(candidate);
      }
      if (!free.length) throw new AccountError('NICKNAME_FULL', 409);
      disc = free[randomInt(free.length)];
    }
    this.sql.exec('DELETE FROM display_names WHERE account_id=?', accountId);
    this.sql.exec('INSERT INTO display_names VALUES (?,?,?)', key, disc, accountId);
    return disc;
  }

  // ---- sessions ---------------------------------------------------------------------------------------------------

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

  // Every session of the account but `except` (a session id) ends.
  #revokeSessions(accountId, except = null) {
    this.sql.exec(`DELETE FROM auth_records WHERE kind='session' AND json_extract(value, '$.accountId')=? AND key IS NOT ?`,
      accountId, except && 'session:' + except);
  }

  // ---- provider status --------------------------------------------------------------------------------------------

  /** The GitHub credentials' last verdict for a configuration: { verdict, expiresAt }, or null. */
  providerStatus(fingerprint) {
    const row = this.sql.exec('SELECT verdict, expires_at FROM provider_status WHERE fingerprint=?', fingerprint).toArray()[0];
    return row ? { verdict: row.verdict, expiresAt: row.expires_at } : null;
  }

  /** Record a verdict; the verdicts of former configurations go. */
  setProviderStatus(fingerprint, verdict, expiresAt) {
    this.sql.exec('DELETE FROM provider_status WHERE fingerprint!=?', fingerprint);
    this.sql.exec('INSERT INTO provider_status VALUES (?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET verdict=excluded.verdict, expires_at=excluded.expires_at',
      fingerprint, verdict, expiresAt);
  }

  // ---- archives and backups ---------------------------------------------------------------------------------------

  registerArchive(matchId) { this.sql.exec('INSERT OR IGNORE INTO archives VALUES (?)', matchId); }

  /**
   * A page of the backup catalog. `profiles`: the accounts, each with what only this directory has of it (its GitHub
   * id, or its username, password hash and creation time); `archives`: the archived match ids.
   */
  backupCatalog({ cursor = '', kind = 'profiles', limit = 100 } = {}) {
    if (typeof cursor !== 'string' || cursor.length > 128 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new AccountError('INVALID_PAGE');
    if (kind !== 'profiles') {
      const rows = this.sql.exec('SELECT match_id AS id FROM archives WHERE match_id>? ORDER BY match_id LIMIT ?', cursor, limit + 1).toArray();
      return { items: rows.slice(0, limit).map((row) => row.id), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
    }
    const rows = this.sql.exec(`SELECT account_id AS id, github_id, NULL AS username, NULL AS password, NULL AS created_at FROM users WHERE account_id>?
      UNION ALL SELECT account_id, NULL, username, password, created_at FROM local_users WHERE account_id>? ORDER BY id LIMIT ?`,
    cursor, cursor, limit + 1).toArray();
    const items = rows.slice(0, limit).map((row) => (row.github_id != null ? { accountId: row.id, githubId: row.github_id }
      : { accountId: row.id, username: row.username, password: JSON.parse(row.password), createdAt: row.created_at }));
    return { items, nextCursor: rows.length > limit ? rows[limit - 1].id : null };
  }

  /**
   * Restore an account's identity from a backup (worker/storage/backup.js validated it): its GitHub user, or its
   * username and password hash, and its display name. An identity that would change hands (another account has the
   * GitHub user, the username or the display name, or this account has another identity) is IDENTITY_CONFLICT. A
   * restored account keeps no session from before.
   */
  restoreAccount({ profile, password = null, createdAt = null }, dryRun = true) {
    const { accountId, githubId = null, username = null } = profile;
    const usernameKey = username?.toLowerCase() ?? null;
    const github = this.sql.exec('SELECT account_id, github_id FROM users WHERE account_id=? OR github_id=?', accountId, githubId).toArray();
    const local = this.sql.exec('SELECT account_id, username_key FROM local_users WHERE account_id=? OR username_key=?', accountId, usernameKey).toArray();
    const name = profile.discriminator ? { key: nameKey(profile.nickname), disc: profile.discriminator } : null;
    const nameTaken = !!name && this.sql.exec('SELECT 1 FROM display_names WHERE name_key=? AND disc=? AND account_id!=?', name.key, name.disc, accountId).toArray().length > 0;
    if (github.some((row) => row.account_id !== accountId || row.github_id !== githubId)
      || local.some((row) => row.account_id !== accountId || row.username_key !== usernameKey) || nameTaken) {
      throw new AccountError('IDENTITY_CONFLICT', 409);
    }
    if (dryRun) return { ok: true };
    this.ctx.storage.transactionSync(() => {
      if (githubId) {
        this.sql.exec('INSERT INTO users VALUES (?,?,?) ON CONFLICT(github_id) DO UPDATE SET profile=excluded.profile', githubId, accountId, JSON.stringify(profile));
      } else {
        this.sql.exec('INSERT INTO local_users VALUES (?,?,?,?,?) ON CONFLICT(username_key) DO UPDATE SET username=excluded.username, password=excluded.password',
          usernameKey, username, accountId, JSON.stringify(password), createdAt);
      }
      this.sql.exec('DELETE FROM display_names WHERE account_id=?', accountId);
      if (name) this.sql.exec('INSERT INTO display_names VALUES (?,?,?)', name.key, name.disc, accountId);
      this.#revokeSessions(accountId);
    });
    return { ok: true };
  }

  // ---- the public lobby -------------------------------------------------------------------------------------------

  /** A room's listing (lease until expiresAt). Answers whether the lobby shows it. */
  publishRoom(room) {
    if (!/^[A-Z]{4}$/.test(room.roomId) || !Number.isSafeInteger(room.expiresAt)) throw new AccountError('INVALID_ROOM');
    const visible = !!room.public && (room.connectedHumans > 0 || !!room.inMatch);
    this.sql.exec(`INSERT INTO rooms VALUES (?,?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET value=excluded.value, visible=excluded.visible,
      updated_at=excluded.updated_at, expires_at=excluded.expires_at WHERE excluded.updated_at>=rooms.updated_at`,
    room.roomId, JSON.stringify(room), visible ? 1 : 0, room.updatedAt, room.expiresAt);
    this.sql.exec('DELETE FROM rooms WHERE expires_at<?', Date.now() - 600000);
    return { visible };
  }

  listRooms({ cursor = '', limit = 20 } = {}) {
    pageLimit(limit);
    if (typeof cursor !== 'string' || (cursor && !/^[A-Z]{4}$/.test(cursor))) throw new AccountError('INVALID_CURSOR');
    const rows = this.sql.exec('SELECT room_id, value FROM rooms WHERE visible=1 AND expires_at>? AND room_id>? ORDER BY room_id LIMIT ?',
      Date.now(), cursor, limit + 1).toArray();
    return { items: rows.slice(0, limit).map((row) => JSON.parse(row.value)), nextCursor: rows.length > limit ? rows[limit - 1].room_id : null };
  }

  async alarm() {
    this.sql.exec('DELETE FROM auth_records WHERE expires_at<=?', Date.now());
    const remaining = this.sql.exec('SELECT MIN(expires_at) AS at FROM auth_records').one().at;
    if (remaining != null) await this.ctx.storage.setAlarm(Math.min(remaining, Date.now() + 600000));
  }
}
