import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Browser,conversationListDOM} from '../lib/browser.mjs';
import {modernChatDOM} from '../lib/modern-chat-dom.mjs';
import {chatRefreshDOM} from '../lib/chat-refresh.mjs';
import {modernJobProofDOM} from '../lib/modern-job-proof-dom.mjs';
import {chooseModernConversationDOM,modernGreetingCapabilityDOM} from '../lib/modern-greeting-adapter.mjs';
import {createStore,identity} from '../lib/store.mjs';
import {createWorkflows} from '../lib/workflows.mjs';
import {simulationWorld,simulationSettings} from '../lib/simulation.mjs';
import {jobUrlKey} from '../lib/job-greeting-browser.mjs';

// Real workflow, greeting manager, native Browser.openGreetingJob, adapter and
// delivery helper. Only transport and already-verified contact are simulated.
function fixture({code='MODERN_CHAT_ACTION_UNAVAILABLE',afterSend=false,existingOpening=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'modern-greeting-workflow-')),store=createStore(dir);
 store.saveSettings({...simulationSettings(),personalizedGreeting:true,greetingFallback:false});
 const world=simulationWorld(),jobs=[world.jobs[0],world.jobs[4]],browser=new Browser(dir);
 browser.connection={generation:1};browser.connectionGeneration=1;
 const contacts=[],events=[];let currentJob=jobs[0],sent=false;
 const chat={id:'chat-fixture',type:'page',url:'https://www.zhipin.com/web/geek/chat'};
 const context=()=>{
  const opening=existingOpening&&contacts.includes(currentJob.url);
  const remoteId=opening?'platform-opening-'+jobs.findIndex(job=>job.url===currentJob.url):'real-fixture-old';
  return {modern:true,contact:currentJob.hrName,company:currentJob.company,jobTitle:currentJob.title,
   anchorIds:[remoteId],latestTail:{atBottom:true,loading:false,signature:'stable-fixture-tail-'+remoteId},
   messages:[{remoteId,platformMessageId:true,role:opening?'assistant':'user',text:opening?'平台已发出的本人开场':'虚构旧消息',
    ...(opening?{deliveryStatus:'confirmed'}:{})}]};
 };
 const refusal=()=>({modern:true,error:'消息页不在前台，未定位职位入口',code,notSent:true,
  ...(code==='MODERN_CHAT_ACTION_UNAVAILABLE'?{reason:'CHAT_NOT_FOREGROUND'}:{})});
 browser.launch=async()=>{};
 browser.search=async(keyword,city,{active})=>assert.equal(active(),true);
 browser.navigate=async url=>{currentJob=jobs.find(job=>job.url===url)||currentJob;};
 browser.readJobs=async()=>({jobs:structuredClone(jobs)});
 browser.target=async()=>({id:'search-fixture',url:'https://www.zhipin.com/web/geek/jobs?query=采购&city=101280100'});
 browser.targets=async()=>[chat];browser.nextPage=async()=>false;
 browser.detail=async()=>structuredClone(currentJob);
 browser.communicate=async(job,{guard})=>{guard();contacts.push(job.url);currentJob=job;return {verified:true,reason:'模拟已沟通'};};
 browser.command=async(method,params,target)=>{
  assert.equal(target.id,chat.id);
  if(method==='Page.bringToFront'){events.push('focus');return {};}
  assert.equal(method,'Input.dispatchMouseEvent');events.push(params.type);return {};
 };
 const open=browser.openGreetingJob.bind(browser);
 browser.openGreetingJob=options=>open({...options,foregroundTimeoutMs:0,foregroundPollMs:1});
 browser.evaluateOn=async(target,fn,args)=>{
  assert.equal(target.id,chat.id,'Never read a different target');
  if(fn===conversationListDOM)return args.mode==='read'?{modernWithoutIds:true,conversations:[{contact:currentJob.hrName,company:currentJob.company}]}:{ok:true};
  if(fn===modernGreetingCapabilityDOM)return {available:true,modern:true,requiresJobProof:true};
  if(fn===chatRefreshDOM)return {ok:true,timeOrigin:100,href:chat.url,readyState:'complete',safeToRefresh:true,ready:true};
  if(fn===chooseModernConversationDOM){
   const selected=jobs.find(job=>job.hrName===args.contact&&job.company===args.company);
   if(selected)currentJob=selected;return {ok:true,found:!!selected};
  }
  if(fn===modernJobProofDOM)return {ok:true,jobUrl:currentJob.url,closed:args.action==='closed',closeClicked:args.action==='close'};
  assert.equal(fn,modernChatDOM);
  if(args.action==='read')return sent?refusal():context();
  if(args.action==='locateJobEntry'){
   events.push('locate');return afterSend?{ok:true,modern:true,x:100,y:100,viewport:{width:1280,height:800}}:refusal();
  }
  if(args.action==='fill'){events.push('fill');return {ok:true,filled:true};}
  if(args.action==='send'){events.push('send');sent=true;return {ok:true,clicked:true};}
  assert.fail('Unexpected fixture operation');
 };
 const flow=createWorkflows(store,browser,browser,browser,true);
 return {store,browser,flow,jobs,contacts,events,getJob:index=>store.jobs().find(job=>job.url===jobs[index].url),
  ledger:job=>store.meta('job-greeting-delivery:'+identity(jobUrlKey(job.url))),
  close(){store.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'modern-greeting-workflow-'));fs.rmSync(dir,{recursive:true,force:true});}};
}

