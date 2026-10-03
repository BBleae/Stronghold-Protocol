import { authenticate, accountOf, json } from '../accounts/auth.js';
export const archiveOf=(env,id)=>env.MATCH_ARCHIVES.get(env.MATCH_ARCHIVES.idFromName(id));
export async function handleHistoryRoutes(request,env) {
  const u=new URL(request.url), own=['/api/me/matches','/api/me/stats'].includes(u.pathname);
  const match=/^\/api\/matches\/([a-zA-Z0-9_.:-]{1,128})(?:\/replay\/(\d+))?$/.exec(u.pathname);
  if(!own && !match) return null;
  if(request.method!=='GET') return json({error:'METHOD'},405);
  const session=await authenticate(request,env);
  if(!session || !env.ACCOUNTS || !env.MATCH_ARCHIVES) return json({error:'LOGIN_REQUIRED'},401);
  try {
    if(own) {
      const filters={mode:u.searchParams.get('mode')||'',difficulty:u.searchParams.get('difficulty')||''};
      return json(u.pathname.endsWith('/stats') ? await accountOf(env,session.accountId).getStats(filters)
        : await accountOf(env,session.accountId).listMatches({...filters,cursor:u.searchParams.get('cursor')||'',status:u.searchParams.get('status')||'',limit:Number(u.searchParams.get('limit')||20)}));
    }
    const archive=archiveOf(env,match[1]);
    return json(match[2]!==undefined ? await archive.readChunk(session.accountId,Number(match[2])) : await archive.read(session.accountId));
  } catch(e) {return json({error:e.code || 'HISTORY_UNAVAILABLE'},e.status || 503);}
}
