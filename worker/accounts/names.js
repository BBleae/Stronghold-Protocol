// Nicknames (博士代号). Players see an account as `昵称#NNNN` (shared/account-protocol.js displayName); the directory
// allocates the discriminator so that no two accounts share a display name (SiteDirectory.claimName, under the
// nickname's key: shared/account-protocol.js nicknameKey).

import { normalizeName } from '../../server/net.js';
import { AccountError, NICKNAME_MAX, NUMBER_SIGNS, validNickname } from '../../shared/account-protocol.js';

/** A nickname a player typed, normalized like every name (server/net.js normalizeName). Throws INVALID_NICKNAME. */
export function parseNickname(raw) {
  const nickname = normalizeName(raw);
  if (!validNickname(nickname)) throw new AccountError('INVALID_NICKNAME');
  return nickname;
}

const shortened = (raw) => [...normalizeName(String(raw ?? '').replace(NUMBER_SIGNS, ''))].slice(0, NICKNAME_MAX).join('').trim();

/**
 * The nickname a GitHub account goes by: its GitHub name, else its login, without number signs, cut to 12 characters
 * (博士, the game's name for a player, when neither leaves a nickname that shows something).
 */
export const githubNickname = (name, login) => [shortened(name), shortened(login)].find(validNickname) ?? '博士';
