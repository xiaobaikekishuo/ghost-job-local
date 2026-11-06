import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStore} from '../lib/store.mjs';
import {SimulationBrowser,simulationSettings} from '../lib/simulation.mjs';
import {createWorkflows} from '../lib/workflows.mjs';

const targetUnavailable=()=>Object.assign(Error('未能核对唯一岗位对应的 HR，确认未发送'),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'deferred-screening-')),store=createStore(dir);
 store.saveSettings({...simulationSettings(),personalizedGreeting:true,greetingFallback:false});
 const browser=new SimulationBrowser(dir),world=browser.world();
 world.jobs=[world.jobs[0],world.jobs[1],world.jobs[3],world.jobs[4],world.jobs[5]];browser.save(world);
 const jobs=world.jobs,flow=createWorkflows(store,browser,browser,browser,true),prepared=[],contacts=[],greetingAttempts=[];
 let reservations=0,capabilities=0;
 const prepare=flow.greetings.prepare,reserve=store.reserveDelivery,communicate=browser.communicate.bind(browser),greet=browser.sendJobGreeting.bind(browser);
 flow.greetings.prepare=async(id,...args)=>{prepared.push(store.getJob(id).url);return prepare(id,...args);};
 store.reserveDelivery=(...args)=>{reservations++;return reserve(...args);};
 browser.assertGreetingAvailable=async()=>{capabilities++;};
 browser.communicate=async(job,...args)=>{contacts.push(job.url);return communicate(job,...args);};
 browser.sendJobGreeting=async(job,...args)=>{greetingAttempts.push(job.url);return greet(job,...args);};
 t.after(()=>{store.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'deferred-screening-'));fs.rmSync(dir,{recursive:true,force:true});});
 return {store,browser,flow,jobs,prepared,contacts,greetingAttempts,normalGreeting:browser.sendJobGreeting,normalCapability:browser.assertGreetingAvailable,
  get reservations(){return reservations;},get capabilities(){return capabilities;},getJob:index=>store.jobs().find(job=>job.url===jobs[index].url)};
}
function assertScreened(f,result){
 assert.equal(result.phase,'筛选完成，沟通待核对');assert.equal(result.error,null);
 assert.equal(result.communicationDeferred,true);assert.match(result.message,/身份待核对.*后续不再发起沟通.*继续筛选.*草稿/);
 assert.equal(result.seen,5);assert.equal(result.skipped,2);assert.equal(f.store.jobs().length,5);
 for(const index of [0,3,4])assert.equal(f.getJob(index).greeting.status,'草稿');
 for(const index of [1,2]){assert.equal(f.getJob(index).status,'不合适');assert.equal(f.getJob(index).greeting,undefined);}
 assert.deepEqual(new Set(f.prepared),new Set([f.jobs[0].url,f.jobs[3].url,f.jobs[4].url]));
 assert.equal(f.store.settings().autoSend,true);assert.equal(f.store.settings().personalizedGreeting,true);
 assert.ok(f.store.logs().some(entry=>/本轮后续不再发起沟通/.test(entry.text)));
}

test('existing platform openings skip custom greetings while the batch continues and never recontacts on restart',async t=>{
 const f=fixture(t);
 f.browser.sendJobGreeting=async job=>({verified:false,notSent:true,alreadyGreeted:true,code:'GREETING_ALREADY_PRESENT',receiptId:'opening-'+job.id,
  conversation:{modernProofVerified:true,jobUrl:job.url,contact:job.hrName,company:job.company,jobTitle:job.title},reason:'已有本人开场，未追加'});
 const result=await f.flow.scan();
 assert.equal(result.phase,'本轮已完成');assert.equal(result.error,null);assert.equal(result.communicationDeferred,false);
 assert.equal(result.seen,5);assert.equal(result.sent,3);assert.equal(f.contacts.length,3);assert.equal(f.flow.stats().greetingPending,0);
 for(const index of [0,3,4])assert.equal(f.getJob(index).greeting.status,'已有开场');
 assert.equal(f.store.messages().length,0);
 const restarted=await f.flow.scan();assert.equal(restarted.sent,0);assert.equal(f.contacts.length,3);
});

