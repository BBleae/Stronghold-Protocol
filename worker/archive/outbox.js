import { archiveOf } from './routes.js';
import { accountOf, directoryOf, hash } from '../accounts/auth.js';
import { encodeReplayChunks } from '../../shared/replay-codec.js';
export async function prepareArchive(entry) {
  if (entry.encodedReplay) return entry.encodedReplay;
  const source = JSON.stringify(entry.replay),
    rulesVersion = entry.replay.rulesVersion;
  // Outboxes written before compression retain their original immutable chunk boundaries, including partial uploads.
  const encoded = entry.archiveEncoding === 2 ? await encodeReplayChunks(source) : { schemaVersion: 1, chunks: [] };
  if (encoded.schemaVersion === 1)
    for (let offset = 0; offset < source.length; offset += 16000)
      encoded.chunks.push({ text: source.slice(offset, offset + 16000) });
  const chunks = [];
  for (const [index, part] of encoded.chunks.entries()) chunks.push({ index, ...part, hash: await hash(part.text) });
  const manifest = {
    schemaVersion: encoded.schemaVersion,
    ...(encoded.schemaVersion === 2 ? { codec: encoded.codec, decodedBytes: encoded.decodedBytes } : {}),
    rulesVersion,
    dataVersion: rulesVersion,
    chunks: chunks.map(({ text, ...meta }) => meta),
  };
  return { manifest, chunks };
}
export async function publishArchive(env, entry) {
  const archive = archiveOf(env, entry.facts.matchId),
    encoded = await prepareArchive(entry);
  for (const chunk of encoded.chunks) await archive.appendChunk({ index: chunk.index, text: chunk.text });
  const facts = { ...entry.facts, personal: entry.personal, manifest: encoded.manifest };
  await archive.finalize(facts);
  await directoryOf(env).registerArchive(facts.matchId);
  for (const fact of entry.personal) await accountOf(env, fact.accountId).applyMatch(fact);
}
