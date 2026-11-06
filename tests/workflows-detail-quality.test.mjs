import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStore,identity} from '../lib/store.mjs';
import {createWorkflows} from '../lib/workflows.mjs';
import {createJobGreetings} from '../lib/job-greetings.mjs';
import {SimulationBrowser,simulationSettings} from '../lib/simulation.mjs';
import {generateGreeting} from '../lib/greeting.mjs';
import {hasUsableJobDetail,JOB_DETAIL_VERSION} from '../lib/job-detail-quality.mjs';

const card='材料采购员\nPUA薪资\n1-3年\n本科\n胜美达\n广州·番禺区·番禺广场';
async function reviewedFixtureGreeting(job,settings){
  const matches=[{requirement:'供应商开发',evidence:'供应商开发'}];
  const text='您好，我想了解贵岗位的供应商开发工作。我之前接触过供应商开发，希望有机会和您进一步聊聊具体工作内容及岗位安排。';
  let calls=0;
  const result=await generateGreeting(job,settings,async()=>JSON.stringify(++calls===1?{text,matches}:
    {approved:true,unsupportedClaims:[],reason:'正文经历由给定供应商开发证据支持，未扩大经历。'}));
  assert.equal(calls,2,'The fixture must exercise both generation and independent review');
  return result;
}
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'job-detail-dataflow-')),store=createStore(dir);
  store.saveSettings({...simulationSettings(),personalizedGreeting:true,greetingFallback:false,autoSend:false,activityEnabled:false});
  const browser=new SimulationBrowser(dir),flow=createWorkflows(store,browser,browser,browser,true),source=browser.world().jobs[0];
  const job=store.upsertJob({...source,title:'材料采购员',description:card,detailsAt:'2020-01-01T00:00:00Z',source:'BOSS直聘'});
  let detailReads=0;
  const detail=browser.detail.bind(browser);
  browser.detail=async()=>{detailReads++;return detail();};
  t.after(()=>{store.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'job-detail-dataflow-'));fs.rmSync(dir,{recursive:true,force:true});});
  return {store,browser,flow,job,source,get detailReads(){return detailReads;}};
}

test('legacy detailsAt plus a list summary is refreshed before analysis and receives a current detail version',async t=>{
  const f=fixture(t),result=await f.flow.checkJob(f.job,true);
  assert.equal(f.detailReads,1);assert.equal(result.detailVersion,JOB_DETAIL_VERSION);
  assert.equal(result.description,f.source.description);assert.ok(hasUsableJobDetail(result));
  assert.notEqual(result.detailsAt,f.job.detailsAt);assert.equal(result.status,'合适');
  await f.flow.checkJob(result,true);assert.equal(f.detailReads,1);
});

test('an old full-looking JD is still refreshed, while a version number cannot certify a list card',async t=>{
  for(const patch of [{description:'旧版：负责供应商开发与采购询价。'},{detailVersion:JOB_DETAIL_VERSION}]){
    const f=fixture(t),job=f.store.upsertJob({...f.job,...patch});
    await f.flow.checkJob(job,true);assert.equal(f.detailReads,1);
    assert.equal(f.store.getJob(job.id).description,f.source.description);
  }
});

test('card-only or wrong-job detail responses do not overwrite stored content, timestamp or delivery status',async t=>{
  for(const response of [{description:card,title:'材料采购员'},{description:'负责供应商开发与采购询价。',detailUrl:'https://www.zhipin.com/job_detail/another.html'}]){
    const f=fixture(t),job=f.store.upsertJob({...f.job,status:'已沟通',sentAt:'2026-01-01',greeting:{status:'草稿',text:'已保存稿'}});
    f.browser.detail=async()=>response;
    await assert.rejects(f.flow.detail(job),{code:'JOB_DETAIL_REQUIRED',notSent:true});
    const after=f.store.getJob(job.id);
    assert.equal(after.description,card);assert.equal(after.detailsAt,job.detailsAt);assert.equal(after.detailVersion,undefined);
    assert.equal(after.status,'已沟通');assert.equal(after.sentAt,job.sentAt);assert.deepEqual(after.greeting,job.greeting);
  }
});

