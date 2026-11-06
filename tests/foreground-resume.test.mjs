import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStore,identity} from '../lib/store.mjs';
import {createWorkflows} from '../lib/workflows.mjs';
import {SimulationBrowser,simulationSettings} from '../lib/simulation.mjs';
import {jobUrlKey} from '../lib/job-greeting-browser.mjs';

const foreground=()=>Object.assign(Error('消息页不在前台，未定位职位入口'),{
 code:'GREETING_TARGET_UNAVAILABLE',notSent:true,reason:'CHAT_NOT_FOREGROUND'});
function fixture(t,{count=7,options={},fallback=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'foreground-resume-')),store=createStore(dir);
 store.saveSettings({...simulationSettings(),personalizedGreeting:true,greetingFallback:fallback,dailyLimit:30});
 const browser=new SimulationBrowser(dir),world=browser.world(),sample=world.jobs[0];
 world.jobs=Array.from({length:count},(_,index)=>({...sample,url:`https://www.zhipin.com/job_detail/foreground-fixture-${index}.html`}));
 browser.save(world);browser.connection={generation:7,session:{connected:true}};
 browser.chatTargetId='fixed-chat';browser.activeTargetId='fixed-chat';
 const flow=createWorkflows(store,browser,browser,browser,true,options),contacts=[],greetings=[],probes=[],capabilities=[];
 const communicate=browser.communicate.bind(browser),sendGreeting=browser.sendJobGreeting.bind(browser);
 browser.communicate=async(job,...args)=>{contacts.push(job.url);return communicate(job,...args);};
 browser.assertGreetingAvailable=async({job,active})=>{assert.equal(active(),true);capabilities.push(job.url);return {available:true};};
 browser.sendJobGreeting=async(job,...args)=>{
  greetings.push(job.url);if(greetings.length<=2)throw foreground();return sendGreeting(job,...args);
 };
 browser.assertGreetingForeground=async({job,targetId,generation,active})=>{
  assert.equal(active(),true);assert.equal(targetId,'fixed-chat');assert.equal(generation,7);
  assert.equal(store.getJob(job.id).status,'合适');assert.equal(contacts.includes(job.url),false);
  assert.equal(store.db.prepare('SELECT 1 FROM deliveries WHERE id=?').get(job.id),undefined);
  assert.equal(flow.task.foregroundRecoveryStatus,'checking');assert.equal(flow.task.foregroundRecoveryAttempts,probes.length+1);
  probes.push(job.url);browser.activeTargetId=targetId;
  return {available:true,foreground:true,targetId,generation};
 };
 t.after(()=>{store.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'foreground-resume-'));fs.rmSync(dir,{recursive:true,force:true});});
 return {store,browser,flow,jobs:world.jobs,contacts,greetings,probes,capabilities,sendGreeting,
  getJob:index=>store.jobs().find(job=>job.url===world.jobs[index].url),
  greetingLedger:job=>store.meta('job-greeting-delivery:'+identity(jobUrlKey(job.url)||job.url||job.id))};
}

test('two pure pre-attempt foreground refusals recover only on the third later suitable job with fresh per-job checks',async t=>{
 const f=fixture(t),result=await f.flow.scan();
 assert.equal(result.phase,'本轮已完成');assert.equal(result.error,null);assert.equal(result.sent,7);
 assert.equal(result.personalizedPaused,false);assert.equal(result.personalizedRecoveryReason,null);
 assert.equal(result.foregroundRecoveryStatus,'recovered');assert.equal(result.foregroundRecoveryAttempts,1);
 assert.deepEqual(f.probes,[f.jobs[4].url]);assert.equal(result.foregroundRecoveryJobsLeft,0);
 assert.deepEqual(f.contacts,f.jobs.map(job=>job.url));assert.equal(f.store.deliveryCount(),7);
 assert.deepEqual(f.greetings,[f.jobs[0].url,f.jobs[1].url,...f.jobs.slice(4).map(job=>job.url)]);
 assert.deepEqual(f.capabilities,f.greetings,'Every resumed job still enters normal capability and recipient delivery flow');
 for(const index of [0,1]){
  const job=f.getJob(index);assert.equal(job.greeting.status,'草稿');assert.equal(job.greeting.deferReason,'CHAT_NOT_FOREGROUND');
  assert.equal(f.greetingLedger(job),null);await assert.rejects(f.flow.sendJob(job.id),/岗位已经处理/);
 }
 for(const index of [2,3])assert.equal(f.getJob(index).greeting,undefined);
 for(const index of [4,5,6])assert.equal(f.getJob(index).greeting.status,'已发送');
 await f.flow.scan();assert.equal(f.contacts.length,7);assert.equal(f.greetings.length,5);assert.equal(f.probes.length,1);
});

