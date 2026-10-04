// GitHub sign-in (an OAuth app). It is offered only while it can work: the app is configured (GITHUB_CLIENT_ID,
// GITHUB_CLIENT_SECRET and AUTH_ORIGIN, a bare https origin) and its credentials are not known to be invalid.
//
// Whether they are valid needs no user: exchanging a made-up code at GitHub's token endpoint answers
// bad_verification_code with valid credentials, incorrect_client_credentials or redirect_uri_mismatch with invalid
// ones (https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-oauth-app-access-token-request-errors).
// The verdict is kept per configuration (a digest of the client id, secret and origin: new credentials are checked
// again) in the directory, for every isolate, and in this isolate: valid for 24 h, invalid for 1 h, unknown (any other
// answer, no answer) for 5 min, during which the sign-in stays offered. A real login whose code GitHub refuses with one
// of the invalid answers has the credentials checked at once: that code is the visitor's (it may have been issued for
// another redirect URI), so only the check, which nobody else can influence, decides for every player.

import { ACCOUNT_LIMITS, AccountError, isAccountError } from '../../shared/account-protocol.js';
import { logWarn, logError, errorFields } from '../log.js';
import { directoryOf, accountOf, hash, cookie, cookieValue, randomToken, startSession } from './auth.js';

const OAUTH_COOKIE = '__Host-sp_oauth';
// Where a login may return to: the lobby, or the invite link the player is applying with (/?room=CODE). The path is
// bound to the OAuth state server-side, so the callback never redirects anywhere a request parameter names.
const RETURN_PATH = /^\/(\?room=[A-Z]{4})?$/;
const VERDICTS = { bad_verification_code: 'valid', incorrect_client_credentials: 'invalid', redirect_uri_mismatch: 'invalid' };
const VERDICT_MS = { valid: 86_400_000, invalid: 3_600_000, unknown: 300_000 };

/** Whether the OAuth app is configured: client id and secret set, AUTH_ORIGIN a bare https origin (host in lower case). */
export const githubConfigured = (env) => !!env.GITHUB_CLIENT_ID && !!env.GITHUB_CLIENT_SECRET
  && /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(env.AUTH_ORIGIN ?? '');

const callbackUrl = (env) => env.AUTH_ORIGIN + '/api/auth/github/callback';
const fingerprintOf = (env) => hash(JSON.stringify([env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET, env.AUTH_ORIGIN]));

// This isolate's last verdict: { fingerprint, verdict, expiresAt }.
let lastVerdict = null;

async function record(env, fingerprint, verdict, now) {
  lastVerdict = { fingerprint, verdict, expiresAt: now() + VERDICT_MS[verdict] };
  await directoryOf(env).setProviderStatus(fingerprint, verdict, lastVerdict.expiresAt);
}

// GitHub's token endpoint, asked to exchange a made-up code.
async function check(env, providerFetch) {
  try {
    const response = await providerFetch('https://github.com/login/oauth/access_token', { method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET,
        code: 'stronghold-credentials-check', redirect_uri: callbackUrl(env) }).toString(), signal: AbortSignal.timeout(5000) });
    const answer = await response.json();
    const verdict = VERDICTS[answer.error] ?? 'unknown';
    if (verdict === 'invalid') logError('github_credentials_invalid', { error: answer.error });
    if (verdict === 'unknown') logWarn('github_check_failed', { status: response.status, error: String(answer.error ?? '') });
    return verdict;
  } catch (error) {
    logWarn('github_check_failed', { error: errorFields(error) });
    return 'unknown';
  }
}

/** Whether GitHub sign-in is offered (see the header). Waits for GitHub at most once per verdict's lifetime. */
export async function githubEnabled(env, { now = Date.now, fetch: providerFetch = globalThis.fetch } = {}) {
  if (!githubConfigured(env)) return false;
  const fingerprint = await fingerprintOf(env);
  if (lastVerdict?.fingerprint !== fingerprint || lastVerdict.expiresAt <= now()) {
    const stored = await directoryOf(env).providerStatus(fingerprint);
    if (stored && stored.expiresAt > now()) lastVerdict = { fingerprint, ...stored };
    else await record(env, fingerprint, await check(env, providerFetch), now);
  }
  return lastVerdict.verdict !== 'invalid';
}

/**
 * GET /api/auth/github/start[?return=/?room=CODE] and /api/auth/github/callback: the OAuth flow (state bound to the
 * browser and stored hashed, S256 PKCE, a fixed redirect URI). A login that fails goes back where it started with
 * ?authError=<code>; a browser navigation never sees a JSON error page.
 */
