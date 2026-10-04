// WebSocket close codes of the room Worker: the one list. A room socket that ends tells its client why with one of
// these. The browser client (public/js/room-net.js) acts on 4001, 4003 and 4004 and treats any other close as a lost
// connection, which it reconnects. A refused upgrade is answered the same way, by a socket that closes at once: a
// browser cannot read the HTTP status of a refused WebSocket upgrade, only a close code.

import { CLOSE as UPSTREAM } from '../server/net.js';

export const CLOSE = Object.freeze({
  /** The session was taken over by another tab or device (upstream server/net.js). Do not reconnect. */
  REPLACED: UPSTREAM.REPLACED, // 4001
  /** The socket never said hello (upstream server/net.js). */
  HELLO_TIMEOUT: UPSTREAM.HELLO_TIMEOUT, // 4002
  /** The login is invalid: no session, or it expired or was revoked (logout). Log in again; do not reconnect. */
  LOGIN_INVALID: 4003,
  /** Nothing to rejoin: no room has this code, the room ended, or the match a spectator watched ended. */
  ROOM_GONE: 4004,
  /** A connection or rate limit: reconnect later (RFC 6455 "try again later"). */
  TRY_LATER: 1013,
  /** Flooding past the rate limit (upstream server/net.js). */
  POLICY: UPSTREAM.POLICY, // 1008
  /** A frame larger than the room accepts. */
  TOO_BIG: 1009,
  /** No frame and no heartbeat for too long. */
  IDLE: 1001,
  /** The room lost this socket's record (it restarted before the socket was saved): reconnect. */
  LOST: 1011,
});

/** Answer a WebSocket upgrade with a socket that closes at once with `code` and `reason`. */
export function refuseSocket(code, reason) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}
