import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStore,identity} from '../lib/store.mjs';
import {createJobGreetings} from '../lib/job-greetings.mjs';
import {generateGreeting,validateGeneratedGreeting,composeGreeting,GREETING_GENERATOR_VERSION} from '../lib/greeting.mjs';
import {simulationSettings,simulationWorld} from '../lib/simulation.mjs';
import {jobUrlKey} from '../lib/job-greeting-browser.mjs';
import {configureChatGPTPlan} from '../lib/ai.mjs';

const natural='您好，我之前做过供应商开发，希望进一步了解贵岗位的工作内容和具体安排，方便的话期待与您沟通。';
const alternative='您好，我对岗位中的供应商开发工作很感兴趣，之前也有相关经历。想和您聊聊这一岗位的具体工作内容，方便时期待您的回复。';
const matches=[{requirement:'供应商开发',evidence:'供应商开发'}];
async function reviewed(job,settings,text=natural,onCall=()=>{}){
 let calls=0;
 return generateGreeting(job,settings,async()=>{
  onCall(++calls);
  return JSON.stringify(calls===1?{text,matches}:{approved:true,unsupportedClaims:[],reason:'正文由给定经历支持'});
 });
}
function fixture({generate,simulation=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'greeting-trust-')),store=createStore(dir);
 store.saveSettings({...simulationSettings(),aiProvider:'api',aiBase:'https://example.invalid',aiModel:'fixture-model'});
 const job=store.upsertJob({...simulationWorld().jobs[0],simulation:false,source:'fixture',detailVersion:2,detailsAt:new Date().toISOString()});
 let calls=0;
 const greetings=createJobGreetings({store,simulation,browser:{sendJobGreeting(){assert.fail('No browser action');}},detail(){assert.fail('No detail read');},
  generate:generate||((j,s)=>{calls++;return reviewed(j,s);})});
 return {dir,store,job,greetings,get calls(){return calls;},close(){store.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'greeting-trust-')));fs.rmSync(dir,{recursive:true,force:true});}};
}

test('natural audited prose is cached with local trust and survives service recreation',async()=>{
 const f=fixture();try{
  const draft=await f.greetings.prepare(f.job.id);
  assert.notEqual(draft.text,composeGreeting(draft.matches));
  assert.equal(f.greetings.assertPersonalized(f.job.id).text,natural);
  assert.equal((await f.greetings.prepare(f.job.id)).revision,draft.revision);assert.equal(f.calls,1);
  const reopened=createJobGreetings({store:f.store,browser:{},detail(){assert.fail('No detail');},generate(){assert.fail('Trusted cache must persist');}});
  assert.equal((await reopened.prepare(f.job.id)).revision,draft.revision);
  assert.equal(reopened.assertPersonalized(f.job.id).revision,draft.revision);
 }finally{f.close();}
});

test('imported v4 audit is insufficient without the non-exported local review record',async()=>{
 const first=fixture(),other=fixture();try{
  await first.greetings.prepare(first.job.id);
  const imported=first.store.getJob(first.job.id);
  other.store.upsertJob(imported);
  assert.throws(()=>other.greetings.assertPersonalized(imported.id),{code:'GREETING_INVALID'});
  assert.throws(()=>other.greetings.save(imported.id,alternative),/本机审查/);
  const regenerated=await other.greetings.prepare(imported.id);
  assert.equal(other.calls,1);assert.equal(other.greetings.assertPersonalized(imported.id).revision,regenerated.revision);
  assert.equal(other.store.deliveryCount(),0);
 }finally{first.close();other.close();}
});

test('even a correctly self-hashed external review cannot replace the locally reviewed content',async()=>{
 const f=fixture();try{
  const draft=await f.greetings.prepare(f.job.id),job=f.store.getJob(f.job.id);
  const external=await reviewed(job,f.store.settings(true),alternative);
  assert.equal(validateGeneratedGreeting(job,f.store.settings(true),external).text,alternative);
  f.store.upsertJob({...job,greeting:{...draft,...external}});
  assert.throws(()=>f.greetings.assertPersonalized(job.id),{code:'GREETING_INVALID'});
  const fresh=await f.greetings.prepare(job.id);assert.equal(f.calls,2);assert.equal(fresh.text,natural);
  for(const patch of [{matches:[...fresh.matches,{requirement:'订单交付',evidence:'订单交付'}]},{audit:{...fresh.audit,hash:'0'.repeat(64)}},{generationModel:'different-model'}]){
   f.store.upsertJob({...job,greeting:{...fresh,...patch}});
   assert.throws(()=>f.greetings.assertPersonalized(job.id),{code:'GREETING_INVALID'});
  }
 }finally{f.close();}
});

test('v2 and v3 unsent drafts are freshly generated, while every delivery terminal stays locked',async()=>{
 for(const version of [2,3]){
  const f=fixture();try{
   const draft=await f.greetings.prepare(f.job.id),job=f.store.getJob(f.job.id);
   f.store.upsertJob({...job,greeting:{...draft,generatorVersion:version,audit:null}});
   const fresh=await f.greetings.prepare(job.id);assert.equal(f.calls,2);assert.equal(fresh.generatorVersion,GREETING_GENERATOR_VERSION);
   for(const status of ['已发送','待核实','已有开场']){
    f.store.upsertJob({...job,greeting:{...draft,generatorVersion:version,status}});
    await assert.rejects(f.greetings.prepare(job.id,{force:true}),/已有发送记录/);
   }
   f.store.upsertJob({...job,greeting:{...draft,generatorVersion:version}});
   f.store.meta('job-greeting-delivery:'+identity(jobUrlKey(job.url)),{status:'待核实',revision:draft.revision});
   await assert.rejects(f.greetings.prepare(job.id,{force:true}),/不会重复发送/);
   assert.equal(f.calls,2);
  }finally{f.close();}
 }
});

