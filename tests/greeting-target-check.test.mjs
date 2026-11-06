import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkGreetingTarget} from '../lib/greeting-target-check.mjs';

const job={status:'已沟通',title:'采购专员',company:'测试公司',hrName:'林女士',url:'https://www.zhipin.com/job_detail/test-job.html'};
function fixture(){
 const calls=[];
 const context={contact:job.hrName,company:job.company,jobTitle:job.title,anchorIds:['existing-message'],messages:[]};
 const browser={chatTargetId:'chat',activeTargetId:'chat',connection:{generation:1},
  openChat:async()=>calls.push('openChat'),waitForConversationList:async()=>({modernWithoutIds:true}),
  targets:async()=>[{id:'chat',type:'page',url:'https://www.zhipin.com/web/geek/chat'}],
  evaluateOn:async(target,fn,args)=>{
   calls.push(args.action||fn.name);
   assert.ok(!['fill','send'].includes(args.action),'Check must never fill or send');
   if(fn.name==='chooseModernConversationDOM')return {ok:true,found:true};
   if(fn.name==='modernJobProofDOM')return {ok:true,jobUrl:job.url,closeClicked:true,closed:true};
   if(args.action==='read')return structuredClone(context);
   if(args.action==='openJob')return {ok:true,openedJob:true};
   assert.fail('Unexpected browser action');
  },
  communicate:async()=>assert.fail('Check must not initiate contact'),
  sendJobGreeting:async()=>assert.fail('Check must not send a greeting')};
 return {browser,calls,context};
}
test('checking a contacted job proves its recipient without sending or generating a message',async()=>{
 const f=fixture();const result=await checkGreetingTarget(f.browser,job,{timeoutMs:0,lookupTimeoutMs:0});
 assert.equal(result.verified,true);assert.equal(result.sent,false);assert.equal(result.jobUrl,job.url);
 assert.equal(result.contact,job.hrName);assert.ok(f.calls.includes('openJob'));assert.ok(!f.calls.includes('send'));
});
test('read-only recipient check reports existing or uncertain openings without filling or sending',async()=>{
 for(const confirmed of [true,false]){
  const f=fixture();f.context.messages=[{role:'assistant',text:'已有本人开场',remoteId:'existing-message',platformMessageId:true,deliveryStatus:confirmed?'confirmed':'pending'}];
  const result=await checkGreetingTarget(f.browser,job,{timeoutMs:0,lookupTimeoutMs:0});
  assert.equal(result.sent,false);assert.equal(result.alreadyGreeted,confirmed);assert.equal(result.presenceUnknown,!confirmed);
  assert.match(result.reason,confirmed?/跳过追加/:/阻止追加/);assert.ok(!f.calls.some(call=>['fill','send'].includes(call)));
 }
});

test('uncontacted, demo and missing jobs cannot start a recipient check',async()=>{
 for(const j of [null,{...job,status:'合适'},{...job,demo:true},{...job,simulation:true}]){
  const f=fixture();await assert.rejects(checkGreetingTarget(f.browser,j),/已沟通/);assert.equal(f.calls.length,0);
 }
});
test('wrong recipient or cancellation cannot report a successful check',async()=>{
 const f=fixture();f.context.company='另一公司';
 await assert.rejects(checkGreetingTarget(f.browser,job,{timeoutMs:0,lookupTimeoutMs:0}),/HR、公司、岗位/);
 assert.ok(!f.calls.includes('openJob'));
 const g=fixture();await assert.rejects(checkGreetingTarget(g.browser,job,{guard:()=>false}),{code:'CANCELLED'});assert.equal(g.calls.length,0);
});

function failedProbe(failure=Object.assign(Error('PRIVATE_PROOF_FAILURE'),{code:'GREETING_TARGET_UNAVAILABLE'}),onFailure=()=>{}){
 const f=fixture(),evaluate=f.browser.evaluateOn;
 f.browser.evaluateOn=async(target,fn,args)=>{
  if(fn.name==='chooseModernConversationDOM'){
   f.calls.push('chooseModernConversationDOM');onFailure(f.browser);throw failure;
  }
  return evaluate(target,fn,args);
 };
 return {...f,failure};
}
const probeOptions={timeoutMs:0,lookupTimeoutMs:0};

test('failed proof captures only its pinned chat and reports a sanitized envelope without sending',async()=>{
 const f=failedProbe(),diagnostic={version:2,usable:true,route:'/web/geek/chat',counts:{renderedRows:2}};
 let captures=0,report;
 f.browser.openChat=async()=>{f.calls.push('openChat');f.browser.chatTargetId=f.browser.activeTargetId='new-chat';};
 f.browser.targets=async()=>[{id:'new-chat',type:'page',url:'https://www.zhipin.com/web/geek/chat'}];
 f.browser.captureDiagnostics=async options=>{
  captures++;assert.equal(options.targetId,'new-chat');assert.equal(options.generation,1);
  assert.equal(options.guard(),true);return diagnostic;
 };
 await assert.rejects(checkGreetingTarget(f.browser,job,{...probeOptions,onDiagnostic:value=>{report=value;}}),error=>error===f.failure);
 assert.equal(captures,1);assert.equal(report.diagnostic,diagnostic);
 assert.deepEqual(Object.keys(report).sort(),['capturedAt','diagnostic','errorCode','generation','kind','targetId','version']);
 assert.equal(report.version,1);assert.equal(report.kind,'greeting-target-check');assert.equal(report.targetId,'new-chat');
 assert.equal(report.generation,1);assert.equal(report.errorCode,f.failure.code);assert.ok(Number.isFinite(Date.parse(report.capturedAt)));
 const serialized=JSON.stringify(report);
 for(const value of [f.failure.message,job.hrName,job.company,job.title,job.url])assert.ok(!serialized.includes(value));
 assert.deepEqual(f.calls,['openChat','chooseModernConversationDOM']);
});

