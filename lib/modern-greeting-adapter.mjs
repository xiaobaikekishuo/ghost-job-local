import {randomUUID} from 'node:crypto';
import {modernChatDOM} from './modern-chat-dom.mjs';
import {modernJobProofDOM} from './modern-job-proof-dom.mjs';
import {normalizeJobTitle,normalizeHRName,isUsableCompanyName} from './job-detail-quality.mjs';
import {jobUrlKey} from './job-greeting-browser.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const label=value=>String(value||'').trim().replace(/\s+/g,' ');
const problem=(message,code='GREETING_TARGET_UNAVAILABLE')=>Object.assign(Error(message),{code,notSent:true});
const canonical=value=>jobUrlKey(value)?'https://www.zhipin.com'+jobUrlKey(value):'';
const structureCodes=new Set(['MODERN_CHAT_IDENTITY_UNAVAILABLE','MODERN_CHAT_ACTION_UNAVAILABLE']);
const safeContextErrors=new Set(['现代消息页结构不完整或有多个可见会话，未执行操作',
 '当前 HR、公司或岗位名称为空或不唯一，未执行操作','未确认唯一选中的 HR 会话，未执行操作',
 '选中行与当前 HR 或公司不一致，页面可能正在切换','可见列表中存在同名同公司的 HR，无法唯一确认会话',
 '同一消息编号对应不同内容，当前会话回执不可靠']);
const safeProofErrors=new Set(['当前消息页地址不可核对','当前页面不是可核对的 BOSS 消息页','请在 BOSS 消息页核对当前岗位',
 '目标岗位公开链接无效','存在多个可见岗位框架，无法唯一核对当前岗位','岗位框架地址不可核对','岗位框架不是当前 BOSS 同源公开页面',
 '岗位框架地址不是支持的公开岗位入口','此岗位框架需要先提供完整目标岗位链接，不能从标题猜测',
 '岗位框架中的完整岗位编号与目标岗位不一致或不唯一','弹窗包含不可核对的岗位链接','弹窗内有多个可见岗位链接，无法唯一核对',
 '未找到可见弹窗中的公开岗位链接或可核对框架','当前弹窗的岗位链接或所属弹窗证据冲突','当前职位弹窗不是目标岗位，未继续操作']);
function resultOrThrow(result,fallback){
 if(!result||result.error){
  const code=structureCodes.has(result?.code)?'GREETING_TARGET_UNAVAILABLE':result?.code||'GREETING_TARGET_UNAVAILABLE';
  const presence={};
  if(result?.notSent===true&&['GREETING_ALREADY_PRESENT','GREETING_PRESENCE_UNCERTAIN'].includes(code)){
   if(code==='GREETING_ALREADY_PRESENT'&&result.alreadyGreeted===true){
    presence.alreadyGreeted=true;
    if(typeof result.receiptId==='string'&&result.receiptId.trim()&&result.receiptId.length<=512)presence.receiptId=result.receiptId;
   }
   if(code==='GREETING_PRESENCE_UNCERTAIN'&&result.presenceUnknown===true)presence.presenceUnknown=true;
  }
  throw Object.assign(Error(result?.error||fallback),{code},result?.notSent===true?{notSent:true}:{},presence);
 }
 return result;
}

