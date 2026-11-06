import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStore} from '../lib/store.mjs';
import {createJobGreetings} from '../lib/job-greetings.mjs';
import {createWorkflows} from '../lib/workflows.mjs';
import {SimulationBrowser, simulationSettings, simulationGreetingMatches} from '../lib/simulation.mjs';
import {GREETING_GENERATOR_VERSION,generateGreeting,validateGeneratedGreeting} from '../lib/greeting.mjs';

function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'job-greeting-test-')),store=createStore(dir);
  store.saveSettings({...simulationSettings(),personalizedGreeting:true,greetingFallback:false});
  const browser=new SimulationBrowser(dir),flow=createWorkflows(store,browser,browser,browser,true);
  const job=store.upsertJob({...browser.world().jobs[0],detailVersion:2,detailsAt:new Date().toISOString()});
  return {store,browser,flow,job,close(){store.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'job-greeting-test-'));fs.rmSync(dir,{recursive:true,force:true});}};
}
test('Preview never contacts HR; edited drafts persist and source changes invalidate them',async()=>{
  const f=fixture();try{
    let generated=0,contacts=0;
    const greetings=createJobGreetings({store:f.store,browser:{sendJobGreeting(){contacts++;}},detail:async()=>assert.fail('Should use stored details'),generate:async(job,settings)=>{generated++;return generateGreeting(job,settings,async()=>JSON.stringify({text:'',matches:[]}));}});
    await greetings.prepare(f.job.id);assert.equal(generated,1);assert.equal(contacts,0);assert.equal(f.store.deliveryCount(),0);
    greetings.save(f.job.id,'您好，希望了解该岗位的采购品类。');
    assert.equal((await greetings.prepare(f.job.id)).text,'您好，希望了解该岗位的采购品类。');assert.equal(generated,1);
    f.store.saveSettings({resume:'修改后的真实采购简历'});
    assert.throws(()=>greetings.save(f.job.id,'继续使用旧招呼'),/重新生成/);
    await greetings.prepare(f.job.id);assert.equal(generated,2);assert.equal(contacts,0);
  }finally{f.close();}
});
test('Missing resume or a generation failure blocks contact and consumes no daily quota',async()=>{
  const f=fixture();try{
    let contacts=0;f.browser.communicate=async()=>{contacts++;};
    f.store.saveSettings({resume:''});
    await assert.rejects(f.flow.sendJob(f.job.id),/简历/);
    assert.equal(contacts,0);assert.equal(f.store.deliveryCount(),0);
    f.store.saveSettings({resume:'三年采购经验'});f.flow.greetings.prepare=async()=>{throw Error('AI 返回不可核实经历');};
    await assert.rejects(f.flow.sendJob(f.job.id),/不可核实/);
    assert.equal(contacts,0);assert.equal(f.store.deliveryCount(),0);
  }finally{f.close();}
});