test('scan and collect preserve verified JD and identity when newer list cards contain summary text',async t=>{
  const f=fixture(t),full=await f.flow.detail(f.job);
  const item={...f.source,title:'材料采购员\n12-18K\n在线',hrName:'其他 HR\n刚刚活跃',description:card,detailVersion:999,detailsAt:'forged-list-time'};
  f.browser.readJobs=async()=>({jobs:[item]});
  const beforeReads=f.detailReads;
  const result=await f.flow.scan();assert.equal(result.error,null);
  let after=f.store.getJob(full.id);
  assert.equal(after.description,full.description);assert.equal(after.title,full.title);assert.equal(after.hrName,full.hrName);
  assert.equal(after.detailVersion,JOB_DETAIL_VERSION);assert.equal(after.detailsAt,full.detailsAt);assert.equal(f.detailReads,beforeReads);
  f.store.upsertJob({...after,status:'已沟通',sentAt:'2026-01-01',greeting:{status:'待核实',text:'保留旧稿'}});
  await f.flow.collect();after=f.store.getJob(full.id);
  assert.equal(after.description,full.description);assert.equal(after.status,'已沟通');assert.equal(after.greeting.status,'待核实');assert.equal(after.sentAt,'2026-01-01');
});

test('new list records cannot inherit detailsAt or detailVersion from a list payload',async t=>{
  const f=fixture(t),item={...f.source,url:'https://www.zhipin.com/job_detail/new-fixture.html',description:card,detailsAt:'forged',detailVersion:JOB_DETAIL_VERSION};
  f.browser.readJobs=async()=>({jobs:[item]});await f.flow.collect();
  const saved=f.store.jobs().find(job=>job.url===item.url);
  assert.equal(saved.detailsAt,undefined);assert.equal(saved.detailVersion,undefined);assert.equal(hasUsableJobDetail(saved),false);
});

test('greeting preparation refreshes an already-contacted old card and generates only from the new JD',async t=>{
  const f=fixture(t),job=f.store.upsertJob({...f.job,status:'已沟通',sentAt:'2026-01-01'});let generation=0;
  const greetings=createJobGreetings({store:f.store,browser:f.browser,detail:f.flow.detail,generate:async (current,settings)=>{
    generation++;assert.equal(current.description,f.source.description);assert.equal(current.detailVersion,JOB_DETAIL_VERSION);
    return reviewedFixtureGreeting(current,settings);
  }});
  const draft=await greetings.prepare(job.id);
  assert.equal(f.detailReads,1);assert.equal(generation,1);assert.equal(draft.status,'草稿');assert.equal(draft.matches[0].requirement,'供应商开发');
  assert.equal(f.store.getJob(job.id).status,'已沟通');assert.equal(f.store.getJob(job.id).sentAt,job.sentAt);
  assert.equal(f.browser.world().sent.length,0);assert.equal(f.store.deliveryCount(),0);
  await greetings.prepare(job.id);assert.equal(generation,1);assert.equal(f.detailReads,1);
});

test('greeting generation and new contact stop when refresh still returns card text',async t=>{
  const f=fixture(t);let generated=0,contacts=0;
  f.browser.detail=async()=>({description:card,title:f.job.title});f.browser.communicate=async()=>{contacts++;};
  const greetings=createJobGreetings({store:f.store,browser:f.browser,detail:f.flow.detail,generate:async()=>{generated++;return {matches:[]};}});
  await assert.rejects(greetings.prepare(f.job.id),{code:'JOB_DETAIL_REQUIRED'});
  await assert.rejects(f.flow.sendJob(f.job.id),{code:'JOB_DETAIL_REQUIRED'});
  assert.equal(generated,0);assert.equal(contacts,0);assert.equal(f.store.deliveryCount(),0);assert.equal(f.store.getJob(f.job.id).description,card);
});

test('a changed detail version invalidates cached drafts and sent jobs remain protected after refresh or reanalysis',async t=>{
  const f=fixture(t),draft=await f.flow.greetings.prepare(f.job.id);
  const downgraded=f.store.upsertJob({...f.store.getJob(f.job.id),detailVersion:1});
  assert.throws(()=>f.flow.greetings.assertPersonalized(downgraded.id,draft.revision),{code:'JOB_DETAIL_REQUIRED'});
  const contact=f.store.upsertJob({...downgraded,status:'已沟通',sentAt:'2026-01-01'});
  const checked=await f.flow.checkJob(contact,true);assert.equal(checked.status,'已沟通');assert.equal(checked.sentAt,contact.sentAt);
  await assert.rejects(f.flow.sendJob(checked.id),/重复发送/);
  f.store.upsertJob({...checked,status:'合适'});await assert.rejects(f.flow.sendJob(checked.id),/重复发送/);
  assert.equal(f.browser.world().sent.length,0);
});

