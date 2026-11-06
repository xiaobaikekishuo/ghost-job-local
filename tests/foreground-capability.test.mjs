import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {Browser,greetingVisibilityDOM} from '../lib/browser.mjs';
import {chatRefreshDOM} from '../lib/chat-refresh.mjs';

function fixture(){
 const connection={mode:'existing',generation:8,preferredTargetId:'user-detail',session:{connected:true},createdTargets:new Set()};
 const b=new Browser('offline-foreground-capability','jobs',connection);
 b.chatTargetId='remembered-chat';b.activeTargetId='current-job';
 const f={b,connection,clock:0,stopped:false,commands:[],reads:[],waits:[],idleCalls:[],visibility:['visible'],
  safe:{ok:true,safeToRefresh:true},onFocus:null,onIdle:null,onWait:null,onRead:null,
  pages:[{id:'remembered-chat',type:'page',url:'https://www.zhipin.com/web/geek/chat'},
   {id:'other-chat',type:'page',url:'https://www.zhipin.com/web/geek/chat'}]};
 b.targets=async()=>f.pages;
 b.command=async(method,params,target,{guard}={})=>{
  assert.equal(method,'Page.bringToFront');assert.deepEqual(params,{});assert.equal(target.id,'remembered-chat');
  guard?.();f.commands.push(method);await f.onFocus?.();guard?.();return {};
 };
 b.evaluateOn=async(target,fn,args)=>{
  assert.equal(target.id,'remembered-chat');assert.ok([chatRefreshDOM,greetingVisibilityDOM].includes(fn));
  f.reads.push(fn);await f.onRead?.(fn);
  if(fn===chatRefreshDOM){assert.deepEqual(args,{action:'inspect'});return f.safe;}
  return {visibilityState:f.visibility.length>1?f.visibility.shift():f.visibility[0]};
 };
 b.assertGreetingChatIdle=async options=>{options.guard();f.idleCalls.push(options);await f.onIdle?.();options.guard();return {idle:true,targetId:options.targetId,generation:options.generation};};
 for(const name of ['launch','openChat','navigate','newTab','sendChat','sendJobGreeting','communicate','openGreetingJob','refreshGreetingChat','resetConversations','selectConversation'])
  b[name]=async()=>assert.fail('Foreground capability must not call '+name);
 f.options={targetId:'remembered-chat',generation:8,active:()=>!f.stopped,
  foregroundNow:()=>f.clock,foregroundWait:async ms=>{f.waits.push(ms);f.clock+=ms;await f.onWait?.();}};
 return f;
}

test('foreground capability reuses only the remembered chat, focuses once and verifies visibility after the idle check',async()=>{
 const f=fixture();f.visibility=['hidden','visible','visible'];f.onFocus=()=>{f.clock+=5000;};
 const result=await f.b.assertGreetingForeground(f.options);
 assert.deepEqual(result,{available:true,foreground:true,targetId:'remembered-chat',generation:8});
 assert.equal(f.clock,5100);assert.deepEqual(f.waits,[100]);assert.deepEqual(f.commands,['Page.bringToFront']);
 assert.equal(f.idleCalls.length,1);assert.equal(f.idleCalls[0].targetId,'remembered-chat');
 assert.equal(f.reads.at(-1),greetingVisibilityDOM);assert.equal(f.b.activeTargetId,'remembered-chat');
 assert.equal(f.connection.preferredTargetId,'user-detail');assert.equal(f.connection.createdTargets.size,0);
});

