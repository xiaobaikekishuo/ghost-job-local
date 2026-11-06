import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStore,identity} from '../lib/store.mjs';
import {createWorkflows} from '../lib/workflows.mjs';
import {SimulationBrowser,simulationSettings} from '../lib/simulation.mjs';
import {jobUrlKey} from '../lib/job-greeting-browser.mjs';

const coded=(code,extra={})=>Object.assign(Error('fixture '+code),{code,...extra});
function fixture(t,{personalizedGreeting=true,...settings}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'continuous-review-')),store=createStore(dir);
 store.saveSettings({...simulationSettings(),personalizedGreeting,...settings});
 const browser=new SimulationBrowser(dir),world=browser.world();
 world.jobs=[world.jobs[0],world.jobs[4],world.jobs[5]];browser.save(world);
 const flow=createWorkflows(store,browser,browser,browser,true),contacts=[];
 const communicate=browser.communicate.bind(browser);
 browser.communicate=async(job,...args)=>{contacts.push(job.url);return communicate(job,...args);};
 t.after(()=>{store.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'continuous-review-'));fs.rmSync(dir,{recursive:true,force:true});});
 return {store,browser,flow,contacts,jobs:world.jobs,getJob:index=>store.jobs().find(job=>job.url===world.jobs[index].url),
  contactLedger:job=>store.db.prepare('SELECT status FROM deliveries WHERE id=?').get(job.id)?.status,
  greetingLedger:job=>store.meta('job-greeting-delivery:'+identity(jobUrlKey(job.url)||job.url||job.id))};
}

test('continuous fallback stays enabled by default and explicit strict mode remains saved',t=>{
 const f=fixture(t);assert.equal(f.store.settings().greetingFallback,true);
 f.store.saveSettings({greetingFallback:false});assert.equal(f.store.settings().greetingFallback,false);
 f.store.saveSettings({dailyLimit:21});assert.equal(f.store.settings().greetingFallback,false);
});

test('fallback never treats cancellation, auth, transport or unknown preflight errors as permission to contact',async t=>{
 for(const code of ['CANCELLED','AUTH_REQUIRED','VERIFICATION_REQUIRED','RATE_LIMITED','CDP_ERROR','CDP_COMMAND_TIMEOUT','CDP_SESSION_DETACHED','UNKNOWN_TRANSPORT']){
  const f=fixture(t);
  f.browser.assertGreetingAvailable=async()=>{throw coded(code,{notSent:true,transient:true});};
  const result=await f.flow.scan();
  assert.equal(result.phase,code==='CANCELLED'?'已停止':'已暂停',code);
  assert.equal(result.seen,1,code);assert.equal(result.personalizedPaused,false,code);
  assert.equal(f.store.deliveryCount(),0,code);assert.deepEqual(f.contacts,[],code);
  assert.equal(f.getJob(0).greeting.status,'草稿',code);
 }
});

test('known definitely-unsent capability refusal still permits authorized platform-only continuation',async t=>{
 const f=fixture(t);let checks=0,greetings=0;
 f.browser.assertGreetingAvailable=async()=>{checks++;throw coded('GREETING_TARGET_UNAVAILABLE',{notSent:true});};
 f.browser.sendJobGreeting=async()=>{greetings++;assert.fail('Personalized sending is paused');};
 const result=await f.flow.scan();
 assert.equal(result.phase,'本轮已完成');assert.equal(result.sent,3);assert.equal(result.personalizedPaused,true);
 assert.equal(result.communicationDeferred,false);assert.equal(checks,1);assert.equal(greetings,0);
 assert.deepEqual(f.contacts,f.jobs.map(job=>job.url));assert.equal(f.store.deliveryCount(),3);
});

test('post-contact cancellation, restrictions and unknown transport stop even when notSent is true',async t=>{
 for(const code of ['CANCELLED','AUTH_REQUIRED','VERIFICATION_REQUIRED','RATE_LIMITED','CDP_ERROR','CDP_CONNECT_TIMEOUT','CDP_SESSION_DETACHED','UNKNOWN_TRANSPORT']){
  const f=fixture(t);f.browser.sendJobGreeting=async()=>{throw coded(code,{notSent:true});};
  const result=await f.flow.scan(),first=f.getJob(0);
  assert.equal(result.phase,code==='CANCELLED'?'已停止':'已暂停',code);assert.equal(result.seen,1,code);
  assert.equal(result.personalizedPaused,false,code);assert.deepEqual(f.contacts,[f.jobs[0].url],code);
  assert.equal(first.status,'已沟通',code);assert.equal(first.greeting.status,'草稿',code);
  assert.equal(f.contactLedger(first),'sent',code);assert.equal(f.greetingLedger(first),null,code);
  await assert.rejects(f.flow.sendJob(first.id),/岗位已经处理/);
 }
});

