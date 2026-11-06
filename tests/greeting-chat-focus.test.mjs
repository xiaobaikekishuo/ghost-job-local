import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Browser} from '../lib/browser.mjs';

const page=(id='chosen',url='https://www.zhipin.com/web/geek/chat')=>({id,type:'page',url});
function fixture(){
 const state={pages:[page('other'),page()],commands:[],afterCommand:()=>{}};
 const connection={generation:3,session:{connected:true}};
 const browser=new Browser('unused','jobs',connection);
 browser.chatTargetId=browser.activeTargetId='chosen';
 browser.targets=async()=>state.pages;
 browser.command=async(method,params,target)=>{
  assert.equal(method,'Page.bringToFront');assert.deepEqual(params,{});
  state.commands.push({method,params,target});await state.afterCommand();return {};
 };
 for(const method of ['launch','openChat','navigate','newTab','evaluate','evaluateOn','sendChat','sendJobGreeting','refreshGreetingChat'])
  browser[method]=async()=>assert.fail('Focus must not call '+method);
 return {browser,connection,state};
}

test('focusGreetingChat brings only its pinned chat forward once among multiple chat pages',async()=>{
 const f=fixture();
 assert.deepEqual(await f.browser.focusGreetingChat(),{focused:true,targetId:'chosen',generation:3});
 assert.equal(f.state.commands.length,1);assert.equal(f.state.commands[0].target,f.state.pages[1]);
 assert.equal(f.browser.chatTargetId,'chosen');assert.equal(f.browser.activeTargetId,'chosen');
});

test('cancellation, stale generation, disconnected session and mismatched IDs prevent any focus command',async()=>{
 for(const mode of ['cancel','generation','disconnected','chat-id','active-id']){
  const f=fixture(),options={targetId:'chosen',generation:3};
  if(mode==='cancel')options.guard=()=>false;
  if(mode==='generation')f.connection.generation++;
  if(mode==='disconnected')f.connection.session.connected=false;
  if(mode==='chat-id')f.browser.chatTargetId='other';
  if(mode==='active-id')f.browser.activeTargetId='other';
  const code=mode==='cancel'?'CANCELLED':mode==='disconnected'?'CDP_DISCONNECTED':'GREETING_TARGET_UNAVAILABLE';
  await assert.rejects(f.browser.focusGreetingChat(options),{code,notSent:true});
  assert.equal(f.state.commands.length,0,mode);
 }
});

test('missing or non-chat targets never fall back and explicit login or verification routes retain their codes',async()=>{
 const cases=[
  [null,'GREETING_TARGET_UNAVAILABLE'],
  [page('chosen','https://www.zhipin.com/web/geek/jobs'),'GREETING_TARGET_UNAVAILABLE'],
  [page('chosen','http://www.zhipin.com/web/geek/chat'),'GREETING_TARGET_UNAVAILABLE'],
  [page('chosen','https://www.zhipin.com.evil.invalid/web/geek/chat'),'GREETING_TARGET_UNAVAILABLE'],
  [page('chosen','https://user:pass@www.zhipin.com/web/geek/chat'),'GREETING_TARGET_UNAVAILABLE'],
  [page('chosen','https://www.zhipin.com:8443/web/geek/chat'),'GREETING_TARGET_UNAVAILABLE'],
  [{...page(),type:'worker'},'GREETING_TARGET_UNAVAILABLE'],
  [page('chosen','https://www.zhipin.com/web/passport/zp/security.html'),'VERIFICATION_REQUIRED'],
  [page('chosen','https://www.zhipin.com/web/passport/login'),'AUTH_REQUIRED']
 ];
 for(const [target,code] of cases){
  const f=fixture();f.state.pages=[page('other'),...(target?[target]:[])];
  await assert.rejects(f.browser.focusGreetingChat({targetId:'chosen',generation:3}),{code,notSent:true});
  assert.equal(f.state.commands.length,0);
 }
});

test('generation, route, target and cancellation changes after focus reject without focusing another page',async()=>{
 for(const mode of ['generation','route','missing','active-id','chat-id','cancel']){
  const f=fixture();let active=true;
  f.state.afterCommand=()=>{
   if(mode==='generation')f.connection.generation++;
   if(mode==='route')f.state.pages=[page('other'),page('chosen','https://www.zhipin.com/web/geek/jobs')];
   if(mode==='missing')f.state.pages=[page('other')];
   if(mode==='active-id')f.browser.activeTargetId='other';
   if(mode==='chat-id')f.browser.chatTargetId='other';
   if(mode==='cancel')active=false;
  };
  await assert.rejects(f.browser.focusGreetingChat({targetId:'chosen',generation:3,guard:()=>active}),
   {code:mode==='cancel'?'CANCELLED':'GREETING_TARGET_UNAVAILABLE',notSent:true});
  assert.equal(f.state.commands.length,1,mode);assert.equal(f.state.commands[0].target.id,'chosen');
 }
});

test('unknown CDP focus failures preserve the same error and are explicitly not sent',async()=>{
 const f=fixture(),failure=Object.assign(Error('Unknown protocol failure'),{code:'CDP_ERROR',cdpCode:-99});
 f.state.afterCommand=()=>{throw failure;};
 await assert.rejects(f.browser.focusGreetingChat({targetId:'chosen',generation:3}),error=>error===failure);
 assert.equal(failure.code,'CDP_ERROR');assert.equal(failure.cdpCode,-99);assert.equal(failure.notSent,true);
 assert.equal(f.state.commands.length,1);assert.equal(f.state.commands[0].target.id,'chosen');
});