test('persistent hidden state has a bounded two-probe budget and increasing new-job backoff',async t=>{
 const f=fixture(t,{count:9,options:{foregroundRetryEvery:1,foregroundRetryLimit:2}}),probe=f.browser.assertGreetingForeground;
 f.browser.assertGreetingForeground=async options=>{await probe(options);throw foreground();};
 const result=await f.flow.scan();
 assert.equal(result.phase,'本轮已完成');assert.equal(result.personalizedPaused,true);
 assert.equal(result.foregroundRecoveryStatus,'exhausted');assert.equal(result.personalizedRecoveryReason,null);
 assert.equal(result.foregroundRecoveryAttempts,2);assert.equal(result.foregroundRecoveryJobsLeft,0);
 assert.deepEqual(f.probes,[f.jobs[2].url,f.jobs[4].url]);assert.equal(f.greetings.length,2);
 assert.deepEqual(f.contacts,f.jobs.map(job=>job.url));assert.match(result.message,/次数已用尽/);
});

test('successful foreground probes do not reset the per-run budget when foreground is lost again',async t=>{
 const f=fixture(t,{count:10,options:{foregroundRetryEvery:1,foregroundRetryLimit:2}});
 f.browser.sendJobGreeting=async job=>{f.greetings.push(job.url);throw foreground();};
 const result=await f.flow.scan();
 assert.equal(result.phase,'本轮已完成');assert.equal(result.foregroundRecoveryStatus,'exhausted');
 assert.equal(result.foregroundRecoveryAttempts,2);assert.equal(result.personalizedPaused,true);
 assert.deepEqual(f.probes,[f.jobs[2].url,f.jobs[5].url]);
 assert.deepEqual(f.greetings,[0,1,2,3,5,6].map(index=>f.jobs[index].url));
 assert.equal(new Set(f.contacts).size,10);assert.equal(f.contacts.length,10);
});

test('after foreground recovery an existing platform opening still prevents any personalized send attempt',async t=>{
 const f=fixture(t,{count:4,options:{foregroundRetryEvery:1}});let attempts=0;
 f.browser.sendJobGreeting=async(job,text,{onAttempt})=>{
  f.greetings.push(job.url);if(f.greetings.length<=2)throw foreground();
  // No onAttempt call is needed to observe a pre-existing platform message.
  return {verified:false,notSent:true,alreadyGreeted:true,code:'GREETING_ALREADY_PRESENT',receiptId:'existing-'+job.id,
   conversation:{modernProofVerified:true,jobUrl:job.url,contact:job.hrName,company:job.company,jobTitle:job.title},
   reason:'已核对已有本人开场'};
 };
 const originalMeta=f.store.meta;
 f.store.meta=(id,value)=>{if(value?.status==='待核实'&&String(id).startsWith('job-greeting-delivery:'))attempts++;return originalMeta(id,value);};
 const result=await f.flow.scan();assert.equal(result.foregroundRecoveryStatus,'recovered');assert.equal(result.sent,4);
 assert.equal(attempts,0);assert.equal(f.getJob(2).greeting.status,'已有开场');assert.equal(f.getJob(3).greeting.status,'已有开场');
 assert.equal(f.store.messages().length,0);assert.deepEqual(f.contacts,f.jobs.map(job=>job.url));
 await f.flow.scan();assert.equal(f.contacts.length,4);assert.equal(attempts,0);
});

test('a generic ready result or wrong foreground proof cannot unlock personalized delivery',async t=>{
 for(const change of [result=>({available:true}),result=>({...result,foreground:false}),result=>({...result,targetId:'other-chat'}),
  result=>({...result,generation:8}),result=>({...result,error:'invalid proof'})]){
  const f=fixture(t,{count:5,options:{foregroundRetryEvery:1}}),probe=f.browser.assertGreetingForeground;
  f.browser.assertGreetingForeground=async options=>change(await probe(options));
  const result=await f.flow.scan();
  assert.equal(result.phase,'本轮已完成');assert.equal(result.personalizedPaused,true);
  assert.equal(result.foregroundRecoveryStatus,'blocked');assert.equal(result.personalizedRecoveryReason,null);
  assert.equal(f.probes.length,1);assert.equal(f.greetings.length,2);assert.equal(f.contacts.length,5);
 }
});

