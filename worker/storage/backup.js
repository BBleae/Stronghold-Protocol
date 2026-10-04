import { hash, accountOf, directoryOf, json, bearerAuthorized } from '../accounts/auth.js';
import { archiveOf } from '../archive/routes.js';
import { RULES_VERSION } from '../../shared/rules-version.js';
import { publishedRulesVersions } from '../match-versions.js';
import {
  AccountError,
  requireId,
  USERNAME_PATTERN,
  validNickname,
  displayName,
} from '../../shared/account-protocol.js';
import { decodeReplayChunk, REPLAY_MAX_BYTES, REPLAY_CHUNK_BYTES } from '../../shared/replay-codec.js';
import { readJson } from '../http.js';
import { logError } from '../log.js';
import { normalizeName } from '../../server/net.js';
import { PBKDF2_ITERATIONS } from '../accounts/passwords.js';

// The largest import request ({ backup, dryRun }). An archive that would not fit is refused when it is exported, so a
// backup that cannot be restored never looks complete.
const IMPORT_BYTES = 32 * 1024 * 1024;

export async function sealBackup(facts, chunks) {
  const body = { formatVersion: 1, facts, chunks };
  return { ...body, hash: await hash(JSON.stringify(body)) };
}
// An archive can be imported when this deployment publishes the replay engine of its rules version.
export async function validateBackup(backup, versions = [RULES_VERSION, ...publishedRulesVersions]) {
  if (backup?.formatVersion !== 1 || !backup.facts || !Array.isArray(backup.chunks))
    throw new AccountError('INVALID_BACKUP');
  const { formatVersion, facts, chunks } = backup;
  requireId(facts.matchId);
  if ((await hash(JSON.stringify({ formatVersion, facts, chunks }))) !== backup.hash)
    throw new AccountError('BACKUP_HASH');
  if (!versions.includes(facts.manifest?.rulesVersion)) throw new AccountError('BACKUP_VERSION');
  if (
    !Array.isArray(facts.personal) ||
    !Array.isArray(facts.participants) ||
    !facts.participants.length ||
    facts.personal.length !== facts.participants.length ||
    facts.personal.some((p) => !facts.participants.includes(p.accountId) || p.matchId !== facts.matchId)
  )
    throw new AccountError('INVALID_BACKUP');
  if (!Array.isArray(facts.manifest.chunks) || chunks.length > 10001 || chunks.length !== facts.manifest.chunks.length)
    throw new AccountError('BACKUP_INCOMPLETE');
  const compressed = facts.manifest.codec === 'gzip-base64';
  let decoded = 0;
  if (
    (facts.manifest.codec && !compressed) ||
    (compressed &&
      (facts.manifest.schemaVersion !== 2 ||
        !Number.isSafeInteger(facts.manifest.decodedBytes) ||
        facts.manifest.decodedBytes < 1 ||
        facts.manifest.decodedBytes > REPLAY_MAX_BYTES))
  )
    throw new AccountError('INVALID_BACKUP');
  if (
    compressed &&
    (facts.manifest.chunks.some(
      (c) => !Number.isSafeInteger(c.rawBytes) || c.rawBytes < 1 || c.rawBytes > REPLAY_CHUNK_BYTES,
    ) ||
      facts.manifest.chunks.reduce((n, c) => n + c.rawBytes, 0) !== facts.manifest.decodedBytes)
  )
    throw new AccountError('BACKUP_INCOMPLETE');
  for (const [index, chunk] of chunks.entries()) {
    if (
      chunk.index !== index ||
      typeof chunk.text !== 'string' ||
      chunk.text.length > 64000 ||
      chunk.hash !== (await hash(chunk.text)) ||
      chunk.hash !== facts.manifest.chunks[index].hash
    )
      throw new AccountError('BACKUP_HASH');
    if (compressed) decoded += (await decodeReplayChunk(chunk.text, facts.manifest.chunks[index].rawBytes)).length;
  }
  if (compressed && decoded !== facts.manifest.decodedBytes) throw new AccountError('BACKUP_INCOMPLETE');
  return { ok: true };
}
// An account in a backup: its profile (worker/accounts/account.js) and, for a password account, its password hash and
// creation time. Backups made before password accounts hold GitHub profiles only, some of them from before display
// names ({ accountId, githubId, name, avatarUrl }): those restore as they are and get their display name when read.
const PROFILE_FIELDS = [
  'accountId',
  'provider',
  'githubId',
  'githubLogin',
  'username',
  'nickname',
  'nicknameSource',
  'discriminator',
  'name',
  'avatarUrl',
];
const BASE64URL = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The account's backup entry: its profile, read from the account (which completes an unfinished one), and a password
 * account's hash and creation time. A GitHub account whose first login stopped before its profile was stored is its
 * GitHub identity from the directory, which restores like a profile from before display names.
 */