// This is a layout/capability probe only. It does NOT prove the identity of an
// HR or authorize any contact/send action. The adapter below must prove a job URL.
export function modernGreetingCapabilityDOM(){
 const visible=e=>{
  if(!e||e.hidden||e.getAttribute('aria-hidden')==='true')return false;
  const r=e.getBoundingClientRect();if(!r.width||!r.height)return false;
  const s=typeof getComputedStyle==='function'?getComputedStyle(e):{};
  return s.display!=='none'&&s.visibility!=='hidden'&&s.visibility!=='collapse';
 };
 const all=(root,selector)=>[...root.querySelectorAll(selector)].filter(visible);
 const lists=all(document,'.user-list-content');
 if(lists.length!==1)return {available:false,reason:'现代会话列表尚未完整加载'};
 const rows=all(lists[0],'li[role="listitem"]');
 if(!rows.length||!rows.some(row=>all(row,'.friend-content .name-box .name-text').length===1))
  return {available:false,reason:'未识别到现代会话行结构'};
 const headers=all(document,'.top-info-content');
 if(headers.length>1)return {available:false,reason:'存在多个消息头，无法唯一确认页面'};
 if(headers.length===1){
  if(all(document,'.chat-position-content .position-content[ka="geek_chat_job_detail"]').length!==1||
     all(document,'#chat-input[contenteditable]').length!==1||all(document,'button[type="send"].btn-send').length!==1||
     all(document,'.chat-record').length!==1)return {available:false,reason:'当前会话岗位入口或编辑区尚未完整加载'};
 }
 return {available:true,modern:true,requiresJobProof:true};
}