test('Changing AI billing provider, plan model or plan account invalidates a greeting preview',async()=>{
 const f=fixture();try{
  const originalSettings=f.store.settings;let accountId='account-one';
  f.store.settings=(secret=false)=>({...originalSettings(secret),chatgptAccountId:accountId});
  const original=await f.flow.greetings.prepare(f.job.id);
  f.store.saveSettings({aiProvider:'chatgpt-plan',chatgptModel:'fixture-plan-model'});
  assert.throws(()=>f.flow.greetings.verify(f.job.id,original.revision),/已变化/);
  const plan=await f.flow.greetings.prepare(f.job.id);
  accountId='account-two';assert.throws(()=>f.flow.greetings.verify(f.job.id,plan.revision),/已变化/);
  const otherAccount=await f.flow.greetings.prepare(f.job.id);
  f.store.saveSettings({chatgptModel:'another-fixture-model'});
  assert.throws(()=>f.flow.greetings.verify(f.job.id,otherAccount.revision),/已变化/);
  assert.equal(f.store.deliveryCount(),0);
 }finally{f.close();}
});
test('Successful personalized contact keeps separate verified job and greeting receipts',async()=>{
  const f=fixture();try{
    const result=await f.flow.sendJob(f.job.id);
    assert.equal(result.verified,true);assert.equal(result.greetingVerified,true);
    const j=f.store.getJob(f.job.id);assert.equal(j.status,'已沟通');assert.equal(j.greeting.status,'已发送');
    assert.equal(f.store.messages().filter(m=>m.kind==='greeting'&&m.status==='已发送').length,1);
    assert.equal(f.store.deliveryCount(),1);
    await assert.rejects(f.flow.greetings.send(f.job.id),/重复发送/);
    await assert.rejects(f.flow.sendJob(f.job.id),/重复发送/);
    await assert.rejects(f.flow.greetings.prepare(f.job.id,{force:true}),/不会重复发送/);
  }finally{f.close();}
});
test('a verified existing opening ends this draft without recording a newly sent custom message',async()=>{
 for(const late of [false,true]){
  const f=fixture();try{
   const draft=await f.flow.greetings.prepare(f.job.id);
   f.browser.sendJobGreeting=async(job,text,options)=>{
    if(late)options.onAttempt();
    return {verified:false,notSent:true,alreadyGreeted:true,code:'GREETING_ALREADY_PRESENT',receiptId:'existing-platform-message',
     conversation:{modernProofVerified:true,jobUrl:job.url,contact:job.hrName,company:job.company,jobTitle:job.title},reason:'已有本人开场，未追加'};
   };
   const result=await f.flow.sendJob(f.job.id),saved=f.store.getJob(f.job.id);
   assert.equal(result.verified,true);assert.equal(result.greetingVerified,false);assert.equal(result.greetingAlreadyPresent,true);
   assert.equal(saved.greeting.status,'已有开场');assert.equal(saved.greeting.receiptId,undefined);assert.equal(saved.greeting.sentAt,undefined);
   assert.equal(saved.greeting.existingReceiptId,'existing-platform-message');assert.equal(f.flow.stats().greetingPending,0);
   assert.equal(f.store.deliveryCount(),1);assert.equal(f.store.messages().length,0);
   f.store.upsertJob({...saved,greeting:draft});
   await assert.rejects(f.flow.greetings.send(f.job.id),/不会重复发送/);
   await assert.rejects(f.flow.greetings.prepare(f.job.id,{force:true}),/不会重复发送/);
  }finally{f.close();}
 }
});

test('an existing-opening claim must carry a receipt and the exact verified recipient',async()=>{
 for(const mismatch of ['receipt','job','company','contact','proof']){
  const f=fixture();try{
   f.browser.sendJobGreeting=async job=>{
    const result={verified:false,notSent:true,alreadyGreeted:true,code:'GREETING_ALREADY_PRESENT',receiptId:'existing-message',
     conversation:{modernProofVerified:true,jobUrl:job.url,contact:job.hrName,company:job.company,jobTitle:job.title}};
    if(mismatch==='receipt')delete result.receiptId;
    if(mismatch==='job')result.conversation.jobUrl='https://www.zhipin.com/job_detail/other.html';
    if(mismatch==='company')result.conversation.company='其他公司';
    if(mismatch==='contact')result.conversation.contact='其他HR';
    if(mismatch==='proof')delete result.conversation.modernProofVerified;
    return result;
   };
   const result=await f.flow.sendJob(f.job.id);
   assert.equal(result.greetingCode,'GREETING_PRESENCE_UNCERTAIN',mismatch);
   assert.equal(f.store.getJob(f.job.id).greeting.status,'草稿');assert.equal(f.store.messages().length,0);
  }finally{f.close();}
 }
});

