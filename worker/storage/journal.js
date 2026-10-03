import { AccountError, requireId, pageLimit } from '../../shared/account-protocol.js';

function initialize(storage) {
  storage.sql.exec('CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL)');
}
export async function appendEvent(storage, event) {
  if (!event || Object.keys(event).some(k => !['commandId', 'at', 'kind', 'payload'].includes(k)) ||
      !Number.isSafeInteger(event.at) || event.at < 0) throw new AccountError('INVALID_EVENT');
  requireId(event.commandId); requireId(event.kind);
  const payload = JSON.stringify(event.payload);
  if (!payload || new TextEncoder().encode(payload).length > 65536) throw new AccountError('INVALID_EVENT');
  initialize(storage);
  const result = storage.transactionSync(() => {
    const previous = storage.sql.exec('SELECT seq, kind, payload FROM events WHERE command_id = ?', event.commandId).toArray()[0];
    if (previous) {
      if (previous.kind !== event.kind || previous.payload !== payload) throw new AccountError('COMMAND_CONFLICT', 409);
      return {seq: previous.seq, duplicate: true};
    }
    const row = storage.sql.exec('INSERT INTO events (command_id, at, kind, payload) VALUES (?, ?, ?, ?) RETURNING seq',
      event.commandId, event.at, event.kind, payload).one();
    return {seq: row.seq, duplicate: false};
  });
  await storage.sync();
  return result;
}
export async function readEvents(storage, afterSeq = 0, limit = 50) {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new AccountError('INVALID_CURSOR');
  pageLimit(limit); initialize(storage);
  return storage.sql.exec('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?', afterSeq, limit).toArray()
    .map(r => ({seq: r.seq, commandId: r.command_id, at: r.at, kind: r.kind, payload: JSON.parse(r.payload)}));
}
