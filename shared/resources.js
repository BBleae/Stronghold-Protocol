// shared/resources.js — the resource manifest's rules (FORK: the resource packs, public/js/resources): which files are
// resources, and the check the page, the packs and both servers trust. Built by tools/resource-pack.mjs (the Workers
// deployment and the packs) and server/http/resourceManifest.js (the Node server, from its asset index).

// The Workers Static Assets file limit; the import also holds one whole file in memory (public/js/resources/zip.js).
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Content-Type per resource file extension; other files under public/assets and public/fonts are not resources. */
export const RESOURCE_TYPES = Object.freeze({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', css: 'text/css; charset=utf-8',
  atlas: 'text/plain; charset=utf-8', obj: 'text/plain; charset=utf-8', json: 'application/json', skel: 'application/octet-stream',
  // the official battlefield scenes of upstream 0.2.5 (tools/local-extract/scenes.py: public/assets/local/scene/<stage>/scene.bin)
  bin: 'application/octet-stream',
});

export function resourceType(url) {
  return RESOURCE_TYPES[url.split('.').pop().toLowerCase()];
}

export function validateResourceUrl(url) {
  if (typeof url !== 'string' || !/^\/(assets|fonts)\//.test(url) || /[?#\\\x00-\x1f]/.test(url)) throw new Error(`Invalid resource path: ${url}`);
  let decoded;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    throw new Error(`Invalid resource path encoding: ${url}`);
  }
  const segments = decoded.split('/').slice(1);
  if (/[?#\\\x00-\x1f]/.test(decoded) || segments.some(part => !part || part === '.' || part === '..') || !resourceType(decoded)) {
    throw new Error(`Invalid resource path or type: ${url}`);
  }
}

/**
 * Check a manifest: resource paths only (no traversal, no programs), unique URLs, sizes within the static asset limit,
 * SHA-256 hashes, Content-Types matching the extensions, and the total. The page and the pack trust what passes.
 */
export function validateManifest(manifest) {
  if (manifest?.format !== 1 || !/^[a-f0-9]{64}$/.test(manifest.version) || !Array.isArray(manifest.files)) throw new Error('Invalid resource manifest');
  const urls = new Set();
  let total = 0;
  for (const file of manifest.files) {
    validateResourceUrl(file.url);
    if (urls.has(file.url)) throw new Error(`Duplicate resource URL: ${file.url}`);
    urls.add(file.url);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES) throw new Error(`Invalid resource size: ${file.url}`);
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`Invalid resource hash: ${file.url}`);
    if (file.type !== resourceType(decodeURIComponent(file.url))) throw new Error(`Invalid resource type: ${file.url}`);
    total += file.size;
  }
  if (manifest.totalBytes !== total) throw new Error('Invalid resource manifest total size');
  return manifest;
}