for(const code of ['MODERN_CHAT_ACTION_UNAVAILABLE','MODERN_CHAT_IDENTITY_UNAVAILABLE'])
 test('native '+code+' before any message keeps the contacted draft and continues screening without duplicate contact',async()=>{
  const f=fixture({code});try{
   const result=await f.flow.scan(),first=f.getJob(0),second=f.getJob(1);
   assert.equal(result.phase,'筛选完成，沟通待核对');assert.equal(result.error,null);assert.equal(result.communicationDeferred,true);
   assert.equal(result.seen,2);assert.equal(result.sent,1);assert.equal(result.greetingDeferred,1);
   assert.deepEqual(f.contacts,[f.jobs[0].url]);assert.equal(first.status,'已沟通');assert.equal(first.greeting.status,'草稿');
   assert.equal(first.greeting.code,'GREETING_DEFERRED');assert.equal(first.greeting.deferred,true);
   assert.equal(second.status,'合适');assert.equal(second.greeting.status,'草稿');assert.equal(f.flow.stats().greetingPending,1);
   assert.equal(f.ledger(first),null);assert.equal(f.store.deliveryCount(),1);
   assert.equal(f.events.some(event=>['mousePressed','mouseReleased','fill','send'].includes(event)),false);
   const probes=code==='MODERN_CHAT_ACTION_UNAVAILABLE'?2:1;
   assert.equal(f.events.filter(event=>event==='locate').length,probes);assert.equal(f.events.filter(event=>event==='focus').length,probes);
   await assert.rejects(f.flow.sendJob(first.id),/岗位已经处理/);
   const retry=await f.flow.greetings.send(first.id);assert.equal(retry.deferred,true);
   assert.equal(f.contacts.length,1);assert.equal(f.store.deliveryCount(),1);assert.equal(f.ledger(first),null);
  }finally{f.close();}
 });

for(const code of ['AUTH_REQUIRED','VERIFICATION_REQUIRED','RATE_LIMITED','CANCELLED','CDP_ERROR','UNRECOGNIZED_FAILURE'])
 test('native '+code+' is not downgraded to continue-screening',async()=>{
  const f=fixture({code});try{
   const result=await f.flow.scan();
   assert.equal(result.phase,code==='CANCELLED'?'已停止':'已暂停');assert.equal(result.communicationDeferred,false);assert.equal(result.greetingDeferred,0);
   assert.equal(result.seen,1);assert.deepEqual(f.contacts,[f.jobs[0].url]);assert.equal(f.getJob(0).greeting.deferred,false);
   assert.equal(f.getJob(0).greeting.status,'草稿');assert.equal(f.ledger(f.getJob(0)),null);
   assert.equal(f.events.some(event=>['mousePressed','mouseReleased','fill','send'].includes(event)),false);
  }finally{f.close();}
 });

test('the same structure refusal after a message click stays uncertain, pauses and cannot retry contact or greeting',async()=>{
 const f=fixture({afterSend:true});try{
  const result=await f.flow.scan(),first=f.getJob(0);
  assert.equal(result.phase,'已暂停');assert.equal(result.communicationDeferred,false);assert.equal(result.greetingDeferred,0);assert.equal(result.seen,1);
  assert.equal(first.status,'已沟通');assert.equal(first.greeting.status,'待核实');assert.equal(f.ledger(first).status,'待核实');
  assert.equal(f.events.filter(event=>event==='send').length,1);assert.deepEqual(f.contacts,[f.jobs[0].url]);
  await assert.rejects(f.flow.greetings.send(first.id),/不会重复发送/);await assert.rejects(f.flow.sendJob(first.id),/岗位已经处理/);
  assert.equal(f.events.filter(event=>event==='send').length,1);assert.equal(f.contacts.length,1);
 }finally{f.close();}
});

