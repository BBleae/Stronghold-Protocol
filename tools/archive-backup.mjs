// Explicit local export destination; credentials are read only from the environment, never printed or saved.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export async function runBackup({mode,origin,directory,apply=false,fetchFn=fetch,token}) {
  if(!['export','import'].includes(mode) || !directory)throw new Error('Use export|import --origin URL --dir DIRECTORY [--apply]');
  const base=new URL(origin);if(base.protocol!=='https:' && !['localhost','127.0.0.1'].includes(base.hostname))throw new Error('HTTPS required');
  if(!token || token.length<32)throw new Error('Set SP_ARCHIVE_EXPORT_TOKEN or SP_ARCHIVE_IMPORT_TOKEN (at least 32 characters)');
  const request=async(endpoint,body)=>{
    const response=await fetchFn(new URL('/api/admin/backup/'+endpoint,base),{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error'});
    const result=await response.json();if(!response.ok)throw new Error(result.error || 'BACKUP_FAILED');return result;
  };
  const dir=path.resolve(directory);
  if(mode==='export') {
    await fs.mkdir(dir,{recursive:true});
    const catalog={formatVersion:1,profiles:[],archives:[],exportedAt:new Date().toISOString()};
    for(const kind of ['profiles','archives']) {
      let cursor='';do{const page=await request('catalog?kind='+kind+'&cursor='+encodeURIComponent(cursor));catalog[kind].push(...page.items);cursor=page.nextCursor;}while(cursor);
    }
    for(const [index,id] of catalog.archives.entries()) {
      const backup=await request('archive?id='+encodeURIComponent(id));
      await fs.writeFile(path.join(dir,index+'.json'),JSON.stringify(backup)+'\n',{flag:'wx'});
    }
    await fs.writeFile(path.join(dir,'catalog.json'),JSON.stringify(catalog,null,2)+'\n',{flag:'wx'});
    return {profiles:catalog.profiles.length,archives:catalog.archives.length,directory:dir};
  }
  const catalog=JSON.parse(await fs.readFile(path.join(dir,'catalog.json'),'utf8'));
  if(catalog.formatVersion!==1 || !Array.isArray(catalog.profiles) || !Array.isArray(catalog.archives))throw new Error('INVALID_CATALOG');
  // Preflight every object before making the first write. Imports are idempotent, so interrupted runs can restart.
  for(const profile of catalog.profiles)await request('profile',{profile,dryRun:true});
  const backups=[];
  for(const [index,id] of catalog.archives.entries()) {
    const backup=JSON.parse(await fs.readFile(path.join(dir,index+'.json'),'utf8'));
    if(backup.facts?.matchId!==id)throw new Error('INVALID_CATALOG');
    await request('archive',{backup,dryRun:true});backups.push(backup);
  }
  if(apply) {
    for(const profile of catalog.profiles)await request('profile',{profile,dryRun:false});
    for(const backup of backups)await request('archive',{backup,dryRun:false});
  }
  return {dryRun:!apply,written:apply?backups.length:0,profiles:catalog.profiles.length,archives:backups.length};
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=process.argv.slice(2),value=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
  try{console.log(await runBackup({mode:args[0],origin:value('--origin'),directory:value('--dir'),apply:args.includes('--apply'),
    token:process.env[args[0]==='export'?'SP_ARCHIVE_EXPORT_TOKEN':'SP_ARCHIVE_IMPORT_TOKEN']}));}
  catch(e){console.error(e.message);process.exitCode=1;}
}