test('prior identity refusal prevents later foreground readiness from clearing the run restriction',async t=>{
 const f=fixture(t,{count:7,options:{foregroundRetryEvery:1}});let calls=0;
 f.browser.sendJobGreeting=async(job,...args)=>{
  f.greetings.push(job.url);calls++;
  if(calls===1)throw Object.assign(Error('HR identity is ambiguous'),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
  if(calls===2)return f.sendGreeting(job,...args);
  throw foreground();
 };
 const result=await f.flow.scan();
 assert.equal(result.phase,'本轮已完成');assert.equal(result.personalizedPaused,true);
 assert.equal(result.foregroundRecoveryStatus,'blocked');assert.equal(f.probes.length,0);
 assert.equal(f.greetings.length,4);assert.equal(f.contacts.length,7);
});

test('onAttempt refusals, matching words alone and drafts never gain the foreground recovery marker',async t=>{
 for(const kind of ['attempted','words-only','manual-draft']){
  const f=fixture(t,{count:5,options:{foregroundRetryEvery:1}});
  f.browser.sendJobGreeting=async(job,text,{onAttempt})=>{
   f.greetings.push(job.url);const error=foreground();
   if(kind==='attempted')onAttempt();
   else if(kind==='words-only')delete error.reason;
   else{error.message='消息输入框已有未发送草稿';delete error.reason;}
   throw error;
  };
  const result=await f.flow.scan();
  assert.equal(result.phase,'本轮已完成');assert.equal(result.foregroundRecoveryStatus,'blocked',kind);
  assert.equal(f.probes.length,0,kind);assert.equal(f.greetings.length,2,kind);
  for(const index of [0,1])assert.equal(f.getJob(index).greeting.deferReason,null,kind);
 }
});

test('auth, cancellation and transport errors during the read-only recovery stop before the new contact',async t=>{
 for(const code of ['AUTH_REQUIRED','VERIFICATION_REQUIRED','RATE_LIMITED','CANCELLED','CDP_ERROR','UNKNOWN_TRANSPORT']){
  const f=fixture(t,{count:5,options:{foregroundRetryEvery:1}});
  f.browser.assertGreetingForeground=async()=>{throw Object.assign(Error(code),{code,notSent:true});};
  const result=await f.flow.scan();
  assert.equal(result.phase,code==='CANCELLED'?'已停止':'已暂停',code);assert.equal(result.seen,3,code);
  assert.deepEqual(f.contacts,f.jobs.slice(0,2).map(job=>job.url),code);assert.equal(f.greetings.length,2,code);
  assert.equal(f.store.deliveryCount(),2,code);assert.equal(result.personalizedPaused,true,code);
 }
});

test('a manual draft appearing during recovery permanently disables this run recovery without sending it',async t=>{
 const f=fixture(t,{count:5,options:{foregroundRetryEvery:1}});let probes=0;
 f.browser.assertGreetingForeground=async()=>{probes++;throw Object.assign(Error('消息输入框已有未发送草稿'),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});};
 const result=await f.flow.scan();assert.equal(result.phase,'本轮已完成');assert.equal(result.foregroundRecoveryStatus,'blocked');
 assert.equal(result.personalizedPaused,true);assert.equal(probes,1);assert.equal(f.greetings.length,2);assert.equal(f.contacts.length,5);
});

test('stop or pinned target/generation changes during readiness prevent recovery and contact',async t=>{
 for(const mutation of [f=>f.flow.stop(),f=>{f.browser.connection.generation=8;},f=>{f.browser.chatTargetId='other-chat';}]){
  const f=fixture(t,{count:4,options:{foregroundRetryEvery:1}}),probe=f.browser.assertGreetingForeground;
  f.browser.assertGreetingForeground=async options=>{const result=await probe(options);mutation(f);return result;};
  const result=await f.flow.scan();assert.ok(['已停止','已暂停'].includes(result.phase));
  assert.equal(result.personalizedPaused,true);assert.equal(f.contacts.length,2);assert.equal(f.greetings.length,2);
  assert.equal(f.store.deliveryCount(),2);
 }
});

test('a returned uncertain greeting receipt never enters foreground recovery or resends the draft',async t=>{
 const f=fixture(t,{count:5,options:{foregroundRetryEvery:1}});
 f.browser.sendJobGreeting=async(job,text,{onAttempt})=>{
  f.greetings.push(job.url);onAttempt();return {verified:false,code:'GREETING_UNCERTAIN',reason:'CHAT_NOT_FOREGROUND'};
 };
 const result=await f.flow.scan(),first=f.getJob(0);
 assert.equal(result.phase,'本轮已完成');assert.equal(result.personalizedPaused,true);assert.equal(result.foregroundRecoveryStatus,'blocked');
 assert.equal(f.probes.length,0);assert.equal(f.greetings.length,1);assert.equal(f.contacts.length,5);
 assert.equal(first.greeting.status,'待核实');assert.equal(f.greetingLedger(first).status,'待核实');
 await assert.rejects(f.flow.greetings.send(first.id),/不会重复发送/);
});

test('strict fallback-disabled mode keeps the existing screen-only restriction with no recovery probe',async t=>{
 const f=fixture(t,{count:4,options:{foregroundRetryEvery:1},fallback:false}),result=await f.flow.scan();
 assert.equal(result.phase,'筛选完成，沟通待核对');assert.equal(result.communicationDeferred,true);
 assert.equal(f.probes.length,0);assert.equal(f.contacts.length,1);assert.equal(f.greetings.length,1);
});
