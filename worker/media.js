// The extension-less audio alias (shared/media.js) on Workers: /media/bgm/act1 → the static asset
// /assets/audio/bgm/act1.mp3, like server/index.js serveMedia. The game and the resource download ask for audio this
// way because download managers (IDM, 迅雷) hijack fetches of URLs that end in a media extension (public/js/media.js).
import { MEDIA_PREFIX, AUDIO_EXTS } from '../shared/media.js';

const notFound = () => new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

/** GET / HEAD /media/<path>: the first audio file of <path> among the extensions (an explicit one is tried first). */
export async function serveMedia(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('GET only', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const url = new URL(request.url);
  const rest = url.pathname.slice(MEDIA_PREFIX.length);
  let segments;
  try { segments = decodeURIComponent(rest).split('/'); } catch { return notFound(); }
  // Dot segments, dotfiles and "x..mp3" address something else, and the client never asks for them.
  if (!env.ASSETS || segments.some((s) => !s || s.startsWith('.') || s.endsWith('.') || /[\\\x00-\x1f]/.test(s))) return notFound();
  const last = segments[segments.length - 1].toLowerCase();
  const given = AUDIO_EXTS.find((ext) => last.endsWith(ext) && last.length > ext.length);
  const stem = given ? rest.slice(0, -given.length) : rest;
  for (const ext of given ? [given, ...AUDIO_EXTS.filter((e) => e !== given)] : AUDIO_EXTS) {
    // Range and conditional headers go along: the static asset answers them.
    const response = await env.ASSETS.fetch(new Request(`${url.origin}/assets/audio/${stem}${ext}`, { method: request.method, headers: request.headers }));
    if (response.status !== 404) return response;
  }
  return notFound();
}
