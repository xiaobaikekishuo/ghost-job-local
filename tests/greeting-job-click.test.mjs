import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Browser} from '../lib/browser.mjs';
import {modernChatDOM} from '../lib/modern-chat-dom.mjs';

const page=(id='chosen',url='https://www.zhipin.com/web/geek/chat')=>({id,type:'page',url});
const expected={contact:'林女士',company:'测试公司',jobTitle:'采购专员',anchorIds:['fixture-anchor']};
const point=()=>({ok:true,modern:true,x:320,y:160,viewport:{width:1200,height:800}});
function fixture(){
 const state={pages:[page('other'),page()],commands:[],evaluations:[],result:point(),afterEvaluate:()=>{},afterCommand:()=>{}};
 const connection={generation:3,session:{connected:true}};
 const browser=new Browser('unused','jobs',connection);
 browser.chatTargetId=browser.activeTargetId='chosen';
 browser.targets=async()=>state.pages;
 browser.evaluateOn=async(target,fn,args)=>{
  assert.equal(target.id,'chosen');assert.equal(fn,modernChatDOM);assert.deepEqual(args,{action:'locateJobEntry',expected});
  state.evaluations.push({target,fn,args});await state.afterEvaluate();return state.result;
 };
 browser.command=async(method,params,target)=>{
  assert.equal(method,'Input.dispatchMouseEvent');assert.equal(target.id,'chosen');
  const command={method,params,target};state.commands.push(command);await state.afterCommand(command);return {};
 };
 for(const method of ['launch','openChat','navigate','newTab','evaluate','sendChat','sendJobGreeting','refreshGreetingChat'])
  browser[method]=async()=>assert.fail('Opening job proof must not call '+method);
 return {browser,connection,state};
}
const options={targetId:'chosen',generation:3,expected};

test('opening a greeting job uses one pinned DOM location and exactly one mouse press/release pair',async()=>{
 const f=fixture();
 assert.deepEqual(await f.browser.openGreetingJob(options),{ok:true,openedJob:true,targetId:'chosen',generation:3});
 assert.equal(f.state.evaluations.length,1);assert.equal(f.state.commands.length,2);
 assert.deepEqual(f.state.commands.map(command=>command.params),[
  {type:'mousePressed',button:'left',buttons:1,clickCount:1,x:320,y:160},
  {type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:320,y:160}
 ]);
 for(const command of f.state.commands)assert.equal(command.target,f.state.pages[1]);
});

test('wrong targets, routes and cancellation block events, including target changes after DOM lookup',async()=>{
 for(const mode of ['cancel','generation','active','missing','wrong-route','spoof','credentials','port','security','login','after-lookup']){
  const f=fixture(),args={...options};let code='GREETING_TARGET_UNAVAILABLE';
  if(mode==='cancel'){args.guard=()=>false;code='CANCELLED';}
  if(mode==='generation')f.connection.generation++;
  if(mode==='active')f.browser.activeTargetId='other';
  if(mode==='missing')f.state.pages=[page('other')];
  const urls={
   'wrong-route':'https://www.zhipin.com/web/geek/jobs',
   spoof:'https://www.zhipin.com.evil.invalid/web/geek/chat',
   credentials:'https://user:pass@www.zhipin.com/web/geek/chat',
   port:'https://www.zhipin.com:8443/web/geek/chat',
   security:'https://www.zhipin.com/web/passport/zp/security.html',
   login:'https://www.zhipin.com/web/passport/login'
  };
  if(urls[mode])f.state.pages=[page('other'),page('chosen',urls[mode])];
  if(mode==='security')code='VERIFICATION_REQUIRED';if(mode==='login')code='AUTH_REQUIRED';
  if(mode==='after-lookup')f.state.afterEvaluate=()=>{f.browser.activeTargetId='other';};
  await assert.rejects(f.browser.openGreetingJob(args),{code,notSent:true});
  assert.equal(f.state.commands.length,0,mode);
 }
});

