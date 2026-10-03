import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync,gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
/** Source-addressed engines are retained between builds, with committed hashes detecting missing/changed versions. */
export async function buildReplayVersions({root=ROOT,bundle}={}) {
  bundle ||= (await import('./build-worker.mjs')).bundleWorker;
  const manifestPath=path.join(root,'replay-versions.json');
  let manifest={formatVersion:1,entries:[]};
  try{manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const entry of manifest.entries) {
    const archive=JSON.parse(gunzipSync(await fs.readFile(path.join(root,'replay-versions',entry.id+'.json.gz'))));
    for(const name of ['engine.js','recovery.mjs']) {
      const file=path.join(root,'.replay-engines',entry.id,name);
      if(typeof archive[name]!=='string')throw new Error('Missing retained replay/recovery version: '+file);
      const bytes=Buffer.from(archive[name]);
      if(digest(bytes)!==entry.hashes[name])throw new Error('Changed immutable version: '+file);
      await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);
    }
  }
  const files=[];
  async function walk(dir) {
    for(const item of (await fs.readdir(path.join(root,dir),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const file=dir+'/'+item.name;
      if(item.isDirectory())await walk(file);else if(/\.(js|json)$/.test(file))files.push(file);
    }
  }
  for(const dir of ['server','shared','data'])await walk(dir);
  files.push('worker/replay-engine.js','worker/recovery-engine.js','worker/data-loader.js','worker/sim-data-loader.js','tools/build-worker.mjs','tools/build-replay.mjs');
  const hash=createHash('sha256');
  // Git checkouts can normalize CRLF; identical source must keep the same version across operating systems.
  for(const file of files.sort()){hash.update(file);hash.update((await fs.readFile(path.join(root,file),'utf8')).replace(/\r\n/g,'\n'));}
  const current=hash.digest('hex').slice(0,20);
  if(!manifest.entries.some(v=>v.id===current)) {
    const dir=path.join(root,'.replay-engines',current);await fs.mkdir(dir,{recursive:true});
    const hashes={};
    for(const [name,entry] of [['engine.js','worker/replay-engine.js'],['recovery.mjs','worker/recovery-engine.js']]) {
      await bundle({root,outfile:path.join(dir,name),entry,rulesVersion:current});
      hashes[name]=digest(await fs.readFile(path.join(dir,name)));
    }
    manifest.entries.push({id:current,hashes});
    const archive={};for(const name of Object.keys(hashes))archive[name]=await fs.readFile(path.join(dir,name),'utf8');
    await fs.mkdir(path.join(root,'replay-versions'),{recursive:true});
    await fs.writeFile(path.join(root,'replay-versions',current+'.json.gz'),gzipSync(JSON.stringify(archive),{level:9}));
  }
  await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  return {current,entries:manifest.entries};
}