// Selecting a row only opens an existing conversation. Names are a search hint;
// even a uniquely selected row never substitutes for the public job URL proof.
export function chooseModernConversationDOM({contact,company}={}){
 const clean=value=>String(value||'').trim().replace(/\s+/g,' ');
 const visible=e=>{
  if(!e||e.hidden||e.getAttribute('aria-hidden')==='true')return false;
  const r=e.getBoundingClientRect();if(!r.width||!r.height)return false;
  const s=typeof getComputedStyle==='function'?getComputedStyle(e):{};
  return s.display!=='none'&&s.visibility!=='hidden'&&s.visibility!=='collapse';
 };
 const all=(root,selector)=>[...root.querySelectorAll(selector)].filter(visible);
 const fail=error=>({ok:false,error,code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
 if(!clean(contact)||!clean(company))return fail('岗位缺少明确 HR 或公司，未选择会话');
 const lists=all(document,'.user-list-content');if(lists.length!==1)return fail('未找到唯一现代会话列表');
 const rows=all(lists[0],'li[role="listitem"]'),matches=[];
 const diagnostics={rows:rows.length,parsedRows:0,nameMatches:0,companyMatches:0,exactMatches:0};
 for(const row of rows){
  const boxes=all(row,'.name-box');if(boxes.length!==1)continue;
  const box=boxes[0],names=all(box,'.name-text');if(names.length!==1)continue;
  if(clean(names[0].innerText)===clean(contact))diagnostics.nameMatches++;
  let children=[...box.children],index=children.indexOf(names[0]);if(index<0)continue;
  children=children.slice(index+1);index=children.findIndex(e=>e.classList.contains('vline'));
  if(index>=0)children=children.slice(0,index);
  const companies=children.filter(e=>e.tagName==='SPAN'&&visible(e)&&!e.classList.contains('base-title'))
   .map(e=>clean(e.innerText)).filter(Boolean);
  if(companies.length===1){
   diagnostics.parsedRows++;
   if(companies[0]===clean(company))diagnostics.companyMatches++;
   if(clean(names[0].innerText)===clean(contact)&&companies[0]===clean(company))matches.push(row);
  }
 }
 diagnostics.exactMatches=matches.length;
 if(matches.length>1)return {...fail('可见列表有多个同名同公司 HR，未选择会话'),diagnostics};
 if(!matches.length)return {ok:true,found:false,diagnostics};
 const row=matches[0],selected=e=>e.getAttribute('aria-selected')==='true'||['active','selected','is-active'].some(c=>e.classList.contains(c));
 const cards=all(row,'.friend-content');
 if(cards.length!==1)return {...fail('匹配行缺少唯一可见会话卡片，未选择会话'),diagnostics};
 const card=cards[0],selectedUnchanged=selected(row)||selected(card);
 // The virtual-list LI is only a positioning wrapper. BOSS binds selection to
 // its inner friend-content card, so clicking LI may leave the right pane empty.
 if(!selectedUnchanged)card.click();
 return {ok:true,found:true,clicked:!selectedUnchanged,selectedUnchanged,diagnostics};
}

export function createModernGreetingAdapter(browser,options={}){
 const targetId=options.targetId||browser.chatTargetId;
 const generation=browser.connection?.generation??browser.connectionGeneration??0;
 const timeoutMs=Math.min(15000,Math.max(0,Number(options.timeoutMs??8000)));
 const pollMs=Math.min(1000,Math.max(1,Number(options.pollMs??200)));
 const lookupTimeoutMs=Math.min(15000,Math.max(0,Number(options.lookupTimeoutMs??options.timeoutMs??8000)));
 const lookupNow=options.lookupNow||(()=>Date.now()),lookupWait=options.lookupWait||pause;
 const maxAgeMs=Math.min(60000,Math.max(1,Number(options.proofMaxAgeMs??60000)));
 const proofs=new Map();
 const checkActive=()=>{if(options.guard?.()===false)throw problem('操作已停止','CANCELLED');};
 function route(target){
  try{const u=new URL(target?.url);return target.type==='page'&&u.protocol==='https:'&&
   ['www.zhipin.com','zhipin.com'].includes(u.hostname)&&!u.username&&!u.password&&!u.port?u.pathname:'';}catch{return '';}
 }
 async function fixedTarget({receipt=false}={}){
  if(!receipt)checkActive();
  if(!targetId||(browser.connection?.generation??browser.connectionGeneration??0)!==generation||
    browser.chatTargetId!==targetId||browser.activeTargetId!==targetId)
   throw problem('消息标签页或浏览器连接已切换，未继续发送');
  const targets=await browser.targets();
  if(!receipt)checkActive();
  if((browser.connection?.generation??browser.connectionGeneration??0)!==generation||browser.chatTargetId!==targetId||browser.activeTargetId!==targetId)
   throw problem('读取期间消息标签页或浏览器连接已变化');
  const target=targets.find(t=>t.id===targetId),path=route(target);
  if(path==='/web/passport/zp/security.html')throw problem('BOSS 要求安全验证，请完成后继续','VERIFICATION_REQUIRED');
  if(/\/(?:login|passport)(?:\/|$)/.test(path))throw problem('BOSS 登录已失效，请登录后继续','AUTH_REQUIRED');
  if(!/^\/web\/geek\/chat\/?$/.test(path))throw problem('已核对的消息标签页已关闭或离开消息页');
  return target;
 }
 async function evaluate(fn,args,settings={}){
  const target=await fixedTarget(settings);
  const result=await browser.evaluateOn(target,fn,args);
  await fixedTarget(settings);
  return resultOrThrow(result,'消息页读取未返回可靠结果');
 }
 function continuity(expected,current){
  resultOrThrow(current,'当前会话不可读');
  if(['contact','company','jobTitle'].some(k=>!label(current[k])||current[k]!==expected[k]))
   throw problem('当前 HR、公司或岗位已变化，未继续发送');
  if(!Array.isArray(current.anchorIds)||!expected.anchorIds.some(id=>current.anchorIds.includes(id)))
   throw problem('已核对会话的真实消息锚点已失效');
 }
 function registered(proof){
  const entry=proofs.get(proof?.proofId);
  if(!entry||proof.targetId!==targetId||proof.generation!==generation||proof.jobUrl!==entry.jobUrl||
    proof.createdAt!==entry.createdAt||Date.now()-entry.createdAt>maxAgeMs||
    ['contact','company','jobTitle'].some(k=>proof.expected?.[k]!==entry.expected[k])||
    !Array.isArray(proof.expected?.anchorIds)||!proof.expected.anchorIds.length||
    proof.expected.anchorIds.some(id=>typeof id!=='string'||!entry.observed.has(id))||
    proof.expected.requireLatestTail===true&&(proof.expected.anchorIds.length!==1||
      typeof proof.expected.tailSignature!=='string'||!entry.observedTails.has(JSON.stringify([proof.expected.anchorIds[0],proof.expected.tailSignature]))))
   throw problem('岗位会话证明已过期或内容发生变化，请重新核对');
  return entry;
 }
 function rememberTail(entry,context){
  const tail=context.latestTail,last=context.anchorIds?.at(-1);
  if(last&&tail?.atBottom===true&&tail.loading===false&&typeof tail.signature==='string'&&tail.signature)
   entry.observedTails.add(JSON.stringify([last,tail.signature]));
 }
 async function read(proof){
  const entry=registered(proof);
  const current=await evaluate(modernChatDOM,{action:'read'},{receipt:true});
  continuity(proof.expected,current);
  for(const id of current.anchorIds)entry.observed.add(id);
  rememberTail(entry,current);
  return {...current,jobUrl:entry.jobUrl,targetId,generation};
 }
 async function action(proof,action,text){
  const entry=registered(proof);
  if(entry.clicked)throw problem('这条专属招呼已执行发送点击，不会再次点击','GREETING_UNCERTAIN');
  if(!['fill','send'].includes(action))throw problem('不支持的现代招呼动作');
  if(action==='send'&&proof.expected.requireLatestTail!==true)throw problem('发送前尚未确认最新消息边界，未执行发送');
  checkActive();
  const target=await fixedTarget();
  // Do not mark a transport failure after dispatch as notSent. It may have
  // reached the DOM click; the delivery ledger must stay uncertain.
  let result;
  try{result=await browser.evaluateOn(target,modernChatDOM,{action,expected:proof.expected,text});}
  catch(error){if(action==='send')delete error.notSent;throw error;}
  if(result?.ok&&result.clicked){entry.clicked=true;return result;}
  resultOrThrow(result,'网页动作没有返回明确结果');
  if(action!=='send')await fixedTarget();
  return result;
 }
 async function prove(job){
  const contact=label(normalizeHRName(job?.hrName)),company=label(job?.company),jobTitle=label(normalizeJobTitle(job?.title)),jobUrl=canonical(job?.url);
  if(!contact||!isUsableCompanyName(job?.company)||!jobTitle||!jobUrl)throw problem('岗位缺少完整链接、HR、有效公司或岗位名称，请重新读取岗位详情后核对');
  const guard=()=>{checkActive();if(browser.chatTargetId!==targetId||browser.activeTargetId!==targetId)throw problem('消息标签页已切换');};
  await fixedTarget();
  if(typeof browser.focusGreetingChat==='function'){
   const focused=await browser.focusGreetingChat({targetId,generation,guard});
   resultOrThrow(focused,'未确认消息标签页已切到前台，未继续核对');
   if(focused.focused!==true||focused.targetId!==targetId||focused.generation!==generation)
    throw problem('消息页前台切换未确认同一标签页与连接，未继续核对');
   await fixedTarget();
  }
  const lookup={stopReason:'',initialStopReason:'',pages:0,resets:0,refreshAttempts:0,refreshes:0,rows:0,parsedRows:0,nameMatches:0,companyMatches:0,exactMatches:0};
  const reset=async()=>{guard();await browser.resetConversations({targetId,guard});await fixedTarget();lookup.resets++;};
  const locate=async()=>{
   if(typeof browser.assertGreetingChatIdle==='function'){
    guard();const idle=await browser.assertGreetingChatIdle({targetId,generation,guard});await fixedTarget();
    resultOrThrow(idle,'消息页输入状态未确认，未选择 HR 会话');
    if(idle.idle!==true||idle.targetId!==targetId||idle.generation!==generation)
     throw problem('未确认同一消息页没有人工草稿，未选择 HR 会话');
   }
   guard();const selected=await evaluate(chooseModernConversationDOM,{contact,company});lookup.pages++;
   // Counts are viewport maxima, not accumulated names or conversation content.
   for(const key of ['rows','parsedRows','nameMatches','companyMatches','exactMatches']){
    const count=selected.diagnostics?.[key];if(Number.isInteger(count)&&count>=0)lookup[key]=Math.max(lookup[key],count);
   }
   return selected.found===true;
  };
  const search=async()=>{
   if(browser.resetConversations)await reset();
   let found=false,stalls=0,stopReason='';
   for(let page=0;page<30;page++){
    if(await locate()){found=true;break;}
    if(page===29){stopReason='page_limit';break;}
    if(!browser.scrollConversations){stopReason='no_scroll';break;}
    const progress=await browser.scrollConversations({targetId,guard,progress:true});await fixedTarget();
    if(!progress||progress.unavailable||typeof progress!=='object')throw problem('无法可靠滚动定位目标 HR');
    if(progress.complete){stopReason='complete';break;}
    stalls=progress.moved||progress.changed?0:stalls+1;
    if(stalls>=3){stopReason='stalled';break;}
   }
   if(!lookup.refreshes)lookup.initialStopReason=stopReason;else lookup.refreshedStopReason=stopReason;
   if(!found&&browser.resetConversations){
   // Opening chat before contact can leave an old, nonempty list. Keep the
   // initial 30-screen coverage, then allow a bounded synchronization phase
   // only after a complete/stalled pass. New contacts normally arrive at top.
   const synchronize=['complete','stalled'].includes(stopReason);
   const lookupDeadline=lookupNow()+(synchronize?lookupTimeoutMs:0);
   await reset();
   found=await locate();
   for(let poll=0;!found&&lookupNow()<lookupDeadline&&poll<Math.ceil(lookupTimeoutMs/pollMs);poll++){
    await lookupWait(Math.min(pollMs,Math.max(0,lookupDeadline-lookupNow())));guard();
    if(lookupNow()>=lookupDeadline)break;
    found=await locate();
   }
   // Virtual lists can preserve a scroll anchor when a new row is prepended.
   // Re-pin top once after waiting, even when the first top snapshot was stale.
   if(!found&&synchronize&&lookupTimeoutMs>0){await reset();found=await locate();}
    if(!found)lookup.stopReason=synchronize?'sync_timeout':stopReason;
   }
   if(!found)lookup.stopReason||=stopReason||'not_found';
   return found;
  };
  let found=await search();
  if(!found&&typeof browser.refreshGreetingChat==='function'){
   // Only a completed no-match lookup may request this guarded recovery. The
   // browser helper must preserve any human draft and verify a new document.
   // Never refresh after obtaining a proof, editing or attempting to send.
   guard();await fixedTarget();lookup.refreshAttempts++;
   try{
    const refreshed=await browser.refreshGreetingChat({targetId,generation,guard,lookupFailed:true});
    await fixedTarget();
    resultOrThrow(refreshed,'消息页同步刷新未返回明确结果');
    if(refreshed.refreshed!==true||refreshed.targetId!==targetId||refreshed.generation!==generation)
     throw problem('消息页同步刷新未确认同一标签页与连接，专属招呼仍为草稿');
    lookup.refreshes++;proofs.clear();lookup.stopReason='';found=await search();
   }catch(error){error.lookup={...lookup,stopReason:'refresh_failed'};throw error;}
  }
  if(!found){
   lookup.stopReason||=lookup.initialStopReason||'not_found';
   const mismatch=lookup.nameMatches&&!lookup.exactMatches?'存在同名 HR，但公司未精确匹配':
    lookup.companyMatches&&!lookup.nameMatches?'存在目标公司，但 HR 未精确匹配':
    lookup.rows&&!lookup.parsedRows?'会话行身份信息尚未完整':'目标会话尚未出现在可核对列表';
   throw Object.assign(problem('尚未定位到属于该岗位 HR 的会话，专属招呼仍为草稿（'+mismatch+'；已检查 '+lookup.pages+' 屏，回顶 '+lookup.resets+' 次，刷新 '+lookup.refreshes+' 次）'),{lookup});
  }
  const deadline=Date.now()+timeoutMs;let before,contextCheck;
  do{
   try{
    before=await evaluate(modernChatDOM,{action:'read'});
    contextCheck={contactMatches:label(before.contact)===contact,companyMatches:label(before.company)===company,
     jobTitleMatches:label(before.jobTitle)===jobTitle,hasAnchors:Array.isArray(before.anchorIds)&&before.anchorIds.length>0,readError:null};
    if(contextCheck.contactMatches&&contextCheck.companyMatches&&contextCheck.jobTitleMatches&&contextCheck.hasAnchors)break;
    before=null;
   }catch(error){
    if(error.code!=='GREETING_TARGET_UNAVAILABLE')throw error;before=null;
    contextCheck={contactMatches:null,companyMatches:null,jobTitleMatches:null,hasAnchors:null,
     readError:safeContextErrors.has(error.message)?error.message:'会话结构暂不可读，未取得可靠上下文'};
   }
   if(Date.now()>=deadline)break;
   await pause(Math.min(pollMs,deadline-Date.now()));
  }while(Date.now()<=deadline);
  if(!before){
   const flag=value=>value===true?'一致':value===false?'不匹配':'未知';
   const detail=(contextCheck.readError?'读取状态：'+contextCheck.readError+'；':'')+
    'HR='+flag(contextCheck.contactMatches)+'，公司='+flag(contextCheck.companyMatches)+'，岗位='+flag(contextCheck.jobTitleMatches)+
    '，消息锚点='+(contextCheck.hasAnchors===true?'存在':contextCheck.hasAnchors===false?'缺失':'未知');
   throw Object.assign(problem('选中会话的 HR、公司、岗位或消息锚点尚未一致，未发送（'+detail+'）'),{contextCheck,lookup});
  }
  const expected={contact:before.contact,company:before.company,jobTitle:before.jobTitle,anchorIds:[...before.anchorIds]};
  const pageSnapshot=async()=>{
   await fixedTarget();const targets=await browser.targets();await fixedTarget();
   if(!Array.isArray(targets))throw problem('未取得点击前后的标签页列表，无法核对新打开的岗位');
   // Browser.targets exposes allowed BOSS pages. Keep only IDs as the baseline;
   // security query strings from target URLs never enter diagnostics or proofs.
   return targets.filter(target=>target.type==='page');
  };
  const baselineIds=new Set((await pageSnapshot()).map(target=>target.id));
  let opened;
  if(typeof browser.openGreetingJob==='function'){
   guard();await fixedTarget();
   try{opened=await browser.openGreetingJob({targetId,generation,expected,guard});}
   catch(error){
    // Native job opening throws DOM refusals, while the legacy DOM path returns
    // them through resultOrThrow. Normalize only those known, definitely-unsent
    // structure errors at this pre-message boundary; transport/auth stay typed.
    if(error?.notSent===true&&structureCodes.has(error.code))error.code='GREETING_TARGET_UNAVAILABLE';
    throw error;
   }
   await fixedTarget();resultOrThrow(opened,'当前会话职位入口未返回明确点击结果');
  }else opened=await evaluate(modernChatDOM,{action:'openJob',expected});
  if(!opened.ok||!opened.openedJob)throw problem('未确认当前会话职位详情已打开');
  const popupDeadline=Date.now()+timeoutMs;let evidence;
  const proofCheck={attempts:0,readError:null,urlMatches:null,newPageCount:0,openerPresentCount:0,openerMatches:null,newPageUrlMatches:null};
  const newPageEvidence=async()=>{
   const pages=(await pageSnapshot()).filter(target=>!baselineIds.has(target.id));
   proofCheck.newPageCount=pages.length;
   proofCheck.openerPresentCount=pages.filter(target=>typeof target.openerId==='string'&&target.openerId.length>0).length;
   if(!pages.length)return null;
   const refuse=(message,reason)=>{throw Object.assign(problem(message),{proofCheck:{...proofCheck,newPageReason:reason}});};
   if(pages.length!==1)refuse('本次点击后出现多个新 BOSS 标签页，无法唯一核对岗位，专属招呼仍为草稿','multiple_new_pages');
   const page=pages[0];proofCheck.openerMatches=page.openerId===targetId;
   proofCheck.newPageUrlMatches=canonical(page.url)===jobUrl;
   if(typeof page.id!=='string'||!page.id)refuse('新岗位标签页缺少可核对的标识，专属招呼仍为草稿','missing_target_id');
   if(!proofCheck.openerMatches)refuse('新岗位标签页未确认由当前 HR 消息页打开，专属招呼仍为草稿','opener_mismatch');
   if(!proofCheck.newPageUrlMatches)refuse('新打开标签页的完整岗位链接与目标岗位不一致，专属招呼仍为草稿','job_url_mismatch');
   return {ok:true,jobUrl,source:'new-tab',targetId:page.id};
  };
  do{
   proofCheck.attempts++;
   evidence=await newPageEvidence();
   if(evidence){proofCheck.urlMatches=true;break;}
   try{
    evidence=await evaluate(modernJobProofDOM,{expectedJobUrl:jobUrl});
    proofCheck.urlMatches=Boolean(evidence.ok&&canonical(evidence.jobUrl)===jobUrl);
    if(proofCheck.urlMatches)break;
    proofCheck.readError='当前职位弹窗不是目标岗位，未继续操作';evidence=null;
   }catch(error){
    if(error.code!=='GREETING_TARGET_UNAVAILABLE')throw error;evidence=null;proofCheck.urlMatches=null;
    proofCheck.readError=safeProofErrors.has(error.message)?error.message:'岗位弹窗尚未返回可核对的公开链接证据';
   }
   if(Date.now()>=popupDeadline)break;
   await pause(Math.min(pollMs,popupDeadline-Date.now()));
  }while(Date.now()<=popupDeadline);
  if(!evidence)throw Object.assign(problem('职位弹窗或本次新标签页未提供与该岗位完全一致的公开链接，专属招呼已保留（'+proofCheck.readError+'）'),{proofCheck});
  if(evidence.source==='new-tab'){
   // Do not read, navigate or close the newly opened page. Return to the pinned
   // chat only, then verify both its context and the same child page again.
   if(typeof browser.focusGreetingChat!=='function')throw problem('已核对新岗位标签页，但无法安全返回原消息页，未进入发送');
   const focused=await browser.focusGreetingChat({targetId,generation,guard});
   resultOrThrow(focused,'未确认已返回原 HR 消息页');
   if(focused.focused!==true||focused.targetId!==targetId||focused.generation!==generation)
    throw problem('返回消息页未确认同一标签页与连接，未进入发送');
   await fixedTarget();continuity(expected,await evaluate(modernChatDOM,{action:'read'}));
   const confirmed=await newPageEvidence();
   if(!confirmed||confirmed.targetId!==evidence.targetId)throw problem('新岗位标签页在核对期间已关闭或变化，未进入发送');
  }else{
   if(await newPageEvidence())throw problem('职位弹窗核对期间又打开了新岗位标签页，证据存在冲突，未进入发送');
   // Close only the verified popup. Never Escape or a broad close selector.
   continuity(expected,await evaluate(modernChatDOM,{action:'read'}));
   const closed=await evaluate(modernJobProofDOM,{action:'close',expectedJobUrl:jobUrl});
   if(!closed.ok||!closed.closeClicked||canonical(closed.jobUrl)!==jobUrl)throw problem('未确认已核对的职位弹窗关闭，未进入发送');
   const closeDeadline=Date.now()+timeoutMs;let gone=false;
   do{
    const settled=await evaluate(modernJobProofDOM,{action:'closed',expectedJobUrl:jobUrl});
    gone=settled.ok===true&&settled.closed===true&&canonical(settled.jobUrl)===jobUrl;
    if(gone||Date.now()>=closeDeadline)break;
    await pause(Math.min(pollMs,closeDeadline-Date.now()));
   }while(Date.now()<=closeDeadline);
   if(!gone)throw problem('职位弹窗尚未关闭，未进入发送');
  }
  const after=await evaluate(modernChatDOM,{action:'read'});continuity(expected,after);
  const proof={proofId:randomUUID(),targetId,generation,jobUrl,expected,createdAt:Date.now()};
  const entry={...proof,expected:{...expected,anchorIds:[...expected.anchorIds]},observed:new Set([...before.anchorIds,...after.anchorIds]),observedTails:new Set(),clicked:false};
  rememberTail(entry,before);rememberTail(entry,after);proofs.set(proof.proofId,entry);
  return proof;
 }
 return {prove,read,action};
}