test('Unmatched HR after contact preserves contact success and leaves greeting as draft',async()=>{
  const f=fixture();try{
    f.browser.sendJobGreeting=async()=>{throw Object.assign(Error('未确认匹配会话'),{notSent:true,code:'GREETING_TARGET_UNAVAILABLE'});};
    const result=await f.flow.sendJob(f.job.id);
    assert.equal(result.verified,true);assert.equal(result.greetingVerified,false);
    assert.equal(result.greetingDeferred,true);assert.equal(result.greetingNotSent,true);assert.equal(result.greetingCode,'GREETING_DEFERRED');
    assert.equal(f.store.getJob(f.job.id).status,'已沟通');assert.equal(f.store.getJob(f.job.id).greeting.status,'草稿');
    assert.equal(f.store.getJob(f.job.id).greeting.deferred,true);assert.equal(f.flow.stats().greetingPending,1);
    assert.equal(f.store.messages().length,0);assert.equal(f.store.deliveryCount(),1);
  }finally{f.close();}
});
test('Loss of receipt after sending stays uncertain and blocks automatic retry',async()=>{
  const f=fixture();try{
    f.browser.sendJobGreeting=async(j,text,options)=>{options.onAttempt();throw Error('发送后连接中断');};
    const result=await f.flow.sendJob(f.job.id);
    assert.equal(result.greetingVerified,false);assert.equal(f.store.getJob(f.job.id).greeting.status,'待核实');
    await assert.rejects(f.flow.greetings.send(f.job.id),/重复发送/);
    assert.equal(f.store.getJob(f.job.id).status,'已沟通');
  }finally{f.close();}
});
test('Stopping while generating a greeting prevents contact',async()=>{
  const f=fixture();try{
    let active=true,contacts=0;
    f.flow.greetings.prepare=async()=>{active=false;};f.browser.communicate=async()=>{contacts++;};
    await assert.rejects(f.flow.sendJob(f.job.id,()=>active),{code:'CANCELLED'});
    assert.equal(contacts,0);assert.equal(f.store.deliveryCount(),0);
  }finally{f.close();}
});
test('Automatic replies wait while a job task owns the browser',async()=>{
  const f=fixture();try{
    f.flow.task.busy=true;f.flow.startReply();f.browser.openChat=async()=>assert.fail('Must not compete for HR conversation');
    await f.flow.replyTick();assert.equal(f.flow.reply.busy,false);
  }finally{f.close();}
});
test('Stale confirmation cannot send edited text or silently enable personalized messages',async()=>{
  const f=fixture();try{
    const preview=await f.flow.greetings.prepare(f.job.id);let contacts=0;
    f.browser.communicate=async()=>{contacts++;};
    f.flow.greetings.save(f.job.id,'已修改的采购招呼，请重新确认。');
    await assert.rejects(f.flow.sendJob(f.job.id,()=>true,{personalized:true,revision:preview.revision}),/重新预览/);
    await assert.rejects(f.flow.sendJob(f.job.id,()=>true,{personalized:false}),/设置已变化/);
    assert.equal(contacts,0);assert.equal(f.store.deliveryCount(),0);
  }finally{f.close();}
});
test('An old saved job or restored draft cannot bypass the independent greeting receipt',async()=>{
  const f=fixture();try{
    await f.flow.greetings.prepare(f.job.id);const oldJob=f.store.getJob(f.job.id);
    await f.flow.sendJob(f.job.id);
    f.store.upsertJob({...oldJob,status:'已沟通'});
    await assert.rejects(f.flow.greetings.send(f.job.id),/不会重复发送/);
    await assert.rejects(f.flow.greetings.prepare(f.job.id,{force:true}),/不会重复发送/);
    assert.equal(f.store.messages().filter(m=>m.kind==='greeting').length,1);
    const alias=f.store.upsertJob({...oldJob,id:'different-local-id',url:oldJob.url.replace('www.zhipin.com','zhipin.com')+'?tracking=new',status:'已沟通'});
    await assert.rejects(f.flow.greetings.send(alias.id),/不会重复发送/);
  }finally{f.close();}
});
test('Changing the recipient job URL after preview invalidates confirmation',async()=>{
  const f=fixture();try{
    const preview=await f.flow.greetings.prepare(f.job.id);
    f.store.upsertJob({...f.store.getJob(f.job.id),url:'https://www.zhipin.com/job_detail/another-job.html'});
    await assert.rejects(f.flow.sendJob(f.job.id,()=>true,{personalized:true,revision:preview.revision}),/重新预览/);
    assert.equal(f.store.deliveryCount(),0);assert.equal(f.browser.world().sent.length,0);
  }finally{f.close();}
});

function twoJobs(f) {
  const world=f.browser.world();world.jobs=[world.jobs[0],world.jobs[4]];f.browser.save(world);
  return world.jobs;
}

