// Visible DOM only. Never return draft text, file names, chat text or account data.
// The reload guard and the reload itself execute in this same page evaluation.
export function chatRefreshDOM({action='inspect',expectedTimeOrigin,expectedHref}={}) {
 const fail=(error,code='GREETING_TARGET_UNAVAILABLE',reason='UNSAFE_STATE')=>({ok:false,error,code,notSent:true,readiness:'unavailable',reason});
 let page;try{page=new URL(location.href);}catch{return fail('消息页地址不可核对，未刷新');}
 if(page.protocol!=='https:'||!['www.zhipin.com','zhipin.com'].includes(page.hostname)||page.username||page.password||page.port)
  return fail('当前不是已连接的 BOSS 消息页，未刷新');
 if(/^\/(?:web\/passport\/(?:[^/]+\/)?|web\/|)(?:security|verify|captcha)(?:[/.]|$)/i.test(page.pathname))
  return fail('BOSS 要求安全验证，请手动完成后继续','VERIFICATION_REQUIRED');
 if(/^\/(?:web\/)?(?:passport|login)(?:[/.]|$)/i.test(page.pathname))
  return fail('BOSS 要求登录，请登录后继续','AUTH_REQUIRED');
 if(!/^\/web\/geek\/chat\/?$/.test(page.pathname))return fail('所选标签页已离开消息页，未刷新');
 if(!['inspect','reload'].includes(action))return fail('不支持的消息页刷新动作');
 const visible=element=>{
  if(!element)return false;
  const rect=element.getBoundingClientRect();if(!(rect.width>0&&rect.height>0))return false;
  for(let node=element;node;node=node.parentElement){
   if(node.hidden||node.getAttribute('aria-hidden')==='true')return false;
   const style=typeof getComputedStyle==='function'?getComputedStyle(node):{};
   if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.opacity==='0')return false;
  }
  return true;
 };
 const all=(root,selector)=>[...root.querySelectorAll(selector)].filter(visible);
 const messages='.chat-record,.chat-message-list,.message-list,.message-item,.chat-item,.message-text,.text-content';
 const chrome=element=>!element.closest(messages)&&!element.closest('[contenteditable],textarea,input,.resume-content');
 if(all(document,'.verify-dialog,.captcha-dialog,.geetest_panel,.geetest_panel_box').some(chrome))
  return fail('BOSS 要求安全验证，请手动完成后继续','VERIFICATION_REQUIRED');
 if(all(document,'.login-dialog,.login-page,.login-wrap').some(chrome))return fail('BOSS 要求登录，请登录后继续','AUTH_REQUIRED');
 const dialogs=all(document,'[role="dialog"],[aria-modal="true"],.dialog-wrap,.dialog-container,.dialog-content,.boss-dialog,.boss-dialog__wrapper,.el-dialog').filter(chrome);
 const titles=dialogs.flatMap(dialog=>all(dialog,'.dialog-title,.title,h1,h2,h3,[role="heading"]')).filter(chrome)
  .map(element=>String(element.innerText||'').trim().replace(/\s+/g,'').replace(/[。！!：:]+$/,''));
 if(titles.some(title=>/^(?:安全验证|请完成(?:安全|人机)?验证|请完成安全检查|拖动滑块(?:完成验证)?|滑动验证|点击验证|人机验证)$/.test(title)))
  return fail('BOSS 要求安全验证，请手动完成后继续','VERIFICATION_REQUIRED');
 if(titles.some(title=>/^(?:请先登录|扫码登录|账号登录|密码登录|验证码登录|登录已失效|登录已过期|登录后查看)$/.test(title)))
  return fail('BOSS 要求登录，请登录后继续','AUTH_REQUIRED');
 if(titles.some(title=>/^(?:(?:访问|操作|请求)过于频繁(?:[，,]请稍后(?:再试|重试))?|(?:今日)?(?:沟通|打招呼)(?:次数)?已(?:达|达到)上限)$/.test(title)))
  return fail('BOSS 提示访问频繁或沟通次数上限，请稍后继续','RATE_LIMITED');
 if(dialogs.length)return fail('消息页有未关闭的弹窗，已保留当前页面，未刷新');
 const inputs=all(document,'#chat-input[contenteditable]'),headers=all(document,'.top-info-content'),lists=all(document,'.user-list-content');
 if(inputs.length>1||headers.length>1||lists.length>1)return fail('消息页编辑区或列表不唯一，未刷新','GREETING_TARGET_UNAVAILABLE','STRUCTURE_AMBIGUOUS');
 const input=inputs[0];
 const otherEditors=all(document,'[contenteditable],textarea').filter(element=>element!==input&&!input?.contains(element)&&
  element.getAttribute('contenteditable')!=='false'&&!element.closest(messages));
 if(otherEditors.length)return fail('消息页存在其他编辑区，已保留当前草稿，未刷新');
 if(input){
  if(String(input.textContent||'').trim())return fail('消息输入框已有未发送草稿，已保留原稿，未刷新');
  // Empty formatting nodes are safe; an image, file chip or other embedded
  // content can be a pending attachment even when textContent is empty.
  if([...input.querySelectorAll('*')].some(element=>!['DIV','P','SPAN','BR'].includes(element.tagName)||element.getAttribute('contenteditable')==='false'))
   return fail('消息输入框含附件或嵌入内容，已保留原稿，未刷新');
 }
 const attachments=all(document,'.attachment-card,.file-card,.resume-card,[data-type="attachment"],[data-type="file"],[data-type="resume"],.upload-preview,.attachment-preview,.file-preview')
  .filter(element=>!element.closest(messages));
 const pendingFile=[...document.querySelectorAll('input[type="file"]')].some(element=>!element.closest(messages)&&(element.files?.length>0||String(element.value||'').trim()));
 if(attachments.length||pendingFile)return fail('消息页有未发送附件，已保留原稿，未刷新');
 const list=lists[0],rows=list?all(list,'li[role="listitem"]'):[];
 const marked=element=>element.getAttribute('aria-selected')==='true'||['selected','active','is-active'].some(name=>element.classList.contains(name));
 const selected=rows.filter(row=>marked(row)||all(row,'.friend-content').some(marked));
 if(selected.length>1)return fail('消息页选中的会话不唯一，未刷新','GREETING_TARGET_UNAVAILABLE','STRUCTURE_AMBIGUOUS');
 const emptyRight=!headers.length&&!inputs.length&&!selected.length;
 const emptyComposer=headers.length===1&&inputs.length===1&&input.getAttribute('contenteditable')!=='false'&&selected.length<=1;
 const documentLoading=document.readyState==='loading'||document.readyState==='interactive';
 const listLoading=!!list&&(list.getAttribute('aria-busy')==='true'||list.parentElement?.getAttribute('aria-busy')==='true'||
  all(list,'.loading,.list-loading,[aria-busy="true"]').length>0);
 const timeOrigin=typeof performance==='undefined'?NaN:performance.timeOrigin;
 if(!Number.isFinite(timeOrigin)||timeOrigin<=0)return fail('无法核对消息页文档代次，未刷新');
 const safeToRefresh=lists.length===1&&document.readyState==='complete'&&!listLoading&&(emptyRight||emptyComposer);
 // Only known loading signals or a partially mounted conversation in a
 // unique list may wait. Unknown layouts and disabled composers are unsafe.
 const mounting=lists.length===1&&(!input||input.getAttribute('contenteditable')!=='false')&&
  !emptyRight&&!emptyComposer&&(!headers.length||!inputs.length);
 const reason=safeToRefresh?'READY':input?.getAttribute('contenteditable')==='false'?'COMPOSER_UNAVAILABLE':
  documentLoading?'DOCUMENT_LOADING':listLoading?'LIST_LOADING':mounting?'CONVERSATION_MOUNTING':
  !lists.length?'LIST_UNAVAILABLE':'STRUCTURE_UNAVAILABLE';
 const readiness=safeToRefresh?'ready':['DOCUMENT_LOADING','LIST_LOADING','CONVERSATION_MOUNTING'].includes(reason)?'loading':'unavailable';
 const result={ok:true,timeOrigin,href:page.origin+page.pathname,readyState:document.readyState,safeToRefresh,ready:safeToRefresh&&rows.length>0,readiness,reason};
 if(action==='inspect')return result;
 if(!safeToRefresh)return fail('消息页尚未完整加载或无法确认编辑区为空，未刷新');
 if(expectedTimeOrigin!==timeOrigin||expectedHref!==result.href)return fail('消息页在刷新前发生变化，未刷新');
 location.reload();return {...result,reloadRequested:true};
}

