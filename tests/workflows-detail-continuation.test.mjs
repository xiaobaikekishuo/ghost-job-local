import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStore,identity} from '../lib/store.mjs';
import {SimulationBrowser,simulationSettings} from '../lib/simulation.mjs';
import {createWorkflows} from '../lib/workflows.mjs';

const detailRequired=()=>Object.assign(Error('当前岗位详情尚未核实'),{code:'JOB_DETAIL_REQUIRED',notSent:true});
const identityRequired=()=>Object.assign(Error('当前岗位对应的 HR 尚未核实'),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
function fixture(t,count=2){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'detail-continuation-')),store=createStore(dir);
 store.saveSettings({...simulationSettings(),personalizedGreeting:true,greetingFallback:false});
 const browser=new SimulationBrowser(dir),world=browser.world();
 world.jobs=[world.jobs[0],world.jobs[4],world.jobs[5]].slice(0,count);browser.save(world);
 const jobs=world.jobs,listJobs=jobs.map(job=>({...job,description:job.title+'\n'+job.company+'\n8-12K\n本科'}));
 const flow=createWorkflows(store,browser,browser,browser,true),reserved=[],contacts=[],reads=[];
 const reserve=store.reserveDelivery,communicate=browser.communicate.bind(browser),detail=browser.detail.bind(browser);
 store.reserveDelivery=(id,...args)=>{reserved.push(store.getJob(id).url);return reserve(id,...args);};
 browser.communicate=async(job,...args)=>{contacts.push(job.url);return communicate(job,...args);};
 browser.readJobs=async()=>({jobs:listJobs,blocked:''});
 browser.detail=async(...args)=>{reads.push(browser.jobUrl);return detail(...args);};
 t.after(()=>{store.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'detail-continuation-'));fs.rmSync(dir,{recursive:true,force:true});});
 return {store,browser,flow,jobs,listJobs,reserved,contacts,reads,detail:browser.detail,
  getJob:index=>store.jobs().find(job=>job.url===jobs[index].url)};
}

test('missing JD or company only fails that job, preserves its draft, and allows the next valid job to send',async t=>{
 for(const missing of ['jd','company']){
  const f=fixture(t),draft={status:'草稿',text:'保留原有人工草稿',revision:'saved-revision'};
  if(missing==='company')f.listJobs[0].company='公司名称';
  f.store.upsertJob({...f.listJobs[0],greeting:draft});
  f.browser.detail=async(...args)=>f.browser.jobUrl===f.jobs[0].url
   ?{...f.jobs[0],...(missing==='jd'?{description:f.listJobs[0].description}:{company:'公司名称'})}:f.detail(...args);
  const result=await f.flow.scan(),first=f.getJob(0),second=f.getJob(1);
  assert.equal(result.phase,'本轮已完成',missing);assert.equal(result.error,null);assert.equal(result.failed,1);assert.equal(result.skipped,0);
  assert.equal(result.seen,2);assert.equal(result.sent,1);assert.equal(first.status,'分析失败');assert.match(first.reason,/详情待核对/);
  assert.deepEqual(first.greeting,draft);assert.equal(second.status,'已沟通');assert.equal(second.greeting.status,'已发送');
  assert.deepEqual(f.reserved,[f.jobs[1].url]);assert.deepEqual(f.contacts,[f.jobs[1].url]);
  assert.equal(f.store.deliveryCount(),1);assert.ok(f.store.logs().some(entry=>entry.text.includes(first.title)&&/详情待核对/.test(entry.text)));
  f.browser.detail=f.detail;f.listJobs[0].company=f.jobs[0].company;
  const retry=await f.flow.scan();assert.equal(retry.error,null);assert.equal(retry.failed,0);assert.equal(retry.sent,1);assert.equal(retry.duplicates,1);
 }
});

test('detail failure inside greeting preparation continues before reserving when basic screening needs no detail',async t=>{
 const f=fixture(t);f.store.saveSettings({aiEnabled:false,resumeMatch:false,activityEnabled:false});
 let failedReads=0;
 f.browser.detail=async(...args)=>{
  if(f.browser.jobUrl===f.jobs[0].url){failedReads++;assert.equal(f.getJob(0).status,'合适');return {...f.jobs[0],description:f.listJobs[0].description};}
  return f.detail(...args);
 };
 const result=await f.flow.scan();
 assert.equal(result.error,null);assert.equal(result.failed,1);assert.equal(result.skipped,0);assert.equal(result.sent,1);assert.equal(failedReads,1);
 assert.equal(f.getJob(0).status,'分析失败');assert.equal(f.getJob(1).status,'已沟通');
 assert.deepEqual(f.reserved,[f.jobs[1].url]);assert.deepEqual(f.contacts,[f.jobs[1].url]);
});

