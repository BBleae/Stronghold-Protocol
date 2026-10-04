// Reset a password account's password (administrators):
//   npm run accounts:reset-password -- --origin https://stronghold.lunar.ag --username <name> [--generate]
// Asks for the new password twice (not shown while typed), or with --generate makes a random one and prints it once.
// The Worker sets it and ends every session of the account. The administrator token is read from the environment
// (SP_ACCOUNT_ADMIN_TOKEN, the Worker's secret ACCOUNT_ADMIN_TOKEN), never printed or saved.
import path from 'node:path';
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validPassword, PASSWORD_LENGTH } from '../shared/account-protocol.js';

// What a reset needs besides the password: refused before anything is asked or sent.
function checkTarget({ origin, username, token }) {
  if (!origin || !username) throw new Error('Use --origin URL --username NAME [--generate]');
  const base = new URL(origin);
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('HTTPS required');
  if (!token || token.length < 32) throw new Error('Set SP_ACCOUNT_ADMIN_TOKEN (at least 32 characters)');
  return base;
}

/** POST /api/admin/accounts/password. Rejects with the Worker's error code (ACCOUNT_NOT_FOUND, FORBIDDEN, …). */
export async function resetPassword({ origin, username, password, token, fetchFn = fetch }) {
  const base = checkTarget({ origin, username, token });
  if (!validPassword(password)) throw new Error(`A password has ${PASSWORD_LENGTH.min}-${PASSWORD_LENGTH.max} characters`);
  const response = await fetchFn(new URL('/api/admin/accounts/password', base), { method: 'POST', redirect: 'error',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (response.status === 204) return;
  const text = await response.text();
  let code = `HTTP ${response.status}`;
  if (response.headers.get('Content-Type')?.includes('application/json')) code = JSON.parse(text).error ?? code;
  throw new Error(code);
}

/** A random password: 18 random bytes, base64url (24 characters). */
export const generatePassword = () => randomBytes(18).toString('base64url');

// Piped input: one reader for all its lines, which keeps them until they are asked for.
let piped = null;
let pipedLines = null;

// Keys of a terminal line typed with its echo off.
const ENTER = ['\r', '\n'];
const CTRL_C = '\u0003';
const BACKSPACE = ['\u007f', '\b'];

// A line from the terminal, not shown while typed (piped input is read as it is).
function askSecret(question) {
  const input = process.stdin;
  process.stdout.write(question);
  if (!input.isTTY) {
    piped ??= readline.createInterface({ input });
    pipedLines ??= piped[Symbol.asyncIterator]();
    return pipedLines.next().then(({ value }) => value ?? '');
  }
  return new Promise((resolve, reject) => {
    let value = '';
    const done = () => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ENTER.includes(ch)) { done(); resolve(value); return; }
        if (ch === CTRL_C) { done(); reject(new Error('cancelled')); return; }
        value = BACKSPACE.includes(ch) ? [...value].slice(0, -1).join('') : value + ch;
      }
    };
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    input.on('data', onData);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const target = { origin: value('--origin'), username: value('--username'), token: process.env.SP_ACCOUNT_ADMIN_TOKEN };
  try {
    checkTarget(target);
    const generate = args.includes('--generate');
    const password = generate ? generatePassword() : await askSecret('New password: ');
    if (!generate && (await askSecret('Again: ')) !== password) throw new Error('The two passwords differ');
    await resetPassword({ ...target, password });
    console.log(`The password of ${target.username} was reset; every session of the account ended.`);
    if (generate) console.log(`New password (shown once): ${password}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    piped?.close();
  }
}