test('pre-contact identity refusal finishes screening across pages with drafts and no reservations or HR contact',async t=>{
 const f=fixture(t);let checks=0,page=0;
 f.browser.assertGreetingAvailable=async()=>{checks++;throw targetUnavailable();};
 f.browser.readJobs=async()=>({jobs:page===0?f.jobs.slice(0,2):[f.jobs[0],...f.jobs.slice(2)],blocked:''});
 f.browser.nextPage=async()=>++page<2;
 const result=await f.flow.scan();assertScreened(f,result);
 assert.equal(result.sent,0);assert.equal(result.greetingDeferred,0);assert.equal(checks,1);
 assert.equal(f.reservations,0);assert.equal(f.store.deliveryCount(),0);assert.deepEqual(f.contacts,[]);assert.deepEqual(f.greetingAttempts,[]);
 for(const index of [0,3,4])assert.equal(f.getJob(index).status,'合适');
});

test('post-contact identity refusal preserves both ledgers and continues drafts without another opening',async t=>{
 const f=fixture(t);let attempts=0;
 f.browser.sendJobGreeting=async()=>{attempts++;throw targetUnavailable();};
 const result=await f.flow.scan();assertScreened(f,result);
 assert.equal(result.sent,1);assert.equal(result.greetingDeferred,1);assert.equal(f.capabilities,1);assert.equal(attempts,1);
 assert.equal(f.reservations,1);assert.equal(f.store.deliveryCount(),1);assert.deepEqual(f.contacts,[f.jobs[0].url]);
 const first=f.getJob(0);assert.equal(first.status,'已沟通');assert.ok(first.sentAt);assert.equal(first.greeting.deferred,true);
 assert.equal(f.store.db.prepare('SELECT status FROM deliveries WHERE id=?').get(first.id).status,'sent');
 assert.equal(f.store.messages().filter(message=>message.kind==='greeting').length,0);
 for(const index of [3,4])assert.equal(f.getJob(index).status,'合适');
 await assert.rejects(f.flow.sendJob(first.id),/岗位已经处理/);assert.equal(f.reservations,1);
});

test('a new explicit run resets the local restriction and retries pre-contact jobs using the saved configuration',async t=>{
 const f=fixture(t);f.browser.assertGreetingAvailable=async()=>{throw targetUnavailable();};
 assert.equal((await f.flow.scan()).communicationDeferred,true);
 f.browser.assertGreetingAvailable=f.normalCapability;
 const result=await f.flow.scan();
 assert.equal(result.phase,'本轮已完成');assert.equal(result.communicationDeferred,false);assert.equal(result.message,'');
 assert.equal(result.sent,3);assert.equal(result.greetingDeferred,0);assert.equal(f.reservations,3);
 assert.equal(new Set(f.contacts).size,3);assert.equal(f.store.deliveryCount(),3);assert.equal(f.store.settings().autoSend,true);
});

test('restarting after post-contact deferral skips the contacted job and only opens the remaining suitable jobs',async t=>{
 const f=fixture(t);f.browser.sendJobGreeting=async()=>{throw targetUnavailable();};
 await f.flow.scan();const first=f.getJob(0),revision=first.greeting.revision;
 f.browser.sendJobGreeting=f.normalGreeting;
 const result=await f.flow.scan();
 assert.equal(result.communicationDeferred,false);assert.equal(result.sent,2);assert.equal(result.duplicates,1);
 assert.equal(f.contacts.filter(url=>url===first.url).length,1);assert.equal(f.reservations,3);assert.equal(f.store.deliveryCount(),3);
 assert.equal(f.getJob(0).status,'已沟通');assert.equal(f.getJob(0).greeting.status,'草稿');assert.equal(f.getJob(0).greeting.revision,revision);
});