test('stopping during detail refresh does not persist a new version or generate a greeting',async t=>{
  const f=fixture(t);let active=true,generations=0;
  f.browser.detail=async()=>{active=false;return f.source;};
  const greetings=createJobGreetings({store:f.store,browser:f.browser,detail:f.flow.detail,generate:async()=>{generations++;return {matches:[]};}});
  await assert.rejects(greetings.prepare(f.job.id,{active:()=>active}),{code:'CANCELLED'});
  assert.equal(generations,0);assert.equal(f.store.getJob(f.job.id).detailVersion,undefined);assert.equal(f.store.getJob(f.job.id).description,card);
});

test('detail field labels and placeholders cannot replace an existing usable company brand',async t=>{
  for(const company of ['公司名称','公司名称：','—','暂无','模拟·青禾…','',undefined]){
    const f=fixture(t),job=f.store.upsertJob({...f.job,company:'已核实列表品牌',listCompany:'已核实列表品牌',listCompanyJobUrl:f.job.url});
    f.browser.detail=async()=>({...f.source,company});
    const saved=await f.flow.detail(job);
    assert.equal(saved.company,'已核实列表品牌',String(company));
    assert.equal(saved.listCompany,job.listCompany);assert.equal(saved.listCompanyJobUrl,job.listCompanyJobUrl);
    assert.equal(saved.description,f.source.description);assert.equal(hasUsableJobDetail(saved),true);
  }
});

test('a polluted v2 detail is refreshed using matching stored list evidence, never another job or missing provenance',async t=>{
  const f=fixture(t),job=f.store.upsertJob({...f.job,company:'公司名称',description:f.source.description,detailVersion:JOB_DETAIL_VERSION,
    listCompany:f.source.company,listCompanyJobUrl:f.job.url+'?source=original-list'});
  let reads=0;f.browser.detail=async()=>{reads++;return {...f.source,company:'公司名称'};};
  assert.equal(hasUsableJobDetail(job),false);
  const saved=await f.flow.checkJob(job,true);
  assert.equal(reads,1);assert.equal(saved.company,f.source.company);assert.equal(hasUsableJobDetail(saved),true);
  await f.flow.checkJob(saved,true);assert.equal(reads,1);

  for(const listCompanyJobUrl of [undefined,'https://www.zhipin.com/job_detail/different-full-id.html',
    'https://www.zhipin.com.example.test/job_detail/sim-1.html']){
    const x=fixture(t),bad=x.store.upsertJob({...x.job,company:'公司名称',description:x.source.description,detailVersion:JOB_DETAIL_VERSION,
      listCompany:x.source.company,listCompanyJobUrl,status:'已沟通',sentAt:'2026-01-01',greeting:{status:'草稿',text:'保留原稿'}});
    const snapshot=x.store.getJob(bad.id);
    x.browser.detail=async()=>({...x.source,company:'企业名称'});
    await assert.rejects(x.flow.detail(bad),{code:'JOB_DETAIL_REQUIRED',notSent:true});
    assert.deepEqual(x.store.getJob(bad.id),snapshot);
  }
});

