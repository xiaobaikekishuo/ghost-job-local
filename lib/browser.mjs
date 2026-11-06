import {chatDOM} from './chat-dom.mjs';
import {modernChatDOM} from './modern-chat-dom.mjs';
import {browserDiagnosticsDOM} from './browser-diagnostics.mjs';
import {jobDetailDOM} from './job-detail-dom.mjs';
import {isJobDescription,isUsableCompanyName} from './job-detail-quality.mjs';
import {assertConversation,assertActive} from './conversation.mjs';
import {sendJobGreeting as sendGreeting,greetingTargetUnavailable,jobUrlKey,greetingOpeningPresence} from './job-greeting-browser.mjs';
import {sendModernGreeting} from './modern-greeting-delivery.mjs';
import {createModernGreetingAdapter,modernGreetingCapabilityDOM} from './modern-greeting-adapter.mjs';
import {chatRefreshDOM,refreshGreetingChat as refreshChat,assertGreetingChatIdle as assertChatIdle} from './chat-refresh.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const transientContextError=e=>e?.code==='CDP_ERROR'&&/Execution context was destroyed|Cannot find context with specified id|Cannot find context with id|Inspected target navigated or closed/i.test(e.message);
export function greetingVisibilityDOM(){return {visibilityState:document.visibilityState};}
export function isBossPage(url){try{const u=new URL(url);return u.protocol==='https:'&&['www.zhipin.com','zhipin.com'].includes(u.hostname);}catch{return false;}}
function browserPageRole(target){try{const u=new URL(target.url);if(target.type!=='page'||!isBossPage(u.href)||u.username||u.password||u.port)return '';return /^\/web\/geek\/chat\/?$/.test(u.pathname)?'chat':u.pathname==='/'||/^\/web\/geek\/jobs?\/?$/.test(u.pathname)?'main':'';}catch{return '';}}
function assertBrowserPageAccess(target){
 if(!target||!isBossPage(target.url))return;
 const pathname=new URL(target.url).pathname;
 if(/^\/(?:web\/passport\/(?:[^/]+\/)?|web\/|)(?:security|verify|captcha)(?:[/.]|$)/i.test(pathname))
  throw Object.assign(Error('BOSS 要求安全验证，请完成验证后继续搜索'),{code:'VERIFICATION_REQUIRED'});
 if(/\/(?:login|passport)(?:\/|$)/i.test(pathname))throw Object.assign(Error('BOSS 要求重新登录，请登录后继续搜索'),{code:'AUTH_REQUIRED'});
}
// Remember only verified page handles in this connection generation. These are
// navigation choices, never cached recipient proofs or permission to send.
export function rememberBrowserSelection(clients,page,pages){
 const selected=pages.find(target=>target.id===page.id),role=browserPageRole(selected);
 for(const client of clients){
  client.syncConnection();
  client.chatTargetId=role==='chat'?selected.id:pages.some(target=>target.id===client.chatTargetId&&browserPageRole(target)==='chat')?client.chatTargetId:null;
  client.mainTargetId=role==='main'?selected.id:pages.some(target=>target.id===client.mainTargetId&&browserPageRole(target)==='main')?client.mainTargetId:null;
  client.activeTargetId=null;client.detailTargetId=null;
 }
}
export const cities={'全国':'100010000','北京':'101010100','上海':'101020100','广州':'101280100','深圳':'101280600','杭州':'101210100','成都':'101270100','武汉':'101200100','南京':'101190100','苏州':'101190400','西安':'101110100','长沙':'101250100','重庆':'101040100','天津':'101030100','郑州':'101180100','合肥':'101220100','厦门':'101230200','福州':'101230100','济南':'101120100','青岛':'101120200','东莞':'101281600','佛山':'101280800'};
export function chromePath(){const list=[process.env.GHOST_CHROME,path.join(process.env.PROGRAMFILES||'C:\\Program Files','Google/Chrome/Application/chrome.exe'),path.join(process.env['PROGRAMFILES(X86)']||'C:\\Program Files (x86)','Google/Chrome/Application/chrome.exe'),path.join(process.env.LOCALAPPDATA||'','Google/Chrome/Application/chrome.exe')];const found=list.find(p=>p&&fs.existsSync(p));if(!found)throw Error('没有找到 Google Chrome，请安装后重试');return found;}
export function openApp(url,dir){const p=spawn(chromePath(),['--app='+url,'--user-data-dir='+path.join(dir,'app-profile'),'--no-first-run','--no-default-browser-check','--window-size=1280,900'],{detached:true,stdio:'ignore',windowsHide:false});p.on('error',()=>{});p.unref();}
// Runs in the page. The modern list is virtualized; its padded UL and the
// surrounding document are not the scroll viewport.
export function conversationListDOM({mode='read'}={}) {
 const visible=e=>e&&e.getBoundingClientRect().height>0;
 const route=typeof location==='undefined'?'':location.pathname;
 const dialogs=[...(document.querySelectorAll?.('[role="dialog"],.dialog-container,.dialog-wrap')||[])].filter(visible).map(e=>e.innerText||'').join('\n');
 if(route==='/web/passport/zp/security.html'||/安全验证|请完成验证|拖动滑块/.test(dialogs))return {error:'BOSS 要求安全验证，请在浏览器完成后继续',code:'VERIFICATION_REQUIRED'};
 if(/访问过于频繁|今日沟通.*上限|沟通次数.*上限/.test(dialogs))return {error:'BOSS 提示访问频繁或沟通次数上限，请稍后继续',code:'RATE_LIMITED'};
 if(/\/(?:login|passport)(?:\/|$)/.test(route)||/扫码登录|请先登录|登录已失效/.test(dialogs))return {error:'BOSS 登录状态已失效，请重新登录后继续',code:'AUTH_REQUIRED'};
 const root=document.querySelector('.user-list,.chat-user-list,.conversation-list,.chat-list');
 if(!root)return {error:'未找到会话列表，请先进入 BOSS 消息页；网页改版时需更新适配',code:'CHAT_LIST_UNAVAILABLE'};
 const modern=root.querySelector(':scope > .user-list-content');
 const rows=()=>[...root.querySelectorAll(modern?'li[role="listitem"]':'.user-item,.chat-user,.conversation-item,.friend-item,li')].filter(visible);
 const read=()=>rows().map((e,index)=>{
  const nameBox=e.querySelector('.friend-content .name-box,.name-box');
  const contact=nameBox?.querySelector('.name-text')?.innerText?.trim()||e.querySelector('.name,.user-name,.nickname')?.innerText?.trim()||e.innerText.split('\n').filter(Boolean)[0]||'';
  const company=(nameBox?[...nameBox.querySelectorAll(':scope > span')].filter(x=>!x.classList.contains('name-text')).map(x=>x.innerText.trim()).find(Boolean):'')||e.querySelector('.company,.company-name')?.innerText?.trim()||'';
  const remoteId=e.getAttribute('data-conversation-id')||e.getAttribute('data-uid')||e.getAttribute('data-id')||e.getAttribute('data-geekid')||'';
  const jobTitle=e.querySelector('.job-name,.job-title')?.innerText?.trim()||'';
  const jobUrl=e.querySelector('a[href*="/job_detail/"]')?.href?.split(/[?#]/)[0]||'';
  return {id:remoteId||[contact,company,jobTitle].join('|'),remoteId,contact,company,jobTitle,jobUrl,unread:!!e.querySelector('.badge,.red-dot,.unread,.badge-count'),lastText:e.querySelector('.last-msg,.message,.msg')?.innerText?.trim()||'',index};
 }).filter(item=>item.contact);
 if(mode==='read'){
  const conversations=read();
  const knownModern=!!modern&&rows().some(row=>row.querySelector('.friend-content .name-box .name-text'));
  return {conversations,loading:document.readyState==='loading'||root.getAttribute('aria-busy')==='true',modernWithoutIds:knownModern&&conversations.length>0&&conversations.every(item=>!item.remoteId)};
 }
 const scroller=modern||[root,root.parentElement].find(e=>e&&e!==document.body&&e!==document.documentElement&&e.clientHeight>0&&/auto|scroll/.test(getComputedStyle(e).overflowY));
 if(!scroller)return {unavailable:true};
 const snapshot=()=>({top:scroller.scrollTop,height:scroller.scrollHeight,viewport:scroller.clientHeight,
  atBottom:scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop<=2,
  loading:root.getAttribute('aria-busy')==='true'||[...root.querySelectorAll('.loading,[aria-busy="true"]')].some(visible),
  signature:JSON.stringify(read().map(item=>item.remoteId||item.id))});
 const before=snapshot();
 if(mode==='snapshot')return before;
 if(mode==='reset')scroller.scrollTop=0;
 else scroller.scrollTop=Math.min(before.top+Math.max(300,before.viewport*.8),Math.max(0,before.height-before.viewport));
 if(scroller.scrollTop!==before.top)scroller.dispatchEvent(new Event('scroll',{bubbles:true}));
 return {before,after:snapshot()};
}
// The three functions below run inside the job detail page through
// Runtime.evaluate, so each must stay self-contained (no outer references).
export function chatButtonStateDOM(expectedPath=''){
 let page;try{page=new URL(location.href);}catch{return 'redirected';}
 if(page.protocol!=='https:'||!['www.zhipin.com','zhipin.com'].includes(page.hostname)||page.username||page.password||page.port)return 'redirected';
 const body=document.body?.innerText||'';
 if(/^\/(?:web\/passport\/(?:[^/]+\/)?|web\/|)(?:security|verify|captcha)(?:[/.]|$)/i.test(page.pathname))return 'blocked';
 if(/\/(?:login|passport)(?:\/|$)/i.test(page.pathname))return 'auth';
 if(document.readyState==='loading'||!body.trim())return 'loading';
 // Never judge (or later click) a page other than the target job, e.g. after a redirect.
 // Login and verification pages fall through to the 'blocked' check below.
 if(expectedPath&&location.pathname!==expectedPath&&!/\/(?:login|passport)(?:\/|$)|security/.test(location.pathname))return 'redirected';
 if(location.pathname==='/web/passport/zp/security.html'||/安全验证|请完成验证|拖动滑块|扫码登录/.test(body))return 'blocked';
 if(/今日沟通.*上限|沟通次数.*上限/.test(body))return 'limit';
 const label=e=>String(e.innerText||'').replace(/\s+/g,'');
 const buttons=[...document.querySelectorAll('a,button')].filter(e=>e.getBoundingClientRect().height>0);
 if(buttons.some(e=>label(e)==='继续沟通'))return 'already';
 if(buttons.filter(e=>label(e)==='立即沟通').length===1)return 'ready';
 if(/职位已关闭|该职位已关闭|职位已下线|该职位已下线|职位已失效|职位已过期|停止招聘|暂停招聘/.test(body))return 'closed';
 if(/继续沟通|已沟通/.test(body))return 'already';
 return 'missing';
}
export function clickChatButtonDOM(expectedPath='',attemptId=''){
 let page;try{page=new URL(location.href);}catch{return false;}
 if(page.protocol!=='https:'||!['www.zhipin.com','zhipin.com'].includes(page.hostname)||page.username||page.password||page.port)return false;
 const body=document.body?.innerText||'';
 if(/^\/(?:web\/passport\/(?:[^/]+\/)?|web\/|)(?:security|verify|captcha)(?:[/.]|$)/i.test(page.pathname)||/安全验证|请完成验证|拖动滑块/.test(body))return {clicked:false,code:'VERIFICATION_REQUIRED'};
 if(/\/(?:login|passport)(?:\/|$)/i.test(page.pathname)||/扫码登录/.test(body))return {clicked:false,code:'AUTH_REQUIRED'};
 if(/今日沟通.*上限|沟通次数.*上限/.test(body))return {clicked:false,code:'RATE_LIMITED'};
 if(!/^\/job_detail\/[^/]+\.html$/.test(expectedPath)||page.pathname!==expectedPath||!attemptId)return false;
 const label=e=>String(e.innerText||'').replace(/\s+/g,'');
 const visibleButtons=[...document.querySelectorAll('a,button')].filter(e=>e.getBoundingClientRect().height>0);
 if(visibleButtons.some(e=>label(e)==='继续沟通'))return false;
 const buttons=visibleButtons.filter(e=>label(e)==='立即沟通');
 const b=buttons[0];if(buttons.length!==1||b.disabled||b.getAttribute?.('aria-disabled')==='true')return false;
 // Count existing "continue" markers first, so unrelated page text cannot confirm the click.
 const marks=(document.body?.innerText||'').match(/继续沟通|已沟通/g)?.length||0;
 b.setAttribute('data-abj-chat',attemptId);b.click();
 return {clicked:true,marks};
}
export function chatConfirmationDOM(before=0,expectedPath='',attemptId=''){
 let page;try{page=new URL(location.href);}catch{return 'pending';}
 if(page.protocol!=='https:'||!['www.zhipin.com','zhipin.com'].includes(page.hostname)||page.username||page.password||page.port)return 'pending';
 const body=document.body?.innerText||'';
 if(/^\/(?:web\/passport\/(?:[^/]+\/)?|web\/|)(?:security|verify|captcha)(?:[/.]|$)/i.test(page.pathname)||/安全验证|请完成验证|拖动滑块/.test(body))return 'blocked';
 if(/\/(?:login|passport)(?:\/|$)/i.test(page.pathname)||/扫码登录/.test(body))return 'auth';
 if(/今日沟通.*上限|沟通次数.*上限|沟通.{0,6}已达.{0,4}上限|(?:今日|今天).{0,16}沟通.{0,16}明天再/.test(body))return 'limit';
 if(!/^\/job_detail\/[^/]+\.html$/.test(expectedPath)||!attemptId)return 'pending';
 if(/^\/web\/geek\/chat\/?$/.test(page.pathname))return 'sent';
 if(page.pathname!==expectedPath)return 'pending';
 const marked=[...document.querySelectorAll('[data-abj-chat]')].filter(e=>e.getAttribute('data-abj-chat')===attemptId);
 if(marked.length===1&&marked[0].getBoundingClientRect().height>0&&String(marked[0].innerText||'').replace(/\s+/g,'')==='继续沟通')return 'sent';
 return 'pending';
}
export class Browser{
 constructor(dir,role='jobs',connection=null){this.dir=dir;this.role=role;this.connection=connection;this.connectionGeneration=connection?.generation;this.port=0;this.process=null;this.activeTargetId=null;this.mainTargetId=null;this.detailTargetId=null;this.chatTargetId=null;this.portFile=path.join(dir,'boss-profile','DevToolsActivePort');}
 get existing(){return this.connection?.mode==='existing';}
 syncConnection(){if(this.connection&&this.connectionGeneration!==this.connection.generation){this.connectionGeneration=this.connection.generation;this.port=0;this.activeTargetId=null;this.mainTargetId=null;this.detailTargetId=null;this.chatTargetId=null;}}
 existingPageAllowed(t){return t?.type==='page'&&(isBossPage(t.url)||this.connection.createdTargets.has(t.id)&&(t.url==='about:blank'||this.role==='company'&&/^https:\/\/www\.bing\.com\/search(?:\?|$)/.test(t.url)));}
 async targets(){this.syncConnection();if(this.existing){if(!this.connection.session.connected)return [];return (await this.connection.session.targets()).filter(t=>this.existingPageAllowed(t));}try{const r=await fetch(`http://127.0.0.1:${this.port}/json/list`,{signal:AbortSignal.timeout(2000)});return await r.json();}catch{return [];}}
 async owned(){this.syncConnection();if(this.existing)return this.connection.session.connected;try{const [port,endpoint]=fs.readFileSync(this.portFile,'utf8').trim().split(/\r?\n/);const n=Number(port);if(!Number.isInteger(n)||n<1)return false;const r=await fetch(`http://127.0.0.1:${n}/json/version`,{signal:AbortSignal.timeout(2000)});const v=await r.json();if(!v.webSocketDebuggerUrl?.endsWith(endpoint))return false;this.port=n;return true;}catch{return false;}}
 async waitForBossPage(timeoutMs=15000){const deadline=Date.now()+timeoutMs;do{const page=(await this.targets()).find(t=>t.type==='page'&&isBossPage(t.url));if(page){this.activeTargetId=page.id;return page;}await pause(200);}while(Date.now()<deadline);throw Error('浏览器已打开，但 BOSS 直聘页面尚未加载。请检查网络或代理，等待页面出现后重试。');}
 async openExistingBossPage(timeoutMs=15000){
  if(!this.existing||!this.connection.session.connected)throw Error('请先允许连接日常 Chrome');
  const created=await this.newTab('https://www.zhipin.com/');
  const deadline=Date.now()+timeoutMs;
  do{const page=(await this.targets()).find(t=>t.id===created.id&&isBossPage(t.url));if(page)return page;await pause(200);}while(Date.now()<deadline);
  throw Error('已在日常 Chrome 打开 BOSS，但页面尚未加载完成。请检查该页面后重新连接。');
 }
 async launch({forSearch=false,active=()=>true}={}){assertActive(active);if(this.existing){
  await this.connection.connect();assertActive(active);this.syncConnection();const generation=this.connection.generation;
  const pages=(await this.targets()).filter(t=>isBossPage(t.url));
  assertActive(active);
  if(this.connection.generation!==generation||this.connection.session.connected===false)throw Object.assign(Error('浏览器连接已变化，请重新连接后继续'),{code:'SEARCH_CONNECTION_CHANGED'});
  for(const target of pages)if(forSearch||[this.connection.preferredTargetId,this.mainTargetId,this.chatTargetId,this.activeTargetId].includes(target.id))assertBrowserPageAccess(target);
  if(!pages.some(t=>t.id===this.chatTargetId&&browserPageRole(t)==='chat'))this.chatTargetId=null;
  if(!pages.some(t=>t.id===this.mainTargetId&&browserPageRole(t)==='main'))this.mainTargetId=null;
  let selected=pages.find(t=>t.id===this.connection.preferredTargetId)||pages.find(t=>t.id===this.mainTargetId)||pages.find(t=>t.id===this.chatTargetId);
  // An explicit search may establish its own page later. Do not guess a chat
  // or mutate a user's unrelated page just to satisfy launch's selection step.
  if(!selected&&forSearch){this.activeTargetId=null;return;}
  if(this.connection.preferredTargetId&&!selected)throw Error('已连接的 BOSS 标签页已关闭或离开网站，请点击「连接已登录 Chrome」重新选择。');
  if(!selected&&pages.length===1)selected=pages[0];
  if(!selected)throw Error(pages.length?'检测到多个 BOSS 页面，请点击「连接已登录 Chrome」选择要使用的标签页。':'请先在日常 Chrome 中打开已登录的 BOSS 页面，再点击连接。');
  assertBrowserPageAccess(selected);if(!forSearch)this.connection.preferredTargetId=selected.id;this.activeTargetId=selected.id;
  if(browserPageRole(selected)==='main')this.mainTargetId=selected.id;else if(browserPageRole(selected)==='chat')this.chatTargetId=selected.id;return;
 }
  if(await this.owned()){if(!(await this.targets()).some(t=>t.type==='page'&&isBossPage(t.url)))await this.newTab('https://www.zhipin.com/web/geek/jobs');await this.waitForBossPage();return;}
  fs.mkdirSync(path.join(this.dir,'boss-profile'),{recursive:true});this.process=spawn(chromePath(),['--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+path.join(this.dir,'boss-profile'),'--no-first-run','--no-default-browser-check','https://www.zhipin.com/web/geek/jobs'],{stdio:'ignore',windowsHide:false});let spawnError;this.process.on('error',e=>spawnError=e);
  for(let i=0;i<50;i++){if(spawnError)throw spawnError;if(await this.owned()){await this.waitForBossPage();return;}await pause(300);}throw Error('浏览器启动超时，请检查 Chrome 是否正常');
 }
 async newTab(url){if(this.existing){if(!isBossPage(url)&&url!=='about:blank'&&!(this.role==='company'&&/^https:\/\/www\.bing\.com\/search\?/.test(url)))throw Error('此连接仅支持 BOSS 页面和企业查询');const t=await this.connection.session.createTarget(url);this.connection.createdTargets.add(t.id);return t;}const r=await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`,{method:'PUT',signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('无法创建浏览器标签页');return r.json();}
 async target(){if(!this.port)await this.owned();const all=(await this.targets()).filter(t=>t.type==='page'&&isBossPage(t.url));if(this.existing){const id=this.activeTargetId||this.connection.preferredTargetId;const t=all.find(t=>t.id===id);if(!t)throw Error('已连接的 BOSS 标签页不可用，请点击「连接已登录 Chrome」重新选择。');return t;}const t=all.find(t=>t.id===this.activeTargetId)||all[0];if(!t)throw Error('请先打开求职浏览器，等待 BOSS 直聘页面加载并完成登录');return t;}
 async command(method,params={},target,{guard}={}){if(this.existing){
  if(method==='Browser.close')throw Error('已登录 Chrome 只能断开连接，不能由软件关闭');
  if(method==='Target.closeTarget'){if(!this.connection.createdTargets.has(params.targetId))throw Error('不能关闭用户原有标签页');const result=await this.connection.session.call(method,params);this.connection.createdTargets.delete(params.targetId);return result;}
  if(!['Runtime.evaluate','Page.navigate','Page.bringToFront','Input.dispatchMouseEvent'].includes(method))throw Error('不支持的浏览器操作');
  let searchNavigation=false;try{searchNavigation=method==='Page.navigate'&&/^\/web\/geek\/jobs?\/?$/.test(new URL(params.url).pathname);}catch{}
  const connection=this.connection,generation=connection.generation;
  const beforeDispatch=()=>{
   if(guard?.()===false)throw Object.assign(Error('操作已停止'),{code:'CANCELLED'});
   if(searchNavigation&&(this.connection!==connection||!this.existing||connection.generation!==generation||connection.session.connected===false))
    throw Object.assign(Error('搜索导航前浏览器连接已变化，未操作页面'),{code:'SEARCH_CONNECTION_CHANGED'});
  };
  beforeDispatch();const t=target||await this.target();const current=(await this.targets()).find(p=>p.id===t.id);beforeDispatch();
  if(searchNavigation){
   assertBrowserPageAccess(current);
   if(browserPageRole(current)!=='main'&&!(current?.type==='page'&&current.url==='about:blank'&&connection.createdTargets.has(current.id)))
    throw Object.assign(Error('搜索目标已关闭或切换到其他页面，未执行导航'),{code:'SEARCH_TARGET_CHANGED'});
  }
  if(!current||!this.existingPageAllowed(current))throw Error('页面已关闭或离开允许的网站，已停止操作');
  if(method==='Page.navigate'&&!isBossPage(params.url))throw Error('仅支持 BOSS 直聘岗位链接');
  beforeDispatch();return connection.session.pageCommand(t.id,method,params);
 }const t=target||await this.target();return new Promise((resolve,reject)=>{const ws=new WebSocket(t.webSocketDebuggerUrl);const timer=setTimeout(()=>{ws.close();reject(Object.assign(Error('浏览器响应超时'),{code:'BROWSER_TIMEOUT'}));},15000);const done=(err,result)=>{clearTimeout(timer);ws.close();err?reject(err):resolve(result);};ws.addEventListener('open',()=>ws.send(JSON.stringify({id:1,method,params})));ws.addEventListener('message',e=>{let r;try{r=JSON.parse(e.data);}catch{return;}if(r.id===1)done(r.error?Object.assign(Error(r.error.message),{code:'CDP_ERROR',cdpCode:r.error.code}):null,r.result);});ws.addEventListener('error',()=>done(Error('浏览器连接中断')));});}
 async evaluateOn(target,fn,...args){const r=await this.command('Runtime.evaluate',{expression:`(${fn.toString()})(${args.map(a=>JSON.stringify(a)).join(',')})`,returnByValue:true,awaitPromise:true},target);if(r.exceptionDetails)throw Error('网页解析失败，请刷新页面后重试');return r.result?.value;}
 async evaluate(fn,...args){return this.evaluateOn(await this.target(),fn,...args);}
 async captureDiagnostics({targetId:requestedTargetId,generation:expectedGeneration,guard=()=>true,timeoutMs=8000,pollMs=400}={}){
  const generation=expectedGeneration??this.connection?.generation??this.connectionGeneration??0;
  const changed=()=>Object.assign(Error('所选消息页已关闭、重新连接或离开消息页，请重新选择后采集'),{code:'DIAGNOSTIC_TARGET_CHANGED'});
  const check=()=>{if(guard()===false)throw Object.assign(Error('操作已停止'),{code:'CANCELLED'});if((this.connection?.generation??this.connectionGeneration??0)!==generation)throw changed();};
  const route=target=>{try{const url=new URL(target.url);return target.type==='page'&&isBossPage(target.url)&&!url.username&&!url.password&&!url.port?url.pathname:'';}catch{return '';}};
  const assertRoute=target=>{const path=route(target);if(path==='/web/passport/zp/security.html')throw Object.assign(Error('所选 BOSS 页面正在安全验证，请完成后回到消息页'),{code:'VERIFICATION_REQUIRED'});if(/\/(?:login|passport)(?:\/|$)/.test(path))throw Object.assign(Error('所选 BOSS 页面正在登录，请登录后回到消息页'),{code:'AUTH_REQUIRED'});return /^\/web\/geek\/chat\/?$/.test(path);};
  check();const initial=await this.targets();check();const pages=initial.filter(target=>/^\/web\/geek\/chat\/?$/.test(route(target)));
  const preferred=this.connection?.preferredTargetId;
  const explicit=requestedTargetId!==undefined,selectedId=explicit?requestedTargetId:preferred||this.activeTargetId||this.chatTargetId;
  const selected=initial.find(page=>page.id===selectedId);if(selected)assertRoute(selected);
  let target=pages.find(page=>page.id===selectedId);
  if(!target&&explicit)throw changed();
  if(!target&&!explicit&&!preferred&&pages.length===1)target=pages[0];
  if(!target)throw Object.assign(Error(pages.length?'请连接并选择要诊断的 BOSS 消息页后重试；不会自动切换到其他标签页':'请先在已连接的浏览器打开 BOSS 消息页，再采集诊断'),{code:pages.length?'DIAGNOSTIC_SELECTION_REQUIRED':'DIAGNOSTIC_CHAT_REQUIRED'});
  const targetId=target.id,deadline=Date.now()+Math.min(15000,Math.max(0,Number(timeoutMs)||0));
  const currentTarget=async()=>{check();const current=(await this.targets()).find(page=>page.id===targetId);check();if(!current||!assertRoute(current))throw changed();return current;};
  let last;
  do{
   const current=await currentTarget();
   try{last=await this.evaluateOn(current,browserDiagnosticsDOM);}catch(error){if(!transientContextError(error)||Date.now()>=deadline)throw error;last={usable:false,state:'loading'};}
   await currentTarget();
   if(last?.error)throw Object.assign(Error(last.error),{code:last.code||'DIAGNOSTIC_CHAT_REQUIRED'});
   if(last?.usable===true)return last;
   if(Date.now()>=deadline)break;
   await pause(Math.min(Math.max(1,Number(pollMs)||1),deadline-Date.now()));
  }while(Date.now()<=deadline);
  const structure=last?.structure;
  const detail=structure?`（状态 ${last.state}；页面子节点 ${structure.bodyChildren||0}；消息头 ${structure.visible?.header||0}/${structure.matched?.header||0}；iframe ${structure.visible?.frames||0}/${structure.matched?.frames||0}）`:'';
  throw Object.assign(Error('等待消息页结构超时，未保存空诊断。请等待所选消息页显示会话或岗位详情后重试'+detail),{code:'DIAGNOSTIC_NOT_READY',diagnostic:last});
 }
 async status(){const meta={mode:this.existing?'existing':'dedicated',connecting:!!this.connection?.pending};if(!await this.owned())return {connected:false,url:'',title:'',...meta};try{const t=await this.targets();const page=this.existing?t.find(x=>x.id===this.connection.preferredTargetId&&isBossPage(x.url)):t.find(x=>x.type==='page'&&isBossPage(x.url));return {connected:!!page,url:page?.url||'',title:page?.title||'',...meta};}catch{return {connected:false,url:'',title:'',...meta};}}
 async searchTarget({check,generation}){
  const usable=target=>browserPageRole(target)==='main'||target?.type==='page'&&target.url==='about:blank'&&this.connection.createdTargets.has(target.id);
  const inspect=async()=>{
   check();const pages=await this.targets();check();
   for(const target of pages)assertBrowserPageAccess(target);
   return {pages,selected:pages.find(target=>target.id===this.mainTargetId&&usable(target))||pages.find(target=>target.id===this.connection.preferredTargetId&&browserPageRole(target)==='main')};
  };
  let {selected}=await inspect();if(selected)return selected;
  let pending=this.searchTargetPending;
  if(pending&&(pending.generation!==generation||pending.connection!==this.connection))throw Object.assign(Error('搜索页创建期间连接已变化，请重新开始搜索'),{code:'SEARCH_CONNECTION_CHANGED'});
  if(!pending){
   pending={generation,connection:this.connection,promise:null};
   pending.promise=(async()=>{
    const current=await inspect();if(current.selected)return current.selected;
    check();const created=await pending.connection.session.createTarget('about:blank');check();
    if(!created?.id)throw Object.assign(Error('未取得新建搜索页标识'),{code:'SEARCH_TARGET_CHANGED'});
    this.connection.createdTargets.add(created.id);
    // Keep an owned blank page available for the exact search navigation. Never
    // adopt an arbitrary existing blank, chat, detail or regional homepage.
    const {pages}=await inspect();const target=pages.find(item=>item.id===created.id);assertBrowserPageAccess(target);
    if(!target||!usable(target))throw Object.assign(Error('新建搜索页已关闭或跳转，未导航其他页面'),{code:'SEARCH_TARGET_CHANGED'});
    check();this.mainTargetId=target.id;return target;
   })();
   this.searchTargetPending=pending;
  }
  try{selected=await pending.promise;check();return selected;}
  finally{if(this.searchTargetPending===pending)this.searchTargetPending=null;}
 }
 async navigate(url,{active=()=>true}={}){assertActive(active);const u=new URL(url);if(u.protocol!=='https:'||!['www.zhipin.com','zhipin.com'].includes(u.hostname)||u.username||u.password||u.port)throw Error('仅支持 BOSS 直聘岗位链接');
  const searchRequest=this.existing&&/^\/web\/geek\/jobs?\/?$/.test(u.pathname),connection=this.connection,generation=connection?.generation;
  const check=()=>{assertActive(active);if(searchRequest&&(this.connection!==connection||!this.existing||this.connection.generation!==generation||this.connection.session.connected===false))throw Object.assign(Error('搜索期间浏览器连接已变化，已停止操作'),{code:'SEARCH_CONNECTION_CHANGED'});};
  check();if(!this.port)await this.owned();check();const all=await this.targets();check();let selected;
  if(u.pathname.startsWith('/job_detail/')){selected=all.find(t=>t.id===this.detailTargetId);if(!selected){selected=await this.newTab('about:blank');assertActive(active);this.detailTargetId=selected.id;}}
  else{if(searchRequest)selected=await this.searchTarget({check,generation});else if(this.existing){selected=all.find(t=>t.id===(this.mainTargetId||this.connection.preferredTargetId)&&isBossPage(t.url));if(!selected||browserPageRole(selected)!=='main'){this.mainTargetId=null;throw Object.assign(Error('已连接的 BOSS 搜索标签页不可用，请在管理浏览器连接中选择搜索页后继续'),{code:'SEARCH_TARGET_REQUIRED'});}}else{selected=all.find(t=>t.id===this.mainTargetId)||all.find(t=>t.type==='page'&&isBossPage(t.url)&&/^\/web\/geek\/jobs?\/?$/.test(new URL(t.url).pathname));if(!selected)selected=await this.target();}check();this.mainTargetId=selected.id;}
  check();this.activeTargetId=selected.id;if(selected.url===url)return;check();let result;try{result=await this.command('Page.navigate',{url},selected,searchRequest?{guard:check}:undefined);}catch(e){if(u.pathname.startsWith('/job_detail/')&&['BROWSER_TIMEOUT','CDP_COMMAND_TIMEOUT'].includes(e?.code))throw Object.assign(Error('岗位页面打开超时：'+e.message),{code:'NAVIGATION_FAILED',notSent:true});throw e;}check();if(result?.errorText)throw Object.assign(Error('岗位页面导航失败：'+result.errorText),{code:'NAVIGATION_FAILED',notSent:true});if(result?.isDownload)throw Object.assign(Error('岗位地址返回了下载文件，未打开岗位页面'),{code:'NAVIGATION_DOWNLOAD',notSent:true});await pause(1600);check();
 }
 async search(keyword,city,options={}){assertActive(options.active);if(!cities[city])throw Object.assign(Error('暂不支持城市：'+city+'；请从配置中心的城市列表选择'),{code:'CITY_UNSUPPORTED'});await this.navigate('https://www.zhipin.com/web/geek/jobs?query='+encodeURIComponent(keyword)+'&city='+cities[city],options);assertActive(options.active);const result=await this.readJobs({...options,expectedSearch:{keyword,city}});assertActive(options.active);if(result.blocked)throw Object.assign(Error(result.blocked),result.blockedCode?{code:result.blockedCode}:{});return result;}
 async readJobs({timeoutMs=20000,pollMs=400,expectedSearch,active=()=>true}={}){
  const deadline=Date.now()+timeoutMs;
  let last,securityCheckSeen=false;
  // blockedCode lets the batch tell "nothing found for this keyword/city" (skip
  // it) apart from login/verification (stop) without parsing messages.
  const stopped=()=>({jobs:[],blocked:'已停止读取岗位',blockedCode:'CANCELLED'});
  do{
   if(!active())return stopped();
   try{last=await this.readJobsSnapshot({expectedSearch});}catch(e){if(!active())return stopped();if(!transientContextError(e))throw e;last={...last,jobs:[],blocked:'',loading:true};}
   if(!active())return stopped();
   securityCheckSeen ||= !!last.securityCheck;
   if(last.blocked&&!last.loading)return last;
   if(expectedSearch&&!last.loading){
    let url;try{url=new URL(last.url);}catch{}
    if(!url||!isBossPage(url.href)||!/^\/web\/geek\/jobs?\/?$/.test(url.pathname))return {...last,jobs:[],blocked:securityCheckSeen?'BOSS 安全检查后返回了首页，未取得搜索结果。请先在 BOSS 网页完成验证或检查网络后重试。':'BOSS 搜索页跳转到了首页或其他页面，未获取到搜索结果。可先在求职浏览器手动搜索，或使用「读取当前页岗位」保存当前推荐岗位。',blockedCode:securityCheckSeen?'VERIFICATION_REQUIRED':'SEARCH_REDIRECTED'};
    if(url.searchParams.get('query')!==expectedSearch.keyword||url.searchParams.get('city')!==cities[expectedSearch.city])return {...last,jobs:[],blocked:'浏览器页面的关键词或城市与本次搜索不一致，已暂停读取，请核对搜索条件。',blockedCode:'SEARCH_MISMATCH'};
   }
   if(!last.loading&&last.jobs.length)return last;
   if(!last.loading&&last.empty)return {...last,blocked:'当前搜索没有匹配岗位，请调整关键词或城市。',blockedCode:'SEARCH_EMPTY'};
   if(Date.now()>=deadline)break;
   await pause(Math.min(pollMs,Math.max(0,deadline-Date.now())));
  }while(Date.now()<=deadline);
  return {...last,jobs:[],blocked:securityCheckSeen?'BOSS 安全检查尚未完成；若页面反复跳转，请在浏览器完成验证或检查网络后重试。':last?.loading?'岗位页面仍在加载，请等待浏览器显示岗位后点击「读取当前页岗位」。':'当前页面未识别到岗位卡片，请打开岗位列表；如果列表已显示，需更新页面适配器。',blockedCode:securityCheckSeen?'VERIFICATION_REQUIRED':last?.loading?'LIST_LOADING':'LIST_UNRECOGNIZED'};
 }
 async readJobsSnapshot({expectedSearch}={}){
  if(!this.port)await this.owned();
  const targets=await this.targets();
  const pages=targets.filter(t=>t.type==='page'&&isBossPage(t.url));
  const isList=t=>/^\/web\/geek\/jobs?\/?$/.test(new URL(t.url).pathname);
  let selected;
  if(expectedSearch&&this.mainTargetId){selected=targets.find(t=>t.id===this.mainTargetId&&t.type==='page');if(!selected)throw Object.assign(Error('本次搜索的浏览器标签页已关闭或不可用，请重新打开求职浏览器'),{code:'SEARCH_TARGET_MISSING'});if(!isBossPage(selected.url))throw Object.assign(Error('本次搜索的标签页已离开 BOSS 直聘，已停止读取'),{code:'SEARCH_TARGET_CHANGED'});}
  else if(this.existing){selected=pages.find(t=>t.id===(this.activeTargetId||this.connection.preferredTargetId));if(!selected)throw Error('已连接的 BOSS 标签页不可用，请重新连接并选择页面。');}
  else selected=pages.find(t=>t.id===this.activeTargetId)||pages.find(isList)||pages[0];
  if(!selected)throw Error('请先打开求职浏览器，等待 BOSS 直聘页面加载并完成登录');
  this.activeTargetId=selected.id;if(expectedSearch&&!this.mainTargetId)this.mainTargetId=selected.id;
  return this.evaluateOn(selected,()=>{
  if(location.protocol!=='https:'||!['www.zhipin.com','zhipin.com'].includes(location.hostname))return {url:location.href,loading:false,jobs:[],blocked:'本次搜索的标签页已离开 BOSS 直聘，已停止读取',blockedCode:'SEARCH_TARGET_CHANGED'};
  if(location.pathname==='/web/passport/zp/security.html')return {url:location.href,loading:true,securityCheck:true,jobs:[],blocked:''};
  const visible=e=>e&&e.getBoundingClientRect().height>0&&getComputedStyle(e).visibility!=='hidden';
  const jobURL=a=>{try{const u=new URL(a.href);return u.protocol==='https:'&&['www.zhipin.com','zhipin.com'].includes(u.hostname)&&/^\/job_detail\/[^/]+\.html$/.test(u.pathname)?u:null;}catch{return null;}};
  const body=document.body?.innerText||'';
  const meta={url:location.href,loading:document.readyState==='loading'||(!body.trim()||/^(?:加载中[，,]?请稍候|正在加载)[。.\s…]*$/.test(body.trim()))};
  if(/安全验证|请完成验证|拖动滑块|访问过于频繁/.test(body))return {...meta,loading:false,blocked:'页面要求验证，请在浏览器中手动完成后继续',blockedCode:/访问过于频繁/.test(body)?'RATE_LIMITED':'VERIFICATION_REQUIRED',jobs:[]};
  const links=[...document.querySelectorAll('a[href*="/job_detail/"]')].filter(a=>visible(a)&&jobURL(a));
  const jobs=links.map(a=>{
   const url=jobURL(a);url.search='';url.hash='';
   let el=a.closest('.job-card-wrap,.job-card-wrapper,.job-card-box,.job-primary,li')||a;
   // Some layouts put the company and city beside the job link. Expand only
   // while the container still describes a single distinct job.
   for(let i=0;i<6&&el.parentElement;i++){
    if(el.querySelector('a[href*="/gongsi/"],a[href*="/gongsi_detail/"],.company-name,.company-info h3'))break;
    const parent=el.parentElement;
    const urls=new Set([...parent.querySelectorAll('a[href*="/job_detail/"]')].map(jobURL).filter(Boolean).map(u=>u.pathname));
    if(urls.size!==1)break;el=parent;
   }
   const text=sel=>[...el.querySelectorAll(sel)].filter(visible).map(n=>n.innerText.trim()).find(Boolean)||'';
   const title=text('.job-name,.job-title,.job-info .name')||a.innerText.trim().split('\n')[0];
   const company=text('.company-name,.company-text .name,.company-info h3,.company-title,.user-info p .name')||text('a[href*="/gongsi/"],a[href*="/gongsi_detail/"]').split(/\n/).map(s=>s.trim()).find(Boolean)||'';
   const salary=text('.salary,.red,.job-salary')||(el.innerText.match(/\d+(?:\.\d+)?\s*[-–]\s*\d+(?:\.\d+)?\s*(?:K|k|万|元\/(?:月|天|时))(?:[·・]\d+薪)?/)||[])[0]||'';
   const tags=[...el.querySelectorAll('.tag-list li,.job-labels span,.company-tag-list li,.job-text span')].filter(visible).map(x=>x.innerText);const raw=el.innerText;
   return {url:url.href,title,company,companyUrl:el.querySelector('a[href*="/gongsi/"],a[href*="/gongsi_detail/"]')?.href||'',salary,city:text('.job-area,.job-area-wrapper,.area,.job-location,.job-address,.sub-li-bottom-commany-place .name'),tags,experience:tags.find(x=>/经验|应届|在校|\d.*年/.test(x))||'',education:tags.find(x=>/学历|初中|高中|中专|大专|本科|硕士|博士/.test(x))||'',industry:[...el.querySelectorAll('.company-tag-list li')].map(x=>x.innerText).find(x=>!/[0-9].*人|融资|轮|上市/.test(x))||'',companySize:tags.find(x=>/\d.*人/.test(x))||'',financing:tags.find(x=>/融资|轮|上市/.test(x))||'',jobType:/兼职/.test(raw)?'兼职':/实习/.test(raw)?'实习':'全职',description:raw.slice(0,6000),source:'BOSS直聘',listUrl:location.origin+location.pathname,listKind:location.pathname==='/'?'首页推荐':'岗位列表'};
  }).filter(x=>x.title);
  const unique=[...new Map(jobs.map(j=>[j.url,j])).values()];
  return {...meta,jobs:unique,empty:!unique.length&&/暂无相关职位|暂无符合条件|没有找到相关职位|暂时没有符合/.test(body),blocked:!unique.length&&/扫码登录|密码登录|立即登录/.test(body)?'请在浏览器中完成 BOSS 直聘登录':'',...(!unique.length&&/扫码登录|密码登录|立即登录/.test(body)?{blockedCode:'AUTH_REQUIRED'}:{})};
 });}
 async detail({active=()=>true,expectedUrl,timeoutMs=8000,pollMs=250}={}){
  const guard=()=>assertActive(active);
  const fail=(message,code='JOB_DETAIL_TARGET_CHANGED')=>{throw Object.assign(Error(message),{code,notSent:true});};
  const deadline=Date.now()+Math.min(8000,Math.max(0,Number(timeoutMs)||0));
  const timeoutError=()=>Object.assign(Error('等待岗位详情加载超时，未读取到完整岗位职责或任职要求；请检查目标岗位页面后重试'),{code:'JOB_DETAIL_REQUIRED',notSent:true});
  const bounded=async operation=>{
   guard();let timer;
   try{return await Promise.race([Promise.resolve().then(()=>{guard();return operation();}),new Promise((_,reject)=>{
    timer=setTimeout(()=>{try{guard();reject(timeoutError());}catch(error){reject(error);}},Math.max(1,deadline-Date.now()));
   })]);}finally{clearTimeout(timer);}
  };
  const jobPath=value=>{try{const u=new URL(value);return isBossPage(u.href)&&!u.username&&!u.password&&!u.port&&/^\/job_detail\/[^/]+\.html$/.test(u.pathname)?u.pathname:'';}catch{return '';}};
  guard();if(!this.port)await bounded(()=>this.owned());guard();
  const initial=await bounded(()=>this.targets());guard();
  const selectedId=this.activeTargetId||this.detailTargetId||this.connection?.preferredTargetId;
  const pages=initial.filter(t=>t.type==='page'&&isBossPage(t.url));
  const selected=selectedId?initial.find(t=>t.id===selectedId&&t.type==='page'):pages.length===1?pages[0]:null;
  if(!selected)fail('本次岗位详情标签页已关闭或未明确选择，请重新打开目标岗位');
  if(expectedUrl&&!jobPath(expectedUrl))fail('目标岗位详情链接无效','JOB_DETAIL_REQUIRED');
  const targetId=selected.id,generation=this.connection?.generation;
  let expectedPath=jobPath(expectedUrl)||jobPath(selected.url),expectedSeen=!!expectedPath&&jobPath(selected.url)===expectedPath;
  const currentTarget=async()=>{
   guard();const all=await bounded(()=>this.targets());guard();
   const current=all.find(t=>t.id===targetId&&t.type==='page');
   if(this.connection?.generation!==generation||!current)fail('本次岗位详情标签页已关闭或连接已变化，已停止读取');
   if(current.url!=='about:blank'&&!isBossPage(current.url))fail('本次岗位详情标签页已离开 BOSS，已停止读取');
   const currentPath=jobPath(current.url);
   if(expectedSeen&&currentPath&&currentPath!==expectedPath)fail('当前标签页已切换到另一岗位，未读取或保存其详情');
   return current;
  };
  // Embed only our own standalone parser so page-thrown codes survive evaluateOn.
  const readDetail=new Function(`try{return {detail:(${jobDetailDOM.toString()})()};}catch(error){return {error:String(error?.message||'岗位详情解析失败'),code:String(error?.code||'JOB_DETAIL_READ_FAILED')};}`);
  do{
   const current=await currentTarget();guard();
   let snapshot;
   try{snapshot=await bounded(()=>this.evaluateOn(current,readDetail));}catch(error){guard();if(!transientContextError(error))throw error;}
   guard();
   if(snapshot?.error)fail(snapshot.error,snapshot.code||'JOB_DETAIL_READ_FAILED');
   const latest=await currentTarget();guard();
   const detail=snapshot?.detail,actualPath=jobPath(detail?.detailUrl),latestPath=jobPath(latest.url);
   if(!expectedPath&&actualPath)expectedPath=actualPath;
   if(expectedSeen&&actualPath&&actualPath!==expectedPath)fail('页面读取期间已切换到另一岗位，未保存其详情');
   if(actualPath&&actualPath===expectedPath&&latestPath===expectedPath){
    expectedSeen=true;
    if(isJobDescription(detail.description,detail))return detail;
   }
   if(Date.now()>=deadline)break;
   await pause(Math.min(Math.max(1,Number(pollMs)||1),Math.max(0,deadline-Date.now())));guard();
  }while(Date.now()<=deadline);
  throw timeoutError();
 }
 async nextPage(){return this.evaluate(()=>{const next=document.querySelector('.ui-icon-arrow-right,.options-pages a.next,.pagination-next');const el=next?.closest('a,button')||next;if(el&&!String(el.className).includes('disabled')&&el.getAttribute('aria-disabled')!=='true'){el.click();return true;}const root=document.querySelector('.job-list-box,.job-list-container')||document.scrollingElement;const scroller=[root,root.parentElement,document.scrollingElement].find(e=>e&&e.scrollHeight>e.clientHeight+50);if(!scroller)return false;const before=scroller.scrollTop;scroller.scrollTop=scroller.scrollHeight;scroller.dispatchEvent(new Event('scroll',{bubbles:true}));return before!==scroller.scrollTop;});}
 async communicate(job,options={}){
  let attempted=false,definitelyNotSent=false,targetId;
  const connection=this.connection,session=connection?.session,generation=connection?.generation??this.connectionGeneration;let port=this.port;
  const guard=()=>{
   assertActive(()=>options.guard?.()!==false);
   if(this.connection!==connection||(connection&&(connection.session!==session||connection.generation!==generation||session?.connected===false))||(!connection&&targetId&&this.port!==port))
    throw Object.assign(Error('沟通期间浏览器连接已变化，已停止操作'),{code:'BROWSER_CONNECTION_CHANGED'});
   if(targetId&&this.activeTargetId!==targetId)throw Object.assign(Error('沟通期间目标标签页已变化，已停止操作'),{code:'BROWSER_TARGET_CHANGED'});
  };
  const readyTimeoutMs=options.readyTimeoutMs??10000,confirmTimeoutMs=options.confirmTimeoutMs??8000,pollMs=options.pollMs??400;
  const expectedPath=jobUrlKey(job?.url),attemptId='contact-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
  const read=async(fn,...args)=>{
   guard();const target=(await this.targets()).find(t=>t.id===targetId);guard();
   let page;try{page=new URL(target?.url);}catch{}
   if(!target||target.type!=='page'||!page||page.protocol!=='https:'||!['www.zhipin.com','zhipin.com'].includes(page.hostname)||page.username||page.password||page.port)
    throw Object.assign(Error('已固定的岗位标签页已关闭或离开 BOSS，已停止操作'),{code:'BROWSER_TARGET_CHANGED'});
   assertBrowserPageAccess(target);
   if(page.pathname!==expectedPath&&!(attempted&&/^\/web\/geek\/chat\/?$/.test(page.pathname)))
    throw Object.assign(Error('已固定的岗位标签页跳转到了其他页面，未在其他页面沟通'),{code:'JOB_REDIRECTED'});
   const r=await this.command('Runtime.evaluate',{expression:`(${fn.toString()})(${args.map(a=>JSON.stringify(a)).join(',')})`,returnByValue:true,awaitPromise:true},target,{guard});
   guard();if(r.exceptionDetails)throw Object.assign(Error('沟通页面执行结果未能确认'),{code:'CDP_ERROR'});
   return r.result?.value;
  };
  // Poll a page reader until it returns a decisive value; tolerate the context
  // resets that BOSS's own client-side navigation causes.
  const poll=async(read,decisive,timeoutMs)=>{
   const deadline=Date.now()+Math.max(0,timeoutMs);let value;
   for(;;){
    try{value=await read();}catch(error){if(!transientContextError(error)||Date.now()>=deadline)throw error;value=undefined;}
    guard();if(decisive(value)||Date.now()>=deadline)return value;
    await pause(Math.min(pollMs,Math.max(1,deadline-Date.now())));guard();
   }
  };
  try{
   if(!expectedPath)throw Object.assign(Error('岗位链接无效，未发起沟通'),{code:'JOB_REDIRECTED'});
   guard();await this.navigate(job.url,{active:()=>{guard();return true;}});guard();
   port=this.port;targetId=this.activeTargetId;if(!targetId)throw Object.assign(Error('无法固定岗位标签页，未发起沟通'),{code:'BROWSER_TARGET_CHANGED'});
   // The detail page renders its buttons asynchronously. Wait for a decisive state
   // instead of judging a half-loaded page once after a fixed 1.6 s.
   let pre=await poll(()=>read(chatButtonStateDOM,expectedPath),v=>!!v&&v!=='loading'&&v!=='missing'&&v!=='redirected',readyTimeoutMs);
   if(!pre||pre==='loading')pre='missing';
   guard();
   if(pre!=='ready'){
    const [message,code]={auth:['需要在浏览器手动登录','AUTH_REQUIRED'],blocked:['需要在浏览器手动登录或验证','VERIFICATION_REQUIRED'],limit:['平台提示已到沟通上限','RATE_LIMITED'],
     already:['页面显示「继续沟通」：之前已与该 HR 建立会话，本次未重复发起','ALREADY_CONTACTED'],closed:['岗位已关闭或下线，未发起沟通','JOB_CLOSED'],
     redirected:['岗位页面跳转到了其他页面（可能已下线），未在其他页面点击沟通','JOB_REDIRECTED']}[pre]
     ||['等待 '+Math.round(readyTimeoutMs/1000)+' 秒仍未找到「立即沟通」按钮，未执行发送','CHAT_BUTTON_MISSING'];
    throw Object.assign(Error(message),{code,notSent:true});
   }
   guard();attempted=true;
   let clicked;
   // A lost evaluation response does not prove whether the click happened.
   // Never fabricate a successful click or dispatch a second one.
   clicked=await read(clickChatButtonDOM,expectedPath,attemptId);
   if(clicked===false||clicked?.clicked===false){
    definitelyNotSent=true;
    const code=['AUTH_REQUIRED','VERIFICATION_REQUIRED','RATE_LIMITED'].includes(clicked?.code)?clicked.code:'CHAT_BUTTON_MISSING';
    throw Object.assign(Error(code==='CHAT_BUTTON_MISSING'?'沟通按钮已变化，未发送':'BOSS 登录、验证或沟通限制已变化，未发送'),{notSent:true,code});
   }
   if(clicked?.clicked!==true)return {verified:false,reason:'沟通点击未返回明确结果，请到 BOSS 直聘核对；不会自动重复发起'};
   const before=typeof clicked==='object'?Number(clicked.marks)||0:0;
   await pause(Math.min(800,confirmTimeoutMs));
   const state=await poll(()=>read(chatConfirmationDOM,before,expectedPath,attemptId),v=>!!v&&v!=='pending',Math.max(0,confirmTimeoutMs-800));
   if(state==='auth')throw Object.assign(Error('点击沟通后 BOSS 要求登录，该岗位已标记待核实'),{code:'AUTH_REQUIRED'});
   if(state==='limit')throw Object.assign(Error('点击沟通后 BOSS 提示今日沟通已达上限，任务暂停；该岗位已标记待核实'),{code:'RATE_LIMITED'});
   if(state==='blocked')throw Object.assign(Error('点击沟通后 BOSS 要求安全验证，请在浏览器完成后继续；该岗位已标记待核实'),{code:'VERIFICATION_REQUIRED'});
   const verified=state==='sent';
   return {verified,reason:verified?'已点击沟通，页面已切换沟通状态':'已点击沟通，但 '+Math.round(confirmTimeoutMs/1000)+' 秒内页面未确认成功，请到 BOSS 直聘核对'};
  }catch(error){if(!attempted||definitelyNotSent)error.notSent=true;else{delete error.notSent;error.uncertain=true;}throw error;}
 }
 async sendJobGreeting(job,text,options={}){
  const guard=()=>assertActive(()=>options.guard?.()!==false);
  let result,targetId;
  try{
   guard();await this.openChat();guard();targetId=this.chatTargetId;
   result=await this.waitForConversationList({targetId,guard});guard();
  }catch(error){
   if(error.code==='CHAT_LIST_UNAVAILABLE')throw greetingTargetUnavailable('消息页尚未加载完成，专属招呼仍为草稿');
   error.notSent=true;throw error;
  }
  if(result.modernWithoutIds)return sendModernGreeting(createModernGreetingAdapter(this,{targetId,guard}),job,text,options);
  return sendGreeting(this,job,text,{...options,openedTargetId:targetId});
 }
 async chatAction(expected, action, text, options={}) {
  options.guard?.();
   let target;
    if(options.targetId){target=(await this.targets()).find(t=>t.id===options.targetId&&t.type==='page'&&isBossPage(t.url));if(!target)throw options.forGreeting?greetingTargetUnavailable('目标会话标签页已关闭或离开 BOSS，未执行发送'):Object.assign(Error('目标会话标签页已关闭或离开 BOSS，未执行发送'),{notSent:true});options.guard?.();}
  if (action !== 'fill') options.onAttempt?.();
   const guardedExpected=options.forGreeting?{...expected,noExistingOpening:true}:expected;
   const result = target?await this.evaluateOn(target,chatDOM,{expected:guardedExpected,action,text}):await this.evaluate(chatDOM, {expected:guardedExpected, action, text});
   if(options.forGreeting&&result?.notSent===true&&
     (result.code==='GREETING_ALREADY_PRESENT'&&result.alreadyGreeted===true||result.code==='GREETING_PRESENCE_UNCERTAIN'&&result.presenceUnknown===true))
     return {verified:false,notSent:true,code:result.code,conversation:result.conversation,
       ...(result.code==='GREETING_ALREADY_PRESENT'?{alreadyGreeted:true,receiptId:result.receiptId}:{presenceUnknown:true})};
  if (result?.error || !result?.ok) {
   const error = Error(result?.error || '网页操作未确认');
    if(result?.code)error.code=result.code;
   error.notSent = true;
    if(options.forGreeting&&/会话.*(?:切换|身份|不一致)|岗位信息不一致/.test(error.message))throw greetingTargetUnavailable(error.message,error);
   throw error;
  }
  return result;
 }
 async sendChat(conversation,text,options={}) {
  options.guard?.();
    const before = await this.readChat({targetId:options.targetId,forGreeting:options.forGreeting});
   try{assertConversation(conversation,before);}catch(error){throw options.forGreeting?greetingTargetUnavailable(error.message,error):error;}
  if(options.forGreeting){const existing=greetingOpeningPresence(before);if(existing)return existing;}
  const filled=await this.chatAction(conversation,'fill',text,options);
  if(options.forGreeting&&filled?.notSent===true&&['GREETING_ALREADY_PRESENT','GREETING_PRESENCE_UNCERTAIN'].includes(filled.code))return filled;
  await pause(250);
  const sent=await this.chatAction(conversation,'send',text,options);
  if(options.forGreeting&&sent?.notSent===true&&['GREETING_ALREADY_PRESENT','GREETING_PRESENCE_UNCERTAIN'].includes(sent.code))return sent;
  await pause(600);
   const after = await this.readChat({targetId:options.targetId});
  assertConversation(conversation,after);
  return after.messages.filter(m=>m.role==='assistant'&&m.text===text).length > before.messages.filter(m=>m.role==='assistant'&&m.text===text).length;
 }
 async refreshGreetingChat(options={}){return refreshChat(this,options);}
 async assertGreetingChatIdle(options={}){return assertChatIdle(this,options);}
 async focusGreetingChat({targetId=this.chatTargetId,generation=this.connection?.generation??this.connectionGeneration??0,guard=()=>true}={}){
  const check=()=>{
   if(guard()===false)throw Object.assign(Error('操作已停止'),{code:'CANCELLED',notSent:true});
   if(this.connection?.session?.connected===false)throw Object.assign(Error('Chrome 调试连接已断开'),{code:'CDP_DISCONNECTED',notSent:true});
   if(!targetId||(this.connection?.generation??this.connectionGeneration??0)!==generation||this.chatTargetId!==targetId||this.activeTargetId!==targetId)
    throw greetingTargetUnavailable('消息标签页或浏览器连接已切换，未切换页面');
  };
  const target=async()=>{
   check();const current=(await this.targets()).find(item=>item.id===targetId);check();
   if(current&&isBossPage(current.url)){
    const pathname=new URL(current.url).pathname;
    if(pathname==='/web/passport/zp/security.html')throw Object.assign(Error('BOSS 要求安全验证，请手动完成后继续'),{code:'VERIFICATION_REQUIRED',notSent:true});
    if(/\/(?:login|passport)(?:\/|$)/.test(pathname))throw Object.assign(Error('BOSS 要求登录，请登录后继续'),{code:'AUTH_REQUIRED',notSent:true});
   }
   if(browserPageRole(current)!=='chat')throw greetingTargetUnavailable('本次消息页已关闭或离开消息页面，未切换到其他标签页');
   return current;
  };
  try{const current=await target();check();await this.command('Page.bringToFront',{},current,{guard:check});await target();return {focused:true,targetId,generation};}
  catch(error){error.notSent=true;throw error;}
 }
 async assertGreetingForeground({active=()=>true,job,targetId,generation,foregroundTimeoutMs=2500,foregroundPollMs=100,foregroundNow=Date.now,foregroundWait=pause,...idleOptions}={}){
  const connection=this.connection,session=connection?.session;let pinned=false;
  const hidden=()=>Object.assign(Error('消息页仍不在前台，未恢复专属招呼'),{code:'GREETING_TARGET_UNAVAILABLE',reason:'CHAT_NOT_FOREGROUND',notSent:true});
  const check=()=>{
   assertActive(active);
   if(connection?.session?.connected===false)throw Object.assign(Error('Chrome 调试连接已断开'),{code:'CDP_DISCONNECTED'});
   if(!targetId||generation===undefined||this.connection!==connection||connection?.session!==session||
      (this.connection?.generation??this.connectionGeneration??0)!==generation||this.chatTargetId!==targetId||(pinned&&this.activeTargetId!==targetId))
    throw greetingTargetUnavailable('原消息标签页或浏览器连接已变化，未恢复专属招呼');
  };
  const target=async()=>{
   check();const current=(await this.targets()).find(item=>item.id===targetId);check();assertBrowserPageAccess(current);
   if(browserPageRole(current)!=='chat')throw greetingTargetUnavailable('原消息页已关闭或离开消息页面，未选择其他标签页');
   return current;
  };
  const observe=async()=>{
   const current=await target();
   // Reuse the existing sanitized read-only guard so auth, dialogs and drafts
   // are never disguised as foreground failures, including while hidden.
   const state=await this.evaluateOn(current,chatRefreshDOM,{action:'inspect'});await target();
   if(!state?.ok||state.error)throw Object.assign(Error(state?.error||'消息页安全状态未返回可靠结果'),{code:state?.code||'GREETING_TARGET_UNAVAILABLE'});
   if(state.safeToRefresh!==true&&!(state.readiness==='loading'&&['DOCUMENT_LOADING','LIST_LOADING','CONVERSATION_MOUNTING'].includes(state.reason)))
    throw Object.assign(greetingTargetUnavailable('消息页编辑区或结构不可用，未恢复专属招呼'),{readiness:state.readiness,reason:state.reason});
   const visibility=await this.evaluateOn(current,greetingVisibilityDOM);await target();
   if(!['visible','hidden'].includes(visibility?.visibilityState))throw greetingTargetUnavailable('无法确认消息页可见性，未恢复专属招呼');
   return {visible:visibility.visibilityState==='visible',safeToRefresh:state.safeToRefresh};
  };
  try{
   await target();check();this.activeTargetId=targetId;pinned=true;
   const focused=await this.focusGreetingChat({targetId,generation,guard:check});await target();
   if(focused?.focused!==true||focused.targetId!==targetId||focused.generation!==generation)
    throw greetingTargetUnavailable('未确认已返回原消息页，未恢复专属招呼');
   const timeoutMs=Math.min(2500,Math.max(0,Number(foregroundTimeoutMs)||0));
   const pollMs=Math.max(1,Math.min(200,Number(foregroundPollMs)||1));
   const deadline=foregroundNow()+timeoutMs,maxPolls=Math.ceil(timeoutMs/pollMs);
   for(let polls=0;;polls++){
    if((await observe()).visible)break;
    const remaining=deadline-foregroundNow();if(remaining<=0||polls>=maxPolls)throw hidden();
    await foregroundWait(Math.min(pollMs,remaining));check();
   }
   const idle=await this.assertGreetingChatIdle({...idleOptions,targetId,generation,guard:check});await target();
   if(idle?.idle!==true||idle.targetId!==targetId||idle.generation!==generation)
    throw greetingTargetUnavailable('未确认原消息页编辑区安全，未恢复专属招呼');
   const final=await observe();if(!final.visible)throw hidden();
   if(final.safeToRefresh!==true)throw greetingTargetUnavailable('消息页编辑区在核验后发生变化，未恢复专属招呼');
   return {available:true,foreground:true,targetId,generation};
  }catch(error){error.notSent=true;throw error;}
 }
 async openChat(){
  await this.launch();
  const chats=(await this.targets()).filter(t=>browserPageRole(t)==='chat');
  if(!chats.some(t=>t.id===this.chatTargetId))this.chatTargetId=null;
  let t=chats.find(t=>t.id===this.chatTargetId)||chats.find(t=>t.id===this.connection?.preferredTargetId);
  if(!t&&chats.length===1)t=chats[0];
  if(!t&&chats.length>1)throw greetingTargetUnavailable('发现多个 BOSS 消息页，请在管理浏览器连接中选中正在使用的消息页');
  if(!t){t=await this.newTab('https://www.zhipin.com/web/geek/chat');await pause(1800);}
  this.chatTargetId=t.id;this.activeTargetId=t.id;
 }
 async openGreetingJob({targetId=this.chatTargetId,generation=this.connection?.generation??this.connectionGeneration??0,expected,guard=()=>true,foregroundTimeoutMs=2500,foregroundPollMs=100,foregroundNow=Date.now,foregroundWait=pause}={}){
  const check=(cleanup=false)=>{
   if(!cleanup&&guard()===false)throw Object.assign(Error('操作已停止'),{code:'CANCELLED',notSent:true});
   if(this.connection?.session?.connected===false)throw Object.assign(Error('Chrome 调试连接已断开'),{code:'CDP_DISCONNECTED',notSent:true});
   if(!targetId||(this.connection?.generation??this.connectionGeneration??0)!==generation||this.chatTargetId!==targetId||this.activeTargetId!==targetId)
    throw greetingTargetUnavailable('本次消息页或浏览器连接已切换，未点击岗位入口');
  };
  const target=async(cleanup=false)=>{
   check(cleanup);const current=(await this.targets()).find(item=>item.id===targetId);check(cleanup);
   if(current&&isBossPage(current.url)){
    const pathname=new URL(current.url).pathname;
    if(pathname==='/web/passport/zp/security.html')throw Object.assign(Error('BOSS 要求安全验证，请手动完成后继续'),{code:'VERIFICATION_REQUIRED',notSent:true});
    if(/\/(?:login|passport)(?:\/|$)/.test(pathname))throw Object.assign(Error('BOSS 要求登录，请登录后继续'),{code:'AUTH_REQUIRED',notSent:true});
   }
   if(browserPageRole(current)!=='chat')throw greetingTargetUnavailable('已固定的消息页不可用，未点击其他页面');
   return current;
  };
  let point,pressed=false,released=false;
  const release=async(cleanup=false)=>{
   const current=await target(cleanup);check(cleanup);released=true;
   await this.command('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',buttons:0,clickCount:1},current);
  };
  try{
   const locate=async()=>{const current=await target();const result=await this.evaluateOn(current,modernChatDOM,{action:'locateJobEntry',expected});await target();return result;};
   const background=result=>result?.modern===true&&result.notSent===true&&result.code==='MODERN_CHAT_ACTION_UNAVAILABLE'&&result.reason==='CHAT_NOT_FOREGROUND'&&!!result.error;
   point=await locate();
   if(background(point)){
    // Only a positively identified background page can recover, and only
    // before any mouse dispatch. Re-evaluate all identity/anchor/hit checks;
    // never reuse the old coordinates or repeat a click after a lost reply.
    const focused=await this.focusGreetingChat({targetId,generation,guard});await target();
    if(focused?.focused!==true||focused.targetId!==targetId||focused.generation!==generation)
     throw greetingTargetUnavailable('未确认已返回同一消息页，未点击岗位入口');
    // Bringing the tab forward and pinning it can itself take over a second.
    // Give visibility its full observation window only after those calls finish.
    const timeoutMs=Math.min(2500,Math.max(0,Number(foregroundTimeoutMs)||0));
    const pollMs=Math.max(1,Math.min(200,Number(foregroundPollMs)||1));
    const deadline=foregroundNow()+timeoutMs,maxPolls=Math.ceil(timeoutMs/pollMs);
    for(let polls=0;;polls++){
     point=await locate();
     const remaining=deadline-foregroundNow();
     if(!background(point)||remaining<=0||polls>=maxPolls)break;
     await foregroundWait(Math.min(pollMs,remaining));check();
    }
   }
   if(point?.error)throw Object.assign(Error(point.error),{code:point.code||'GREETING_TARGET_UNAVAILABLE',notSent:true},point.reason==='CHAT_NOT_FOREGROUND'?{reason:point.reason}:{});
   if(point?.ok!==true||point.modern!==true||point.occluded===true||![point.x,point.y,point.viewport?.width,point.viewport?.height].every(Number.isFinite)||
      point.x<0||point.y<0||point.x>=point.viewport.width||point.y>=point.viewport.height)
    throw greetingTargetUnavailable('未确认岗位入口的可见视口坐标，未点击');
   const pinned=await target();check();pressed=true;
   await this.command('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1},pinned);
   await release();await target();
   return {ok:true,openedJob:true,targetId,generation};
  }catch(error){error.notSent=true;throw error;}
  finally{
   // An interrupted press can leave the pointer held down. Release at most
   // once, only through the same still-valid page and connection; never retry
   // the click or follow a replacement page. Preserve the original failure.
   if(pressed&&!released)try{await release(true);}catch{}
  }
 }
 async assertGreetingAvailable({active=()=>true,job,...options}={}){
  // This is a read-only capability check BEFORE clicking 立即沟通, which can
  // trigger BOSS's own fixed first greeting. It is not recipient verification;
  // sendJobGreeting must still bind and recheck the particular job/HR.
  const check=()=>assertActive(active);check();
  try{
   await this.openChat();check();
   const targetId=this.chatTargetId,generation=this.connection?.generation??this.connectionGeneration??0;
   const guard=()=>{check();if(!targetId||this.chatTargetId!==targetId||this.activeTargetId!==targetId||
    (this.connection?.generation??this.connectionGeneration??0)!==generation)throw greetingTargetUnavailable('消息标签页或连接已切换，尚未发起沟通；请重新连接后再试');};
   guard();const result=await this.waitForConversationList({...options,targetId,guard});guard();
   if(result.modernWithoutIds){
    if(!jobUrlKey(job?.url)||!String(job?.title||'').trim()||!isUsableCompanyName(job?.company)||!String(job?.hrName||'').trim())
     throw greetingTargetUnavailable('岗位缺少完整链接、公司或 HR 信息，尚未发起沟通；请重新读取岗位详情');
    // Check the same loading/draft conditions that recipient selection requires,
    // before platform contact can trigger its own opening message.
    const idle=await this.assertGreetingChatIdle({...options,targetId,generation,guard});guard();
    if(idle?.idle!==true||idle.targetId!==targetId||idle.generation!==generation)
     throw greetingTargetUnavailable('消息页输入状态尚未核实，未发起新沟通');
    const target=(await this.targets()).find(t=>t.id===targetId);guard();
    if(!target)throw greetingTargetUnavailable('消息页已关闭，尚未发起沟通');
    const capability=await this.evaluateOn(target,modernGreetingCapabilityDOM);guard();
    if(capability?.error)throw Object.assign(Error(capability.error),{code:capability.code});
    if(!capability?.available)throw greetingTargetUnavailable(capability?.reason||'新版消息页尚未加载完整，专属招呼仍为草稿');
    return {available:true,modern:true,requiresJobProof:true};
   }
   if(!result.conversations?.some(item=>item.remoteId&&item.contact&&(item.jobUrl||item.company&&item.jobTitle)))
    throw greetingTargetUnavailable('当前消息页缺少岗位核对信息，尚未发起沟通；专属招呼已保留');
   return {available:true};
  }catch(error){
   if(error.code==='CHAT_LIST_UNAVAILABLE')throw greetingTargetUnavailable('消息页面暂不可读，尚未发起沟通。专属招呼已保留，请等待消息页加载后重试。');
   error.notSent=true;throw error;
  }
 }
 async conversationListSnapshot(mode='read',options={}){
  const guard=()=>assertActive(()=>options.guard?.()!==false);guard();let target;
  if(options.targetId){target=(await this.targets()).find(t=>t.id===options.targetId&&t.type==='page'&&isBossPage(t.url));guard();if(!target)throw greetingTargetUnavailable('目标消息页面已关闭或离开 BOSS，未发送专属招呼');}
  const result=target?await this.evaluateOn(target,conversationListDOM,{mode}):await this.evaluate(conversationListDOM,{mode});guard();return result;
 }
 async waitForConversationList(options={}){
  const {timeoutMs=8000,pollMs=400}=options,deadline=Date.now()+Math.max(0,timeoutMs);
  const guard=()=>assertActive(()=>options.guard?.()!==false);let last;
  do{
   guard();
   try{last=await this.conversationListSnapshot('read',options);}
   catch(error){guard();if(!transientContextError(error)||Date.now()>=deadline)throw error;last={error:'消息页正在切换，请等待列表加载',code:'CHAT_LIST_UNAVAILABLE'};}
   guard();
   if(last?.error&&last.code!=='CHAT_LIST_UNAVAILABLE')throw Object.assign(Error(last.error),{code:last.code});
   if(last&&!last.error&&!last.loading&&last.conversations?.length!==0)return last;
   if(Date.now()>=deadline)break;
   await pause(Math.min(Math.max(1,pollMs),deadline-Date.now()));
  }while(Date.now()<=deadline);
  guard();throw Object.assign(Error('等待消息列表加载超时，未发送专属招呼'),{code:'CHAT_LIST_UNAVAILABLE'});
 }
 async listConversations(options={}){await this.openChat();const result=await this.waitForConversationList(options);if(options.forGreeting&&result.modernWithoutIds)throw greetingTargetUnavailable('当前 BOSS 会话列表未提供可靠的平台身份，无法安全确认目标 HR；定制招呼未发送');return result.conversations;}
 async selectConversation(c,options={}){await this.openChat();const selected=await this.evaluate(c=>{const root=document.querySelector('.user-list,.chat-user-list,.conversation-list,.chat-list');const nodes=[...(root?.querySelectorAll('.user-item,.chat-user,.conversation-item,.friend-item,li')||[])].filter(e=>e.getBoundingClientRect().height>0);let matches=c.remoteId?nodes.filter(e=>[e.getAttribute('data-conversation-id'),e.getAttribute('data-uid'),e.getAttribute('data-id'),e.getAttribute('data-geekid')].includes(c.remoteId)):nodes.filter(e=>(e.querySelector('.name,.user-name,.nickname')?.innerText?.trim()||e.innerText.split('\n').filter(Boolean)[0])===c.contact&&(!c.company||e.innerText.includes(c.company))&&(!c.jobTitle||e.innerText.includes(c.jobTitle)));if(matches.length!==1)return false;matches[0].click();return true;},c);if(!selected)throw options.forGreeting?greetingTargetUnavailable('会话不存在或存在同名歧义，定制招呼未发送'):Error('会话不存在或存在同名歧义，请手动选择后重新同步');await pause(650);const current=await this.readChat(options);try{assertConversation(c,current);}catch(error){throw options.forGreeting?greetingTargetUnavailable(error.message,error):error;}}
 async readChat(options={}) {
   let target;
    if(options.targetId){target=(await this.targets()).find(t=>t.id===options.targetId&&t.type==='page'&&isBossPage(t.url));if(!target)throw options.forGreeting?greetingTargetUnavailable('目标会话标签页已关闭或离开 BOSS'):Error('目标会话标签页已关闭或离开 BOSS');}
   else if(this.chatTargetId)this.activeTargetId=this.chatTargetId;
   else {if(!this.port)await this.owned();const t=(await this.targets()).find(t=>t.type==='page'&&isBossPage(t.url)&&t.url.includes('/chat'));if(t)this.activeTargetId=t.id;}
   const current=target?await this.evaluateOn(target,chatDOM):await this.evaluate(chatDOM);
   if(current?.error){const error=Object.assign(Error(current.error),current.code?{code:current.code}:{});if(options.forGreeting&&/会话.*(?:身份|不一致)|岗位信息不一致/.test(error.message))throw greetingTargetUnavailable(error.message,error);throw error;}
   if(!current?.remoteId)throw options.forGreeting?greetingTargetUnavailable('未读取到当前会话的平台 ID，定制招呼未发送'):Error('未读取到当前会话的平台 ID，请重新同步；不会沿用旧会话');
  return {...current,id:current.remoteId};
 }
 async readHistory(){let current=await this.readChat();if(current.error)throw Error(current.error);const initial=current;let messages=[...current.messages],previous='',stable=0;for(let i=0;i<200;i++){await this.evaluate(()=>{const root=document.querySelector('.chat-record,.chat-message-list,.message-list,.chat-conversation');if(!root)throw Error('聊天记录不可读');const container=[root,...root.querySelectorAll('*')].find(e=>e.scrollHeight>e.clientHeight+50)||root;container.scrollTop=0;container.dispatchEvent(new Event('scroll',{bubbles:true}));const more=document.querySelector('.load-more,.history-more');if(more&&more.getBoundingClientRect().height>0)more.click();});await pause(650);current=await this.readChat();assertConversation(initial,current);if(current.error)throw Error(current.error);const known=new Set(messages.map(m=>m.remoteId)),older=current.messages.filter(m=>!known.has(m.remoteId));messages=[...older,...messages];const sig=current.messages[0]?.remoteId+'|'+messages.length;stable=sig===previous?stable+1:0;if(stable>=3)return {...current,messages:messages.map((m,i)=>({...m,sequence:i})),historyComplete:true};previous=sig;}return {...current,messages:messages.map((m,i)=>({...m,sequence:i})),historyComplete:false};}
 async resetConversations(options={}){await this.waitForConversationList(options);const result=await this.conversationListSnapshot('reset',options);if(result.error)throw Object.assign(Error(result.error),{code:result.code});if(result.unavailable)throw Object.assign(Error('无法确认会话列表的滚动容器'),{code:'CHAT_LIST_UNAVAILABLE'});await pause(400);assertActive(()=>options.guard?.()!==false);}
 async scrollConversations(options={}){
  await this.waitForConversationList(options);
  const result=await this.conversationListSnapshot('scroll',options);
  if(result.error)throw Object.assign(Error(result.error),{code:result.code});
  if(result.unavailable){if(options.progress)return result;throw Object.assign(Error('无法确认会话列表的滚动容器'),{code:'CHAT_LIST_UNAVAILABLE'});}
  await pause(300);const settled=await this.conversationListSnapshot('snapshot',options);
  if(settled.error)throw Object.assign(Error(settled.error),{code:settled.code});
  if(settled.unavailable){if(options.progress)return settled;throw Object.assign(Error('会话列表滚动容器已变化'),{code:'CHAT_LIST_UNAVAILABLE'});}
  const complete=result.before.atBottom&&result.after.atBottom&&settled.atBottom&&!result.before.loading&&!result.after.loading&&!settled.loading&&result.before.height===settled.height&&result.before.signature===settled.signature;
  const progress={complete,moved:settled.top>result.before.top+1,changed:settled.signature!==result.before.signature,atBottom:settled.atBottom,top:settled.top,height:settled.height};
  return options.progress?progress:!complete;
 }
 async sendAttachment(conversation,options={}) {
  options.guard?.();
  const before=await this.readChat();assertConversation(conversation,before);
  await this.chatAction(conversation,'attachment',undefined,options);
  await pause(600);
  // If stopped after the first click, keep the attempt uncertain and do not
  // click a second confirmation or silently retry it later.
  const pending=await this.chatAction(conversation,'confirm-attachment',undefined,options);
  await pause(500);
  const after=await this.readChat();assertConversation(conversation,after);
  const receipt=after.messages.find(m=>m.role==='assistant'&&m.kind==='attachment'&&m.deliveryStatus==='confirmed'&&
    !before.messages.some(b=>b.remoteId===m.remoteId&&b.kind==='attachment'&&b.deliveryStatus==='confirmed'));
  const verified=!!receipt;
  return {verified,request:!!receipt?.attachmentRequest,receiptId:receipt?.remoteId,
   reason:verified?(receipt.attachmentRequest?'已确认发出附件请求，等待对方接受':'已确认本人发送的附件卡片'):'未读取到本人附件卡片的成功回执，状态待核实，不会自动重试',pending:pending.confirmed};
 }
 async companyInfo(job){if(!job.companyUrl){await this.navigate(job.url);const d=await this.detail();job={...job,...d};}if(!job.companyUrl)throw Error('未找到公司主页链接，请先读取岗位详情或填写公司主页地址');const u=new URL(job.companyUrl);if(!isBossPage(u.href)||!/^\/gongsi(?:_detail)?\//.test(u.pathname))throw Error('需要有效的 BOSS 公司主页链接');await this.launch();const t=await this.newTab(u.href);try{this.activeTargetId=t.id;await pause(1800);return await this.evaluate(()=>{const text=document.body.innerText;if(/安全验证|请完成验证|拖动滑块/.test(text))throw Error('公司页面需要手动验证');const value=label=>{const r=new RegExp(label+'[：:\\s]*([^\\n]{1,120})').exec(text);return r?.[1]?.trim()||'';};return {name:document.querySelector('h1,.company-name')?.innerText?.trim()||'',legalName:value('企业名称')||value('公司名称'),legalRepresentative:value('法定代表人')||value('法人代表'),capital:value('注册资本'),founded:value('成立日期')||value('成立时间'),status:value('经营状态'),industry:value('所属行业'),description:text.slice(-12000),source:location.href};});}finally{await this.command('Target.closeTarget',{targetId:t.id},t).catch(()=>{});this.activeTargetId=null;}}
 async searchCompany(name){await this.launch();const t=await this.newTab('https://www.bing.com/search?q='+encodeURIComponent('"'+name+'" 欠薪 裁员 失信 劳动争议'));try{await pause(2200);const result=await this.command('Runtime.evaluate',{expression:`(()=>{if(/验证码|captcha/i.test(document.body.innerText))return {blocked:true,results:[]};return {results:[...document.querySelectorAll('#b_results .b_algo')].slice(0,8).map(e=>({title:e.querySelector('h2')?.innerText||'',url:e.querySelector('h2 a')?.href||'',snippet:e.querySelector('.b_caption p')?.innerText||''})).filter(r=>r.title&&/^https?:/.test(r.url))};})()`,returnByValue:true},t);const r=result.result?.value;if(r?.blocked)throw Error('公开搜索需要人工验证，企业报告会保留信息不足');return r?.results||[];}finally{await this.command('Target.closeTarget',{targetId:t.id},t).catch(()=>{});}}
 async close(){if(this.existing){this.connection.disconnect();this.syncConnection();return;}const t=(await this.targets()).find(t=>t.type==='page');if(t)await this.command('Browser.close',{},t).catch(()=>{});this.port=0;this.activeTargetId=null;this.mainTargetId=null;this.detailTargetId=null;this.chatTargetId=null;}
}