test('authentication, verification, limits, transport, unknown and ambiguous preflight failures still stop the batch',async t=>{
 for(const [code,notSent] of [['AUTH_REQUIRED',true],['VERIFICATION_REQUIRED',true],['RATE_LIMITED',true],
  ['CDP_ERROR',true],['UNKNOWN_FAILURE',true],['GREETING_TARGET_UNAVAILABLE',false],['CANCELLED',true]]){
  const f=fixture(t);let checks=0;
  f.browser.assertGreetingAvailable=async()=>{checks++;throw Object.assign(Error(code),{code,notSent});};
  const result=await f.flow.scan();
  assert.equal(result.phase,code==='CANCELLED'?'已停止':'已暂停',code);assert.equal(result.communicationDeferred,false,code);
  assert.equal(result.seen,1);assert.equal(f.store.jobs().length,1);assert.equal(checks,1);
  assert.equal(f.reservations,0);assert.equal(f.store.deliveryCount(),0);assert.deepEqual(f.contacts,[]);
 }
});

test('a target-unavailable error after contact quota is reserved is never mistaken for a safe preflight refusal',async t=>{
 const f=fixture(t);f.browser.communicate=async()=>{throw targetUnavailable();};
 const result=await f.flow.scan();
 assert.equal(result.phase,'已暂停');assert.equal(result.communicationDeferred,false);assert.equal(result.seen,1);
 assert.equal(f.reservations,1);assert.equal(f.store.deliveryCount(),1);assert.equal(f.getJob(0).status,'待核实');
 assert.equal(f.store.db.prepare('SELECT status FROM deliveries WHERE id=?').get(f.getJob(0).id).status,'uncertain');
 assert.equal(f.getJob(3),undefined);
});

test('a send attempt without an explicit notSent guarantee remains uncertain and stops screening',async t=>{
 const f=fixture(t);f.browser.sendJobGreeting=async(job,text,options)=>{options.onAttempt();throw Object.assign(Error('回执丢失'),{code:'GREETING_TARGET_UNAVAILABLE'});};
 const result=await f.flow.scan();
 assert.equal(result.phase,'已暂停');assert.equal(result.communicationDeferred,false);assert.equal(result.seen,1);assert.equal(result.sent,1);
 assert.equal(f.reservations,1);assert.equal(f.getJob(0).status,'已沟通');assert.equal(f.getJob(0).greeting.status,'待核实');
 assert.equal(f.getJob(3),undefined);await assert.rejects(f.flow.greetings.send(f.getJob(0).id),/不会重复发送/);
});

test('a later detail authentication failure still pauses after communication was deferred',async t=>{
 const f=fixture(t),detail=f.browser.detail.bind(f.browser);
 f.browser.assertGreetingAvailable=async()=>{throw targetUnavailable();};
 f.browser.detail=async(...args)=>{if(f.browser.jobUrl===f.jobs[3].url)throw Object.assign(Error('登录已失效'),{code:'AUTH_REQUIRED'});return detail(...args);};
 const result=await f.flow.scan();
 assert.equal(result.phase,'已暂停');assert.equal(result.communicationDeferred,true);assert.match(result.error,/登录已失效/);
 assert.equal(result.seen,4);assert.equal(f.getJob(4),undefined);assert.equal(f.reservations,0);assert.deepEqual(f.contacts,[]);
});

test('stop during later draft preparation keeps already-screened drafts and does not process another job',async t=>{
 const f=fixture(t),prepare=f.flow.greetings.prepare;
 f.browser.assertGreetingAvailable=async()=>{throw targetUnavailable();};
 f.flow.greetings.prepare=async(id,...args)=>{if(f.store.getJob(id).url===f.jobs[3].url)f.flow.stop();return prepare(id,...args);};
 const result=await f.flow.scan();
 assert.equal(result.phase,'已停止');assert.equal(result.error,null);assert.equal(result.communicationDeferred,true);
 assert.equal(f.getJob(0).greeting.status,'草稿');assert.equal(f.getJob(4),undefined);assert.equal(f.reservations,0);assert.deepEqual(f.contacts,[]);
});
