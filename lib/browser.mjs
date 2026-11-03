import {chatDOM} from './chat-dom.mjs';
import {assertConversation} from './conversation.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export function isBossPage(url){try{const u=new URL(url);return u.protocol==='https:'&&['www.zhipin.com','zhipin.com'].includes(u.hostname);}catch{return false;}}
export const cities={'全国':'100010000','北京':'101010100','上海':'101020100','广州':'101280100','深圳':'101280600','杭州':'101210100','成都':'101270100','武汉':'101200100','南京':'101190100','苏州':'101190400','西安':'101110100','长沙':'101250100','重庆':'101040100','天津':'101030100','郑州':'101180100','合肥':'101220100','厦门':'101230200','福州':'101230100','济南':'101120100','青岛':'101120200','东莞':'101281600','佛山':'101280800'};
export function chromePath(){const list=[process.env.GHOST_CHROME,path.join(process.env.PROGRAMFILES||'C:\\Program Files','Google/Chrome/Application/chrome.exe'),path.join(process.env['PROGRAMFILES(X86)']||'C:\\Program Files (x86)','Google/Chrome/Application/chrome.exe'),path.join(process.env.LOCALAPPDATA||'','Google/Chrome/Application/chrome.exe')];const found=list.find(p=>p&&fs.existsSync(p));if(!found)throw Error('没有找到 Google Chrome，请安装后重试');return found;}
export function openApp(url,dir){const p=spawn(chromePath(),['--app='+url,'--user-data-dir='+path.join(dir,'app-profile'),'--no-first-run','--no-default-browser-check','--window-size=1280,900'],{detached:true,stdio:'ignore',windowsHide:false});p.on('error',()=>{});p.unref();}
export class Browser{
 constructor(dir,role='jobs'){this.dir=dir;this.role=role;this.port=0;this.process=null;this.activeTargetId=null;this.mainTargetId=null;this.detailTargetId=null;this.chatTargetId=null;this.portFile=path.join(dir,'boss-profile','DevToolsActivePort');}
 async targets(){try{const r=await fetch(`http://127.0.0.1:${this.port}/json/list`,{signal:AbortSignal.timeout(2000)});return await r.json();}catch{return [];}}
 async owned(){try{const [port,endpoint]=fs.readFileSync(this.portFile,'utf8').trim().split(/\r?\n/);const n=Number(port);if(!Number.isInteger(n)||n<1)return false;const r=await fetch(`http://127.0.0.1:${n}/json/version`,{signal:AbortSignal.timeout(2000)});const v=await r.json();if(!v.webSocketDebuggerUrl?.endsWith(endpoint))return false;this.port=n;return true;}catch{return false;}}
 async waitForBossPage(timeoutMs=15000){const deadline=Date.now()+timeoutMs;do{const page=(await this.targets()).find(t=>t.type==='page'&&isBossPage(t.url));if(page){this.activeTargetId=page.id;return page;}await pause(200);}while(Date.now()<deadline);throw Error('浏览器已打开，但 BOSS 直聘页面尚未加载。请检查网络或代理，等待页面出现后重试。');}
 async launch(){if(await this.owned()){if(!(await this.targets()).some(t=>t.type==='page'&&isBossPage(t.url)))await this.newTab('https://www.zhipin.com/web/geek/job');await this.waitForBossPage();return;}
  fs.mkdirSync(path.join(this.dir,'boss-profile'),{recursive:true});this.process=spawn(chromePath(),['--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+path.join(this.dir,'boss-profile'),'--no-first-run','--no-default-browser-check','https://www.zhipin.com/web/geek/job'],{stdio:'ignore',windowsHide:false});let spawnError;this.process.on('error',e=>spawnError=e);
  for(let i=0;i<50;i++){if(spawnError)throw spawnError;if(await this.owned()){await this.waitForBossPage();return;}await pause(300);}throw Error('浏览器启动超时，请检查 Chrome 是否正常');
 }
 async newTab(url){const r=await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`,{method:'PUT',signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('无法创建浏览器标签页');return r.json();}
 async target(){if(!this.port)await this.owned();const all=(await this.targets()).filter(t=>t.type==='page'&&isBossPage(t.url));const t=all.find(t=>t.id===this.activeTargetId)||all[0];if(!t)throw Error('请先打开求职浏览器，等待 BOSS 直聘页面加载并完成登录');return t;}
 async command(method,params={},target){const t=target||await this.target();return new Promise((resolve,reject)=>{const ws=new WebSocket(t.webSocketDebuggerUrl);const timer=setTimeout(()=>{ws.close();reject(Error('浏览器响应超时'));},15000);const done=(err,result)=>{clearTimeout(timer);ws.close();err?reject(err):resolve(result);};ws.addEventListener('open',()=>ws.send(JSON.stringify({id:1,method,params})));ws.addEventListener('message',e=>{let r;try{r=JSON.parse(e.data);}catch{return;}if(r.id===1)done(r.error?Error(r.error.message):null,r.result);});ws.addEventListener('error',()=>done(Error('浏览器连接中断')));});}
 async evaluate(fn,...args){const r=await this.command('Runtime.evaluate',{expression:`(${fn.toString()})(${args.map(a=>JSON.stringify(a)).join(',')})`,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error('网页解析失败，请刷新页面后重试');return r.result?.value;}
 async status(){if(!await this.owned())return {connected:false,url:'',title:''};const t=await this.targets();const page=t.find(x=>x.type==='page'&&isBossPage(x.url));return {connected:!!page,url:page?.url||'',title:page?.title||''};}
 async navigate(url){const u=new URL(url);if(u.protocol!=='https:'||!['www.zhipin.com','zhipin.com'].includes(u.hostname))throw Error('仅支持 BOSS 直聘岗位链接');if(!this.port)await this.owned();const all=await this.targets();let selected;
  if(u.pathname.startsWith('/job_detail/')){selected=all.find(t=>t.id===this.detailTargetId);if(!selected){selected=await this.newTab('about:blank');this.detailTargetId=selected.id;}}
  else{selected=all.find(t=>t.id===this.mainTargetId)||all.find(t=>t.type==='page'&&t.url.includes('/web/geek/job'));if(!selected)selected=await this.target();this.mainTargetId=selected.id;}
  this.activeTargetId=selected.id;if(selected.url===url)return;await this.command('Page.navigate',{url},selected);await pause(1600);
 }
 async search(keyword,city){if(!cities[city])throw Error('暂不支持城市：'+city+'；请从配置中心的城市列表选择');await this.navigate('https://www.zhipin.com/web/geek/job?query='+encodeURIComponent(keyword)+'&city='+cities[city]);}
 async readJobs(){return this.evaluate(()=>{
  const visible=e=>e&&e.getBoundingClientRect().height>0&&getComputedStyle(e).visibility!=='hidden';
  const jobURL=a=>{try{const u=new URL(a.href);return u.protocol==='https:'&&['www.zhipin.com','zhipin.com'].includes(u.hostname)&&/^\/job_detail\/[^/]+\.html$/.test(u.pathname)?u:null;}catch{return null;}};
  const body=document.body.innerText;
  if(/安全验证|请完成验证|拖动滑块|访问过于频繁/.test(body))return {blocked:'页面要求验证，请在浏览器中手动完成后继续',jobs:[]};
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
   const company=text('.company-name,.company-text .name,.company-info h3,.company-title,a[href*="/gongsi/"],a[href*="/gongsi_detail/"]');
   const salary=text('.salary,.red,.job-salary')||(el.innerText.match(/\d+(?:\.\d+)?\s*[-–]\s*\d+(?:\.\d+)?\s*(?:K|k|万|元\/(?:月|天|时))(?:[·・]\d+薪)?/)||[])[0]||'';
   const tags=[...el.querySelectorAll('.tag-list li,.job-labels span,.company-tag-list li')].filter(visible).map(x=>x.innerText);const raw=el.innerText;
   return {url:url.href,title,company,companyUrl:el.querySelector('a[href*="/gongsi/"]')?.href||'',salary,city:text('.job-area,.job-area-wrapper,.area,.job-location,.job-address'),tags,experience:tags.find(x=>/经验|应届|在校|\d.*年/.test(x))||'',education:tags.find(x=>/学历|初中|高中|中专|大专|本科|硕士|博士/.test(x))||'',industry:[...el.querySelectorAll('.company-tag-list li')].map(x=>x.innerText).find(x=>!/[0-9].*人|融资|轮|上市/.test(x))||'',companySize:tags.find(x=>/\d.*人/.test(x))||'',financing:tags.find(x=>/融资|轮|上市/.test(x))||'',jobType:/兼职/.test(raw)?'兼职':/实习/.test(raw)?'实习':'全职',description:raw.slice(0,6000),source:'BOSS直聘'};
  }).filter(x=>x.title);
  const unique=[...new Map(jobs.map(j=>[j.url,j])).values()];
  return {jobs:unique,blocked:unique.length?'':(/扫码登录|密码登录|立即登录/.test(body)?'请在浏览器中完成 BOSS 直聘登录':'没有读取到岗位。请等待页面加载，或打开搜索结果页；页面结构变化时需要更新适配器。')};
 });}
 async detail(){return this.evaluate(()=>{const text=document.body.innerText;if(/安全验证|请完成验证|拖动滑块/.test(text))throw Error('需要手动完成页面验证');const active=(text.match(/(?:刚刚|今日|今天|3日内|三日内|本周|2周内|本月|近期|很久未)活跃|当前在线/)||[])[0]||'';return {description:document.querySelector('.job-sec-text,.job-detail-section .text,.job-detail .text')?.innerText||'',title:document.querySelector('.job-name h1,.name h1')?.innerText||'',hrActivity:active,hrName:document.querySelector('.boss-info .name,.job-boss-info .name')?.innerText?.trim()||'',companyUrl:document.querySelector('.job-company a[href*="/gongsi/"],.company-info a[href*="/gongsi/"]')?.href||'',company:document.querySelector('.company-info .name,.job-company .name')?.innerText?.trim()||''};});}
 async nextPage(){return this.evaluate(()=>{const next=document.querySelector('.ui-icon-arrow-right,.options-pages a.next,.pagination-next');const el=next?.closest('a,button')||next;if(el&&!String(el.className).includes('disabled')&&el.getAttribute('aria-disabled')!=='true'){el.click();return true;}const root=document.querySelector('.job-list-box,.job-list-container')||document.scrollingElement;const scroller=[root,root.parentElement,document.scrollingElement].find(e=>e&&e.scrollHeight>e.clientHeight+50);if(!scroller)return false;const before=scroller.scrollTop;scroller.scrollTop=scroller.scrollHeight;scroller.dispatchEvent(new Event('scroll',{bubbles:true}));return before!==scroller.scrollTop;});}
 async communicate(job){await this.navigate(job.url);const pre=await this.evaluate(()=>{const body=document.body.innerText;if(/安全验证|请完成验证|拖动滑块|扫码登录/.test(body))return 'blocked';if(/今日沟通.*上限|沟通次数.*上限/.test(body))return 'limit';const b=[...document.querySelectorAll('a,button')].find(e=>e.getBoundingClientRect().height>0&&e.innerText.trim()==='立即沟通');if(!b)return /继续沟通|已沟通/.test(body)?'already':'missing';return 'ready';});
  if(pre!=='ready')throw Error({blocked:'需要在浏览器手动登录或验证',limit:'平台提示已到沟通上限',already:'页面显示已沟通，请人工核对',missing:'未找到立即沟通按钮，未执行发送'}[pre]);
  const clicked=await this.evaluate(()=>{const b=[...document.querySelectorAll('a,button')].find(e=>e.getBoundingClientRect().height>0&&e.innerText.trim()==='立即沟通');if(!b)return false;b.click();return true;});if(!clicked)throw Error('沟通按钮已变化，未发送');await pause(1500);
  const verified=await this.evaluate(()=>/继续沟通|已沟通/.test(document.body.innerText)||location.pathname.includes('/chat'));
  return {verified,reason:verified?'已点击沟通，页面已切换沟通状态':'已点击沟通，但页面未确认成功，请到 BOSS 直聘核对'};
 }
 async chatAction(expected, action, text, options={}) {
  options.guard?.();
  if (action !== 'fill') options.onAttempt?.();
  const result = await this.evaluate(chatDOM, {expected, action, text});
  if (result?.error || !result?.ok) {
   const error = Error(result?.error || '网页操作未确认');
   error.notSent = true;
   throw error;
  }
  return result;
 }
 async sendChat(conversation,text,options={}) {
  options.guard?.();
  const before = await this.readChat();
  assertConversation(conversation,before);
  await this.chatAction(conversation,'fill',text,options);
  await pause(250);
  await this.chatAction(conversation,'send',text,options);
  await pause(600);
  const after = await this.readChat();
  assertConversation(conversation,after);
  return after.messages.filter(m=>m.role==='assistant'&&m.text===text).length > before.messages.filter(m=>m.role==='assistant'&&m.text===text).length;
 }
 async openChat(){await this.launch();let t=(await this.targets()).find(t=>t.id===this.chatTargetId);if(!t){t=await this.newTab('https://www.zhipin.com/web/geek/chat');this.chatTargetId=t.id;await pause(1800);}this.activeTargetId=t.id;}
 async listConversations(){await this.openChat();return this.evaluate(()=>{const visible=e=>e.getBoundingClientRect().height>0;const root=document.querySelector('.user-list,.chat-user-list,.conversation-list,.chat-list');if(!root)throw Error('未找到会话列表，请先进入 BOSS 消息页；网页改版时需更新适配');const nodes=[...root.querySelectorAll('.user-item,.chat-user,.conversation-item,.friend-item,li')].filter(visible);return nodes.map((e,i)=>{const contact=e.querySelector('.name,.user-name,.nickname')?.innerText?.trim()||e.innerText.split('\n').filter(Boolean)[0];const remoteId=e.getAttribute('data-conversation-id')||e.getAttribute('data-uid')||e.getAttribute('data-id')||e.getAttribute('data-geekid')||'';const company=e.querySelector('.company,.company-name')?.innerText?.trim()||'';const jobTitle=e.querySelector('.job-name,.job-title')?.innerText?.trim()||'';return {id:remoteId||[contact,company,jobTitle].join('|'),remoteId,contact,company,jobTitle,unread:!!e.querySelector('.badge,.red-dot,.unread,.badge-count'),lastText:e.querySelector('.last-msg,.message,.msg')?.innerText?.trim()||'',index:i};}).filter(c=>c.contact);});}
 async selectConversation(c){await this.openChat();const selected=await this.evaluate(c=>{const root=document.querySelector('.user-list,.chat-user-list,.conversation-list,.chat-list');const nodes=[...(root?.querySelectorAll('.user-item,.chat-user,.conversation-item,.friend-item,li')||[])].filter(e=>e.getBoundingClientRect().height>0);let matches=c.remoteId?nodes.filter(e=>[e.getAttribute('data-conversation-id'),e.getAttribute('data-uid'),e.getAttribute('data-id'),e.getAttribute('data-geekid')].includes(c.remoteId)):nodes.filter(e=>(e.querySelector('.name,.user-name,.nickname')?.innerText?.trim()||e.innerText.split('\n').filter(Boolean)[0])===c.contact&&(!c.company||e.innerText.includes(c.company))&&(!c.jobTitle||e.innerText.includes(c.jobTitle)));if(matches.length!==1)return false;matches[0].click();return true;},c);if(!selected)throw Error('会话不存在或存在同名歧义，请手动选择后重新同步');await pause(650);const current=await this.readChat();assertConversation(c,current);}
 async readChat() {
  if(this.chatTargetId)this.activeTargetId=this.chatTargetId;
  else {if(!this.port)await this.owned();const t=(await this.targets()).find(t=>t.type==='page'&&isBossPage(t.url)&&t.url.includes('/chat'));if(t)this.activeTargetId=t.id;}
  const current=await this.evaluate(chatDOM);
  if(current?.error)throw Error(current.error);
  if(!current?.remoteId)throw Error('未读取到当前会话的平台 ID，请重新同步；不会沿用旧会话');
  return {...current,id:current.remoteId};
 }
 async readHistory(){let current=await this.readChat();assertConversation(initial,current);if(current.error)throw Error(current.error);const initial=current;let messages=[...current.messages],previous='',stable=0;for(let i=0;i<200;i++){await this.evaluate(()=>{const root=document.querySelector('.chat-record,.chat-message-list,.message-list,.chat-conversation');if(!root)throw Error('聊天记录不可读');const container=[root,...root.querySelectorAll('*')].find(e=>e.scrollHeight>e.clientHeight+50)||root;container.scrollTop=0;container.dispatchEvent(new Event('scroll',{bubbles:true}));const more=document.querySelector('.load-more,.history-more');if(more&&more.getBoundingClientRect().height>0)more.click();});await pause(650);current=await this.readChat();assertConversation(initial,current);if(current.error)throw Error(current.error);const known=new Set(messages.map(m=>m.remoteId)),older=current.messages.filter(m=>!known.has(m.remoteId));messages=[...older,...messages];const sig=current.messages[0]?.remoteId+'|'+messages.length;stable=sig===previous?stable+1:0;if(stable>=3)return {...current,messages:messages.map((m,i)=>({...m,sequence:i})),historyComplete:true};previous=sig;}return {...current,messages:messages.map((m,i)=>({...m,sequence:i})),historyComplete:false};}
 async resetConversations(){await this.evaluate(()=>{const root=document.querySelector('.user-list,.chat-user-list,.conversation-list,.chat-list');const scroller=root&&[root,root.parentElement,...root.querySelectorAll('*')].find(e=>e&&e.scrollHeight>e.clientHeight+40);if(scroller){scroller.scrollTop=0;scroller.dispatchEvent(new Event('scroll',{bubbles:true}));}});await pause(400);}
 async scrollConversations(){return this.evaluate(()=>{const root=document.querySelector('.user-list,.chat-user-list,.conversation-list,.chat-list');if(!root)return false;const scroller=[root,root.parentElement,...root.querySelectorAll('*')].find(e=>e&&e.scrollHeight>e.clientHeight+40);if(!scroller)return false;const before=scroller.scrollTop;scroller.scrollTop=Math.min(scroller.scrollTop+Math.max(300,scroller.clientHeight*.8),scroller.scrollHeight);scroller.dispatchEvent(new Event('scroll',{bubbles:true}));return scroller.scrollTop!==before;});}
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
 async close(){const t=(await this.targets()).find(t=>t.type==='page');if(t)await this.command('Browser.close',{},t).catch(()=>{});}
}