test('an unknown thrown outcome after greeting dispatch keeps its ledger uncertain and stops platform fallback',async t=>{
 for(const failure of [()=>Error('fixture receipt transport lost'),()=>coded('CDP_ERROR'),()=>coded('GREETING_UNCERTAIN')]){
  const f=fixture(t);let attempts=0;
  f.browser.sendJobGreeting=async(job,text,{onAttempt})=>{attempts++;onAttempt();throw failure();};
  const result=await f.flow.scan(),first=f.getJob(0);
  assert.equal(result.phase,'已暂停');assert.equal(result.seen,1);assert.equal(result.personalizedPaused,false);
  assert.deepEqual(f.contacts,[f.jobs[0].url]);assert.equal(first.greeting.status,'待核实');
  assert.equal(f.greetingLedger(first).status,'待核实');assert.equal(f.contactLedger(first),'sent');
  await assert.rejects(f.flow.greetings.send(first.id),/不会重复发送/);
  assert.equal(attempts,1);assert.equal(f.store.releaseDelivery(first.id),false);
 }
});

test('an explicit returned greeting receipt timeout keeps that job uncertain but permits platform-only continuation',async t=>{
 const f=fixture(t);let attempts=0;
 f.browser.sendJobGreeting=async(job,text,{onAttempt})=>{attempts++;onAttempt();return {verified:false,code:'GREETING_UNCERTAIN',reason:'fixture no confirmed receipt'};};
 const result=await f.flow.scan(),first=f.getJob(0);
 assert.equal(result.phase,'本轮已完成');assert.equal(result.sent,3);assert.equal(result.personalizedPaused,true);
 assert.equal(first.greeting.status,'待核实');assert.equal(f.greetingLedger(first).status,'待核实');
 assert.deepEqual(f.contacts,f.jobs.map(job=>job.url));assert.equal(attempts,1);
 await assert.rejects(f.flow.greetings.send(first.id),/不会重复发送/);
 await f.flow.scan();assert.equal(f.contacts.length,3);assert.equal(attempts,1);
});

test('returned unknown greeting failures cannot borrow a notSent guarantee to continue',async t=>{
 const f=fixture(t);
 f.browser.sendJobGreeting=async()=>({verified:false,code:'UNKNOWN_REFUSAL',notSent:true,reason:'fixture unknown refusal'});
 const result=await f.flow.scan();assert.equal(result.phase,'已暂停');assert.equal(result.seen,1);
 assert.deepEqual(f.contacts,[f.jobs[0].url]);assert.equal(result.personalizedPaused,false);
});

test('known pre-click failures release only pending contact quota and permanent flags block manual recontact',async t=>{
 for(const code of ['ALREADY_CONTACTED','JOB_CLOSED']){
  const f=fixture(t,{personalizedGreeting:false});let calls=0;
  f.browser.communicate=async job=>{calls++;throw coded(code,{notSent:true});};
  const job=f.store.upsertJob({...f.jobs[0],status:'合适'});
  await assert.rejects(f.flow.sendJob(job.id),{code,notSent:true});
  const saved=f.store.getJob(job.id);assert.equal(f.contactLedger(saved),undefined);assert.equal(f.store.deliveryCount(),0);
  assert.equal(saved[code==='ALREADY_CONTACTED'?'alreadyContacted':'jobClosed'],true);
  await assert.rejects(f.flow.sendJob(job.id),/岗位已经处理|已关闭/);assert.equal(calls,1);
 }
});

test('pre-click auth and cancellation release quota, but post-click or unknown failures never do',async t=>{
 for(const [code,notSent,released] of [['AUTH_REQUIRED',true,true],['CANCELLED',true,true],['RATE_LIMITED',true,true],
  ['CHAT_BUTTON_MISSING',true,true],['CHAT_BUTTON_MISSING',false,false],['CANCELLED',false,false],['CDP_ERROR',true,false]]){
  const f=fixture(t,{personalizedGreeting:false}),job=f.store.upsertJob({...f.jobs[0],status:'合适'});
  f.browser.communicate=async()=>{throw coded(code,{notSent});};
  await assert.rejects(f.flow.sendJob(job.id),{code});
  const saved=f.store.getJob(job.id);
  assert.equal(f.contactLedger(saved),released?undefined:'uncertain',code+':'+notSent);
  assert.equal(f.store.deliveryCount(),released?0:1,code+':'+notSent);
  assert.equal(saved.status,released?'合适':'待核实',code+':'+notSent);
  if(!released){assert.equal(f.store.releaseDelivery(saved.id),false);await assert.rejects(f.flow.sendJob(saved.id),/岗位已经处理/);}
 }
});