test('A definitively unsent missing conversation retains its draft and screens later jobs without another contact',async()=>{
  const f=fixture();try{
    const [first,second]=twoJobs(f),send=f.browser.sendJobGreeting.bind(f.browser),communicate=f.browser.communicate.bind(f.browser);
    let contacts=0,greetingAttempts=0;
    f.browser.communicate=async(...args)=>{contacts++;return communicate(...args);};
    f.browser.sendJobGreeting=async(job,...args)=>{
      greetingAttempts++;
      if(job.url===first.url)throw Object.assign(Error('会话列表尚未完整读取，无法确认岗位对应的唯一 HR'),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
      return send(job,...args);
    };
    const result=await f.flow.scan();
    assert.equal(result.error,null);assert.equal(result.communicationDeferred,true);assert.match(result.message,/固定开场.*专属稿已保留/);
    assert.equal(result.phase,'筛选完成，沟通待核对');assert.equal(result.sent,1);assert.equal(result.greetingDeferred,1);
    assert.equal(contacts,1);assert.equal(greetingAttempts,1);
    const savedSecond=f.store.jobs().find(job=>job.url===second.url);
    assert.equal(savedSecond.status,'合适');assert.equal(savedSecond.greeting.status,'草稿');
    assert.equal(f.store.getJob(f.job.id).greeting.status,'草稿');assert.equal(f.flow.stats().greetingPending,1);
    assert.equal(f.store.deliveryCount(),1);

    // Retrying the saved greeting must not issue another platform opening.
    const retry=await f.flow.greetings.send(f.job.id);
    assert.equal(retry.deferred,true);assert.equal(contacts,1);assert.equal(greetingAttempts,2);
    await assert.rejects(f.flow.sendJob(f.job.id),/岗位已经处理/);
    assert.equal(f.store.deliveryCount(),1);assert.equal(f.browser.world().sent.length,1);
  }finally{f.close();}
});

test('A missing receipt after a send attempt pauses the scan and cannot be retried',async()=>{
  const f=fixture();try{
    twoJobs(f);let attempts=0;
    f.browser.sendJobGreeting=async(job,text,options)=>{options.onAttempt();attempts++;throw Error('点击发送后回执丢失');};
    const result=await f.flow.scan();
    assert.equal(result.phase,'已暂停');assert.match(result.error,/回执丢失/);assert.equal(result.sent,1);assert.equal(result.greetingDeferred,0);
    assert.equal(f.browser.world().sent.length,1);assert.equal(attempts,1);
    assert.equal(f.store.getJob(f.job.id).status,'已沟通');assert.equal(f.store.getJob(f.job.id).greeting.status,'待核实');
    assert.equal(f.flow.stats().greetingPending,0);
    await assert.rejects(f.flow.greetings.send(f.job.id),/不会重复发送/);
    assert.equal(attempts,1);
  }finally{f.close();}
});

test('Login, verification, rate limits, and unknown notSent failures still pause the scan',async()=>{
  for(const code of ['AUTH_REQUIRED','VERIFICATION_REQUIRED','RATE_LIMITED','UNRECOGNIZED_ADAPTER_FAILURE']){
    const f=fixture();try{
      twoJobs(f);
      f.browser.sendJobGreeting=async()=>{throw Object.assign(Error(code+'，需要处理后继续'),{code,notSent:true});};
      const result=await f.flow.scan();
      assert.equal(result.phase,'已暂停',code);assert.match(result.error,new RegExp(code));
      assert.equal(result.sent,1);assert.equal(result.greetingDeferred,0);assert.equal(f.browser.world().sent.length,1);
      assert.equal(f.store.getJob(f.job.id).greeting.status,'草稿');assert.equal(f.store.getJob(f.job.id).greeting.deferred,false);
    }finally{f.close();}
  }
});

test('A target-unavailable code without a notSent guarantee cannot continue after an attempt',async()=>{
  const f=fixture();try{
    twoJobs(f);
    f.browser.sendJobGreeting=async(job,text,options)=>{options.onAttempt();throw Object.assign(Error('目标会话变化，不能确定是否发送'),{code:'GREETING_TARGET_UNAVAILABLE'});};
    const result=await f.flow.scan();
    assert.equal(result.phase,'已暂停');assert.equal(result.greetingDeferred,0);assert.equal(f.browser.world().sent.length,1);
    assert.equal(f.store.getJob(f.job.id).greeting.status,'待核实');
    await assert.rejects(f.flow.greetings.send(f.job.id),/不会重复发送/);
  }finally{f.close();}
});

test('Cancelling during target lookup stops without being counted as a deferred greeting',async()=>{
  const f=fixture();try{
    twoJobs(f);
    f.browser.sendJobGreeting=async()=>{throw Object.assign(Error('操作已停止'),{code:'CANCELLED',notSent:true});};
    const result=await f.flow.scan();
    assert.equal(result.phase,'已停止');assert.equal(result.error,null);assert.equal(result.sent,1);assert.equal(result.greetingDeferred,0);
    assert.equal(f.browser.world().sent.length,1);assert.equal(f.store.getJob(f.job.id).greeting.status,'草稿');
  }finally{f.close();}
});

test('A user stop winning a target lookup race is cancellation, not deferral',async()=>{
  const f=fixture();try{
    twoJobs(f);
    f.browser.sendJobGreeting=async()=>{f.flow.stop();throw Object.assign(Error('未确认岗位会话'),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});};
    const result=await f.flow.scan();
    assert.equal(result.phase,'已停止');assert.equal(result.error,null);assert.equal(result.greetingDeferred,0);
    assert.equal(f.browser.world().sent.length,1);assert.equal(f.store.getJob(f.job.id).greeting.status,'草稿');
  }finally{f.close();}
});

