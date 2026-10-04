// HTTP plumbing shared by the Worker's routes and the room's internal routes.

import { AccountError, isAccountError } from '../shared/account-protocol.js';
import { normalizeIp, limitKeyOf } from '../server/net.js';
import { logWarn, logError, errorFields } from './log.js';

const json = (body, status, headers = {}) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

// Request limits: Cloudflare's rate limiting bindings (wrangler.jsonc "ratelimits": a limit per minute, counted at each
// Cloudflare location, nothing stored). A request counts against the client's network (its IPv4 address or IPv6 /64,
// as the edge reports it) and, where there is one, against its account.

/** The client's address as Cloudflare's edge reports it (never a header the client sets). */
export const edgeIp = (request) => normalizeIp(request.headers.get('CF-Connecting-IP')) || '0.0.0.0';

/** The limit key of the client's network. */
export const networkKey = (request) => 'net:' + limitKeyOf(edgeIp(request));

/** The limit key of an account. */
export const accountKey = (accountId) => 'account:' + accountId;

/** Whether one more request under `key` is within `limit` (a rate limiting binding). */
export async function within(limit, key) {
  const { success } = await limit.limit({ key });
  return success;
}

/** The answer to a request over its limit. */
export const tooMany = () => json({ error: 'RATE', detail: 'too many requests' }, 429, { 'Retry-After': '10' });

/**
 * The response for an error that ended a request. A known error answers with its own code and status: an AccountError
 * (a Durable Object RPC keeps its code and status, not its class), e.g. 403 FORBIDDEN or 502 OAUTH_PROVIDER_FAILED. A
 * Durable Object that is overloaded or restarting answers 503 UNAVAILABLE. Anything else is a bug: 500 INTERNAL.
 * Everything but a client error (4xx) is logged with `context` (method, path; never headers, cookies or bodies).
 */
export function errorResponse(error, context) {
  if (isAccountError(error)) {
    if (error.status >= 500) logWarn('request_failed', { ...context, error: errorFields(error) });
    return json({ error: error.code }, error.status);
  }
  if (error?.retryable || error?.overloaded) {
    logWarn('request_unavailable', { ...context, error: errorFields(error) });
    return json({ error: 'UNAVAILABLE' }, 503);
  }
  logError('request_failed', { ...context, error: errorFields(error) });
  return json({ error: 'INTERNAL' }, 500);
}

/**
 * A request's JSON object body. Reading stops past `maxBytes` (413 BODY_TOO_LARGE); a body that is not a JSON object
 * is the client's error `invalid` (400).
 */
export async function readJson(request, maxBytes, invalid = 'BAD_MSG') {
  if (Number(request.headers.get('Content-Length')) > maxBytes) throw new AccountError('BODY_TOO_LARGE', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AccountError(invalid);
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AccountError('BODY_TOO_LARGE', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AccountError(invalid);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AccountError(invalid);
  return body;
}