test('DOM errors, occluded entries and invalid coordinates cannot produce mouse events',async()=>{
 const results=[
  {error:'Job entry is covered',code:'GREETING_TARGET_UNAVAILABLE',notSent:true},
  {...point(),ok:false},
  {...point(),occluded:true},
  {...point(),x:NaN},
  {...point(),x:-1},
  {...point(),x:1200},
  {...point(),y:Infinity},
  {...point(),y:800},
  {...point(),x:'320'},
  {...point(),viewport:{width:0,height:800}},
  {...point(),viewport:{width:Infinity,height:800}}
 ];
 for(const result of results){
  const f=fixture();f.state.result=result;
  await assert.rejects(f.browser.openGreetingJob(options),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
  assert.equal(f.state.commands.length,0);
 }
});

test('stopping after press releases only the original target before preserving cancellation',async()=>{
 const f=fixture();let active=true;
 f.state.afterCommand=command=>{if(command.params.type==='mousePressed')active=false;};
 await assert.rejects(f.browser.openGreetingJob({...options,guard:()=>active}),{code:'CANCELLED',notSent:true});
 assert.deepEqual(f.state.commands.map(command=>command.params.type),['mousePressed','mouseReleased']);
 assert.ok(f.state.commands.every(command=>command.target.id==='chosen'));
});

test('connection changes, closed targets or non-chat navigation after press never release on another page',async()=>{
 for(const mode of ['generation','route','missing']){
  const f=fixture();
  f.state.afterCommand=command=>{
   if(command.params.type!=='mousePressed')return;
   if(mode==='generation')f.connection.generation++;
   if(mode==='route')f.state.pages=[page('other'),page('chosen','https://www.zhipin.com/web/geek/jobs')];
   if(mode==='missing')f.state.pages=[page('other')];
  };
  await assert.rejects(f.browser.openGreetingJob(options),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
  assert.equal(f.state.commands.length,1,mode);assert.equal(f.state.commands[0].target.id,'chosen');
 }
});

test('unknown press failures get one safe release, while release failures are never retried',async()=>{
 for(const phase of ['mousePressed','mouseReleased']){
  const f=fixture(),failure=Object.assign(Error('Unknown protocol failure'),{code:'CDP_ERROR',cdpCode:-99});
  f.state.afterCommand=command=>{if(command.params.type===phase)throw failure;};
  await assert.rejects(f.browser.openGreetingJob(options),error=>error===failure);
  assert.equal(failure.code,'CDP_ERROR');assert.equal(failure.cdpCode,-99);assert.equal(failure.notSent,true);
  assert.deepEqual(f.state.commands.map(command=>command.params.type),['mousePressed','mouseReleased']);
  assert.ok(f.state.commands.every(command=>command.target.id==='chosen'));
 }
});

const hidden=()=>({modern:true,error:'消息页不在前台，未定位职位入口',code:'MODERN_CHAT_ACTION_UNAVAILABLE',reason:'CHAT_NOT_FOREGROUND',notSent:true});
const foregroundOptions={...options,foregroundTimeoutMs:100,foregroundPollMs:1};
function foregroundFixture(){
 const f=fixture();f.state.focusCalls=[];f.state.focusResult={focused:true,targetId:'chosen',generation:3};f.state.onFocus=()=>{};
 f.browser.focusGreetingChat=async args=>{
  assert.equal(args.targetId,'chosen');assert.equal(args.generation,3);assert.equal(typeof args.guard,'function');
  assert.equal(f.state.commands.length,0,'Recovery must happen before any mouse press');
  f.state.focusCalls.push(args);await f.state.onFocus();return f.state.focusResult;
 };
 return f;
}

test('typed foreground recovery focuses once and repeats the full pinned identity lookup before clicking',async()=>{
 const f=foregroundFixture();
 f.state.afterEvaluate=()=>{f.state.result=f.state.evaluations.length<3?hidden():point();};
 assert.deepEqual(await f.browser.openGreetingJob(foregroundOptions),{ok:true,openedJob:true,targetId:'chosen',generation:3});
 assert.equal(f.state.focusCalls.length,1);assert.equal(f.state.evaluations.length,3);
 assert.deepEqual(f.state.commands.map(command=>command.params.type),['mousePressed','mouseReleased']);
 for(const read of f.state.evaluations){assert.equal(read.target.id,'chosen');assert.deepEqual(read.args,{action:'locateJobEntry',expected});}
});

test('permanently hidden pages stop after the bounded retry and untyped DOM failures never trigger focus',async()=>{
 const f=foregroundFixture();f.state.result=hidden();
 await assert.rejects(f.browser.openGreetingJob({...foregroundOptions,foregroundTimeoutMs:0}),{code:'MODERN_CHAT_ACTION_UNAVAILABLE',notSent:true});
 assert.equal(f.state.focusCalls.length,1);assert.equal(f.state.evaluations.length,2);assert.equal(f.state.commands.length,0);
 for(const result of [
  {...hidden(),notSent:undefined},{...hidden(),notSent:false},{...hidden(),modern:false},
  {...hidden(),reason:undefined},{...hidden(),reason:'ENTRY_OCCLUDED'},
  {...hidden(),code:'GREETING_TARGET_UNAVAILABLE'}
 ]){
  const g=foregroundFixture();g.state.result=result;
  await assert.rejects(g.browser.openGreetingJob(foregroundOptions),{code:result.code,notSent:true});
  assert.equal(g.state.focusCalls.length,0);assert.equal(g.state.evaluations.length,1);assert.equal(g.state.commands.length,0);
 }
});

test('focus recovery rejects unconfirmed focus results and changed recipient identities without mouse events',async()=>{
 for(const focusResult of [{focused:false,targetId:'chosen',generation:3},{focused:true,targetId:'other',generation:3},{focused:true,targetId:'chosen',generation:4}]){
  const f=foregroundFixture();f.state.result=hidden();f.state.focusResult=focusResult;
  await assert.rejects(f.browser.openGreetingJob(foregroundOptions),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
  assert.equal(f.state.focusCalls.length,1);assert.equal(f.state.commands.length,0);
 }
 const f=foregroundFixture();f.state.result=hidden();
 f.state.onFocus=()=>{f.state.result={error:'当前 HR 身份已变化',code:'MODERN_CHAT_IDENTITY_UNAVAILABLE',notSent:true};};
 await assert.rejects(f.browser.openGreetingJob(foregroundOptions),{code:'MODERN_CHAT_IDENTITY_UNAVAILABLE',notSent:true});
 assert.equal(f.state.focusCalls.length,1);assert.equal(f.state.evaluations.length,2);assert.equal(f.state.commands.length,0);
});

test('stop, connection or route changes during foreground recovery block the subsequent lookup and click',async()=>{
 for(const mode of ['cancel','generation','route','active-id']){
  const f=foregroundFixture();let active=true;f.state.result=hidden();
  f.state.onFocus=()=>{
   if(mode==='cancel')active=false;
   if(mode==='generation')f.connection.generation++;
   if(mode==='route')f.state.pages=[page('other'),page('chosen','https://www.zhipin.com/web/geek/jobs')];
   if(mode==='active-id')f.browser.activeTargetId='other';
  };
  await assert.rejects(f.browser.openGreetingJob({...foregroundOptions,guard:()=>active}),
   {code:mode==='cancel'?'CANCELLED':'GREETING_TARGET_UNAVAILABLE',notSent:true});
  assert.equal(f.state.focusCalls.length,1);assert.equal(f.state.evaluations.length,1);assert.equal(f.state.commands.length,0);
 }
});

test('transport failures are not retried and foreground recovery cannot restart a begun mouse click',async()=>{
 for(const phase of ['first-read','focus','second-read','mousePressed','mouseReleased']){
  const f=foregroundFixture(),failure=Object.assign(Error('Protocol failure'),{code:'CDP_ERROR',cdpCode:-99});
  if(['focus','second-read'].includes(phase))f.state.result=hidden();
  if(phase==='first-read')f.state.afterEvaluate=()=>{throw failure;};
  if(phase==='focus')f.state.onFocus=()=>{throw failure;};
  if(phase==='second-read')f.state.afterEvaluate=()=>{if(f.state.evaluations.length===2)throw failure;};
  if(phase.startsWith('mouse')){
   Object.assign(failure,{code:'MODERN_CHAT_ACTION_UNAVAILABLE',reason:'CHAT_NOT_FOREGROUND',notSent:true});
   f.state.afterCommand=command=>{if(command.params.type===phase)throw failure;};
  }
  await assert.rejects(f.browser.openGreetingJob(foregroundOptions),error=>error===failure);
  assert.equal(failure.notSent,true);
  assert.equal(f.state.focusCalls.length,['focus','second-read'].includes(phase)?1:0);
  assert.equal(f.state.evaluations.length,phase==='second-read'?2:1);
  assert.equal(f.state.commands.length,phase.startsWith('mouse')?2:0);
 }
});

test('slow focus and post-focus target checks do not consume the visibility observation window',async()=>{
 const f=foregroundFixture();let clock=0,pinDelay=false;const waits=[];
 f.state.onFocus=()=>{clock+=5000;pinDelay=true;};
 const targets=f.browser.targets;
 f.browser.targets=async()=>{if(pinDelay){pinDelay=false;clock+=3000;}return targets();};
 f.state.afterEvaluate=()=>{f.state.result=f.state.evaluations.length<3?hidden():point();};
 const result=await f.browser.openGreetingJob({...options,foregroundTimeoutMs:1000,foregroundPollMs:100,
  foregroundNow:()=>clock,foregroundWait:async ms=>{waits.push(ms);clock+=ms;}});
 assert.equal(result.openedJob,true);assert.equal(clock,8100);assert.deepEqual(waits,[100]);
 assert.equal(f.state.focusCalls.length,1);assert.equal(f.state.evaluations.length,3);
 assert.deepEqual(f.state.commands.map(command=>command.params.type),['mousePressed','mouseReleased']);
 for(const read of f.state.evaluations)assert.deepEqual(read.args,{action:'locateJobEntry',expected});
});

test('persistently hidden pages get at most 2500ms after focus and no repeated focus or mouse click',async()=>{
 for(const timeout of [undefined,60000,250]){
  const f=foregroundFixture();let clock=0;const waits=[];f.state.result=hidden();
  f.state.onFocus=()=>{clock+=7000;};
  await assert.rejects(f.browser.openGreetingJob({...options,...timeout===undefined?{}:{foregroundTimeoutMs:timeout},
   foregroundNow:()=>clock,foregroundWait:async ms=>{waits.push(ms);clock+=ms;}}),
   {code:'MODERN_CHAT_ACTION_UNAVAILABLE',reason:'CHAT_NOT_FOREGROUND',notSent:true});
  assert.equal(clock,7000+(timeout===250?250:2500));assert.ok(waits.every(ms=>ms>0&&ms<=100));
  assert.equal(f.state.focusCalls.length,1);assert.equal(f.state.commands.length,0);
  assert.equal(f.state.evaluations.length,waits.length+2);
 }
});

test('cancellation, connection and pinned target changes during the visibility wait stop before another locate or click',async()=>{
 for(const mode of ['cancel','generation','disconnected','active-id','chat-id','route']){
  const f=foregroundFixture();let clock=0,active=true;f.state.result=hidden();
  await assert.rejects(f.browser.openGreetingJob({...options,guard:()=>active,foregroundNow:()=>clock,
   foregroundWait:async ms=>{
    clock+=ms;
    if(mode==='cancel')active=false;
    if(mode==='generation')f.connection.generation++;
    if(mode==='disconnected')f.connection.session.connected=false;
    if(mode==='active-id')f.browser.activeTargetId='other';
    if(mode==='chat-id')f.browser.chatTargetId='other';
    if(mode==='route')f.state.pages=[page('other'),page('chosen','https://www.zhipin.com/web/geek/jobs')];
   }}),{code:mode==='cancel'?'CANCELLED':mode==='disconnected'?'CDP_DISCONNECTED':'GREETING_TARGET_UNAVAILABLE',notSent:true});
  assert.equal(f.state.focusCalls.length,1);assert.equal(f.state.evaluations.length,2);assert.equal(f.state.commands.length,0);
 }
});