test('An explicit no-send refusal after the attempt callback clears its receipt and remains retryable',async()=>{
  const f=fixture();try{
    f.browser.sendJobGreeting=async(job,text,options)=>{options.onAttempt();throw Object.assign(Error('发送前DOM身份核验拒绝'),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});};
    const result=await f.flow.sendJob(f.job.id);
    assert.equal(result.greetingDeferred,true);assert.equal(f.store.getJob(f.job.id).greeting.status,'草稿');
    const retry=await f.flow.greetings.send(f.job.id);
    assert.equal(retry.deferred,true);assert.equal(f.browser.world().sent.length,1);assert.equal(f.flow.stats().greetingPending,1);
  }finally{f.close();}
});

test('A returned target-unavailable result defers, but a returned unknown failure does not',async()=>{
  for(const code of ['GREETING_TARGET_UNAVAILABLE','UNRECOGNIZED_ADAPTER_FAILURE']){
    const f=fixture();try{
      twoJobs(f);
      f.browser.sendJobGreeting=async()=>({verified:false,notSent:true,code,reason:'未完成会话确认'});
      const result=await f.flow.scan(),deferred=code==='GREETING_TARGET_UNAVAILABLE';
      assert.equal(result.phase,deferred?'筛选完成，沟通待核对':'已暂停');
      assert.equal(result.communicationDeferred,deferred);
      assert.equal(result.sent,1);assert.equal(result.greetingDeferred,deferred?1:0);
      assert.equal(f.store.getJob(f.job.id).greeting.status,'草稿');
      assert.equal(f.store.getJob(f.job.id).greeting.deferred,deferred);
    }finally{f.close();}
  }
});

test('An unverified returned receipt after a send attempt pauses and blocks retries',async()=>{
  const f=fixture();try{
    twoJobs(f);
    f.browser.sendJobGreeting=async(job,text,options)=>{options.onAttempt();return {verified:false,reason:'未读取到发出回执'};};
    const result=await f.flow.scan();
    assert.equal(result.phase,'已暂停');assert.equal(result.sent,1);assert.equal(result.greetingDeferred,0);
    assert.equal(f.store.getJob(f.job.id).greeting.status,'待核实');
    await assert.rejects(f.flow.greetings.send(f.job.id),/不会重复发送/);
  }finally{f.close();}
});

async function deferGreeting(f) {
  f.browser.sendJobGreeting=async()=>{throw Object.assign(Error('未匹配到唯一会话'),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});};
  await f.flow.sendJob(f.job.id);
  return f.store.getJob(f.job.id).greeting;
}