test('local manual edits lose AI approval and require the current explicit confirmation',async()=>{
 const f=fixture();try{
  const draft=await f.greetings.prepare(f.job.id);
  const edited=f.greetings.save(f.job.id,'您好，岗位要求供应商开发，我之前接触过供应商开发工作，想进一步了解岗位。');
  assert.equal(edited.audit,null);assert.equal(edited.edited,true);assert.equal(edited.reviewRequired,true);
  assert.notEqual(edited.revision,draft.revision);
  assert.throws(()=>f.greetings.assertPersonalized(f.job.id),{code:'GREETING_REVIEW_REQUIRED'});
  assert.throws(()=>f.greetings.assertPersonalized(f.job.id,draft.revision),{code:'GREETING_STALE'});
  assert.equal(f.greetings.assertPersonalized(f.job.id,edited.revision).text,edited.text);
  assert.equal((await f.greetings.prepare(f.job.id)).revision,edited.revision);assert.equal(f.calls,1);
  const regenerated=await f.greetings.prepare(f.job.id,{force:true});assert.equal(regenerated.edited,false);assert.equal(regenerated.audit.approved,true);
 }finally{f.close();}
});

test('provider endpoint changes invalidate previews even when the model name stays the same',async()=>{
 const f=fixture();try{
  const original=await f.greetings.prepare(f.job.id);
  f.store.saveSettings({aiBase:'https://other.invalid'});
  assert.throws(()=>f.greetings.assertPersonalized(f.job.id),{code:'GREETING_STALE'});
  const replacement=await f.greetings.prepare(f.job.id);
  assert.notEqual(replacement.fingerprint,original.fingerprint);assert.equal(f.calls,2);
 }finally{f.close();}
});

test('source changes and cancellation during generation never certify or save the result',async()=>{
 for(const kind of ['resume','model','cancel']){
  let f,active=true;
  f=fixture({generate:async(job,settings)=>reviewed(job,settings,natural,call=>{
   if(call!==2)return;
   if(kind==='resume')f.store.saveSettings({resume:settings.resume+'补充真实内容'});
   if(kind==='model')f.store.saveSettings({aiModel:'changed-model'});
   if(kind==='cancel')active=false;
  })});
  try{
   await assert.rejects(f.greetings.prepare(f.job.id,{active:()=>active}),{code:kind==='cancel'?'CANCELLED':'GREETING_STALE'});
   assert.equal(f.store.getJob(f.job.id).greeting,undefined);
   assert.equal(f.store.meta('job-greeting-review:'+identity(jobUrlKey(f.job.url))),null);
   assert.equal(f.store.deliveryCount(),0);
  }finally{f.close();}
 }
});

test('simulation approvals are isolated from a real greeting manager on the same store',async()=>{
 const f=fixture({simulation:true,generate:generateGreeting});try{
  const draft=await f.greetings.prepare(f.job.id);assert.equal(draft.audit.approved,true);
  assert.equal(f.greetings.assertPersonalized(f.job.id).text,draft.text);
  const real=createJobGreetings({store:f.store,browser:{},detail(){assert.fail('No detail');},generate:(job,settings)=>reviewed(job,settings)});
  assert.throws(()=>real.assertPersonalized(f.job.id),{code:'GREETING_INVALID'});
  const regenerated=await real.prepare(f.job.id);assert.equal(real.assertPersonalized(f.job.id).revision,regenerated.revision);
 }finally{f.close();}
});

test('the actual two-call provider path stops before audit after an account switch or cancellation',async()=>{
 for(const changeAt of [1,2])for(const kind of ['account','cancel']){
  const f=fixture({generate:generateGreeting});let calls=0,active=true,accountId='first-account';
  try{
   f.store.saveSettings({aiProvider:'chatgpt-plan',chatgptModel:'fixture-plan'});
   const settings=f.store.settings;
   f.store.settings=(secret=false)=>({...settings(secret),chatgptAccountId:accountId});
   configureChatGPTPlan({async chat(){
    calls++;
    if(calls===changeAt){if(kind==='account')accountId='other-account';else active=false;}
    return JSON.stringify(calls===1?{text:natural,matches}:{approved:true,unsupportedClaims:[],reason:'supported'});
   }});
   await assert.rejects(f.greetings.prepare(f.job.id,{active:()=>active}),{code:kind==='account'?'GREETING_STALE':'CANCELLED'});
   assert.equal(calls,changeAt);assert.equal(f.store.getJob(f.job.id).greeting,undefined);
   assert.equal(f.store.meta('job-greeting-review:'+identity(jobUrlKey(f.job.url))),null);
  }finally{configureChatGPTPlan(null);f.close();}
 }
});

test('a failed independent review never replaces the last trusted draft',async()=>{
 const f=fixture();try{
  const old=await f.greetings.prepare(f.job.id);
  const rejecting=createJobGreetings({store:f.store,browser:{},detail(){assert.fail('No detail');},generate:(job,settings)=>{
   let calls=0;return generateGreeting(job,settings,async()=>JSON.stringify(++calls===1?{text:alternative,matches}:{approved:false,unsupportedClaims:['unsupported'],reason:'failed'}));
  }});
  await assert.rejects(rejecting.prepare(f.job.id,{force:true}),{code:'GREETING_INVALID'});
  assert.equal(f.store.getJob(f.job.id).greeting.revision,old.revision);
  assert.equal(f.greetings.assertPersonalized(f.job.id).revision,old.revision);
 }finally{f.close();}
});