export async function handleGithub(request, env, { now = Date.now, fetch: providerFetch = globalThis.fetch } = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/auth/github/')) return null;
  let returnTo = '/';
  try {
    if (request.method !== 'GET') throw new AccountError('METHOD', 405);
    if (!githubConfigured(env)) throw new AccountError('GITHUB_UNAVAILABLE', 503);
    if (url.origin !== env.AUTH_ORIGIN) throw new AccountError('INVALID_ORIGIN');
    const directory = directoryOf(env);
    if (url.pathname === '/api/auth/github/start') {
      const returnPath = url.searchParams.get('return') ?? '/';
      if (!RETURN_PATH.test(returnPath)) throw new AccountError('BAD_RETURN_PATH');
      returnTo = returnPath;
      if (!(await githubEnabled(env, { now, fetch: providerFetch }))) throw new AccountError('GITHUB_UNAVAILABLE', 503);
      const state = randomToken(), verifier = randomToken();
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      const challenge = btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
      await directory.saveOAuth(await hash(state), { verifier, returnTo: returnPath, expiresAt: now() + ACCOUNT_LIMITS.oauthMs });
      const dest = new URL('https://github.com/login/oauth/authorize');
      dest.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: callbackUrl(env), state,
        code_challenge: challenge, code_challenge_method: 'S256' }).toString();
      return new Response(null, { status: 302, headers: { Location: dest.href, 'Cache-Control': 'no-store', 'Set-Cookie': cookie(OAUTH_COOKIE, state, 600) } });
    }
    if (url.pathname !== '/api/auth/github/callback') throw new AccountError('NOT_FOUND', 404);
    const state = url.searchParams.get('state');
    if (!state || !/^[a-f0-9]{64}$/.test(state) || state !== cookieValue(request, OAUTH_COOKIE)) throw new AccountError('OAUTH_STATE');
    const transaction = await directory.consumeOAuth(await hash(state));
    returnTo = transaction?.returnTo ?? '/';
    if (!transaction || transaction.expiresAt <= now() || url.searchParams.has('error')) throw new AccountError('OAUTH_EXPIRED_OR_DENIED');
    const code = url.searchParams.get('code');
    if (!code || code.length > 1024) throw new AccountError('OAUTH_CODE');
    const tokens = await providerFetch('https://github.com/login/oauth/access_token', { method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET,
        code, code_verifier: transaction.verifier, redirect_uri: callbackUrl(env) }).toString(), signal: AbortSignal.timeout(10000) });
    if (!tokens.ok) throw new AccountError('OAUTH_PROVIDER_FAILED', 502);
    const token = await tokens.json();
    if (VERDICTS[token.error] === 'invalid') {
      const verdict = await check(env, providerFetch);
      await record(env, await fingerprintOf(env), verdict, now);
      if (verdict === 'invalid') throw new AccountError('GITHUB_UNAVAILABLE', 503);
      logWarn('github_code_refused', { error: token.error, verdict });
      throw new AccountError('OAUTH_PROVIDER_FAILED', 502);
    }
    if (typeof token.access_token !== 'string' || !token.access_token) throw new AccountError('OAUTH_PROVIDER_FAILED', 502);
    const response = await providerFetch('https://api.github.com/user', { headers: {
      Authorization: 'Bearer ' + token.access_token, Accept: 'application/vnd.github+json', 'User-Agent': 'Stronghold-Protocol' },
    signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new AccountError('OAUTH_PROVIDER_FAILED', 502);
    const profile = await response.json();
    if (!Number.isSafeInteger(profile.id) || profile.id <= 0 || typeof profile.login !== 'string') throw new AccountError('OAUTH_PROVIDER_FAILED', 502);
    const avatarUrl = typeof profile.avatar_url === 'string' && /^https:\/\/avatars\.githubusercontent\.com\//.test(profile.avatar_url) ? profile.avatar_url : null;
    const identity = await directory.resolveGithubUser({ id: String(profile.id), login: profile.login.slice(0, 80), name: profile.name, avatarUrl });
    await accountOf(env, identity.accountId).applyGithubLogin(identity);
    const headers = new Headers({ Location: returnTo, 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', await startSession(env, identity.accountId, now));
    headers.append('Set-Cookie', cookie(OAUTH_COOKIE, '', 0));
    return new Response(null, { status: 303, headers });
  } catch (error) {
    // A known error (AccountError — also one from a Durable Object's RPC, which keeps only code and status) is the
    // answer; anything else is a bug: logged, and answered by the Worker's error response (worker/http.js). A browser
    // navigation goes back where the login started (an invite stays), with the code of what went wrong.
    const known = isAccountError(error);
    if (!request.headers.get('Accept')?.includes('text/html')) throw error;
    if (!known) logError('auth_failed', { path: url.pathname, error: errorFields(error) });
    const back = new URL(returnTo, url.origin);
    back.searchParams.set('authError', known ? error.code : 'INTERNAL');
    return new Response(null, { status: 303, headers: { Location: back.pathname + back.search, 'Cache-Control': 'no-store',
      'Set-Cookie': cookie(OAUTH_COOKIE, '', 0) } });
  }
}