test('Manual confirmation records the user declaration without contacting HR or inventing messages',async()=>{
  const f=fixture();try{
    const draft=await deferGreeting(f),quota=f.store.deliveryCount(),contacts=f.browser.world().sent.length;
    f.browser.sendJobGreeting=async()=>assert.fail('Manual confirmation must not send');
    f.browser.communicate=async()=>assert.fail('Manual confirmation must not contact');
    const result=f.flow.greetings.markManuallySent(f.job.id,{expectedRevision:draft.revision});
    assert.equal(result.ok,true);assert.equal(result.greeting.status,'已发送');
    assert.equal(result.greeting.manualConfirmed,true);assert.ok(result.greeting.manualConfirmedAt);
    assert.equal(result.greeting.sentAt,undefined);assert.equal(result.greeting.deferred,false);
    assert.equal(result.greeting.error,null);assert.equal(result.greeting.code,null);
    assert.equal(f.flow.stats().greetingPending,0);assert.equal(f.store.getJob(f.job.id).status,'已沟通');
    assert.equal(f.store.messages().length,0);assert.equal(f.store.conversations().length,0);
    assert.equal(f.store.deliveryCount(),quota);assert.equal(f.browser.world().sent.length,contacts);
    assert.ok(f.store.logs().some(log=>log.text.includes('用户确认已在 BOSS 手动发送')));
    assert.throws(()=>f.flow.greetings.markManuallySent(f.job.id,{expectedRevision:draft.revision}),/不会重复发送/);
    await assert.rejects(f.flow.greetings.send(f.job.id),/不会重复发送/);
  }finally{f.close();}
});

test('Manual confirmation keeps the independent delivery guard after restoring an old draft or URL alias',async()=>{
  const f=fixture();try{
    const draft=await deferGreeting(f),old=f.store.getJob(f.job.id);
    f.flow.greetings.markManuallySent(f.job.id,{expectedRevision:draft.revision});
    f.store.upsertJob(old);
    assert.throws(()=>f.flow.greetings.markManuallySent(f.job.id,{expectedRevision:draft.revision}),/不会重复发送/);
    await assert.rejects(f.flow.greetings.send(f.job.id),/不会重复发送/);
    await assert.rejects(f.flow.greetings.prepare(f.job.id,{force:true}),/不会重复发送/);
    const alias=f.store.upsertJob({...old,id:'manual-confirmation-url-alias',url:old.url.replace('www.zhipin.com','zhipin.com')+'?tracking=another'});
    assert.throws(()=>f.flow.greetings.markManuallySent(alias.id,{expectedRevision:draft.revision}),/不会重复发送/);
    await assert.rejects(f.flow.greetings.send(alias.id),/不会重复发送/);
  }finally{f.close();}
});

test('Manual confirmation requires the current revision, current facts, and the intended existing job',async()=>{
  const f=fixture();try{
    const draft=await deferGreeting(f);
    assert.throws(()=>f.flow.greetings.markManuallySent(f.job.id),/先核对/);
    assert.throws(()=>f.flow.greetings.markManuallySent(f.job.id,{expectedRevision:''}),/先核对/);
    assert.throws(()=>f.flow.greetings.markManuallySent('nonexistent-job',{expectedRevision:draft.revision}),/岗位不存在/);
    const edited=f.flow.greetings.save(f.job.id,'您好，我有采购经验，希望沟通具体岗位要求。');
    assert.throws(()=>f.flow.greetings.markManuallySent(f.job.id,{expectedRevision:draft.revision}),/重新预览/);
    const other=f.store.upsertJob(f.browser.world().jobs[4]);
    await f.flow.greetings.prepare(other.id);
    f.store.upsertJob({...f.store.getJob(other.id),status:'已沟通'});
    assert.throws(()=>f.flow.greetings.markManuallySent(other.id,{expectedRevision:edited.revision}),/重新预览/);
    f.store.saveSettings({resume:'已修改的采购简历事实'});
    assert.throws(()=>f.flow.greetings.markManuallySent(f.job.id,{expectedRevision:edited.revision}),/重新预览/);
    assert.equal(f.store.getJob(f.job.id).greeting.status,'草稿');
    assert.equal(f.store.getJob(other.id).greeting.status,'草稿');
    assert.equal(f.store.messages().length,0);
    assert.ok(!f.store.logs().some(log=>log.text.includes('用户确认已在 BOSS 手动发送')));
  }finally{f.close();}
});

test('Manual confirmation refuses uncontacted jobs and sent or uncertain greeting states',async()=>{
  for(const [jobStatus,greetingStatus] of [['合适','草稿'],['待核实','草稿'],['已沟通','待核实'],['已沟通','已发送']]){
    const f=fixture();try{
      const draft=await f.flow.greetings.prepare(f.job.id);
      f.store.upsertJob({...f.store.getJob(f.job.id),status:jobStatus,greeting:{...draft,status:greetingStatus}});
      assert.throws(()=>f.flow.greetings.markManuallySent(f.job.id,{expectedRevision:draft.revision}),/只能确认|重新预览/);
      assert.equal(f.store.getJob(f.job.id).greeting.status,greetingStatus);
      assert.equal(f.browser.world().sent.length,0);assert.equal(f.store.messages().length,0);
    }finally{f.close();}
  }
});

