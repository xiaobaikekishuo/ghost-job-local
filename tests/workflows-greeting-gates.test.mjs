import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStore} from '../lib/store.mjs';
import {SimulationBrowser,simulationSettings} from '../lib/simulation.mjs';
import {createWorkflows} from '../lib/workflows.mjs';
import {assertActive} from '../lib/conversation.mjs';

function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-greeting-gate-')),store=createStore(dir);
  store.saveSettings({...simulationSettings(),personalizedGreeting:true,greetingFallback:false});
  const browser=new SimulationBrowser(dir);
  browser.assertGreetingAvailable=async({active})=>assertActive(active);
  const flow=createWorkflows(store,browser,browser,browser,true);
  const job=store.upsertJob(browser.world().jobs[0]);
  let reservations=0;
  const reserve=store.reserveDelivery;
  store.reserveDelivery=(...args)=>{reservations++;return reserve(...args);};
  t.after(()=>{store.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'workflow-greeting-gate-'));fs.rmSync(dir,{recursive:true,force:true});});
  return {store,browser,flow,job,get reservations(){return reservations;}};
}

function editedGreeting(draft){
  return '您好，'+draft.matches.map(match=>`岗位需要“${match.requirement}”，我有“${match.evidence}”的经历。`).join('')+'感谢您的时间。';
}

test('no-match drafts block automatic and explicitly confirmed contact before capability checks or quota reservation',async t=>{
  const f=fixture(t);f.store.saveSettings({resume:'曾负责门店日常接待与商品陈列。'});
  let capabilities=0,contacts=0;
  f.browser.assertGreetingAvailable=async()=>{capabilities++;};f.browser.communicate=async()=>{contacts++;};
  const draft=await f.flow.greetings.prepare(f.job.id);
  for(const confirmation of [null,{personalized:true,revision:draft.revision}])
    await assert.rejects(f.flow.sendJob(f.job.id,()=>true,confirmation),{code:'GREETING_NO_MATCH'});
  assert.equal(capabilities,0);assert.equal(contacts,0);assert.equal(f.reservations,0);assert.equal(f.store.deliveryCount(),0);
  assert.equal(f.store.getJob(f.job.id).greeting.status,'草稿');assert.equal(f.store.getJob(f.job.id).greeting.text,'');
  assert.notEqual(f.store.getJob(f.job.id).status,'待核实');
});

test('a capability refusal blocks contact without consuming quota and preserves the personalized draft',async t=>{
  const f=fixture(t);let capabilities=0;
  f.browser.assertGreetingAvailable=async({active,job})=>{assert.equal(active(),true);assert.equal(job.id,f.job.id);assert.equal(job.url,f.job.url);assert.equal(job.company,f.job.company);assert.equal(job.hrName,f.job.hrName);assert.ok(job.detailsAt);capabilities++;throw Object.assign(Error('fixture cannot safely send personalized greeting'),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});};
  f.browser.communicate=async()=>assert.fail('Capability refusal must prevent platform contact');
  await assert.rejects(f.flow.sendJob(f.job.id),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
  assert.equal(capabilities,1);assert.equal(f.reservations,0);assert.equal(f.store.deliveryCount(),0);
  assert.ok(f.store.getJob(f.job.id).greeting.matches.length);assert.equal(f.store.getJob(f.job.id).greeting.status,'草稿');
});

test('ordinary contact retains its existing behavior when personalized greeting is disabled',async t=>{
  const f=fixture(t);f.store.saveSettings({personalizedGreeting:false});
  f.flow.greetings.prepare=async()=>assert.fail('Disabled personalization must not generate a draft');
  f.browser.assertGreetingAvailable=async()=>assert.fail('Disabled personalization must not require modern chat support');
  const result=await f.flow.sendJob(f.job.id);
  assert.equal(result.verified,true);assert.equal(result.greetingVerified,undefined);
  assert.equal(f.reservations,1);assert.equal(f.store.deliveryCount(),1);assert.equal(f.browser.world().sent.length,1);
  assert.equal(f.store.messages().filter(message=>message.kind==='greeting').length,0);
});

test('stopping while the capability check awaits prevents reservation and contact',async t=>{
  const f=fixture(t);let active=true;
  f.browser.assertGreetingAvailable=async options=>{assert.equal(options.active(),true);active=false;};
  f.browser.communicate=async()=>assert.fail('A stopped check must not contact HR');
  await assert.rejects(f.flow.sendJob(f.job.id,()=>active),{code:'CANCELLED'});
  assert.equal(f.reservations,0);assert.equal(f.store.deliveryCount(),0);
});

test('source changes during capability checking are revalidated before the delivery reservation',async t=>{
  const f=fixture(t);
  f.browser.assertGreetingAvailable=async()=>{f.store.saveSettings({resume:'变更为门店陈列与接待经历。'});};
  f.browser.communicate=async()=>assert.fail('A changed resume invalidates the checked draft');
  await assert.rejects(f.flow.sendJob(f.job.id),{code:'GREETING_STALE'});
  assert.equal(f.reservations,0);assert.equal(f.store.deliveryCount(),0);
});