test('cancellation and disconnected proof errors never request diagnostics',async()=>{
 for(const code of ['CANCELLED','CDP_DISCONNECTED','CDP_CONNECTION_FAILED','CDP_CONNECT_TIMEOUT','CDP_SESSION_DETACHED']){
  const failure=Object.assign(Error(code),{code}),f=failedProbe(failure);let captures=0,reports=0;
  f.browser.captureDiagnostics=async()=>{captures++;return {usable:true};};
  await assert.rejects(checkGreetingTarget(f.browser,job,{...probeOptions,onDiagnostic:()=>{reports++;}}),error=>error===failure);
  assert.equal(captures,0,code);assert.equal(reports,0,code);
 }
});

test('changed connection or target prevents failure capture instead of following another page',async()=>{
 for(const mutate of [
  browser=>{browser.connection.generation++;},
  browser=>{browser.chatTargetId='other-chat';},
  browser=>{browser.activeTargetId='other-chat';},
  browser=>{browser.connection.session={connected:false};}
 ]){
  const f=failedProbe(undefined,mutate);let captures=0,reports=0;
  f.browser.captureDiagnostics=async()=>{captures++;return {usable:true};};
  await assert.rejects(checkGreetingTarget(f.browser,job,{...probeOptions,onDiagnostic:()=>{reports++;}}),error=>error===f.failure);
  assert.equal(captures,0);assert.equal(reports,0);
 }
});

test('capture errors, unusable results and callback errors cannot replace the original proof error',async()=>{
 for(const mode of ['capture-error','unusable','callback-error']){
  const f=failedProbe();let captures=0,reports=0;
  f.browser.captureDiagnostics=async()=>{captures++;if(mode==='capture-error')throw Error('CAPTURE_ERROR');return {usable:mode!=='unusable'};};
  await assert.rejects(checkGreetingTarget(f.browser,job,{...probeOptions,onDiagnostic:()=>{reports++;throw Error('CALLBACK_ERROR');}}),error=>error===f.failure);
  assert.equal(captures,1);assert.equal(reports,mode==='callback-error'?1:0);
  assert.deepEqual(f.calls,['openChat','chooseModernConversationDOM']);
 }
});

test('cancellation or target changes during capture discard the diagnostic and preserve the proof error',async()=>{
 for(const mode of ['cancel','generation','chat-target','active-target']){
  const f=failedProbe();let active=true,reports=0;
  f.browser.captureDiagnostics=async options=>{
   assert.equal(options.guard(),true);
   if(mode==='cancel')active=false;
   if(mode==='generation')f.browser.connection.generation++;
   if(mode==='chat-target')f.browser.chatTargetId='other';
   if(mode==='active-target')f.browser.activeTargetId='other';
   return {usable:true};
  };
  await assert.rejects(checkGreetingTarget(f.browser,job,{...probeOptions,guard:()=>active,onDiagnostic:()=>{reports++;}}),error=>error===f.failure);
  assert.equal(reports,0,mode);
 }
});

test('successful checks and failures before prove do not collect failure diagnostics',async()=>{
 for(const mode of ['success','open-failure','list-failure']){
  const f=fixture(),failure=Error(mode);let captures=0,reports=0;
  f.browser.captureDiagnostics=async()=>{captures++;return {usable:true};};
  if(mode==='open-failure')f.browser.openChat=async()=>{throw failure;};
  if(mode==='list-failure')f.browser.waitForConversationList=async()=>{throw failure;};
  const pending=checkGreetingTarget(f.browser,job,{...probeOptions,onDiagnostic:()=>{reports++;}});
  if(mode==='success')assert.equal((await pending).sent,false);
  else await assert.rejects(pending,error=>error===failure);
  assert.equal(captures,0);assert.equal(reports,0);
 }
});

test('diagnostic errorCode falls back safely without serializing arbitrary error text',async()=>{
 const f=failedProbe(Object.assign(Error('PRIVATE_ERROR_TEXT'),{code:'PRIVATE_ERROR_CODE?token=secret'}));let report;
 f.browser.captureDiagnostics=async()=>({usable:true});
 await assert.rejects(checkGreetingTarget(f.browser,job,{...probeOptions,onDiagnostic:value=>{report=value;}}),error=>error===f.failure);
 assert.equal(report.errorCode,'GREETING_TARGET_UNAVAILABLE');assert.ok(!JSON.stringify(report).includes('PRIVATE'));
});