test('Manual confirmation cannot turn demo or simulation jobs into real HR receipts',async()=>{
  const f=fixture();try{
    const draft=await deferGreeting(f);
    const real=createJobGreetings({store:f.store,browser:f.browser,detail:()=>assert.fail('No detail reads'),simulation:false});
    assert.throws(()=>real.markManuallySent(f.job.id,{expectedRevision:draft.revision}),/体验岗位/);
    f.store.upsertJob({...f.store.getJob(f.job.id),demo:true});
    assert.throws(()=>f.flow.greetings.markManuallySent(f.job.id,{expectedRevision:draft.revision}),/体验岗位/);
    assert.equal(f.store.getJob(f.job.id).greeting.status,'草稿');assert.equal(f.store.messages().length,0);
  }finally{f.close();}
});

test('Simulation creates source-grounded personalized drafts through the real quality gate',async()=>{
  const f=fixture();try{
    const draft=await f.flow.greetings.prepare(f.job.id);
    assert.equal(draft.generatorVersion,GREETING_GENERATOR_VERSION);
    assert.equal(draft.reviewRequired,false);assert.equal(draft.reviewReason,null);
    assert.ok(draft.matches.length>=1);assert.ok(draft.text);
    for(const match of draft.matches){
      assert.ok(f.job.description.includes(match.requirement));
      assert.ok(f.store.settings(true).resume.includes(match.evidence));
    }
    assert.equal(validateGeneratedGreeting(f.job,f.store.settings(true),draft).text,draft.text);
    assert.equal(draft.audit.approved,true);
    assert.equal(f.flow.greetings.assertPersonalized(f.job.id).revision,draft.revision);
    assert.deepEqual(simulationGreetingMatches({description:'维护门店陈列与接待顾客。'},{resume:'采购订单交付。'}),[]);
    assert.equal(f.browser.world().sent.length,0);assert.equal(f.store.deliveryCount(),0);
  }finally{f.close();}
});

test('No-match drafts stay empty and review-required and cannot be sent with an explicit confirmation',async()=>{
  const f=fixture();try{
    f.store.saveSettings({resume:'曾负责门店日常接待与商品陈列。'});
    const draft=await f.flow.greetings.prepare(f.job.id);
    assert.equal(draft.text,'');assert.deepEqual(draft.matches,[]);
    assert.equal(draft.reviewRequired,true);assert.equal(draft.reviewReason,'no_match');
    assert.equal(draft.code,'GREETING_NO_MATCH');assert.match(draft.error,/不会自动发送/);
    assert.throws(()=>f.flow.greetings.assertPersonalized(f.job.id),{code:'GREETING_NO_MATCH'});
    assert.throws(()=>f.flow.greetings.assertPersonalized(f.job.id,draft.revision),{code:'GREETING_NO_MATCH'});
    let sends=0;f.browser.sendJobGreeting=async()=>{sends++;assert.fail('No-match draft must not send');};
    f.store.upsertJob({...f.store.getJob(f.job.id),status:'已沟通'});
    await assert.rejects(f.flow.greetings.send(f.job.id,{expectedRevision:draft.revision}),{code:'GREETING_NO_MATCH'});
    const edited=f.flow.greetings.save(f.job.id,'您好，我对岗位有兴趣，希望进一步沟通。');
    assert.throws(()=>f.flow.greetings.assertPersonalized(f.job.id,edited.revision),{code:'GREETING_NO_MATCH'});
    assert.equal(sends,0);assert.equal(f.browser.world().sent.length,0);assert.equal(f.store.deliveryCount(),0);
  }finally{f.close();}
});