test('a reviewed edited revision passes both pre-contact gates and reaches the final greeting send unchanged',async t=>{
  const f=fixture(t),draft=await f.flow.greetings.prepare(f.job.id);
  const edited=f.flow.greetings.save(f.job.id,editedGreeting(draft)),events=[];
  const prepare=f.flow.greetings.prepare,quality=f.flow.greetings.assertPersonalized,send=f.flow.greetings.send;
  const reserve=f.store.reserveDelivery,communicate=f.browser.communicate.bind(f.browser);
  f.flow.greetings.prepare=async(...args)=>{events.push('prepare');return prepare(...args);};
  f.flow.greetings.assertPersonalized=(id,revision)=>{assert.equal(revision,edited.revision);events.push('quality');return quality(id,revision);};
  f.browser.assertGreetingAvailable=async({active})=>{assert.equal(active(),true);events.push('capability');};
  f.store.reserveDelivery=(...args)=>{events.push('reserve');return reserve(...args);};
  f.browser.communicate=async(...args)=>{events.push('communicate');return communicate(...args);};
  f.flow.greetings.send=async(id,options)=>{assert.equal(options.expectedRevision,edited.revision);events.push('greeting');return send(id,options);};
  const result=await f.flow.sendJob(f.job.id,()=>true,{personalized:true,revision:edited.revision});
  assert.equal(result.greetingVerified,true);
  assert.deepEqual(events,['prepare','quality','capability','quality','reserve','communicate','greeting']);
  assert.equal(f.store.messages().find(message=>message.kind==='greeting').text,edited.text);
});

test('automatic contact cannot send an edited draft without explicit revision confirmation',async t=>{
  const f=fixture(t),draft=await f.flow.greetings.prepare(f.job.id);
  f.flow.greetings.save(f.job.id,editedGreeting(draft));
  f.browser.assertGreetingAvailable=async()=>assert.fail('Review gate must precede browser capability check');
  f.browser.communicate=async()=>assert.fail('Unreviewed edits must not trigger platform contact');
  await assert.rejects(f.flow.sendJob(f.job.id),{code:'GREETING_REVIEW_REQUIRED'});
  assert.equal(f.reservations,0);assert.equal(f.store.deliveryCount(),0);
});

test('a manual revision changed during platform contact cannot silently send the replacement text',async t=>{
  const f=fixture(t),draft=await f.flow.greetings.prepare(f.job.id);
  const communicate=f.browser.communicate.bind(f.browser);let greetingCalls=0;
  f.browser.communicate=async(...args)=>{const result=await communicate(...args);f.flow.greetings.save(f.job.id,draft.text+'感谢您的时间。');return result;};
  f.browser.sendJobGreeting=async()=>{greetingCalls++;assert.fail('The confirmed revision changed');};
  const result=await f.flow.sendJob(f.job.id,()=>true,{personalized:true,revision:draft.revision});
  assert.equal(result.verified,true);assert.equal(result.greetingVerified,false);assert.equal(greetingCalls,0);
  assert.match(result.reason,/固定开场.*专属稿已保留.*重新预览/);
  assert.equal(f.store.getJob(f.job.id).status,'已沟通');assert.equal(f.store.getJob(f.job.id).greeting.status,'草稿');
  assert.equal(f.browser.world().sent.length,1);
});

test('strict mode: no-match jobs are skipped one by one (draft kept) and the scan finishes without contact or quota usage',async t=>{
  // Previously the first no-match job paused the whole batch and, because the job
  // stayed 合适, every restart paused on the same job again.
  const f=fixture(t);f.store.saveSettings({resume:'门店接待与商品陈列。'});
  f.browser.assertGreetingAvailable=async()=>assert.fail('No-match quality must fail first');
  f.browser.communicate=async()=>assert.fail('No-match scan must not contact HR');
  const result=await f.flow.scan();
  assert.equal(result.phase,'本轮已完成');assert.equal(result.error,null);assert.equal(result.sent,0);
  assert.equal(result.greetingDeferred,3);assert.equal(result.failed,0);
  const suitable=f.store.jobs().filter(job=>job.status==='合适');
  assert.equal(suitable.length,3);
  for(const job of suitable){assert.match(job.reason,/专属招呼待确认.*直接匹配证据/);assert.equal(job.greeting.status,'草稿');assert.equal(job.greeting.reviewRequired,true);}
  assert.equal(f.reservations,0);assert.equal(f.store.deliveryCount(),0);assert.equal(f.browser.world().sent.length,0);
  const again=await f.flow.scan();
  assert.equal(again.phase,'本轮已完成');assert.equal(again.error,null);assert.equal(f.reservations,0);
});
