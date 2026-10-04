export const ACCOUNT_LIMITS = Object.freeze({
  sessionMs: 30 * 86400000, oauthMs: 600000, applicationMs: 120000,
  // How long an approval holds the applicant's seat: long enough to switch apps on a phone and back.
  approvalMs: 120000, leaseMs: 60000, heartbeatMs: 20000, pageSize: 50,
});
export class AccountError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export function requireId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw new AccountError('INVALID_ID');
  return value;
}
export function pageLimit(value = 20) {
  if (!Number.isSafeInteger(value) || value < 1 || value > ACCOUNT_LIMITS.pageSize) throw new AccountError('INVALID_PAGE');
  return value;
}

// Password accounts (worker/accounts/*, the title screen's account card). The Worker decides; the client checks the
// same rules first so a player sees a mistake before sending it.

/** A username is a login identifier only, never shown to other players: 3–20 letters, digits or underscores. */
export const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

/** A password has 8–128 characters (code points), any characters. */
export const PASSWORD_LENGTH = Object.freeze({ min: 8, max: 128 });

/** A nickname (博士代号) has at most this many characters (code points) after the name normalization. */
export const NICKNAME_MAX = 12;

/** Every character that reads as '#' (its NFKC form): a nickname has none, so its display name parses one way. */
export const NUMBER_SIGNS = /[#\uFE5F\uFF03]/g;

/** Whether a password has an allowed length. */
export const validPassword = (password) => typeof password === 'string'
  && [...password].length >= PASSWORD_LENGTH.min && [...password].length <= PASSWORD_LENGTH.max;

/**
 * The key a nickname's discriminators are unique under (the directory allocates them): look-alike, case and invisible
 * variants of a nickname share it. It drops what Unicode calls invisible (default-ignorable characters), then takes
 * NFKC and lower case. An empty key: the nickname shows nothing.
 */
export const nicknameKey = (nickname) => nickname.replace(/\p{Default_Ignorable_Code_Point}/gu, '').normalize('NFKC').toLowerCase();

/** Whether an already normalized nickname is one: 1–NICKNAME_MAX characters, something visible, no number sign. */
export const validNickname = (nickname) => typeof nickname === 'string' && nicknameKey(nickname).length > 0
  && [...nickname].length <= NICKNAME_MAX && !nickname.match(NUMBER_SIGNS);

/** The name every other player sees: the nickname and the account's discriminator (0000–9999), e.g. 晴猫#1145. */
export const displayName = (nickname, discriminator) => `${nickname}#${discriminator}`;