test('Legacy drafts are regenerated while current cached drafts retain their exact revision',async()=>{
  const f=fixture();try{
    const original=await f.flow.greetings.prepare(f.job.id);
    assert.equal((await f.flow.greetings.prepare(f.job.id)).revision,original.revision);
    const legacy={...original,text:'旧版通用招呼不能再次自动发送。'};delete legacy.generatorVersion;
    f.store.upsertJob({...f.store.getJob(f.job.id),greeting:legacy});
    assert.throws(()=>f.flow.greetings.assertPersonalized(f.job.id),{code:'GREETING_STALE'});
    const regenerated=await f.flow.greetings.prepare(f.job.id);
    assert.equal(regenerated.generatorVersion,GREETING_GENERATOR_VERSION);
    assert.notEqual(regenerated.text,legacy.text);assert.ok(regenerated.matches.length);
    assert.equal(f.flow.greetings.assertPersonalized(f.job.id).text,regenerated.text);
    f.store.upsertJob({...f.store.getJob(f.job.id),greeting:{...regenerated,generatorVersion:GREETING_GENERATOR_VERSION-1}});
    assert.throws(()=>f.flow.greetings.assertPersonalized(f.job.id),{code:'GREETING_STALE'});
  }finally{f.close();}
});

test('Version migration cannot replace a sent or uncertain draft or bypass the delivery ledger',async()=>{
  const f=fixture();try{
    const draft=await f.flow.greetings.prepare(f.job.id),old={...f.store.getJob(f.job.id),status:'已沟通'};
    f.store.upsertJob(old);
    f.flow.greetings.markManuallySent(f.job.id,{expectedRevision:draft.revision});
    f.store.upsertJob({...old,greeting:{...draft,generatorVersion:1}});
    await assert.rejects(f.flow.greetings.prepare(f.job.id,{force:true}),/不会重复发送/);
    assert.throws(()=>f.flow.greetings.assertPersonalized(f.job.id),/不会重复发送/);
    const another=f.store.upsertJob({...f.browser.world().jobs[4],greeting:{...draft,status:'待核实',generatorVersion:1}});
    await assert.rejects(f.flow.greetings.prepare(another.id,{force:true}),/已有发送记录/);
    assert.equal(f.store.getJob(another.id).greeting.status,'待核实');
  }finally{f.close();}
});

test('The quality gate rechecks source facts, cached evidence, text and explicit revision',async()=>{
  const f=fixture();try{
    const draft=await f.flow.greetings.prepare(f.job.id),original=f.store.getJob(f.job.id);
    assert.throws(()=>f.flow.greetings.assertPersonalized(f.job.id,'stale-revision'),{code:'GREETING_STALE'});
    f.store.upsertJob({...original,greeting:{...draft,matches:[{requirement:'供应商开发',evidence:'十年供应商开发经验'}]}});
    assert.throws(()=>f.flow.greetings.assertPersonalized(f.job.id),{code:'GREETING_INVALID'});
    f.store.upsertJob({...original,greeting:{...draft,text:draft.text+'本人拥有十年采购经验。'}});
    assert.throws(()=>f.flow.greetings.assertPersonalized(f.job.id),{code:'GREETING_INVALID'});
    f.store.upsertJob(original);f.store.saveSettings({resume:'改为门店接待与陈列经历。'});
    assert.throws(()=>f.flow.greetings.assertPersonalized(f.job.id),{code:'GREETING_STALE'});
    assert.equal(f.browser.world().sent.length,0);assert.equal(f.store.messages().length,0);
  }finally{f.close();}
});

test('Editing requires explicit review and cannot remove verified requirements or evidence',async()=>{
  const f=fixture();try{
    const draft=await f.flow.greetings.prepare(f.job.id);
    const unchanged=f.flow.greetings.save(f.job.id,draft.text);
    assert.equal(unchanged.edited,false);assert.equal(unchanged.revision,draft.revision);
    const edited=f.flow.greetings.save(f.job.id,draft.matches.map(match=>`岗位要求${match.requirement}，我的经历是${match.evidence}。`).join('')+'感谢您的时间。');
    assert.equal(edited.reviewRequired,true);assert.equal(edited.reviewReason,'edited');
    assert.throws(()=>f.flow.greetings.assertPersonalized(f.job.id),{code:'GREETING_REVIEW_REQUIRED'});
    assert.equal(f.flow.greetings.assertPersonalized(f.job.id,edited.revision).text,edited.text);
    const generic=f.flow.greetings.save(f.job.id,'您好，我对这个岗位感兴趣，希望进一步沟通。');
    assert.throws(()=>f.flow.greetings.assertPersonalized(f.job.id,generic.revision),{code:'GREETING_INVALID'});
    assert.equal(f.browser.world().sent.length,0);assert.equal(f.store.deliveryCount(),0);
  }finally{f.close();}
});
