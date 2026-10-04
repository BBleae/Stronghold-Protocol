import { DurableObject } from 'cloudflare:workers';
import { requireId, AccountError, isAccountError, displayName } from '../../shared/account-protocol.js';
import { aggregateStats } from '../../shared/history.js';
import { validatePreferencePatch } from '../../public/js/preferenceSchema.js';
import { directoryOf } from './auth.js';
import { githubNickname } from './names.js';

/**
 * One account: its profile, preferences, seat, join application and match history.
 *
 * The profile is what every page and room shows of the account: { accountId, provider: 'github'|'password',
 * githubId?, githubLogin?, username?, nickname, nicknameSource: 'github'|'user', discriminator, name, avatarUrl }, where
 * `name` is the display name 昵称#NNNN. Its display name is the directory's to allocate (SiteDirectory.claimName): this
 * object claims it there, then stores the profile, one change at a time. A profile is completed when it is next read:
 * a registration that stopped halfway is finished, and a GitHub account stored before display names existed
 * ({ accountId, githubId, githubLogin?, name, avatarUrl }) gets its nickname and discriminator.
 */
export class AccountDurableObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS history (match_id TEXT PRIMARY KEY, ended_at INTEGER NOT NULL, mode TEXT NOT NULL, difficulty TEXT NOT NULL, fact TEXT NOT NULL)',
    );
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS history_time ON history(ended_at DESC,match_id DESC)');
  }

  // Profile changes run one at a time: each claims its name in the directory before it stores the profile.
  #changes = Promise.resolve();

  #change(fn) {
    const run = this.#changes.then(fn);
    // The next change waits for this one, whether it succeeded or not (its caller gets its error).
    this.#changes = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  // The stored profile (null: none), completed first. Without a profile, a stored registration is finished (register).
  // A GitHub account's profile from before display names gets its nickname from its name (GitHub's, else its login).
  // Called inside #change.
  async #profile() {
    const profile = (await this.ctx.storage.get('profile')) ?? null;
    if (!profile) {
      const registration = await this.ctx.storage.get('registration');
      return registration ? this.#register(registration) : null;
    }
    if (profile.discriminator) return profile;
    const nickname = githubNickname(profile.name, profile.githubLogin);
    const discriminator = await directoryOf(this.env).claimName(profile.accountId, nickname, null);
    const completed = {
      ...profile,
      provider: 'github',
      nickname,
      nicknameSource: 'github',
      discriminator,
      name: displayName(nickname, discriminator),
    };
    await this.ctx.storage.put('profile', completed);
    return completed;
  }

  // A password account's registration: the directory takes (or, a second time, confirms) its username, password hash
  // and display name, then the profile replaces the registration.
  async #register({ accountId, username, password, nickname }) {
    const discriminator = await directoryOf(this.env).registerLocal({ accountId, username, password, nickname });
    const profile = {
      accountId,
      provider: 'password',
      username,
      nickname,
      nicknameSource: 'user',
      discriminator,
      name: displayName(nickname, discriminator),
      avatarUrl: null,
    };
    await this.ctx.storage.transaction(async (tx) => {
      await tx.put('profile', profile);
      await tx.delete('registration');
    });
    return profile;
  }

  /** The profile (null: none). */
  getProfile() {
    return this.#change(() => this.#profile());
  }

  /** Store a profile as it is (a restore from a backup: its identity and display name are restored by the directory). */
  setProfile(profile) {
    return this.#change(() => this.ctx.storage.put('profile', profile));
  }

  /**
   * A new password account (this object's name is `accountId`), registered in two objects: this one stores the
   * registration first, then the directory takes the username, password hash and display name, then the profile is
   * stored. A registration that stops after the directory took it (an object reset mid-call) is finished when the
   * account is next read: at its first login. One the directory refuses (an AccountError: USERNAME_TAKEN,
   * NICKNAME_FULL; its transaction took nothing) leaves nothing. Resolves with the profile.
   */
  register(registration) {
    return this.#change(async () => {
      await this.ctx.storage.put('registration', registration);
      try {
        return await this.#register(registration);
      } catch (error) {
        if (isAccountError(error)) await this.ctx.storage.delete('registration');
        throw error;
      }
    });
  }

  /**
   * A GitHub login (`identity`: SiteDirectory.resolveGithubUser): the GitHub login and avatar are kept, and the nickname
   * follows the GitHub name unless the player chose one. Resolves with the profile.
   */
  applyGithubLogin(identity) {
    return this.#change(async () => {
      const current = await this.#profile();
      const chosen = current?.nicknameSource === 'user';
      const nickname = chosen ? current.nickname : githubNickname(identity.name, identity.githubLogin);
      const discriminator = await directoryOf(this.env).claimName(
        identity.accountId,
        nickname,
        current?.discriminator ?? null,
      );
      const profile = {
        accountId: identity.accountId,
        provider: 'github',
        githubId: identity.githubId,
        githubLogin: identity.githubLogin,
        nickname,
        nicknameSource: chosen ? 'user' : 'github',
        discriminator,
        name: displayName(nickname, discriminator),
        avatarUrl: identity.avatarUrl,
      };
      await this.ctx.storage.put('profile', profile);
      return profile;
    });
  }

  /** The player chose a nickname (already validated: names.js parseNickname). Resolves with the profile. */
  rename(nickname) {
    return this.#change(async () => {
      const current = await this.#profile();
      const discriminator = await directoryOf(this.env).claimName(current.accountId, nickname, current.discriminator);
      const profile = {
        ...current,
        nickname,
        nicknameSource: 'user',
        discriminator,
        name: displayName(nickname, discriminator),
      };
      await this.ctx.storage.put('profile', profile);
      return profile;
    });
  }

  async getPreferences() {
    return (await this.ctx.storage.get('preferences')) ?? null;
  }
  async savePreferences(patch, initialize = false) {
    validatePreferencePatch(patch);
    return this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get('preferences');
      // First-login migration is atomic: a stale device never replaces an existing account profile.
      if (initialize && current != null) return current;
      const next = { ...current, ...patch };
      await tx.put('preferences', next);
      return next;
    });
  }
  async getActiveSeat() {
    return (await this.ctx.storage.get('activeSeat')) || null;
  }
  async getApplication() {
    const value = await this.ctx.storage.get('application');
    return value?.expiresAt > Date.now() ? value : null;
  }
  async claimApplication(value) {
    return this.ctx.storage.transaction(async (tx) => {
      const active = await tx.get('activeSeat'),
        pending = await tx.get('application');
      if (active) return { ok: false, error: 'ALREADY_SEATED' };
      if (pending && pending.expiresAt > Date.now() && pending.roomId !== value.roomId)
        return { ok: false, error: 'APPLICATION_PENDING' };
      await tx.put('application', value);
      return { ok: true };
    });
  }
  async clearApplication(roomId, id = null) {
    return this.ctx.storage.transaction(async (tx) => {
      const pending = await tx.get('application');
      if (pending?.roomId === roomId && (!id || pending.id === id)) await tx.delete('application');
    });
  }
  applyMatch(fact) {
    requireId(fact.matchId);
    const sql = this.ctx.storage.sql;
    const old = sql.exec('SELECT fact FROM history WHERE match_id=?', fact.matchId).toArray()[0];
    if (old) {
      if (old.fact !== JSON.stringify(fact)) throw new AccountError('HISTORY_CONFLICT', 409);
      return { ok: true };
    }
    sql.exec(
      'INSERT INTO history VALUES (?,?,?,?,?)',
      fact.matchId,
      fact.endedAt,
      fact.mode,
      fact.difficulty,
      JSON.stringify(fact),
    );
    return { ok: true };
  }
  listMatches({ cursor = '', limit = 20, mode = '', difficulty = '', status = '' } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || typeof cursor !== 'string' || cursor.length > 128)
      throw new AccountError('INVALID_PAGE');
    const sql = this.ctx.storage.sql,
      anchor = cursor ? sql.exec('SELECT ended_at FROM history WHERE match_id=?', cursor).toArray()[0] : null;
    if (cursor && !anchor) throw new AccountError('INVALID_CURSOR');
    const rows = sql
      .exec(
        `SELECT fact FROM history WHERE (?='' OR mode=?) AND (?='' OR difficulty=?)
      AND (?='' OR json_extract(fact,'$.status')=?) AND (?='' OR ended_at<? OR (ended_at=? AND match_id<?))
      ORDER BY ended_at DESC,match_id DESC LIMIT ?`,
        mode,
        mode,
        difficulty,
        difficulty,
        status,
        status,
        cursor,
        anchor?.ended_at ?? 0,
        anchor?.ended_at ?? 0,
        cursor,
        limit + 1,
      )
      .toArray()
      .map((x) => JSON.parse(x.fact));
    const items = rows.slice(0, limit);
    return { items, nextCursor: rows.length > limit ? items.at(-1).matchId : null };
  }
  getStats({ mode = '', difficulty = '' } = {}) {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT fact FROM history WHERE (?='' OR mode=?) AND (?='' OR difficulty=?)",
        mode,
        mode,
        difficulty,
        difficulty,
      )
      .toArray();
    return aggregateStats(rows.map((r) => JSON.parse(r.fact)));
  }
  // The seat is a pointer: its room decides whether it is still held (worker/accounts/routes.js seatOf), so it has no
  // expiry of its own. Seats stored earlier carry an unused expiresAt.
  async claimSeat({ claimId, seat }) {
    requireId(claimId);
    requireId(seat.roomId);
    requireId(seat.roomGeneration);
    return this.ctx.storage.transaction(async (tx) => {
      const active = await tx.get('activeSeat');
      if (active && active.claimId !== claimId) return { ok: false, error: 'ALREADY_SEATED' };
      if (active) return { ok: true, seat: active };
      const value = { ...seat, claimId };
      await tx.put('activeSeat', value);
      return { ok: true, seat: value };
    });
  }
  async releaseSeat({ claimId }) {
    return this.ctx.storage.transaction(async (tx) => {
      const active = await tx.get('activeSeat');
      if (!active || active.claimId !== claimId) return { ok: false };
      await tx.delete('activeSeat');
      return { ok: true };
    });
  }
}