test('missing arguments, old generations, replaced chats and invalid remembered routes cannot focus a fallback page',async()=>{
 for(const mode of ['no-id','no-generation','generation','chat-id','missing','route','auth','verify','disconnected']){
  const f=fixture(),options={...f.options};
  if(mode==='no-id')delete options.targetId;if(mode==='no-generation')delete options.generation;
  if(mode==='generation')f.connection.generation++;if(mode==='chat-id')f.b.chatTargetId='other-chat';
  if(mode==='missing')f.pages.shift();
  if(mode==='route')f.pages[0].url='https://www.zhipin.com/job_detail/other.html';
  if(mode==='auth')f.pages[0].url='https://www.zhipin.com/web/passport/login';
  if(mode==='verify')f.pages[0].url='https://www.zhipin.com/web/passport/zp/security.html';
  if(mode==='disconnected')f.connection.session.connected=false;
  await assert.rejects(f.b.assertGreetingForeground(options),e=>{
   assert.equal(e.code,mode==='auth'?'AUTH_REQUIRED':mode==='verify'?'VERIFICATION_REQUIRED':mode==='disconnected'?'CDP_DISCONNECTED':'GREETING_TARGET_UNAVAILABLE');
   assert.equal(e.notSent,true);assert.notEqual(e.reason,'CHAT_NOT_FOREGROUND');return true;
  });
  assert.equal(f.commands.length,0);assert.equal(f.reads.length,0);assert.equal(f.b.activeTargetId,'current-job');
 }
});

test('persistently hidden visibility is bounded to 2500ms after focus and never passes the idle gate',async()=>{
 for(const requested of [undefined,60000,0]){
  const f=fixture();f.visibility=['hidden'];f.onFocus=()=>{f.clock+=5000;};
  await assert.rejects(f.b.assertGreetingForeground({...f.options,...requested===undefined?{}:{foregroundTimeoutMs:requested}}),
   {code:'GREETING_TARGET_UNAVAILABLE',reason:'CHAT_NOT_FOREGROUND',notSent:true});
  assert.equal(f.clock,requested===0?5000:7500);assert.equal(f.commands.length,1);assert.equal(f.idleCalls.length,0);
 }
});

test('drafts, dialogs and auth or rate barriers retain their codes even on hidden pages',async()=>{
 for(const code of ['GREETING_TARGET_UNAVAILABLE','AUTH_REQUIRED','VERIFICATION_REQUIRED','RATE_LIMITED']){
  const f=fixture();f.visibility=['hidden'];f.safe={ok:false,code,error:'Fixture blocked state'};
  await assert.rejects(f.b.assertGreetingForeground(f.options),e=>e.code===code&&e.notSent===true&&e.reason!=='CHAT_NOT_FOREGROUND');
  assert.equal(f.waits.length,0);assert.equal(f.idleCalls.length,0);
 }
});

test('hidden unavailable composers and unknown structures retain their reason instead of becoming foreground failures',async()=>{
 for(const state of [
  {readiness:'unavailable',reason:'COMPOSER_UNAVAILABLE'},
  {readiness:'unavailable',reason:'LIST_UNAVAILABLE'},
  {readiness:'unavailable',reason:'STRUCTURE_UNAVAILABLE'},
  {readiness:'loading',reason:'UNKNOWN_LOADING'},
  {reason:'DOCUMENT_LOADING'},{}
 ]){
  const f=fixture();f.visibility=['hidden'];f.safe={ok:true,safeToRefresh:false,...state};
  await assert.rejects(f.b.assertGreetingForeground(f.options),e=>{
   assert.equal(e.code,'GREETING_TARGET_UNAVAILABLE');assert.equal(e.notSent,true);
   assert.equal(e.reason,state.reason);assert.notEqual(e.reason,'CHAT_NOT_FOREGROUND');return true;
  });
  assert.deepEqual(f.reads,[chatRefreshDOM]);assert.equal(f.waits.length,0);assert.equal(f.idleCalls.length,0);
 }
});

test('only explicit known structural loading states may proceed to the bounded visibility wait',async()=>{
 for(const reason of ['DOCUMENT_LOADING','LIST_LOADING','CONVERSATION_MOUNTING']){
  const f=fixture();f.visibility=['hidden','visible','visible'];
  f.safe={ok:true,safeToRefresh:false,readiness:'loading',reason};
  f.onWait=()=>{f.safe={ok:true,safeToRefresh:true,readiness:'ready',reason:'READY'};};
  assert.equal((await f.b.assertGreetingForeground(f.options)).foreground,true);
  assert.equal(f.waits.length,1);assert.equal(f.idleCalls.length,1);
 }
});

