// Password hashes: PBKDF2-SHA256 (WebCrypto) with a random 16-byte salt and a 32-byte key, stored with their parameters
// ({ alg, iterations, salt, hash }, base64url) so the parameters can change later: a login with a hash made under other
// parameters stores it again under the current ones. Hashes are derived in the Worker's request, never inside the
// directory Durable Object, whose every call waits behind the one before it.

/** Cloudflare Workers allow at most 100,000 PBKDF2 iterations (local workerd does not enforce it: never exceed it). */
export const PBKDF2_ITERATIONS = 100_000;
const ALG = 'pbkdf2-sha256';
const SALT_BYTES = 16;
const KEY_BYTES = 32;

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const fromBase64url = (text) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, KEY_BYTES * 8);
  return new Uint8Array(bits);
}

/** The stored form of a new password. */
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return { alg: ALG, iterations: PBKDF2_ITERATIONS, salt: base64url(salt), hash: base64url(await derive(password, salt, PBKDF2_ITERATIONS)) };
}

// What an unknown username's password is checked against: the same derivation as a real one, so the answer takes as
// long whether the username exists or not.
const NOBODY = { alg: ALG, iterations: PBKDF2_ITERATIONS, salt: 'c3Ryb25naG9sZC1kdW1teQ', hash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };

/** Whether `password` is the one `stored` was made from (null: an unknown username, which never matches). */
export async function verifyPassword(password, stored) {
  const record = stored ?? NOBODY;
  const expected = fromBase64url(record.hash);
  const actual = await derive(password, fromBase64url(record.salt), record.iterations);
  // Constant time: every byte is compared, whatever the first difference.
  let difference = expected.length ^ actual.length;
  for (let i = 0; i < Math.min(expected.length, actual.length); i++) difference |= expected[i] ^ actual[i];
  return stored != null && difference === 0;
}

/** Whether a stored hash was made under other parameters than a new one would be. */
export const outdated = (stored) => stored.alg !== ALG || stored.iterations !== PBKDF2_ITERATIONS;
