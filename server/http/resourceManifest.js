// server/http/resourceManifest.js — FORK: /resource-manifest.json on the Node server (docs/design/fork.md §F10). The
// resource packs (public/js/resources: download, import, export) are the one way to keep the art locally on both
// deployments; the Workers build writes this manifest with tools/resource-pack.mjs, the Node server answers it from its
// asset index (assetIndex.js keeps each file's whole SHA-256): every resource file under public/assets and public/fonts,
// the same URLs, types and version as the pack tool would write for this tree. A file above the pack's size limit is
// left out (it still loads on demand). Rebuilt when the index changes; null without an index (SP_ASSET_INDEX=0: the
// page then plays on demand).

import { createHash } from 'node:crypto';
import { MAX_FILE_BYTES, resourceType, validateManifest } from '../../shared/resources.js';

export const RESOURCE_MANIFEST_URL = '/resource-manifest.json';

/**
 * @param {ReturnType<typeof import('./assetIndex.js').createAssetIndex> | null} assetIndex
 * @returns {{ get(): Promise<{ body: Buffer, hash: string } | null> }}
 */
export function createResourceManifest(assetIndex) {
  let cached = null; // { generation, view }
  return {
    async get() {
      if (!assetIndex) return null;
      await assetIndex.whenReady();
      if (cached && cached.generation === assetIndex.generation) return cached.view;
      const generation = assetIndex.generation;
      const files = [];
      for (const f of assetIndex.files()) {
        const url = '/' + f.rel.split('/').map(encodeURIComponent).join('/');
        const type = resourceType(url);
        if (!type || f.size > MAX_FILE_BYTES) continue;
        files.push({ url, size: f.size, sha256: f.sha256, type });
      }
      files.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
      const version = createHash('sha256').update(JSON.stringify(files)).digest('hex');
      const manifest = validateManifest({ format: 1, version, files, totalBytes: files.reduce((sum, file) => sum + file.size, 0) });
      cached = { generation, view: { body: Buffer.from(JSON.stringify(manifest)), hash: version.slice(0, 16) } };
      return cached.view;
    },
  };
}