const failure=message=>Object.assign(Error(message),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
const transient=error=>error?.code==='CDP_ERROR'&&/Execution context was destroyed|Cannot find context with specified id|Cannot find context with id|Inspected target navigated or closed/i.test(error.message);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function pinned(browser,{targetId=browser.chatTargetId,generation=browser.connection?.generation??browser.connectionGeneration??0,guard}={}){
 const check=()=>{
  if(guard?.()===false)throw Object.assign(Error('操作已停止'),{code:'CANCELLED',notSent:true});
  if(!targetId||generation!==(browser.connection?.generation??browser.connectionGeneration??0)||browser.chatTargetId!==targetId||browser.activeTargetId!==targetId)
   throw failure('消息标签页或连接代次已变化，未刷新');
 };
 const target=async()=>{
  check();const targets=await browser.targets();check();const current=targets.find(item=>item.id===targetId);
  let url;try{url=new URL(current?.url);}catch{}
  if(!current||current.type!=='page'||!url||url.protocol!=='https:'||!['www.zhipin.com','zhipin.com'].includes(url.hostname)||url.username||url.password||url.port)
   throw failure('已固定的消息页已关闭或离开 BOSS，未刷新');
  if(/^\/(?:web\/passport\/(?:[^/]+\/)?|web\/|)(?:security|verify|captcha)(?:[/.]|$)/i.test(url.pathname))
   throw Object.assign(Error('BOSS 要求安全验证，请手动完成后继续'),{code:'VERIFICATION_REQUIRED',notSent:true});
  if(/^\/(?:web\/)?(?:passport|login)(?:[/.]|$)/i.test(url.pathname))throw Object.assign(Error('BOSS 要求登录，请登录后继续'),{code:'AUTH_REQUIRED',notSent:true});
  if(!/^\/web\/geek\/chat\/?$/.test(url.pathname))throw failure('已固定的标签页离开消息页，未刷新');
  return current;
 };
 const accept=result=>{
  if(!result?.ok||result.error)throw Object.assign(Error(result?.error||'消息页没有返回可靠刷新状态'),{code:result?.code||'GREETING_TARGET_UNAVAILABLE',notSent:true});
  return result;
 };
 const inspect=async()=>{
  const current=await target(),result=await browser.evaluateOn(current,chatRefreshDOM,{action:'inspect'});
  await target();return accept(result);
 };
 return {targetId,generation,check,target,accept,inspect};
}

export async function assertGreetingChatIdle(browser,options={}){
 try{
  const pin=pinned(browser,options),now=options.now??Date.now,wait=options.wait??pause;
  const timeoutValue=Number(options.timeoutMs??8000),pollValue=Number(options.pollMs??200);
  const timeoutMs=Math.min(15000,Math.max(0,Number.isFinite(timeoutValue)?timeoutValue:8000));
  const pollMs=Math.min(1000,Math.max(1,Number.isFinite(pollValue)?pollValue:200));
  const deadline=now()+timeoutMs,maxPolls=Math.ceil(timeoutMs/pollMs);
  for(let attempt=0;;attempt++){
   const state=await pin.inspect();
   if(state.safeToRefresh)return {idle:true,targetId:pin.targetId,generation:pin.generation};
   const loading=state.readiness==='loading'&&['DOCUMENT_LOADING','LIST_LOADING','CONVERSATION_MOUNTING'].includes(state.reason);
   if(!loading)throw Object.assign(failure('消息页尚未完整加载或无法确认编辑区为空，未选择其他 HR'),{readiness:state.readiness,reason:state.reason});
   const remaining=deadline-now();
   if(remaining<=0||attempt>=maxPolls)
    throw Object.assign(failure('消息页加载等待超时，仍无法确认编辑区为空，未选择其他 HR'),{readiness:'loading',reason:state.reason});
   await wait(Math.min(pollMs,remaining));pin.check();
  }
 }catch(error){error.notSent=true;throw error;}
}

export async function refreshGreetingChat(browser,options={}){
 try{
  if(options.lookupFailed!==true)throw failure('仅允许在目标会话查找失败且尚未填字或发送时刷新');
  const pin=pinned(browser,options),before=await pin.inspect();
  if(!before.safeToRefresh)throw failure('消息页尚未完整加载或无法确认编辑区为空，未刷新');
  const current=await pin.target();let result,contextLost=false;
  // Exactly one dispatch. A destroyed context can mean reload took effect;
  // observe the new document instead of ever dispatching this command again.
  try{result=await browser.evaluateOn(current,chatRefreshDOM,{action:'reload',expectedTimeOrigin:before.timeOrigin,expectedHref:before.href});}
  catch(error){if(!transient(error))throw error;contextLost=true;}
  await pin.target();
  if(!contextLost&&!pin.accept(result).reloadRequested)throw failure('消息页未确认刷新，未继续查找');
  const timeoutMs=Math.min(15000,Math.max(0,Number(options.timeoutMs??8000)||0)),pollMs=Math.min(1000,Math.max(1,Number(options.pollMs??200)||1));
  const deadline=Date.now()+timeoutMs;
  do{
   pin.check();let state;
   try{state=await pin.inspect();}catch(error){if(!transient(error))throw error;}
   if(state&&state.timeOrigin!==before.timeOrigin&&state.ready){
    const list=await browser.waitForConversationList({targetId:pin.targetId,guard:pin.check,timeoutMs:Math.max(0,deadline-Date.now()),pollMs});
    await pin.target();
    if(list?.error)throw Object.assign(Error(list.error),{code:list.code||'GREETING_TARGET_UNAVAILABLE',notSent:true});
    if(!Array.isArray(list?.conversations)||!list.conversations.length||list.loading)throw failure('刷新后的消息列表尚未就绪');
    let after;try{after=await pin.inspect();}catch(error){if(!transient(error))throw error;}
    if(after&&after.timeOrigin!==state.timeOrigin)throw failure('消息页在加载后再次换页，未继续查找');
    if(after?.ready)return {refreshed:true,targetId:pin.targetId,generation:pin.generation};
   }
   if(Date.now()>=deadline)break;
   await pause(Math.min(pollMs,Math.max(1,deadline-Date.now())));
  }while(Date.now()<=deadline);
  throw failure('消息页刷新后尚未完成同步，专属招呼仍为草稿');
 }catch(error){error.notSent=true;throw error;}
}