test('a later safe draft detail failure stays local while identity-deferred screening continues',async t=>{
 const f=fixture(t,3),prepare=f.flow.greetings.prepare,draft={status:'草稿',text:'第二岗位旧稿',revision:'old-second'};
 f.store.upsertJob({...f.listJobs[1],greeting:draft});
 f.browser.assertGreetingAvailable=async()=>{throw identityRequired();};
 f.flow.greetings.prepare=async(id,...args)=>{if(f.store.getJob(id).url===f.jobs[1].url)throw detailRequired();return prepare(id,...args);};
 const result=await f.flow.scan();
 assert.equal(result.phase,'筛选完成，沟通待核对');assert.equal(result.error,null);assert.equal(result.communicationDeferred,true);
 assert.equal(result.failed,1);assert.equal(result.skipped,0);assert.equal(result.sent,0);assert.equal(result.seen,3);
 assert.equal(f.getJob(0).greeting.status,'草稿');assert.deepEqual(f.getJob(1).greeting,draft);assert.equal(f.getJob(1).status,'分析失败');
 assert.equal(f.getJob(2).status,'合适');assert.equal(f.getJob(2).greeting.status,'草稿');assert.equal(f.store.deliveryCount(),0);
 assert.deepEqual(f.reserved,[]);assert.deepEqual(f.contacts,[]);
});

test('missing no-send certainty, auth, verification, limits, transport and unknown detail errors still pause',async t=>{
 for(const [code,notSent] of [['JOB_DETAIL_REQUIRED',undefined],['JOB_DETAIL_REQUIRED',false],['AUTH_REQUIRED',true],
  ['VERIFICATION_REQUIRED',true],['RATE_LIMITED',true],['CDP_ERROR',true],['UNKNOWN_FAILURE',true],[undefined,true]]){
  const f=fixture(t);f.browser.detail=async()=>{throw Object.assign(Error(code||'uncoded detail failure'),{code,notSent});};
  const result=await f.flow.scan();
  assert.equal(result.phase,'已暂停',String(code));assert.ok(result.error);assert.equal(result.failed,0);assert.equal(result.seen,1);
  assert.equal(f.getJob(1),undefined);assert.deepEqual(f.reserved,[]);assert.deepEqual(f.contacts,[]);assert.equal(f.store.deliveryCount(),0);
 }
});

test('a detail-required error after contact reservation remains uncertain and never continues to another job',async t=>{
 const f=fixture(t);f.browser.communicate=async job=>{f.contacts.push(job.url);throw detailRequired();};
 const result=await f.flow.scan(),first=f.getJob(0);
 assert.equal(result.phase,'已暂停');assert.equal(result.failed,0);assert.equal(result.seen,1);assert.equal(f.getJob(1),undefined);
 assert.deepEqual(f.reserved,[f.jobs[0].url]);assert.deepEqual(f.contacts,[f.jobs[0].url]);assert.equal(f.store.deliveryCount(),1);
 assert.equal(first.status,'待核实');assert.ok(first.attemptedAt);assert.equal(first.greeting.status,'草稿');
 assert.equal(f.store.db.prepare('SELECT status FROM deliveries WHERE id=?').get(first.id).status,'uncertain');
});

test('paused scans retain the failing phase and a fresh run clears it',async t=>{
 const f=fixture(t);f.browser.detail=async()=>{throw Object.assign(Error('AI 生成：连接中断（ECONNRESET，已尝试 3 次）'),{code:'CHATGPT_NETWORK_ERROR'});};
 const failed=await f.flow.scan();
 assert.equal(failed.phase,'已暂停');assert.match(failed.failedPhase,/分析：/);
 assert.ok(f.store.logs().some(entry=>entry.text.includes(failed.failedPhase)&&entry.text.includes('ECONNRESET')));
 f.browser.detail=f.detail;const finished=await f.flow.scan();
 assert.equal(finished.phase,'本轮已完成');assert.equal(finished.failedPhase,null);assert.equal(finished.error,null);
});

