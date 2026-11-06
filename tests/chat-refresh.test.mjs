import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {Browser} from '../lib/browser.mjs';
import {chatRefreshDOM,refreshGreetingChat,assertGreetingChatIdle} from '../lib/chat-refresh.mjs';

// Offline page tree. Selectors traverse relationships; the real DOM function
// runs serialized in a VM and location.reload only increments a local counter.
class Element {
 constructor(tag,attrs={},text='',children=[]){
  this.tagName=tag.toUpperCase();this.nodeType=1;this.attrs={...attrs};this._text=text;
  this.children=[];this.parentElement=null;this.hidden=false;this.style={};this.files=[];this.value='';
  children.forEach(child=>this.append(child));
 }
 append(child){child.parentElement=this;this.children.push(child);return child;}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null;}
 get id(){return this.attrs.id||'';}
 get className(){return this.attrs.class||'';}
 get classList(){return {contains:name=>this.className.split(/\s+/).includes(name)};}
 get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
 set textContent(value){this._text=value;this.children.forEach(child=>child.parentElement=null);this.children=[];}
 get innerText(){return this.textContent;}
 get childNodes(){return [...(this._text?[{nodeType:3,textContent:this._text}]:[]),...this.children];}
 getAttribute(name){return Object.hasOwn(this.attrs,name)?String(this.attrs[name]):null;}
 hasAttribute(name){return Object.hasOwn(this.attrs,name);}
 setAttribute(name,value){this.attrs[name]=String(value);}
 contains(node){return node===this||this.children.some(child=>child.contains(node));}
 closest(selector){for(let node=this;node;node=node.parentElement)if(node.matches(selector))return node;return null;}
 matches(selector){return selector.split(',').some(part=>matchesSelector(this,part.trim(),this));}
 querySelectorAll(selector){const nodes=[];const visit=node=>node.children.forEach(child=>{nodes.push(child);visit(child);});visit(this);return nodes.filter(node=>selector.split(',').some(part=>matchesSelector(node,part.trim(),this)));}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 getBoundingClientRect(){for(let node=this;node;node=node.parentElement)if(node.hidden||node.style.display==='none'||node.style.visibility==='hidden')return {width:0,height:0};return {width:300,height:100};}
}
function simple(node,selector,scope){
 if(!node)return false;if(selector===':scope')return node===scope;
 for(const [,excluded] of selector.matchAll(/:not\(([^)]+)\)/g))if(simple(node,excluded,scope))return false;
 selector=selector.replace(/:not\([^)]+\)/g,'');
 const attrs=[...selector.matchAll(/\[([\w-]+)(?:([*^$]?=)(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g)];
 selector=selector.replace(/\[[^\]]*\]/g,'');
 const tag=/^[a-z][\w-]*/i.exec(selector)?.[0];if(tag&&node.tagName!==tag.toUpperCase())return false;
 for(const [,id] of selector.matchAll(/#([\w-]+)/g))if(node.id!==id)return false;
 for(const [,name] of selector.matchAll(/\.([\w-]+)/g))if(!node.classList.contains(name))return false;
 for(const [,name,operator,double,single,bare] of attrs){const actual=node.getAttribute(name),expected=double??single??bare;
  if(actual===null)return false;if(!operator)continue;
  if(operator==='='&&actual!==expected||operator==='*='&&!actual.includes(expected)||operator==='^='&&!actual.startsWith(expected)||operator==='$='&&!actual.endsWith(expected))return false;
 }
 return true;
}
function matchesSelector(node,selector,scope){
 const tokens=selector.match(/(?:\[[^\]]*\]|[^\s>])+|>/g)||[];let index=tokens.length-1,current=node;
 if(!simple(current,tokens[index--]||'',scope))return false;
 while(index>=0){if(tokens[index]==='>'){current=current.parentElement;index--;if(!simple(current,tokens[index--],scope))return false;}
  else{const token=tokens[index--];current=current.parentElement;while(current&&!simple(current,token,scope))current=current.parentElement;if(!current)return false;}}
 return true;
}
const el=(...args)=>new Element(...args);
function pageFixture(){
 const selected=el('div',{class:'friend-content selected'},'',[
  el('div',{class:'name-box'},'',[el('span',{class:'name-text'},'虚构 HR'),el('span',{},'虚构公司')])]);
 const row=el('li',{role:'listitem'},'',[selected]);
 const list=el('div',{class:'user-list-content'},'',[el('ul',{role:'group'},'',[row])]);
 const root=el('div',{class:'user-list'},'',[list]);
 const header=el('div',{class:'top-info-content'},'',[el('span',{class:'name-text'},'虚构 HR')]);
 const input=el('div',{id:'chat-input',contenteditable:'true'});
 const record=el('div',{class:'chat-record'},'',[el('div',{class:'message-item'},'历史消息')]);
 const body=el('body',{},'',[root,header,record,input]);
 const document=el('document',{},'',[body]);document.body=body;document.documentElement=body;document.readyState='complete';
 const performance={timeOrigin:1000};let reloads=0;
 const location={href:'https://www.zhipin.com/web/geek/chat',origin:'https://www.zhipin.com',pathname:'/web/geek/chat',
  reload(){reloads++;f.onReload?.();}};
 const setURL=value=>{const u=new URL(value);Object.assign(location,{href:u.href,origin:u.origin,pathname:u.pathname,protocol:u.protocol,hostname:u.hostname,search:u.search,hash:u.hash});};
 const run=args=>structuredClone(vm.runInNewContext(`(${chatRefreshDOM.toString()})(args)`,{
  document,location,performance,args,URL,Node:{ELEMENT_NODE:1,TEXT_NODE:3},getComputedStyle:node=>({display:'block',visibility:'visible',opacity:'1',...node.style})
 }));
 const f={document,body,root,list,row,selected,header,input,record,performance,location,setURL,run,onReload:null,get reloads(){return reloads;}};
 setURL(location.href);return f;
}
function browserFixture(){
 const page=pageFixture(),connection={mode:'existing',generation:7},browser=new Browser('offline-fixture-only','jobs',connection);
 browser.activeTargetId=browser.chatTargetId='chat-fixture';
 const targets=[{id:'chat-fixture',type:'page',url:page.location.href},{id:'unrelated-chat',type:'page',url:page.location.href}];
 const evaluations=[],waits=[];let targetReads=0;
 const fixture={page,browser,connection,targets,evaluations,waits,beforeEvaluate:null,afterEvaluate:null,beforeTargets:null,onWait:null};
 browser.targets=async()=>{targetReads++;await fixture.beforeTargets?.(targetReads);return structuredClone(targets);};
 browser.evaluateOn=async(target,fn,args)=>{
  assert.equal(target.id,'chat-fixture');assert.equal(fn,chatRefreshDOM);evaluations.push(args?.action||'inspect');
  await fixture.beforeEvaluate?.(args);const result=page.run(args);await fixture.afterEvaluate?.(args,result);return result;
 };
 browser.waitForConversationList=async options=>{waits.push(options);assert.equal(options.targetId,'chat-fixture');options.guard?.();await fixture.onWait?.();return {conversations:[{contact:'虚构 HR'}]};};
 for(const method of ['launch','openChat','target','evaluate','navigate','newTab','command'])browser[method]=async()=>assert.fail('Refresh must not call '+method);
 page.onReload=()=>{page.performance.timeOrigin=2000;};
 fixture.options={targetId:'chat-fixture',generation:7,guard:()=>{},lookupFailed:true,timeoutMs:80,pollMs:1};
 return fixture;
}
const unavailable={code:'GREETING_TARGET_UNAVAILABLE',notSent:true};

test('DOM refresh refuses text drafts, unknown composer content, file attachments and ambiguous composers without mutation',()=>{
 const mutations=[f=>{f.input.textContent='未发送的人工草稿';},f=>f.input.append(el('img',{src:'blob:fixture'})),
  f=>f.input.append(el('strong')),f=>f.body.append(el('div',{contenteditable:'true'},'另一个输入框')),
  f=>{const file=f.body.append(el('input',{type:'file'}));file.files=[{name:'private-fixture.pdf'}];},
  f=>{const file=f.body.append(el('input',{type:'file'}));file.value='C:\\fakepath\\fixture.pdf';},
  f=>f.body.append(el('div',{class:'attachment-preview'},'待发送附件'))];
 for(const [index,mutate] of mutations.entries()){const f=pageFixture();mutate(f);const before=f.input.textContent;
  const result=f.run({action:'reload',expectedTimeOrigin:1000,expectedHref:f.location.href});
  assert.equal(result.ok,false,'draft mutation '+index);assert.equal(result.code,unavailable.code);assert.equal(result.notSent,true);
  assert.equal(f.reloads,0);assert.equal(f.input.textContent,before);
 }
});

test('DOM permits empty editor formatting and an unselected empty right pane but requires visible rows before ready',()=>{
 const f=pageFixture();f.input.append(el('div',{},'',[el('span',{},'',[el('br')])]));
 const ready=f.run({action:'inspect'});assert.equal(ready.ok,true);assert.equal(ready.ready,true);assert.equal(ready.safeToRefresh,true);assert.equal(f.reloads,0);
 f.header.remove();f.input.remove();f.selected.setAttribute('class','friend-content');
 assert.equal(f.run({action:'inspect'}).safeToRefresh,true);
 f.row.remove();const empty=f.run({action:'inspect'});assert.equal(empty.safeToRefresh,true);assert.equal(empty.ready,false);
 const selected=pageFixture();selected.header.remove();selected.input.remove();assert.equal(selected.run({action:'inspect'}).safeToRefresh,false);
 const ambiguous=pageFixture();ambiguous.body.append(el('div',{class:'user-list'},'',[el('div',{class:'user-list-content'})]));assert.equal(ambiguous.run({action:'inspect'}).code,unavailable.code);
});

test('DOM reload verifies origin, exact chat route, document time and current href before its one dispatch',()=>{
 for(const mutate of [f=>{f.performance.timeOrigin=2000;},f=>f.setURL('https://www.zhipin.com/web/geek/chat/'),
  f=>f.setURL('https://www.zhipin.com.evil.test/web/geek/chat'),f=>f.setURL('http://www.zhipin.com/web/geek/chat'),
  f=>f.setURL('https://user:pass@www.zhipin.com/web/geek/chat'),f=>{f.performance.timeOrigin=NaN;}]){
  const f=pageFixture();mutate(f);const result=f.run({action:'reload',expectedTimeOrigin:1000,expectedHref:'https://www.zhipin.com/web/geek/chat'});
  assert.equal(result.code,unavailable.code);assert.equal(result.notSent,true);assert.equal(f.reloads,0);
 }
 const f=pageFixture(),snapshot=f.run({action:'inspect'}),result=f.run({action:'reload',expectedTimeOrigin:snapshot.timeOrigin,expectedHref:snapshot.href});
 assert.equal(result.ok,true);assert.equal(result.reloadRequested,true);assert.equal(f.reloads,1);
});

test('explicit authentication, verification and rate-limit chrome stops reload while chat message text cannot impersonate it',()=>{
 const cases=[['https://www.zhipin.com/web/passport/zp/security.html','VERIFICATION_REQUIRED'],
  ['https://www.zhipin.com/web/passport/login','AUTH_REQUIRED']];
 for(const [url,code] of cases){const f=pageFixture();f.setURL(url);const result=f.run({action:'reload'});assert.equal(result.code,code);assert.equal(f.reloads,0);}
 for(const [title,code] of [['请完成安全验证','VERIFICATION_REQUIRED'],['登录已失效','AUTH_REQUIRED'],['访问过于频繁，请稍后重试','RATE_LIMITED']]){
  const f=pageFixture();f.body.append(el('div',{role:'dialog'},'',[el('h2',{},title)]));const result=f.run({action:'reload'});assert.equal(result.code,code);assert.equal(f.reloads,0);
 }
 const f=pageFixture();f.record.textContent='请先登录，岗位涉及安全验证与访问过于频繁处理。';
 f.record.append(el('div',{class:'message-item'},'',[el('div',{class:'captcha-dialog'})]));
 assert.equal(f.run({action:'inspect'}).safeToRefresh,true);assert.equal(f.reloads,0);
});

test('runner refreshes only the pinned target once and confirms a new ready document before and after list readiness',async()=>{
 const f=browserFixture();const result=await refreshGreetingChat(f.browser,f.options);
 assert.deepEqual(result,{refreshed:true,targetId:'chat-fixture',generation:7});assert.equal(f.page.reloads,1);
 assert.equal(f.evaluations.filter(action=>action==='reload').length,1);assert.equal(f.waits.length,1);
 assert.equal(f.evaluations.at(-1),'inspect');assert.equal(f.browser.activeTargetId,'chat-fixture');assert.equal(f.browser.chatTargetId,'chat-fixture');
});

test('old ready DOM never counts as a completed reload and does not reach conversation-list readiness',async()=>{
 const f=browserFixture();f.page.onReload=()=>{};
 await assert.rejects(refreshGreetingChat(f.browser,{...f.options,timeoutMs:0}),unavailable);
 assert.equal(f.page.reloads,1);assert.equal(f.waits.length,0);assert.equal(f.evaluations.filter(action=>action==='reload').length,1);
});

test('a new document that is still loading is polled until visible conversation rows are ready',async()=>{
 const f=browserFixture();let dispatched=false,probes=0;
 f.page.onReload=()=>{dispatched=true;f.page.document.readyState='loading';};
 f.afterEvaluate=async args=>{if(dispatched&&args.action==='inspect'){
  probes++;if(probes===1)f.page.performance.timeOrigin=2000;if(probes===2)f.page.document.readyState='complete';
 }};
 f.onWait=async()=>{assert.equal(f.page.performance.timeOrigin,2000);assert.equal(f.page.document.readyState,'complete');assert.ok(probes>=3);};
 const result=await refreshGreetingChat(f.browser,{...f.options,timeoutMs:250});
 assert.equal(result.refreshed,true);assert.equal(f.waits.length,1);assert.equal(f.page.reloads,1);
});

test('only a context-destroyed reload response can be followed by readiness polling; unknown CDP errors are not retried',async()=>{
 const f=browserFixture();f.afterEvaluate=async args=>{if(args.action==='reload')throw Object.assign(Error('Execution context was destroyed.'),{code:'CDP_ERROR',cdpCode:-32000});};
 assert.equal((await refreshGreetingChat(f.browser,f.options)).refreshed,true);assert.equal(f.page.reloads,1);assert.equal(f.waits.length,1);
 for(const action of ['inspect','reload']){
  const x=browserFixture(),error=Object.assign(Error('Unknown transport failure'),{code:'CDP_ERROR',cdpCode:-32077});
  x.beforeEvaluate=async args=>{if(args.action===action)throw error;};
  await assert.rejects(refreshGreetingChat(x.browser,x.options),failure=>failure===error&&failure.cdpCode===-32077);
  assert.equal(x.waits.length,0);assert.equal(x.evaluations.filter(value=>value===action).length,1);assert.equal(x.page.reloads,0);
 }
 const initial=browserFixture(),destroyed=Object.assign(Error('Execution context was destroyed.'),{code:'CDP_ERROR'});
 initial.beforeEvaluate=async()=>{throw destroyed;};
 await assert.rejects(refreshGreetingChat(initial.browser,initial.options),failure=>failure===destroyed);
 assert.deepEqual(initial.evaluations,['inspect']);assert.equal(initial.page.reloads,0);assert.equal(initial.waits.length,0);
});

test('stop, generation changes and target changes after an await block refresh continuation',async()=>{
 for(const mutate of [f=>{f.connection.generation++;},f=>{f.browser.activeTargetId='unrelated-chat';},f=>{f.browser.chatTargetId='unrelated-chat';}]){
  const f=browserFixture();f.afterEvaluate=async args=>{if(args.action==='inspect')mutate(f);};
  await assert.rejects(refreshGreetingChat(f.browser,f.options),unavailable);assert.equal(f.page.reloads,0);assert.equal(f.waits.length,0);
 }
 for(const afterReload of [false,true]){
  const f=browserFixture();let stopped=false;f.options.guard=()=>{if(stopped)throw Object.assign(Error('Stopped'),{code:'CANCELLED'});};
  f.afterEvaluate=async args=>{if(args.action===(afterReload?'reload':'inspect'))stopped=true;};
  await assert.rejects(refreshGreetingChat(f.browser,f.options),{code:'CANCELLED',notSent:true});assert.equal(f.page.reloads,afterReload?1:0);assert.equal(f.waits.length,0);
 }
});

test('route restrictions and typed failures from pinned target or list readiness retain their codes',async()=>{
 for(const [url,code] of [['https://www.zhipin.com/web/passport/zp/security.html','VERIFICATION_REQUIRED'],
  ['https://www.zhipin.com/web/passport/login','AUTH_REQUIRED'],['https://www.zhipin.com/web/geek/jobs','GREETING_TARGET_UNAVAILABLE']]){
  const f=browserFixture();f.targets[0].url=url;await assert.rejects(refreshGreetingChat(f.browser,f.options),{code,notSent:true});assert.equal(f.page.reloads,0);
 }
 for(const code of ['AUTH_REQUIRED','VERIFICATION_REQUIRED','RATE_LIMITED','CDP_ERROR']){
  const f=browserFixture(),error=Object.assign(Error(code),{code});f.onWait=async()=>{throw error;};
  await assert.rejects(refreshGreetingChat(f.browser,f.options),failure=>failure===error&&failure.notSent===true);assert.equal(f.page.reloads,1);assert.equal(f.waits.length,1);
 }
});

test('a second navigation or a new draft while waiting for the list invalidates the refreshed page',async()=>{
 for(const mutate of [f=>{f.page.performance.timeOrigin=3000;},f=>{f.page.input.textContent='等待期间输入的人工草稿';}]){
  const f=browserFixture();f.onWait=async()=>mutate(f);
  await assert.rejects(refreshGreetingChat(f.browser,f.options),unavailable);assert.equal(f.page.reloads,1);assert.equal(f.waits.length,1);
 }
});

test('refresh requires the explicit lookup-failed reason and the real Browser wrappers retain all safety checks',async()=>{
 for(const lookupFailed of [false,undefined,'true']){const f=browserFixture();await assert.rejects(refreshGreetingChat(f.browser,{...f.options,lookupFailed}),unavailable);assert.equal(f.evaluations.length,0);assert.equal(f.page.reloads,0);}
 const f=browserFixture();assert.deepEqual(await f.browser.refreshGreetingChat(f.options),{refreshed:true,targetId:'chat-fixture',generation:7});assert.equal(f.page.reloads,1);
 const idle=browserFixture();assert.deepEqual(await assertGreetingChatIdle(idle.browser,idle.options),{idle:true,targetId:'chat-fixture',generation:7});
 assert.equal(idle.page.reloads,0);assert.equal(idle.waits.length,0);
 idle.page.input.textContent='人工草稿';await assert.rejects(idle.browser.assertGreetingChatIdle(idle.options),unavailable);assert.equal(idle.page.reloads,0);
});

function idleFixture(options={}){
 const f=browserFixture();let clock=0;f.idleDelays=[];f.onIdleWait=null;f.elapsed=()=>clock;
 f.idleOptions={targetId:'chat-fixture',generation:7,now:()=>clock,
  wait:async ms=>{assert.ok(ms>0&&Number.isFinite(ms));f.idleDelays.push(ms);clock+=ms;await f.onIdleWait?.();},...options};
 return f;
}
function assertInspectOnly(f){
 assert.equal(f.page.reloads,0);assert.equal(f.waits.length,0);
 assert.ok(f.evaluations.every(action=>action==='inspect'));
}

test('DOM readiness distinguishes known loading and partial conversation mounts from unavailable or ambiguous layouts',()=>{
 const cases=[
  [f=>{f.document.readyState='loading';},'loading','DOCUMENT_LOADING'],
  [f=>{f.document.readyState='interactive';},'loading','DOCUMENT_LOADING'],
  [f=>f.list.setAttribute('aria-busy','true'),'loading','LIST_LOADING'],
  [f=>f.root.setAttribute('aria-busy','true'),'loading','LIST_LOADING'],
  [f=>f.list.append(el('div',{class:'list-loading'})),'loading','LIST_LOADING'],
  [f=>f.input.remove(),'loading','CONVERSATION_MOUNTING'],
  [f=>f.header.remove(),'loading','CONVERSATION_MOUNTING'],
  [f=>{f.input.remove();f.header.remove();},'loading','CONVERSATION_MOUNTING'],
  [f=>f.list.remove(),'unavailable','LIST_UNAVAILABLE'],
  [f=>f.input.setAttribute('contenteditable','false'),'unavailable','COMPOSER_UNAVAILABLE'],
  [f=>f.body.append(el('div',{class:'top-info-content'})),'unavailable','STRUCTURE_AMBIGUOUS'],
  [f=>f.body.append(el('div',{id:'chat-input',contenteditable:'true'})),'unavailable','STRUCTURE_AMBIGUOUS'],
  [f=>f.body.append(el('div',{class:'user-list-content'})),'unavailable','STRUCTURE_AMBIGUOUS'],
  [f=>f.list.append(el('li',{role:'listitem'},'',[el('div',{class:'friend-content selected'})])),'unavailable','STRUCTURE_AMBIGUOUS']
 ];
 for(const [mutate,readiness,reason] of cases){const f=pageFixture();mutate(f);const result=f.run({action:'inspect'});
  assert.equal(result.readiness,readiness,reason);assert.equal(result.reason,reason);assert.notEqual(result.safeToRefresh,true);assert.equal(f.reloads,0);
 }
 const f=pageFixture(),result=f.run({action:'inspect'});
 assert.equal(result.readiness,'ready');assert.equal(result.reason,'READY');assert.equal(result.safeToRefresh,true);
});

test('idle inspection waits for a partially mounted conversation and succeeds without refreshing or reading the list',async()=>{
 const f=idleFixture({timeoutMs:1000,pollMs:100});f.page.input.remove();
 f.onIdleWait=()=>{if(f.idleDelays.length===2)f.page.body.append(f.page.input);};
 assert.deepEqual(await f.browser.assertGreetingChatIdle(f.idleOptions),{idle:true,targetId:'chat-fixture',generation:7});
 assert.deepEqual(f.idleDelays,[100,100]);assert.equal(f.evaluations.length,3);assertInspectOnly(f);
});

test('idle loading timeouts use an 8 second default, a 15 second cap and a bounded final wait with virtual time',async()=>{
 for(const [options,expectedMs,expectedDelays] of [[{},8000,40],[{timeoutMs:60000},15000,75],[{timeoutMs:350,pollMs:200},350,2]]){
  const f=idleFixture(options);f.page.document.readyState='loading';
  await assert.rejects(assertGreetingChatIdle(f.browser,f.idleOptions),error=>{
   assert.equal(error.code,'GREETING_TARGET_UNAVAILABLE');assert.equal(error.notSent,true);
   assert.equal(error.readiness,'loading');assert.equal(error.reason,'DOCUMENT_LOADING');assert.match(error.message,/等待超时/);return true;
  });
  assert.equal(f.elapsed(),expectedMs);assert.equal(f.idleDelays.length,expectedDelays);assert.equal(f.evaluations.length,expectedDelays+1);
  assert.ok(f.idleDelays.every(ms=>ms<=200));if(expectedMs===350)assert.deepEqual(f.idleDelays,[200,150]);assertInspectOnly(f);
 }
});

test('drafts, attachments, ambiguous editors, dialogs and account barriers fail immediately even during known loading',async()=>{
 const cases=[
  [f=>{f.input.textContent='保留人工草稿';},'GREETING_TARGET_UNAVAILABLE'],
  [f=>f.input.append(el('img',{src:'blob:offline-attachment'})),'GREETING_TARGET_UNAVAILABLE'],
  [f=>f.body.append(el('div',{class:'attachment-preview'})),'GREETING_TARGET_UNAVAILABLE'],
  [f=>f.body.append(el('div',{contenteditable:'true'})),'GREETING_TARGET_UNAVAILABLE'],
  [f=>f.body.append(el('div',{role:'dialog'},'',[el('h2',{},'普通弹窗')])),'GREETING_TARGET_UNAVAILABLE'],
  [f=>f.body.append(el('div',{role:'dialog'},'',[el('h2',{},'请先登录')])),'AUTH_REQUIRED'],
  [f=>f.body.append(el('div',{role:'dialog'},'',[el('h2',{},'安全验证')])),'VERIFICATION_REQUIRED'],
  [f=>f.body.append(el('div',{role:'dialog'},'',[el('h2',{},'访问过于频繁')])),'RATE_LIMITED']
 ];
 for(const [mutate,code] of cases)for(const duringWait of [false,true]){
  const f=idleFixture();f.page.document.readyState='loading';
  if(duringWait)f.onIdleWait=()=>mutate(f.page);else mutate(f.page);
  await assert.rejects(assertGreetingChatIdle(f.browser,f.idleOptions),{code,notSent:true});
  assert.equal(f.idleDelays.length,duringWait?1:0);assert.equal(f.evaluations.length,duringWait?2:1);assertInspectOnly(f);
 }
});

test('idle waiting stops on cancellation, generation, target and route changes before inspecting a replacement',async()=>{
 const cases=[
  [f=>{f.stopped=true;},'CANCELLED'],
  [f=>{f.connection.generation++;},'GREETING_TARGET_UNAVAILABLE'],
  [f=>{f.browser.activeTargetId='unrelated-chat';},'GREETING_TARGET_UNAVAILABLE'],
  [f=>{f.browser.chatTargetId='unrelated-chat';},'GREETING_TARGET_UNAVAILABLE'],
  [f=>f.targets.shift(),'GREETING_TARGET_UNAVAILABLE'],
  [f=>{f.targets[0].url='https://www.zhipin.com/web/geek/jobs';},'GREETING_TARGET_UNAVAILABLE'],
  [f=>{f.targets[0].url='https://www.zhipin.com/web/passport/zp/security.html';},'VERIFICATION_REQUIRED'],
  [f=>{f.targets[0].url='https://www.zhipin.com/web/passport/login';},'AUTH_REQUIRED']
 ];
 for(const [mutate,code] of cases){
  const f=idleFixture();f.page.document.readyState='loading';f.idleOptions.guard=()=>!f.stopped;
  f.onIdleWait=()=>mutate(f);
  await assert.rejects(assertGreetingChatIdle(f.browser,f.idleOptions),{code,notSent:true});
  assert.equal(f.idleDelays.length,1);assert.equal(f.evaluations.length,1);assertInspectOnly(f);
 }
});

test('idle inspection never retries unknown CDP errors or destroyed contexts, before or after a loading wait',async()=>{
 for(const message of ['Unknown protocol failure','Execution context was destroyed.'])for(const duringWait of [false,true]){
  const f=idleFixture(),failure=Object.assign(Error(message),{code:'CDP_ERROR',cdpCode:-32000});
  f.page.document.readyState='loading';
  f.beforeEvaluate=()=>{if(!duringWait||f.idleDelays.length)throw failure;};
  await assert.rejects(assertGreetingChatIdle(f.browser,f.idleOptions),error=>error===failure&&error.notSent===true);
  assert.equal(f.idleDelays.length,duringWait?1:0);assert.equal(f.evaluations.length,duringWait?2:1);assertInspectOnly(f);
 }
});

test('idle waits only for explicit allowed loading reasons and keeps safe legacy snapshots compatible',async()=>{
 for(const fields of [{},{readiness:'loading'},{reason:'DOCUMENT_LOADING'},
  {readiness:'loading',reason:'UNKNOWN_LOADING'},{readiness:'unavailable',reason:'CONVERSATION_MOUNTING'}]){
  const f=idleFixture();f.afterEvaluate=(_args,result)=>{
   result.safeToRefresh=false;delete result.readiness;delete result.reason;Object.assign(result,fields);
  };
  await assert.rejects(assertGreetingChatIdle(f.browser,f.idleOptions),unavailable);
  assert.equal(f.idleDelays.length,0);assert.equal(f.evaluations.length,1);assertInspectOnly(f);
 }
 const f=idleFixture();f.afterEvaluate=(_args,result)=>{delete result.readiness;delete result.reason;};
 assert.deepEqual(await assertGreetingChatIdle(f.browser,f.idleOptions),{idle:true,targetId:'chat-fixture',generation:7});
 assert.equal(f.idleDelays.length,0);assert.equal(f.evaluations.length,1);assertInspectOnly(f);
});
