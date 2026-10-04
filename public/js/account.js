// Account API client (Workers deployment): the signed-in GitHub account as /api/me reported it at boot, the one HTTP
// helper every account request goes through, and the GitHub login URL.
//
// Errors are NetErrors (net.js) like the socket's: one code, one text (errorText: the shared ERR_TEXT, then the
// client's CLIENT_ERR_TEXT, which holds the account codes).

import { NetError } from './net.js';

/**
 * /api/me at boot: `enabled` = the server runs accounts, `loginReady` = GitHub login is configured; `activeSeat` and
 * `application` are the account's seat and pending join application at that moment.
 */
export const account = { enabled: false, loginReady: false, user: null, activeSeat: null, application: null };

/** An account request gives up after this long (response headers and body together). */
export const ACCOUNT_REQUEST_TIMEOUT_MS = 10000;

/**
 * JSON request to the account API (same origin, with the session cookie): GET without a body, POST with one.
 * Resolves with the parsed answer (null for 204). Rejects with a NetError carrying the server's error code, or
 * TIMEOUT, OFFLINE (no answer at all) or UNAVAILABLE (an answer that is not the API's JSON, e.g. an edge error page).
 * @param {string} path
 * @param {any} [body]
 * @param {typeof fetch} [fetchFn]
 */
export async function accountRequest(path, body, fetchFn = globalThis.fetch) {
  const post = body !== undefined;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ACCOUNT_REQUEST_TIMEOUT_MS);
  let response = null;
  let result;
  try {
    response = await fetchFn(path, {
      method: post ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: abort.signal,
      headers: post ? { 'Content-Type': 'application/json' } : undefined,
      body: post ? JSON.stringify(body) : undefined,
    });
    if (response.status === 204) return null;
    result = await response.json();
  } catch (error) {
    if (abort.signal.aborted) throw new NetError('TIMEOUT');
    if (!response) throw new NetError('OFFLINE');
    console.warn(`[account] ${path}: HTTP ${response.status} without a JSON answer`, error);
    throw new NetError('UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
  if (response.ok) return result;
  const code = typeof result?.error === 'string' && result.error ? result.error : 'UNAVAILABLE';
  // A code without a text of its own (a developer error) still reads as Chinese, with the code for a bug report.
  throw new NetError(code, `请求失败，请稍后重试（${code}）`, result?.detail);
}

/** Load /api/me into `account`. */
export async function loadAccount(fetchFn = globalThis.fetch) {
  const result = await accountRequest('/api/me', undefined, fetchFn);
  Object.assign(account, {
    enabled: !!(result.capabilities?.accountSystem || result.capabilities?.accounts),
    loginReady: !!result.capabilities?.accounts,
    user: result.user, activeSeat: result.activeSeat, application: result.application,
  });
  return result;
}

const INVITE_CODE = /^[A-Z]{4}$/;

/**
 * GitHub login. A pending invite code travels through the login (the Worker binds the return path to the OAuth
 * state), so the player comes back to `/?room=CODE` and the application goes out.
 * @param {string|null} [room] pending invite code
 */
export function loginUrl(room = null) {
  const start = '/api/auth/github/start';
  return INVITE_CODE.test(room ?? '') ? `${start}?return=${encodeURIComponent(`/?room=${room}`)}` : start;
}