async function exportAccount(env, item) {
  const profile = await accountOf(env, item.accountId).getProfile();
  if (item.githubId) return profile ?? item.identity;
  if (!profile) {
    logError('backup_profile_missing', { accountId: item.accountId });
    throw new AccountError('PROFILE_MISSING', 500);
  }
  return { ...profile, password: item.password, createdAt: item.createdAt };
}

/** A backup entry checked field by field: { profile, password, createdAt } (INVALID_PROFILE). */
function parseAccount(entry) {
  const invalid = () => new AccountError('INVALID_PROFILE');
  if (!entry || typeof entry !== 'object') throw invalid();
  const profile = Object.fromEntries(
    PROFILE_FIELDS.filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]]),
  );
  const { password = null, createdAt = null } = entry;
  requireId(profile.accountId);
  if (profile.provider === 'password') {
    const hashed =
      password &&
      password.alg === 'pbkdf2-sha256' &&
      Number.isSafeInteger(password.iterations) &&
      password.iterations > 0 &&
      password.iterations <= PBKDF2_ITERATIONS &&
      BASE64URL.test(password.salt) &&
      BASE64URL.test(password.hash);
    if (
      !USERNAME_PATTERN.test(profile.username ?? '') ||
      profile.githubId !== undefined ||
      !hashed ||
      !Number.isSafeInteger(createdAt)
    )
      throw invalid();
  } else if (
    (profile.provider ?? 'github') !== 'github' ||
    !/^[0-9]{1,20}$/.test(profile.githubId ?? '') ||
    password !== null ||
    (profile.githubLogin !== undefined && (typeof profile.githubLogin !== 'string' || profile.githubLogin.length > 80))
  ) {
    throw invalid();
  }
  if (profile.discriminator !== undefined) {
    const named =
      /^\d{4}$/.test(profile.discriminator) &&
      validNickname(profile.nickname) &&
      normalizeName(profile.nickname) === profile.nickname &&
      ['github', 'user'].includes(profile.nicknameSource) &&
      profile.name === displayName(profile.nickname, profile.discriminator);
    if (!named) throw invalid();
  } else if (profile.provider === 'password' || typeof profile.name !== 'string' || profile.name.length > 80) {
    throw invalid();
  }
  if (profile.avatarUrl != null && !/^https:\/\/avatars\.githubusercontent\.com\//.test(profile.avatarUrl))
    throw invalid();
  profile.avatarUrl ??= null;
  return { profile, password, createdAt };
}

export async function handleBackupRoutes(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/admin/backup')) return null;
  const isWrite = request.method === 'POST';
  // A player session is deliberately irrelevant to administrator authorization.
  if (!(await bearerAuthorized(request, isWrite ? env.ARCHIVE_IMPORT_TOKEN : env.ARCHIVE_EXPORT_TOKEN)))
    return json({ error: 'FORBIDDEN' }, 403);
  const directory = directoryOf(env);
  if (request.method === 'GET' && url.pathname === '/api/admin/backup/catalog') {
    const kind = url.searchParams.get('kind') || 'profiles';
    const page = await directory.backupCatalog({ kind, cursor: url.searchParams.get('cursor') || '' });
    if (kind === 'profiles') page.items = await Promise.all(page.items.map((item) => exportAccount(env, item)));
    return json(page);
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/backup/archive') {
    const id = requireId(url.searchParams.get('id'));
    const archive = await archiveOf(env, id).exportArchive();
    const backup = await sealBackup(archive.facts, archive.chunks);
    if (new TextEncoder().encode(JSON.stringify({ backup, dryRun: false })).length > IMPORT_BYTES)
      throw new AccountError('BACKUP_TOO_LARGE', 413);
    return json(backup);
  }
  if (!isWrite) return json({ error: 'METHOD' }, 405);
  const input = await readJson(request, IMPORT_BYTES, 'INVALID_BACKUP'),
    dryRun = input.dryRun !== false;
  if (url.pathname === '/api/admin/backup/profile') {
    // The directory restores the identity (and ends the account's sessions), then the account its profile.
    const account = parseAccount(input.profile);
    await directory.restoreAccount(account, dryRun);
    if (!dryRun) await accountOf(env, account.profile.accountId).setProfile(account.profile);
    return json({ ok: true, written: dryRun ? 0 : 1 });
  }
  if (url.pathname !== '/api/admin/backup/archive') return json({ error: 'NOT_FOUND' }, 404);
  await validateBackup(input.backup);
  const { facts, chunks } = input.backup,
    archive = archiveOf(env, facts.matchId);
  await archive.checkImport(facts, chunks);
  for (const p of facts.personal) {
    const profile = await accountOf(env, p.accountId).getProfile();
    if (!dryRun && !profile) throw new AccountError('RESTORE_PROFILES_FIRST');
  }
  if (!dryRun) {
    for (const chunk of chunks) await archive.appendChunk({ index: chunk.index, text: chunk.text });
    await archive.finalize(facts);
    await directory.registerArchive(facts.matchId);
    for (const p of facts.personal) await accountOf(env, p.accountId).applyMatch(p);
  }
  return json({ ok: true, written: dryRun ? 0 : 1 });
}