test('cancellation, generation, session replacement and route changes while waiting stop without reading another target',async()=>{
 for(const mode of ['cancel','generation','connection','session','active-id','chat-id','route']){
  const f=fixture();f.visibility=['hidden'];
  f.onWait=()=>{
   if(mode==='cancel')f.stopped=true;if(mode==='generation')f.connection.generation++;
   if(mode==='connection')f.b.connection={...f.connection};if(mode==='session')f.connection.session={connected:true};
   if(mode==='active-id')f.b.activeTargetId='other-chat';if(mode==='chat-id')f.b.chatTargetId='other-chat';
   if(mode==='route')f.pages[0].url='https://www.zhipin.com/web/geek/jobs';
  };
  await assert.rejects(f.b.assertGreetingForeground(f.options),e=>e.code===(mode==='cancel'?'CANCELLED':'GREETING_TARGET_UNAVAILABLE')&&e.notSent===true&&e.reason!=='CHAT_NOT_FOREGROUND');
  assert.equal(f.commands.length,1);assert.equal(f.reads.length,2);assert.equal(f.idleCalls.length,0);
 }
});

test('unknown protocol errors and unknown visibility never become a foreground timeout',async()=>{
 for(const phase of ['focus','read','idle']){
  const f=fixture(),error=Object.assign(Error('Fixture protocol failure'),{code:'CDP_ERROR',cdpCode:-99});
  if(phase==='focus')f.onFocus=()=>{throw error;};if(phase==='read')f.onRead=()=>{throw error;};if(phase==='idle')f.onIdle=()=>{throw error;};
  await assert.rejects(f.b.assertGreetingForeground(f.options),e=>e===error&&e.notSent===true&&e.reason!=='CHAT_NOT_FOREGROUND');
  assert.equal(f.waits.length,0);
 }
 const f=fixture();f.visibility=[undefined];
 await assert.rejects(f.b.assertGreetingForeground(f.options),e=>e.code==='GREETING_TARGET_UNAVAILABLE'&&e.reason!=='CHAT_NOT_FOREGROUND');
 assert.equal(f.waits.length,0);
});

test('visibility, safe editor state and pinned identity are checked again after idle',async()=>{
 const hidden=fixture();hidden.visibility=['visible','hidden'];
 await assert.rejects(hidden.b.assertGreetingForeground(hidden.options),{code:'GREETING_TARGET_UNAVAILABLE',reason:'CHAT_NOT_FOREGROUND',notSent:true});
 assert.equal(hidden.idleCalls.length,1);assert.equal(hidden.commands.length,1);
 for(const mode of ['draft','loading','target']){
  const f=fixture();f.onIdle=()=>{
   if(mode==='draft')f.safe={ok:false,code:'GREETING_TARGET_UNAVAILABLE',error:'Fixture draft preserved'};
   if(mode==='loading')f.safe={ok:true,safeToRefresh:false};
   if(mode==='target')f.b.activeTargetId='other-chat';
  };
  await assert.rejects(f.b.assertGreetingForeground(f.options),e=>e.code==='GREETING_TARGET_UNAVAILABLE'&&e.notSent===true&&e.reason!=='CHAT_NOT_FOREGROUND');
  assert.equal(f.commands.length,1);
 }
});

test('visibility DOM probe returns only the actual visibility flag',()=>{
 const value=vm.runInNewContext('('+greetingVisibilityDOM.toString()+')()',{
  document:{visibilityState:'visible',body:{innerText:'must not be returned'}}});
 assert.deepEqual(JSON.parse(JSON.stringify(value)),{visibilityState:'visible'});
});