test('stop wins a race with a safe detail failure and does not mark or process another job',async t=>{
 const f=fixture(t),draft={status:'草稿',text:'停止前保存的草稿'};f.store.upsertJob({...f.listJobs[0],greeting:draft});
 f.browser.detail=async()=>{f.flow.stop();throw detailRequired();};
 const result=await f.flow.scan();
 assert.equal(result.phase,'已停止');assert.equal(result.error,null);assert.equal(result.failed,0);assert.equal(result.seen,1);
 assert.equal(f.getJob(1),undefined);assert.notEqual(f.getJob(0).status,'分析失败');assert.deepEqual(f.getJob(0).greeting,draft);
 assert.deepEqual(f.reserved,[]);assert.deepEqual(f.contacts,[]);assert.equal(f.store.deliveryCount(),0);
});

test('a prior attempt marker prevents a safe-detail skip even when no quota changed in this run',async t=>{
 const f=fixture(t);f.store.upsertJob({...f.listJobs[0],attemptedAt:'2026-01-01T00:00:00Z'});
 f.browser.detail=async()=>{throw detailRequired();};
 const result=await f.flow.scan();
 assert.equal(result.phase,'已暂停');assert.equal(result.failed,0);assert.equal(result.seen,1);assert.equal(f.getJob(1),undefined);
 assert.equal(f.getJob(0).attemptedAt,'2026-01-01T00:00:00Z');assert.equal(f.store.deliveryCount(),0);assert.deepEqual(f.contacts,[]);
});

test('an older quota or independent greeting ledger prevents continuation even with restored job fields',async t=>{
 for(const kind of ['quota','greeting']){
  const f=fixture(t),job=f.store.upsertJob(f.listJobs[0]);
  const key='job-greeting-delivery:'+identity(new URL(job.url).pathname);
  if(kind==='quota'){
   f.store.reserveDelivery(job.id,20);f.store.finishDelivery(job.id,'sent');
   f.store.db.prepare('UPDATE deliveries SET day=? WHERE id=?').run('2020-01-01',job.id);
  }else f.store.meta(key,{status:'待核实',time:'2020-01-01'});
  const ledger=f.store.db.prepare('SELECT * FROM deliveries').all(),receipt=f.store.meta(key);
  assert.equal(f.store.deliveryCount(),0);
  f.browser.detail=async()=>{throw detailRequired();};
  const result=await f.flow.scan();
  assert.equal(result.phase,'已暂停',kind);assert.equal(result.failed,0);assert.equal(result.seen,1);
  assert.equal(f.getJob(1),undefined);assert.deepEqual(f.contacts,[]);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM deliveries').all(),ledger);assert.deepEqual(f.store.meta(key),receipt);
 }
});

test('a skipped detail still observes job pacing and batch rest, where stop prevents the next job',async t=>{
 const f=fixture(t);f.store.saveSettings({autoSend:false,personalizedGreeting:false,aiEnabled:false,resumeMatch:false,
  activityEnabled:true,paceMode:'custom',delayMin:1,delayMax:1,restEvery:1,restMin:1,restMax:1});
 const flow=createWorkflows(f.store,f.browser,f.browser,f.browser,false);let reads=0;
 f.browser.detail=async()=>{reads++;throw detailRequired();};
 t.mock.timers.enable({apis:['setTimeout']});
 const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
 const tick=async()=>{t.mock.timers.tick(250);await settle();};
 const running=flow.scan();await settle();
 for(let i=0;i<8;i++)await tick();
 assert.equal(flow.task.failed,1);assert.equal(flow.task.seen,1);assert.equal(reads,1);
 for(let i=0;i<3;i++)await tick();
 assert.equal(flow.task.seen,1);assert.notEqual(flow.task.phase,'批次休息');
 await tick();assert.equal(flow.task.phase,'批次休息');assert.equal(flow.task.seen,1);
 flow.stop();await tick();const result=await running;
 assert.equal(result.phase,'已停止');assert.equal(result.error,null);assert.equal(result.failed,1);assert.equal(reads,1);
 assert.equal(f.getJob(1),undefined);assert.deepEqual(f.contacts,[]);assert.equal(f.store.deliveryCount(),0);
});
