export const account={enabled:false,user:null,activeSeat:null};
const ERRORS={LOGIN_REQUIRED:'请先使用 GitHub 登录',AUTH_UNAVAILABLE:'GitHub 登录尚未配置',ALREADY_SEATED:'你已有一个房间，请先继续对局或离开',
  APPLICATION_PENDING:'已有一个加入申请，请先取消或等待处理',APPLICATION_EXPIRED:'申请已过期，请重新申请',ROOM_STARTED:'对局已开始，不能中途加入',
  ROOM_FULL:'大厅已满',NOT_HOST:'只有房主可以处理申请',REPLAY_INCOMPLETE:'回放记录不完整，暂时无法播放',HISTORY_UNAVAILABLE:'对局记录暂时不可用，请重试'};
export async function accountRequest(path,body,fetchFn=globalThis.fetch) {
  const response=await fetchFn(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',
    headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  if(response.status===204) return null;
  const result=await response.json();
  if(!response.ok) {const e=new Error(ERRORS[result.error] || result.error || '请求失败，请重试');e.code=result.error;throw e;}
  return result;
}
export async function loadAccount(fetchFn=globalThis.fetch) {
  const result=await accountRequest('/api/me',undefined,fetchFn);
  Object.assign(account,{enabled:!!(result.capabilities?.accountSystem || result.capabilities?.accounts),
    loginReady:!!result.capabilities?.accounts,user:result.user,activeSeat:result.activeSeat,application:result.application});
  return result;
}