function readinessFixture({neverReady=false,draftBeforeContact=false}={}){
 const f=fixture({afterSend:true,existingOpening:true});
 const evaluate=f.browser.evaluateOn,idle=f.browser.assertGreetingChatIdle.bind(f.browser);
 const inspections=[],waits=[];let clock=0,afterContactReads=0;
 f.browser.assertGreetingChatIdle=options=>idle({...options,timeoutMs:40,pollMs:10,
  now:()=>clock,wait:async ms=>{waits.push(ms);clock+=ms;}});
 f.browser.evaluateOn=async(target,fn,args)=>{
  if(fn!==chatRefreshDOM)return evaluate(target,fn,args);
  assert.equal(args.action,'inspect','Readiness recovery must never refresh or mutate the page');
  let state=await evaluate(target,fn,args);
  if(draftBeforeContact)state={ok:false,code:'GREETING_TARGET_UNAVAILABLE',notSent:true,
   error:'消息输入框已有未发送草稿，已保留原稿，未刷新'};
  else if(f.contacts.length===1&&(neverReady||afterContactReads++<2))state={...state,safeToRefresh:false,ready:false,
   readyState:'loading',readiness:'loading',reason:'DOCUMENT_LOADING'};
  inspections.push({contacts:f.contacts.length,...state});return state;
 };
 return {...f,inspections,waits};
}

test('first contacted conversation finishes loading and existing platform openings let both jobs continue without a second opening',async()=>{
 const f=readinessFixture();try{
  const result=await f.flow.scan();
  assert.equal(result.phase,'本轮已完成');assert.equal(result.error,null);assert.equal(result.communicationDeferred,false);
  assert.equal(result.seen,2);assert.equal(result.sent,2);assert.equal(result.greetingDeferred,0);
  assert.deepEqual(f.contacts,f.jobs.map(job=>job.url));assert.equal(f.store.deliveryCount(),2);
  assert.deepEqual(f.waits,[10,10]);
  assert.equal(f.inspections.filter(state=>state.contacts===1&&state.readiness==='loading').length,2);
  assert.ok(f.inspections.some(state=>state.contacts===1&&state.safeToRefresh===true));
  for(let index=0;index<2;index++){
   const job=f.getJob(index),ledger=f.ledger(job);
   assert.equal(job.status,'已沟通');assert.equal(job.greeting.status,'已有开场');assert.equal(job.greeting.deferred,false);
   assert.equal(ledger.status,'已有开场');assert.equal(ledger.existingReceiptId,'platform-opening-'+index);
   assert.equal(ledger.receiptId,undefined,'An observed old opening must not become a new draft receipt');
   await assert.rejects(f.flow.sendJob(job.id),/岗位已经处理/);
   await assert.rejects(f.flow.greetings.send(job.id),/不会重复发送/);
  }
  assert.equal(f.flow.stats().greetingPending,0);assert.equal(f.store.messages().length,0);
  assert.equal(f.events.filter(event=>event==='fill'||event==='send').length,0);
  assert.equal(f.contacts.length,2);
 }finally{f.close();}
});

test('bounded post-contact loading timeout preserves the first draft and screens the next job without another contact',async()=>{
 const f=readinessFixture({neverReady:true});try{
  const result=await f.flow.scan(),first=f.getJob(0),second=f.getJob(1);
  assert.equal(result.phase,'筛选完成，沟通待核对');assert.equal(result.error,null);assert.equal(result.communicationDeferred,true);
  assert.equal(result.seen,2);assert.equal(result.sent,1);assert.equal(result.greetingDeferred,1);
  assert.deepEqual(f.contacts,[f.jobs[0].url]);assert.equal(f.store.deliveryCount(),1);
  assert.deepEqual(f.waits,[10,10,10,10]);
  assert.equal(f.inspections.filter(state=>state.contacts===1&&state.readiness==='loading').length,5);
  assert.equal(first.status,'已沟通');assert.equal(first.greeting.status,'草稿');assert.equal(first.greeting.deferred,true);
  assert.equal(second.status,'合适');assert.equal(second.greeting.status,'草稿');assert.equal(f.ledger(first),null);
  assert.equal(f.events.some(event=>['locate','mousePressed','mouseReleased','fill','send'].includes(event)),false);
  await assert.rejects(f.flow.sendJob(first.id),/岗位已经处理/);assert.equal(f.contacts.length,1);
 }finally{f.close();}
});

test('a manual draft fails pre-contact readiness without waiting, changing the draft, or reserving contact quota',async()=>{
 const f=readinessFixture({draftBeforeContact:true});try{
  const result=await f.flow.scan();
  assert.equal(result.phase,'筛选完成，沟通待核对');assert.equal(result.error,null);assert.equal(result.communicationDeferred,true);
  assert.equal(result.seen,2);assert.equal(result.sent,0);assert.equal(result.greetingDeferred,0);
  assert.deepEqual(f.contacts,[]);assert.equal(f.store.deliveryCount(),0);assert.deepEqual(f.waits,[]);
  assert.equal(f.inspections.length,1);assert.equal(f.inspections[0].contacts,0);
  for(let index=0;index<2;index++){
   const job=f.getJob(index);assert.equal(job.status,'合适');assert.equal(job.greeting.status,'草稿');assert.equal(f.ledger(job),null);
   assert.equal(f.store.db.prepare('SELECT 1 FROM deliveries WHERE id=?').get(job.id),undefined);
  }
  assert.equal(f.events.some(event=>['locate','mousePressed','mouseReleased','fill','send'].includes(event)),false);
 }finally{f.close();}
});
