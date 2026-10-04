// Account administration, authorized by its own secret ACCOUNT_ADMIN_TOKEN (≥ 32 characters; apart from the archive
// backup tokens: least privilege), never by a player session. tools/reset-password.mjs is its client.

import { AccountError, validPassword } from '../../shared/account-protocol.js';
import { readJson } from '../http.js';
import { logInfo } from '../log.js';
import { bearerAuthorized, directoryOf, json } from './auth.js';
import { hashPassword } from './passwords.js';

/**
 * POST /api/admin/accounts/password {username, password}: the password account gets a new password and every one of
 * its sessions ends (204; ACCOUNT_NOT_FOUND).
 */
export async function handleAccountAdmin(request, env) {
  if (new URL(request.url).pathname !== '/api/admin/accounts/password') return null;
  if (!(await bearerAuthorized(request, env.ACCOUNT_ADMIN_TOKEN))) return json({ error: 'FORBIDDEN' }, 403);
  if (request.method !== 'POST') return json({ error: 'METHOD' }, 405);
  const { username, password } = await readJson(request, 4096);
  if (typeof username !== 'string') throw new AccountError('BAD_MSG');
  if (!validPassword(password)) throw new AccountError('INVALID_PASSWORD');
  const accountId = await directoryOf(env).resetPassword(username, await hashPassword(password));
  logInfo('account_password_reset', { accountId });
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}
