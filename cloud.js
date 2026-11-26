(function(){
 'use strict';
 const {copy,equal,merge}=JournalSyncCore;
 const cfg=window.TRAINING_CLOUD_CONFIG||{};
 const configured=/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(cfg.url||'')&&!!cfg.key;
 const BASE=(cfg.url||'').replace(/\/$/,'');
 const SESSION='form-cloud-session-v1',OWNER='form-cloud-active-user',GUEST='form-journal-v1';
 const keyFor=id=>'form-journal-user-'+id,metaFor=id=>'form-cloud-meta-'+id;
 let auth=null,meta=null,busy=false,needs=false,ready=false,epoch=0,pendingConflicts=null,timer,refreshPromise,status='正在准备云端保存…',retry=0,hydrating=false,lastLocal=null;
 const read=(key,fallback)=>{try{const v=localStorage.getItem(key);return v?JSON.parse(v):fallback}catch{return fallback}};
 function write(key,value){try{localStorage.setItem(key,JSON.stringify(value));return true}catch{status='设备存储不可用，请保持页面打开并导出备份';paint();return false}}
 const uid=()=>auth?.user?.id;
 const validId=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id);
 const isSession=a=>a&&typeof a.access_token==='string'&&typeof a.refresh_token==='string'&&validId(a.user?.id);
 function errorText(e){
  if(e.status===401||e.status===403)return '登录已失效或权限不足，请重新登录；未同步记录仍保留在此设备';
  if(e.status===429)return '请求过于频繁，请稍后重试';
  if(e.code==='42P01'||e.code==='PGRST202'||e.code==='PGRST205')return '云端数据表尚未准备好，请先运行数据库初始化文件';
  if(e.code==='over_email_send_rate_limit')return '登录邮件发送过于频繁，请稍后再试';
  if(e.code==='email_address_not_authorized')return '邮件服务暂不允许这个邮箱，请在 Supabase 配置邮件发送服务';
  if(!navigator.onLine)return '当前离线，记录已留在设备，联网后继续上传';
  if(e.name==='AbortError'||e.name==='TimeoutError'||e instanceof TypeError)return '暂时无法连接云端，记录保留在设备，稍后自动重试';
  return '云端操作未完成，请稍后重试；设备上的记录未删除';
 }
 async function request(path,{method='GET',body,token}={}){
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),18000);
  try{
   const headers={apikey:cfg.key,'Content-Type':'application/json'};if(token)headers.Authorization='Bearer '+token;
   const response=await fetch(BASE+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,cache:'no-store',credentials:'omit'});
   let data=null;try{data=await response.json()}catch{}
   if(!response.ok){const e=new Error('Cloud request failed');e.status=response.status;e.code=data?.error_code||data?.code;throw e}
   return data;
  }finally{clearTimeout(timeout)}
 }
 function saveAuth(a){auth=a;write(SESSION,a)}
 async function accessToken(force=false){
  if(!auth)throw Object.assign(new Error('Login required'),{status:401});
  if(!force&&auth.expires_at>Date.now()/1000+90)return auth.access_token;
  if(refreshPromise)return refreshPromise;
  const prior=auth,guard=epoch;
  refreshPromise=(async()=>{const a=await request('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:{refresh_token:prior.refresh_token}});if(guard!==epoch||uid()!==prior.user.id)throw Error('Account changed');a.user=a.user||prior.user;a.expires_at=a.expires_at||Math.floor(Date.now()/1000)+(a.expires_in||3600);if(!isSession(a))throw Error('Invalid session');saveAuth(a);return a.access_token})();
  try{return await refreshPromise}finally{refreshPromise=null}
 }
 async function authenticated(path,options={}){
  const token=await accessToken();try{return await request(path,{...options,token})}catch(e){if(e.status!==401)throw e;return request(path,{...options,token:await accessToken(true)})}
 }
 function paint(){
  const label=document.querySelector('#cloud-status');if(!label)return;
  label.textContent=status;
  document.querySelector('#cloud-account').textContent=auth?.user?.email||'邮箱登录 · 手机和电脑同步';
  document.querySelector('#cloud-login').hidden=!!auth;
  document.querySelector('#cloud-sync').hidden=!auth;document.querySelector('#cloud-sync').disabled=busy||hydrating||!!pendingConflicts;
  document.querySelector('#cloud-logout').hidden=!auth;document.querySelector('#cloud-logout').disabled=busy||hydrating;
  document.querySelector('#cloud-conflicts').hidden=!pendingConflicts;
  const guest=read(GUEST,null);document.querySelector('#cloud-import-local').hidden=!auth||!guest||!Object.keys(guest.logs||{}).length;
  document.querySelector('#cloud-import-local').disabled=busy||!ready||!!pendingConflicts;
  document.querySelector('#cloud-login').disabled=!configured;
  document.querySelector('#view').inert=!!auth&&(!ready||!!pendingConflicts);
  const badge=document.querySelector('.local-badge b');if(badge)badge.textContent=auth?'● '+status:'● 未登录，仅保存在此设备';
  const hint=document.querySelector('#save-hint');if(hint)hint.textContent=status;
 }
 function persistAccount(){if(uid()&&ready){lastLocal=copy(state);write(keyFor(uid()),state);write(metaFor(uid()),meta)}}
 function applied(doc,persist=true){if(!validateState(doc))throw Error('Invalid journal');state=migrate(copy(doc));loadFailed=false;lastLocal=copy(state);try{if(persist)localStorage.setItem(KEY,JSON.stringify(state));storageOK=true}catch{storageOK=false}render();paint()}
 function setConflict(base,local,remote,result,revision){
  pendingConflicts={base:copy(base),local:copy(local),remote:copy(remote),document:result.document,conflicts:result.conflicts,revision,editSnapshot:copy(state)};
  write('form-cloud-conflict-'+uid(),pendingConflicts);
  status='发现不同设备对同一天的修改，请选择保留哪份';paint();showConflicts();
 }
 function showConflicts(){
  if(!pendingConflicts)return;
  const container=document.querySelector('#conflict-items');container.replaceChildren();
  for(const c of pendingConflicts.conflicts){const label=document.createElement('label');label.className='field';label.append(document.createTextNode(c.key==='profile'?'个人资料与计划设置':c.key+' 的记录'));
   const detail=document.createElement('small');const summary=v=>v===undefined?'已删除':c.key==='profile'?`体重 ${v.weight} kg，开始日期 ${v.start}`:`${v.checked?'已打卡':'未打卡'}；体重 ${v.measures?.weight||'未填'}；备注 ${(v.note||'无').slice(0,90)}`;
   detail.textContent='本机：'+summary(c.local)+' / 云端：'+summary(c.remote);label.append(detail);
   const select=document.createElement('select');select.dataset.conflictKey=c.key;for(const [v,t] of [['','请选择'],['local','保留本机这一天的记录'],['remote','保留云端这一天的记录']]){const o=document.createElement('option');o.value=v;o.textContent=t;select.append(o)}label.append(select);container.append(label);
  }
  const dialog=document.querySelector('#cloud-conflict-dialog');if(!dialog.open)dialog.showModal();
 }
 function schedule(ms=1200){clearTimeout(timer);if(configured&&auth&&ready&&!pendingConflicts)timer=setTimeout(()=>sync(),ms)}
 function changed(){
  if(!auth){status=configured?'尚未登录：本次记录仅保存在此设备':'云端尚未配置：本次记录保存在此设备';paint();return}
  needs=true;status=navigator.onLine?'记录已保存在设备，等待上传…':'离线记录已保存，联网后上传';persistAccount();paint();schedule();
 }
 async function sync(){
  if(busy||!auth||!ready||!configured||pendingConflicts||loadFailed)return;
  if(!navigator.onLine){status='当前离线，记录已留在设备，联网后继续上传';paint();return}
  busy=true;status='正在同步…';paint();const guard=epoch;
  try{
   for(let attempt=0;attempt<3;attempt++){
    const rows=await authenticated('/rest/v1/training_journals?select=document,revision,updated_at&user_id=eq.'+encodeURIComponent(uid()));if(guard!==epoch)return;
    const row=rows?.[0],remote=row?migrate(copy(row.document)):null;
    if(row&&(!validateState(remote)||!Number.isSafeInteger(row.revision)))throw Error('Invalid cloud record');
    const original=copy(state),baseline=meta?.baseline||null;
    let result=remote?merge(baseline,original,remote):{document:original,conflicts:[]};
    if(result.conflicts.length){setConflict(baseline,original,remote,result,row.revision);return}
    const merged=result.document;if(!validateState(merged))throw Error('Invalid merged journal');
    let stored=row;
    if(!remote||!equal(merged,remote)){
     try{const saved=await authenticated('/rest/v1/rpc/save_training_journal',{method:'POST',body:{p_document:merged,p_expected_revision:row?.revision||0}});stored=saved?.[0];if(!stored||!validateState(stored.document))throw Error('Invalid cloud response')}
     catch(e){if(e.status===409)continue;throw e}
    }
    if(guard!==epoch)return;
    const current=copy(state),after=merge(original,current,merged);
    meta={baseline:copy(merged),revision:stored.revision,lastSync:stored.updated_at};
    if(after.conflicts.length){persistAccount();setConflict(original,current,merged,after,stored.revision);return}
    // Preserve edits made while the network request was in flight.
    if(!equal(state,after.document)){applied(after.document)}
    needs=!equal(state,merged);persistAccount();retry=0;
    status=needs?'新修改已保存在设备，继续上传…':'已保存到云端 · '+new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
    if(needs)schedule(500);return;
   }
   status='另一台设备正在更新，稍后自动重试';schedule(3000);
  }catch(e){status=errorText(e);needs=true;if(e.status!==401&&e.status!==403)schedule(Math.min(60000,3000*2**Math.min(retry++,4)))}
  finally{busy=false;paint()}
 }
 async function activate(a){
  epoch++;const guard=epoch;ready=false;hydrating=true;needs=false;pendingConflicts=null;clearTimeout(timer);
  a.expires_at=a.expires_at||Math.floor(Date.now()/1000)+(a.expires_in||3600);
  if(!isSession(a))throw Error('Invalid login');saveAuth(a);
  const accountKey=keyFor(uid()),cached=read(accountKey,null);meta=read(metaFor(uid()),{baseline:null,revision:0});
  KEY=accountKey;localStorage.setItem(OWNER,uid());status='正在读取你的云端记录…';
  try{
   if(cached&&!validateState(cached))throw Error('Invalid local account record');
   applied(cached||defaults(),false);paint();
   if(!cached){
    const rows=await authenticated('/rest/v1/training_journals?select=document,revision,updated_at&user_id=eq.'+encodeURIComponent(uid()));
    if(guard!==epoch)return;
    if(rows?.[0]){if(!validateState(rows[0].document))throw Error('Invalid cloud data');applied(rows[0].document,false);meta={baseline:copy(state),revision:rows[0].revision,lastSync:rows[0].updated_at}}
   }
   ready=true;persistAccount();
   const savedConflict=read('form-cloud-conflict-'+uid(),null);if(savedConflict?.conflicts?.length){pendingConflicts=savedConflict;status='有尚未处理的记录冲突';showConflicts();return}
   status='已登录，正在同步记录…';await sync();
  }catch(e){if(guard===epoch){status=errorText(e);if(!cached)status+='；首次读取成功前暂不允许修改，请点“立即同步”重试'}}
  finally{if(guard===epoch){hydrating=false;paint()}}
 }
 async function sendLink(e){
  e.preventDefault();if(!configured)return;
  const button=document.querySelector('#cloud-send-link'),email=document.querySelector('#cloud-email').value.trim();button.disabled=true;
  try{
   const redirect=location.origin+location.pathname;
   await request('/auth/v1/otp?redirect_to='+encodeURIComponent(redirect),{method:'POST',body:{email,create_user:true}});
   document.querySelector('#cloud-auth-message').textContent='登录邮件已发送。请在这台设备的同一浏览器打开邮件中的登录链接；不要转发链接。若未收到，检查垃圾邮件。';
   document.querySelector('#cloud-verify-form').hidden=false;sessionStorage.setItem('form-cloud-email',email);
  }catch(err){document.querySelector('#cloud-auth-message').textContent=errorText(err)}finally{setTimeout(()=>button.disabled=false,15000)}
 }
 async function verifyCode(e){
  e.preventDefault();const button=document.querySelector('#cloud-verify-code');button.disabled=true;
  try{const email=document.querySelector('#cloud-email').value.trim()||sessionStorage.getItem('form-cloud-email');const a=await request('/auth/v1/verify',{method:'POST',body:{email,token:document.querySelector('#cloud-code').value.trim(),type:'email'}});await activate(a);document.querySelector('#cloud-auth').close()}
  catch(err){document.querySelector('#cloud-auth-message').textContent=errorText(err)}finally{button.disabled=false}
 }
 async function signout(){
  if(busy||hydrating)return;
  const perform=async()=>{const old=auth;epoch++;clearTimeout(timer);persistAccount();auth=null;ready=false;hydrating=false;pendingConflicts=null;needs=false;localStorage.removeItem(SESSION);localStorage.removeItem(OWNER);KEY=GUEST;meta=null;applied(read(GUEST,null)||defaults());status='已退出，未上传记录仍保留在原账号的设备缓存中';paint();if(old)request('/auth/v1/logout?scope=local',{method:'POST',token:old.access_token}).catch(()=>{})};
  if(needs||pendingConflicts)requestConfirm('还有未同步的记录','退出后记录仍保留在此设备的原账号中，下次登录同一邮箱继续同步。建议先导出备份。',perform);else await perform();
 }
 function importGuest(){
  const guest=read(GUEST,null);if(!guest||!validateState(guest)||!ready)return;
  requestConfirm('把本机旧记录加入当前账号？','只导入这台设备尚未登录时保存的记录。同一天已有不同记录时，会让你选择。',()=>{
   const local=migrate(copy(guest)),remote=copy(state);const result=merge(null,local,remote);
   if(result.conflicts.length){setConflict(null,local,remote,result,meta?.revision||0);return}
   applied(result.document);changed();
  });
 }
 function resolveConflicts(){
  if(!pendingConflicts)return;const resolved=copy(pendingConflicts.document);
  for(const c of pendingConflicts.conflicts){const control=[...document.querySelectorAll('[data-conflict-key]')].find(el=>el.dataset.conflictKey===c.key);if(!control?.value){toast('请为每一项选择要保留的记录');return}const value=c[control.value];if(c.key==='profile')resolved.profile=copy(value);else if(value===undefined)delete resolved.logs[c.key];else resolved.logs[c.key]=copy(value)}
  const current=copy(state),during=merge(pendingConflicts.editSnapshot||pendingConflicts.local,current,resolved);
  // The dialog prevents normal editing. Reconcile any edits made by another open tab conservatively.
  if(!equal(current,pendingConflicts.editSnapshot||pendingConflicts.local)&&during.conflicts.length){toast('记录又有新修改，请先导出冲突备份后重试');return}
  meta={...meta,baseline:copy(pendingConflicts.tabOnly?pendingConflicts.cloudBase:pendingConflicts.remote),revision:pendingConflicts.revision};pendingConflicts=null;localStorage.removeItem('form-cloud-conflict-'+uid());document.querySelector('#cloud-conflict-dialog').close();applied(during.document);changed();
 }
 async function start(){
  if(!configured){status='云端服务配置中 · 当前记录仍保存在设备';paint();return}
  const params=new URLSearchParams(location.hash.slice(1));const access=params.get('access_token'),refresh=params.get('refresh_token');
  if(access||params.has('error'))history.replaceState(null,'',location.pathname+location.search);
  try{
   if(params.has('error')){const prior=read(SESSION,null);if(isSession(prior))await activate(prior);else{KEY=GUEST;localStorage.removeItem(OWNER);applied(read(GUEST,null)||defaults())}status='邮件登录链接已失效，请重新发送登录邮件';paint();return}
   if(access&&refresh){const user=await request('/auth/v1/user',{token:access});await activate({access_token:access,refresh_token:refresh,user,expires_at:Math.floor(Date.now()/1000)+Number(params.get('expires_in')||3600)});return}
   const cached=read(SESSION,null);if(isSession(cached)){await activate(cached)}else{KEY=GUEST;localStorage.removeItem(OWNER);applied(read(GUEST,null)||defaults());status='未登录：登录后自动保存到云端';paint()}
  }catch(e){status=errorText(e);paint();}
 }
 window.CloudJournal={changed,paint,sync};
 document.querySelector('#cloud-login').onclick=()=>document.querySelector('#cloud-auth').showModal();
 document.querySelector('#cloud-auth-close').onclick=()=>document.querySelector('#cloud-auth').close();
 document.querySelector('#cloud-send-form').onsubmit=sendLink;document.querySelector('#cloud-verify-form').onsubmit=verifyCode;
 document.querySelector('#cloud-sync').onclick=()=>ready?sync():activate(auth);document.querySelector('#cloud-logout').onclick=signout;document.querySelector('#cloud-import-local').onclick=importGuest;
 document.querySelector('#cloud-conflicts').onclick=showConflicts;
 document.querySelector('#cloud-conflict-close').onclick=()=>document.querySelector('#cloud-conflict-dialog').close();
 document.querySelector('#cloud-conflict-apply').onclick=resolveConflicts;
 document.querySelector('#cloud-conflict-export').onclick=()=>download(JSON.stringify(pendingConflicts,null,2),'训练记录冲突备份-'+today()+'.json');
 window.addEventListener('online',()=>{if(auth){status='网络已恢复，正在同步…';paint();schedule(200)}});
 window.addEventListener('offline',()=>{status=auth?'当前离线，记录留在设备，联网后上传':'当前离线，记录保存在设备';paint()});
 window.addEventListener('focus',()=>{if(auth&&ready)schedule(500)});
 window.addEventListener('storage',e=>{
  if(e.key===SESSION){const updated=read(SESSION,null);if(isSession(updated)&&updated.user.id===uid()){auth=updated}else if(!updated||isSession(updated)){location.reload();return}}
  if(auth&&ready&&e.key===keyFor(uid())&&e.newValue){try{
   const other=JSON.parse(e.newValue);if(!validateState(other)||equal(state,other))return;
   const result=merge(meta?.baseline,state,other);
   if(result.conflicts.length){setConflict(lastLocal,state,other,result,meta?.revision||0);pendingConflicts.tabOnly=true;pendingConflicts.cloudBase=copy(meta?.baseline);write('form-cloud-conflict-'+uid(),pendingConflicts);return}
   applied(result.document,false);needs=true;schedule();
  }catch{}}
 });
 // Block editing during first cloud hydration or an unresolved conflict, including open dialogs.
 for(const event of ['click','input','change','submit'])document.addEventListener(event,e=>{
  if(auth&&(!ready||pendingConflicts)&&!e.target.closest('.cloud-bar,#cloud-auth,#cloud-conflict-dialog')&&e.target.closest('#view,#settings,#import-file,#confirm')){e.preventDefault();e.stopImmediatePropagation();}
 },true);
 setInterval(()=>{if(auth&&ready&&!document.hidden&&!document.activeElement?.matches('input,textarea,select'))schedule(50)},60000);
 start();
})();