test('collect and scan repair a contacted job by canonical URL without touching either send ledger',async t=>{
  for(const action of ['collect','scan']){
    const f=fixture(t),job=f.store.upsertJob({...f.job,company:'公司名称',description:f.source.description,detailVersion:JOB_DETAIL_VERSION,
      status:'已沟通',sentAt:'2026-01-01',historicalDelivery:true,greeting:{status:'待核实',text:'原专属稿',revision:'original-revision'}});
    f.store.reserveDelivery(job.id,20);f.store.finishDelivery(job.id,'sent');
    const key='job-greeting-delivery:'+identity(new URL(job.url).pathname),receipt={status:'待核实',time:'2026-01-01',revision:'original-revision'};
    f.store.meta(key,receipt);
    const beforeDeliveries=f.store.db.prepare('SELECT * FROM deliveries').all();
    f.browser.communicate=async()=>assert.fail('Repair must never initiate contact');
    f.browser.detail=async()=>assert.fail('Already-contacted jobs must not enter analysis during a scan');
    f.browser.readJobs=async()=>({jobs:[{...f.source,id:'different-list-id',url:job.url.replace('www.zhipin.com','zhipin.com')+'?tracking=changed',
      company:'可核实原始列表品牌',status:'待分析',sentAt:null,historicalDelivery:false,greeting:null}]});
    const result=await f.flow[action]();if(action==='scan')assert.equal(result.error,null);
    const saved=f.store.getJob(job.id);
    assert.equal(f.store.jobs().length,1);assert.equal(saved.id,job.id);assert.equal(saved.url,job.url);
    assert.equal(saved.company,'可核实原始列表品牌');assert.equal(saved.listCompany,saved.company);assert.equal(saved.listCompanyJobUrl,job.url);
    for(const field of ['status','sentAt','historicalDelivery','greeting','description','detailsAt','detailVersion'])assert.deepEqual(saved[field],job[field],field);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM deliveries').all(),beforeDeliveries);assert.deepEqual(f.store.meta(key),receipt);
    await assert.rejects(f.flow.sendJob(job.id),/重复发送/);
    await assert.rejects(f.flow.greetings.prepare(job.id,{force:true}),/不会重复发送/);
    assert.equal(f.browser.world().sent.length,0);
  }
});

test('new list evidence is retained separately and never rewrites a different usable legal company name',async t=>{
  const f=fixture(t),job=f.store.upsertJob({...f.job,company:'广州某某电子制造有限公司',status:'已沟通',sentAt:'2026-01-01'});
  f.browser.readJobs=async()=>({jobs:[{...f.source,company:'某某电子'}]});
  await f.flow.collect();
  const saved=f.store.getJob(job.id);
  assert.equal(saved.company,job.company);assert.equal(saved.listCompany,'某某电子');assert.equal(saved.listCompanyJobUrl,job.url);
  assert.equal(saved.status,job.status);assert.equal(saved.sentAt,job.sentAt);
});

test('repairing a polluted company invalidates its saved draft and requires a new preview without sending',async t=>{
  const f=fixture(t),job=f.store.upsertJob({...f.job,company:'旧有完整公司名称',description:f.source.description,detailVersion:JOB_DETAIL_VERSION,
    title:f.source.title,hrName:f.source.hrName,status:'已沟通',sentAt:'2026-01-01'});
  let generated=0;
  const greetings=createJobGreetings({store:f.store,browser:f.browser,detail:f.flow.detail,generate:async (current,settings)=>{
    generated++;assert.equal(current.company,generated===1?job.company:'可核实原始列表品牌');
    return reviewedFixtureGreeting(current,settings);
  }});
  const legacy=await greetings.prepare(job.id);
  assert.equal(f.flow.greetings.verify(job.id,legacy.revision).revision,legacy.revision);
  f.store.upsertJob({...f.store.getJob(job.id),company:'公司名称'});
  f.browser.communicate=async()=>assert.fail('Draft repair must not initiate contact');
  f.browser.sendJobGreeting=async()=>assert.fail('Draft repair must not send a greeting');
  f.browser.readJobs=async()=>({jobs:[{...f.source,company:'可核实原始列表品牌'}]});
  await f.flow.collect();
  assert.deepEqual(f.store.getJob(job.id).greeting,legacy);
  assert.throws(()=>f.flow.greetings.verify(job.id,legacy.revision),/重新预览/);
  await assert.rejects(f.flow.greetings.send(job.id,{expectedRevision:legacy.revision}),/重新预览/);
  const fresh=await greetings.prepare(job.id);
  assert.equal(generated,2);assert.notEqual(fresh.fingerprint,legacy.fingerprint);assert.notEqual(fresh.revision,legacy.revision);
  assert.equal(greetings.verify(job.id,fresh.revision).revision,fresh.revision);
  const saved=f.store.getJob(job.id);assert.equal(saved.status,job.status);assert.equal(saved.sentAt,job.sentAt);
  assert.equal(f.store.deliveryCount(),0);assert.equal(f.browser.world().sent.length,0);assert.equal(f.store.messages().length,0);
});
