import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createModernGreetingAdapter,chooseModernConversationDOM,modernGreetingCapabilityDOM} from '../lib/modern-greeting-adapter.mjs';

const job={url:'https://www.zhipin.com/job_detail/job-fixture.html',title:'采购专员',company:'虚构采购公司',hrName:'林 HR'};
const clone=value=>structuredClone(value);
function fixture(options={}){
 const state={active:true,context:{modern:true,contact:job.hrName,company:job.company,jobTitle:job.title,anchorIds:['old-1'],latestTail:{atBottom:true,loading:false,signature:'tail-old-1'},messages:[{remoteId:'old-1',platformMessageId:true,role:'user',text:'先前消息'}]},
  selectResults:[{ok:true,found:true}],proofResults:[{ok:true,jobUrl:job.url}],closed:{ok:true,closeClicked:true,closed:true,jobUrl:job.url},settled:{ok:true,closed:true,jobUrl:job.url},calls:[],pages:0,resets:0};
 const browser={connection:{generation:1},chatTargetId:'chat',activeTargetId:'chat',
  targets:async()=>state.targets||[{id:'chat',type:'page',url:'https://www.zhipin.com/web/geek/chat'}],
  resetConversations:async options=>{options.guard();state.resets++;state.calls.push('reset');state.onReset?.();},
  scrollConversations:async options=>{options.guard();state.pages++;return state.progress||{changed:true,moved:true,complete:false};},
  evaluateOn:async(target,fn,args)=>{
   assert.equal(target.id,'chat');state.calls.push([fn.name,clone(args)]);
   if(state.fail)throw state.fail;
   let result;
   if(fn.name==='chooseModernConversationDOM')result=state.choose?state.choose():state.selectResults.length>1?state.selectResults.shift():state.selectResults[0];
   else if(fn.name==='modernJobProofDOM')result=args.action==='close'?state.closed:args.action==='closed'?state.settled:state.proofResults.length>1?state.proofResults.shift():state.proofResults[0];
   else if(fn.name==='modernChatDOM'){
    if(args.action==='read')result=state.context;
    if(args.action==='openJob')result={ok:true,openedJob:true};
    if(args.action==='fill')result={ok:true,filled:true};
    if(args.action==='send')result=state.sendResult||{ok:true,clicked:true};
   }
   state.after?.(fn.name,args);
   return clone(result);
  }};
 const adapter=createModernGreetingAdapter(browser,{targetId:'chat',guard:()=>state.active,timeoutMs:5,pollMs:1,...options});
 return {state,browser,adapter};
}
const error=(message,code)=>({ok:false,error:message,code,notSent:true});
const sending=proof=>({...proof,expected:{...proof.expected,anchorIds:['old-1'],requireLatestTail:true,tailSignature:'tail-old-1'}});

test('prove selects a row, verifies and closes matching public job popup before issuing a local proof',async()=>{
 const f=fixture();f.state.selectResults=[{ok:true,found:false},{ok:true,found:true}];
 const proof=await f.adapter.prove({...job,title:'采购专员\n8-12K',hrName:'林 HR\n在线'});
 assert.equal(f.state.pages,1);assert.equal(proof.jobUrl,job.url);assert.equal(proof.targetId,'chat');
 assert.equal(proof.generation,1);assert.equal('id' in proof,false);assert.equal('remoteId' in proof,false);
 const dom=f.state.calls.filter(Array.isArray);
 assert.deepEqual(dom.map(([name,args])=>name==='modernChatDOM'?args.action:name==='modernJobProofDOM'?args.action||'proof':name),
  ['chooseModernConversationDOM','chooseModernConversationDOM','read','openJob','proof','read','close','closed','read']);
 assert.ok(!dom.some(([,args])=>['fill','send'].includes(args.action)));
 assert.equal((await f.adapter.read(proof)).jobUrl,job.url);
});

test('prove focuses its pinned chat once before lookup, never again during lookup or message actions',async()=>{
 const f=fixture();let focused=0;
 f.browser.focusGreetingChat=async options=>{
  assert.equal(options.targetId,'chat');assert.equal(options.generation,1);options.guard();
  assert.equal(f.state.resets,0);assert.deepEqual(f.state.calls,[]);focused++;
  return {focused:true,targetId:'chat',generation:1};
 };
 f.state.selectResults=[{ok:true,found:false},{ok:true,found:false},{ok:true,found:true}];
 const proof=sending(await f.adapter.prove(job));assert.equal(f.state.pages,2);
 await f.adapter.action(proof,'fill','专属正文');await f.adapter.action(proof,'send','专属正文');
 f.state.active=false;await f.adapter.read(proof);assert.equal(focused,1);
});

test('unconfirmed focus, changed pinned state or cancellation blocks lookup and preserves typed failures',async()=>{
 const cases=[
  [f=>({focused:false,targetId:'chat',generation:1}),'GREETING_TARGET_UNAVAILABLE'],
  [f=>({focused:true,targetId:'other',generation:1}),'GREETING_TARGET_UNAVAILABLE'],
  [f=>({focused:true,targetId:'chat',generation:2}),'GREETING_TARGET_UNAVAILABLE'],
  [f=>{f.browser.activeTargetId='other';return {focused:true,targetId:'chat',generation:1};},'GREETING_TARGET_UNAVAILABLE'],
  [f=>{f.browser.connection.generation++;return {focused:true,targetId:'chat',generation:1};},'GREETING_TARGET_UNAVAILABLE'],
  [f=>{f.state.active=false;return {focused:true,targetId:'chat',generation:1};},'CANCELLED'],
  [f=>{throw Object.assign(Error('fixture transport failure'),{code:'CDP_ERROR'});},'CDP_ERROR']
 ];
 for(const [focus,code] of cases){const f=fixture();let count=0;
  f.browser.focusGreetingChat=async()=>{count++;return focus(f);};
  await assert.rejects(f.adapter.prove(job),{code});assert.equal(count,1);assert.equal(f.state.resets,0);assert.deepEqual(f.state.calls,[]);
 }
 const f=fixture();let called=false;f.state.active=false;f.browser.focusGreetingChat=async()=>{called=true;};
 await assert.rejects(f.adapter.prove(job),{code:'CANCELLED'});assert.equal(called,false);
});

test('native job opening receives exact verified context and still requires the complete public popup proof',async()=>{
 for(const wrongPopup of [false,true]){
  const f=fixture({timeoutMs:0});let opens=0;
  f.browser.openGreetingJob=async options=>{
   assert.equal(options.targetId,'chat');assert.equal(options.generation,1);options.guard();
   assert.deepEqual(options.expected,{contact:job.hrName,company:job.company,jobTitle:job.title,anchorIds:['old-1']});
   opens++;return {ok:true,openedJob:true};
  };
  if(wrongPopup)f.state.proofResults=[{ok:true,jobUrl:'https://www.zhipin.com/job_detail/wrong-job.html'}];
  if(wrongPopup)await assert.rejects(f.adapter.prove(job),{code:'GREETING_TARGET_UNAVAILABLE'});
  else assert.equal((await f.adapter.prove(job)).jobUrl,job.url);
  assert.equal(opens,1);assert.equal(f.state.calls.filter(Array.isArray).some(([,args])=>['openJob','fill','send'].includes(args.action)),false);
 }
});

test('failed native job opening or changed target never falls back to a DOM click or proceeds into popup proof',async()=>{
 for(const mode of ['refused','changed','cancelled','transport']){
  const f=fixture();let opens=0;
  f.browser.openGreetingJob=async()=>{opens++;
   if(mode==='transport')throw Object.assign(Error('fixture CDP failure'),{code:'CDP_ERROR'});
   if(mode==='changed')f.browser.activeTargetId='other';
   if(mode==='cancelled')f.state.active=false;
   return {ok:true,openedJob:mode!=='refused'};
  };
  await assert.rejects(f.adapter.prove(job),{code:mode==='transport'?'CDP_ERROR':mode==='cancelled'?'CANCELLED':'GREETING_TARGET_UNAVAILABLE'});
  assert.equal(opens,1);assert.equal(f.state.calls.filter(Array.isArray).some(([name,args])=>name==='modernJobProofDOM'||['openJob','fill','send'].includes(args.action)),false);
 }
});

test('only definitely-unsent known native job-entry structure refusals normalize to target-unavailable',async()=>{
 for(const code of ['MODERN_CHAT_ACTION_UNAVAILABLE','MODERN_CHAT_IDENTITY_UNAVAILABLE',
  'AUTH_REQUIRED','VERIFICATION_REQUIRED','RATE_LIMITED','CANCELLED','CDP_ERROR','UNRECOGNIZED_FAILURE']){
  for(const notSent of [true,false,undefined]){
   const f=fixture(),failure=Object.assign(Error('fixture native entry refused'),{code,...notSent!==undefined?{notSent}:{}});
   f.browser.openGreetingJob=async()=>{throw failure;};
   const normalized=notSent===true&&code.startsWith('MODERN_CHAT_');
   await assert.rejects(f.adapter.prove(job),error=>error===failure&&error.code===(normalized?'GREETING_TARGET_UNAVAILABLE':code)&&error.notSent===notSent);
   assert.equal(f.state.calls.filter(Array.isArray).some(([name,args])=>name==='modernJobProofDOM'||['fill','send'].includes(args.action)),false);
  }
 }
});

test('the same structure error thrown after message dispatch is not normalized or declared unsent',async()=>{
 for(const code of ['MODERN_CHAT_ACTION_UNAVAILABLE','MODERN_CHAT_IDENTITY_UNAVAILABLE']){
  const f=fixture(),proof=sending(await f.adapter.prove(job));
  f.state.fail=Object.assign(Error('fixture response lost after dispatch'),{code,notSent:true});
  await assert.rejects(f.adapter.action(proof,'send','专属正文'),error=>error.code===code&&!('notSent' in error));
 }
});

test('atomic opening refusals preserve only typed definitely-unsent presence metadata',async()=>{
 for(const code of ['GREETING_ALREADY_PRESENT','GREETING_PRESENCE_UNCERTAIN','UNRECOGNIZED_FAILURE'])for(const notSent of [true,false]){
  const f=fixture(),proof=sending(await f.adapter.prove(job));
  f.state.sendResult={error:'fixture refusal',code,notSent,alreadyGreeted:true,presenceUnknown:true,receiptId:'existing-platform-mid',privateData:'do-not-copy'};
  await assert.rejects(f.adapter.action(proof,'send','专属正文'),failure=>{
   assert.equal(failure.code,code);assert.equal(failure.alreadyGreeted,notSent&&code==='GREETING_ALREADY_PRESENT'?true:undefined);
   assert.equal(failure.receiptId,notSent&&code==='GREETING_ALREADY_PRESENT'?'existing-platform-mid':undefined);
   assert.equal(failure.presenceUnknown,notSent&&code==='GREETING_PRESENCE_UNCERTAIN'?true:undefined);
   assert.equal(failure.privateData,undefined);return true;
  });
 }
});

const chatPage=()=>({id:'chat',type:'page',url:'https://www.zhipin.com/web/geek/chat'});
const childJobPage=(overrides={})=>({id:'new-job',type:'page',openerId:'chat',url:job.url,...overrides});
function newTabFixture({newPages=[childJobPage()],preexisting=[]}={}){
 const f=fixture({timeoutMs:0});f.state.targets=[chatPage(),...preexisting];f.state.focusCount=0;
 f.browser.focusGreetingChat=async options=>{
  options.guard();assert.equal(options.targetId,'chat');assert.equal(options.generation,1);
  f.state.focusCount++;f.state.onFocus?.(f.state.focusCount);
  return {focused:true,targetId:'chat',generation:1};
 };
 f.browser.openGreetingJob=async options=>{options.guard();f.state.targets.push(...newPages);return {ok:true,openedJob:true};};
 return f;
}

test('a unique newly opened child job tab proves its full URL and returns to the same chat without reading or closing the tab',async()=>{
 const f=newTabFixture({newPages:[childJobPage({url:job.url+'?security=private-sensitive-value#private'})],
  preexisting:[childJobPage({id:'existing-job'})]});
 const proof=await f.adapter.prove(job);
 assert.equal(proof.jobUrl,job.url);assert.equal(proof.targetId,'chat');assert.equal(proof.generation,1);
 assert.equal(f.state.focusCount,2);assert.equal(f.state.targets.length,3);assert.equal(f.state.targets[2].id,'new-job');
 assert.equal(JSON.stringify(proof).includes('private'),false);assert.equal(JSON.stringify(proof).includes('security'),false);
 assert.equal(f.state.calls.filter(Array.isArray).some(([name,args])=>name==='modernJobProofDOM'||['openJob','fill','send'].includes(args.action)),false);
 assert.equal((await f.adapter.read(proof)).contact,job.hrName);assert.equal(f.state.focusCount,2);
});

test('new tabs with missing or different openers, mismatched full URLs or multiple new BOSS pages cannot prove a job',async()=>{
 const cases=[
  [[childJobPage({openerId:undefined})],'opener_mismatch'],
  [[childJobPage({openerId:'other-chat'})],'opener_mismatch'],
  [[childJobPage({url:'https://www.zhipin.com/job_detail/job-fixture-extra.html?security=private-value'})],'job_url_mismatch'],
  [[childJobPage({url:'https://www.zhipin.com/job_detail/job.html'})],'job_url_mismatch'],
  [[childJobPage({url:'http://www.zhipin.com/job_detail/job-fixture.html'})],'job_url_mismatch'],
  [[childJobPage({url:'https://www.zhipin.com.evil.invalid/job_detail/job-fixture.html'})],'job_url_mismatch'],
  [[childJobPage(),childJobPage({id:'extra-job'})],'multiple_new_pages'],
  [[childJobPage(),childJobPage({id:'extra-boss',openerId:'other',url:'https://www.zhipin.com/web/geek/jobs'})],'multiple_new_pages']
 ];
 for(const [newPages,reason] of cases){const f=newTabFixture({newPages});
  await assert.rejects(f.adapter.prove(job),failure=>{
   assert.equal(failure.code,'GREETING_TARGET_UNAVAILABLE');assert.equal(failure.notSent,true);
   assert.equal(failure.proofCheck.newPageReason,reason);assert.equal(JSON.stringify(failure).includes('private-value'),false);return true;
  });
  assert.equal(f.state.focusCount,1);assert.equal(f.state.calls.filter(Array.isArray).some(([name,args])=>name==='modernJobProofDOM'||['fill','send','openJob'].includes(args.action)),false);
 }
});

test('a matching preexisting job tab cannot substitute for evidence from this click',async()=>{
 const f=newTabFixture({newPages:[],preexisting:[childJobPage({id:'old-job'})]});
 f.state.proofResults=[error('未找到可见弹窗中的公开岗位链接或可核对框架','GREETING_TARGET_UNAVAILABLE')];
 await assert.rejects(f.adapter.prove(job),failure=>failure.code==='GREETING_TARGET_UNAVAILABLE'&&failure.proofCheck.newPageCount===0);
 assert.equal(f.state.focusCount,1);assert.equal(f.state.targets.length,2);
 assert.equal(f.state.calls.filter(Array.isArray).some(([,args])=>['fill','send','close'].includes(args.action)),false);
});

test('returning from a verified child tab must preserve chat identity, anchors, generation and the same new page',async()=>{
 const cases=[
  [f=>{f.state.context.contact='另一 HR';},'GREETING_TARGET_UNAVAILABLE'],
  [f=>{f.state.context.company='另一公司';},'GREETING_TARGET_UNAVAILABLE'],
  [f=>{f.state.context.jobTitle='另一岗位';},'GREETING_TARGET_UNAVAILABLE'],
  [f=>{f.state.context.anchorIds=['different-message'];},'GREETING_TARGET_UNAVAILABLE'],
  [f=>{f.browser.connection.generation++;},'GREETING_TARGET_UNAVAILABLE'],
  [f=>{f.browser.activeTargetId='other-chat';},'GREETING_TARGET_UNAVAILABLE'],
  [f=>{f.state.active=false;},'CANCELLED'],
  [f=>{f.state.targets[0].url='https://www.zhipin.com/web/passport/login';},'AUTH_REQUIRED'],
  [f=>{f.state.targets.pop();},'GREETING_TARGET_UNAVAILABLE'],
  [f=>{f.state.targets[1]=childJobPage({id:'replacement-job'});},'GREETING_TARGET_UNAVAILABLE'],
  [f=>{f.state.targets[1].url='https://www.zhipin.com/job_detail/other-job.html';},'GREETING_TARGET_UNAVAILABLE'],
  [f=>{f.state.targets.push(childJobPage({id:'extra-job'}));},'GREETING_TARGET_UNAVAILABLE']
 ];
 for(const [mutate,code] of cases){const f=newTabFixture();f.state.onFocus=count=>{if(count===2)mutate(f);};
  await assert.rejects(f.adapter.prove(job),{code});assert.equal(f.state.focusCount,2);
  assert.equal(f.state.calls.filter(Array.isArray).some(([name,args])=>name==='modernJobProofDOM'||['fill','send','close'].includes(args.action)),false);
 }
});

test('a child job tab appearing after the initial popup read is accepted only after the same strict new-tab proof',async()=>{
 const f=fixture({timeoutMs:30,pollMs:1});f.state.targets=[chatPage()];let focuses=0;
 f.browser.focusGreetingChat=async options=>{options.guard();focuses++;return {focused:true,targetId:'chat',generation:1};};
 f.state.proofResults=[error('未找到可见弹窗中的公开岗位链接或可核对框架','GREETING_TARGET_UNAVAILABLE')];
 f.state.after=name=>{if(name==='modernJobProofDOM')f.state.targets.push(childJobPage());};
 const proof=await f.adapter.prove(job);assert.equal(proof.jobUrl,job.url);assert.equal(focuses,2);
 assert.equal(f.state.calls.filter(Array.isArray).filter(([name])=>name==='modernJobProofDOM').length,1);
 assert.equal(f.state.calls.filter(Array.isArray).some(([,args])=>['fill','send','close'].includes(args.action)),false);
});

test('proof refusal, ambiguous row, wrong popup URL and close failure never reach fill/send',async()=>{
 const variants=[
  f=>{f.state.selectResults=[error('多个同名同公司 HR','GREETING_TARGET_UNAVAILABLE')];},
  f=>{f.state.proofResults=[error('无公开链接','GREETING_TARGET_UNAVAILABLE')];},
  f=>{f.state.proofResults=[{ok:true,jobUrl:'https://www.zhipin.com/job_detail/another.html'}];},
  f=>{f.state.closed={ok:true,closed:false,jobUrl:job.url};},
  f=>{f.state.closed={ok:true,closeClicked:true,closed:true,jobUrl:'https://www.zhipin.com/job_detail/another.html'};},
  f=>{f.state.settled={ok:true,closed:false,jobUrl:job.url};}
 ];
 for(const mutate of variants){const f=fixture();mutate(f);await assert.rejects(f.adapter.prove(job),{code:'GREETING_TARGET_UNAVAILABLE'});
  assert.equal(f.state.calls.filter(Array.isArray).some(([,args])=>['fill','send'].includes(args.action)),false);}
});

test('wrong title or missing platform anchors after row selection cannot open the popup',async()=>{
 for(const mutate of [s=>{s.context.jobTitle='别的岗位';},s=>{s.context.anchorIds=[];}]){
  const f=fixture();mutate(f.state);await assert.rejects(f.adapter.prove(job),{code:'GREETING_TARGET_UNAVAILABLE'});
  assert.equal(f.state.calls.filter(Array.isArray).some(([,args])=>args.action==='openJob'),false);
 }
});

test('connection generation, active target and actual chat route are pinned before every operation',async()=>{
 for(const mutate of [f=>{f.browser.connection.generation++;},f=>{f.browser.activeTargetId='other';},
  f=>{f.browser.chatTargetId='other';},f=>{f.state.targets=[];},
  f=>{f.state.targets=[{id:'chat',type:'page',url:'https://www.zhipin.com.evil.invalid/web/geek/chat'}];}]){
  const f=fixture(),proof=await f.adapter.prove(job);mutate(f);const count=f.state.calls.length;
  await assert.rejects(f.adapter.action(proof,'fill','专属招呼'),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
  assert.equal(f.state.calls.length,count);
 }
});

test('login, verification, rate limit and CDP failures preserve their typed codes',async()=>{
 for(const code of ['AUTH_REQUIRED','VERIFICATION_REQUIRED','RATE_LIMITED','CDP_ERROR']){
  const f=fixture();f.state.proofResults=[error('测试拒绝',code)];
  await assert.rejects(f.adapter.prove(job),{code});
 }
 const f=fixture();f.state.fail=Object.assign(Error('transport'),{code:'CDP_DISCONNECTED'});
 await assert.rejects(f.adapter.prove(job),{code:'CDP_DISCONNECTED'});
});

test('proof registry rejects forged target/job/labels/expiry and unobserved strengthened anchors',async()=>{
 const f=fixture(),proof=await f.adapter.prove(job);
 for(const mutate of [p=>{p.proofId='invented';},p=>{p.targetId='other';},p=>{p.jobUrl=job.url+'?other=1';},
  p=>{p.expected.company='other';},p=>{p.createdAt--;},p=>{p.expected.anchorIds=['invented-message'];}]){
  const forged=clone(proof);mutate(forged);await assert.rejects(f.adapter.read(forged),{code:'GREETING_TARGET_UNAVAILABLE'});
 }
 f.state.context.anchorIds.push('observed-new');f.state.context.messages.push({remoteId:'observed-new',platformMessageId:true,role:'user',text:'新消息'});
 await f.adapter.read(proof);
 const strengthened={...proof,expected:{...proof.expected,anchorIds:['observed-new']}};
 assert.equal((await f.adapter.action(strengthened,'fill','专属招呼')).filled,true);
});

test('modern DOM send refusals remain definitely unsent; transport failure after send dispatch is uncertain',async()=>{
 const f=fixture(),proof=sending(await f.adapter.prove(job));
 f.state.sendResult=error('身份改变','MODERN_CHAT_IDENTITY_UNAVAILABLE');
 await assert.rejects(f.adapter.action(proof,'send','专属招呼'),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
 f.state.fail=Object.assign(Error('timeout'),{code:'CDP_ERROR',notSent:true});
 await assert.rejects(f.adapter.action(proof,'send','专属招呼'),e=>e.code==='CDP_ERROR'&&!('notSent'in e));
});

test('successful click is one-shot and receipt reads continue after cancellation without allowing another action',async()=>{
 const f=fixture(),proof=sending(await f.adapter.prove(job));
 assert.equal((await f.adapter.action(proof,'send','专属招呼')).clicked,true);
 f.state.active=false;
 f.state.context.anchorIds.push('fresh-receipt');f.state.context.latestTail.signature='tail-with-receipt';
 f.state.context.messages.push({remoteId:'fresh-receipt',platformMessageId:true,role:'assistant',text:'专属招呼',deliveryStatus:'confirmed'});
 assert.equal((await f.adapter.read(proof)).contact,job.hrName);
 await assert.rejects(f.adapter.action(proof,'send','专属招呼'),{code:'GREETING_UNCERTAIN'});
});

test('send requires a latest-tail signature observed by this adapter, not one invented or copied from a different boundary',async()=>{
 const f=fixture(),proof=await f.adapter.prove(job);
 await assert.rejects(f.adapter.action(proof,'send','专属招呼'),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
 const forged=sending(proof);forged.expected.tailSignature='unobserved';
 await assert.rejects(f.adapter.action(forged,'send','专属招呼'),{code:'GREETING_TARGET_UNAVAILABLE'});
 f.state.context.anchorIds.push('new-boundary');f.state.context.latestTail.signature='tail-new-boundary';await f.adapter.read(proof);
 const mixed={...proof,expected:{...proof.expected,anchorIds:['new-boundary'],requireLatestTail:true,tailSignature:'tail-old-1'}};
 await assert.rejects(f.adapter.action(mixed,'send','专属招呼'),{code:'GREETING_TARGET_UNAVAILABLE'});
 mixed.expected.tailSignature='tail-new-boundary';assert.equal((await f.adapter.action(mixed,'send','专属招呼')).clicked,true);
});

test('context switching during popup close invalidates proof; later identity or anchor changes block reads',async()=>{
 const f=fixture();f.state.after=(name,args)=>{if(name==='modernJobProofDOM'&&args.action==='close')f.state.context.contact='另一位 HR';};
 await assert.rejects(f.adapter.prove(job),{code:'GREETING_TARGET_UNAVAILABLE'});
 for(const mutate of [s=>{s.context.company='另一公司';},s=>{s.context.anchorIds=['other'];}]){
  const f=fixture(),proof=await f.adapter.prove(job);mutate(f.state);
  await assert.rejects(f.adapter.read(proof),{code:'GREETING_TARGET_UNAVAILABLE'});
 }
});

function node(tag='div',text='',classes='',children=[]){
 return {tagName:tag.toUpperCase(),innerText:text,children,hidden:false,clicks:0,
  classList:{contains:name=>classes.split(' ').includes(name)},
  getAttribute:()=>null,getBoundingClientRect(){return this.hidden?{width:0,height:0}:{width:100,height:20};},
  querySelectorAll(selector){return this.selectors?.[selector]||[];},click(){this.clicks++;}};
}
function row(contact,company){
 const name=node('span',contact,'name-text'),companyNode=node('span',company),divider=node('i','','vline'),role=node('span','HR');
 const box=node('span','','name-box',[name,companyNode,divider,role]);box.selectors={'.name-text':[name]};
 const card=node('div','','friend-content',[box]);
 const row=node('li');row.card=card;row.selectors={'.name-box':[box],'.friend-content':[card],'.friend-content .name-box .name-text':[name]};return row;
}
function runDOM(fn,document,args){return structuredClone(vm.runInNewContext(`(${fn.toString()})(args)`,{document,args,getComputedStyle:()=>({display:'block',visibility:'visible'})}));}
test('serialized row selector respects company before vline, refuses same company duplicates, ignores hidden rows',()=>{
 const target=row('林 HR','虚构采购公司'),other=row('林 HR','别的公司'),duplicate=row('林 HR','虚构采购公司');
 const list=node();list.selectors={'li[role="listitem"]':[target,other]};
 const document=node();document.selectors={'.user-list-content':[list]};
 assert.equal(runDOM(chooseModernConversationDOM,document,{contact:job.hrName,company:job.company}).found,true);
 assert.equal(target.clicks,0);assert.equal(target.card.clicks,1);assert.equal(other.clicks,0);assert.equal(other.card.clicks,0);
 list.selectors['li[role="listitem"]'].push(duplicate);
 assert.equal(runDOM(chooseModernConversationDOM,document,{contact:job.hrName,company:job.company}).notSent,true);
 assert.equal(target.clicks,0);assert.equal(target.card.clicks,1);duplicate.hidden=true;
 assert.equal(runDOM(chooseModernConversationDOM,document,{contact:job.hrName,company:job.company}).found,true);
});

test('capability reports only layout availability and never clicks or claims job proof',()=>{
 const target=row('林 HR','虚构采购公司'),list=node(),document=node();
 list.selectors={'li[role="listitem"]':[target]};document.selectors={'.user-list-content':[list],'.top-info-content':[]};
 assert.deepEqual(runDOM(modernGreetingCapabilityDOM,document),{available:true,modern:true,requiresJobProof:true});assert.equal(target.clicks,0);
 document.selectors['.top-info-content']=[node()];
 assert.equal(runDOM(modernGreetingCapabilityDOM,document).available,false);
 for(const selector of ['.chat-position-content .position-content[ka="geek_chat_job_detail"]','#chat-input[contenteditable]','button[type="send"].btn-send','.chat-record'])document.selectors[selector]=[node()];
 assert.equal(runDOM(modernGreetingCapabilityDOM,document).available,true);
});

test('selection activates the inner friend-content handler while the outer LI has no selection behavior',()=>{
 const target=row(job.hrName,job.company),list=node(),document=node();let active=false;
 target.card.classList={contains:name=>name==='friend-content'||name==='selected'&&active};
 target.card.click=()=>{target.card.clicks++;active=true;};
 list.selectors={'li[role="listitem"]':[target]};document.selectors={'.user-list-content':[list]};
 let result=runDOM(chooseModernConversationDOM,document,{contact:job.hrName,company:job.company});
 assert.equal(result.found,true);assert.equal(result.clicked,true);assert.equal(result.selectedUnchanged,false);
 assert.equal(active,true);assert.equal(target.clicks,0);assert.equal(target.card.clicks,1);
 result=runDOM(chooseModernConversationDOM,document,{contact:job.hrName,company:job.company});
 assert.equal(result.clicked,false);assert.equal(result.selectedUnchanged,true);assert.equal(target.card.clicks,1);assert.equal(target.clicks,0);
});

test('matching identity still requires one visible inner card before selection',()=>{
 for(const count of [0,2]){
  const target=row(job.hrName,job.company),list=node(),document=node();
  target.selectors['.friend-content']=Array.from({length:count},()=>node('div','','friend-content'));
  list.selectors={'li[role="listitem"]':[target]};document.selectors={'.user-list-content':[list]};
  const result=runDOM(chooseModernConversationDOM,document,{contact:job.hrName,company:job.company});
  assert.equal(result.code,'GREETING_TARGET_UNAVAILABLE');assert.equal(result.notSent,true);assert.equal(target.clicks,0);
  assert.ok(target.selectors['.friend-content'].every(card=>card.clicks===0));
 }
});

test('context failure keeps only safe specific read errors or match flags, never conversation content',async()=>{
 const f=fixture({timeoutMs:0});f.state.context={error:'现代消息页结构不完整或有多个可见会话，未执行操作',code:'MODERN_CHAT_IDENTITY_UNAVAILABLE'};
 await assert.rejects(f.adapter.prove(job),error=>{
  assert.match(error.message,/读取状态：现代消息页结构不完整/);assert.match(error.message,/HR=未知/);
  assert.equal(error.contextCheck.contactMatches,null);assert.equal(error.code,'GREETING_TARGET_UNAVAILABLE');assert.equal(error.notSent,true);return true;
 });
 const g=fixture({timeoutMs:0});g.state.context.jobTitle='private-unmatched-title';g.state.context.messages[0].text='private-message-body';g.state.context.anchorIds=[];
 await assert.rejects(g.adapter.prove(job),error=>{
  assert.match(error.message,/HR=一致，公司=一致，岗位=不匹配，消息锚点=缺失/);
  assert.equal(error.contextCheck.jobTitleMatches,false);assert.equal(error.contextCheck.hasAnchors,false);
  assert.equal(JSON.stringify(error).includes('private-'),false);assert.equal(error.message.includes('private-'),false);return true;
 });
 const h=fixture({timeoutMs:0});h.state.context={error:'private-untrusted-DOM-text',code:'MODERN_CHAT_IDENTITY_UNAVAILABLE'};
 await assert.rejects(h.adapter.prove(job),error=>!error.message.includes('private-')&&error.contextCheck.readError==='会话结构暂不可读，未取得可靠上下文');
 for(const current of [f,g,h])assert.equal(current.state.calls.filter(Array.isArray).some(([,args])=>['openJob','fill','send'].includes(args.action)),false);
});

test('popup proof failure preserves only allowlisted specific reasons and never exposes raw DOM content',async()=>{
 for(const reason of ['未找到可见弹窗中的公开岗位链接或可核对框架','岗位框架中的完整岗位编号与目标岗位不一致或不唯一',
  '存在多个可见岗位框架，无法唯一核对当前岗位','private-query-token-and-message']){
  const f=fixture({timeoutMs:0});f.state.proofResults=[error(reason,'GREETING_TARGET_UNAVAILABLE')];
  await assert.rejects(f.adapter.prove(job),failure=>{
   assert.equal(failure.code,'GREETING_TARGET_UNAVAILABLE');assert.equal(failure.notSent,true);assert.equal(failure.proofCheck.attempts,1);
   assert.equal(failure.proofCheck.urlMatches,null);
   if(reason.startsWith('private-')){assert.equal(failure.message.includes(reason),false);assert.equal(JSON.stringify(failure.proofCheck).includes(reason),false);}
   else{assert.ok(failure.message.includes(reason));assert.equal(failure.proofCheck.readError,reason);}return true;
  });
  assert.equal(f.state.calls.filter(Array.isArray).some(([,args])=>['fill','send','close'].includes(args.action)),false);
 }
 const f=fixture({timeoutMs:0});f.state.proofResults=[{ok:true,jobUrl:'https://www.zhipin.com/job_detail/other.html?private=secret'}];
 await assert.rejects(f.adapter.prove(job),failure=>failure.proofCheck.urlMatches===false&&!failure.message.includes('private')&&!JSON.stringify(failure.proofCheck).includes('other.html'));
});

function lookupFixture(lookupTimeoutMs=40){
 let time=0;const waits=[];
 const f=fixture({timeoutMs:30,pollMs:10,lookupTimeoutMs,lookupNow:()=>time,lookupWait:async ms=>{waits.push(ms);time+=ms;f.state.onWait?.();}});
 return {...f,waits,now:()=>time};
}
const missing={ok:true,found:false,diagnostics:{rows:6,parsedRows:6,nameMatches:0,companyMatches:0,exactMatches:0}};
const noMessageActions=f=>assert.equal(f.state.calls.filter(Array.isArray).some(([,args])=>['fill','send'].includes(args.action)),false);

test('an old nonempty complete list waits for the newly contacted row to synchronize',async()=>{
 const f=lookupFixture();f.state.progress={complete:true,moved:false,changed:false};
 f.state.choose=()=>f.now()>=20?{ok:true,found:true}:missing;
 const proof=await f.adapter.prove(job);
 assert.equal(proof.jobUrl,job.url);assert.equal(f.state.pages,1);assert.equal(f.state.resets,2);
 assert.deepEqual(f.waits,[10,10]);assert.equal(f.state.calls.filter(Array.isArray).filter(([name])=>name==='chooseModernConversationDOM').length,4);
 noMessageActions(f);
});

test('new top-inserted row is rechecked after all thirty initially visible screens',async()=>{
 const f=lookupFixture();f.state.choose=()=>f.state.resets>=2?{ok:true,found:true}:missing;
 const proof=await f.adapter.prove(job);
 assert.equal(proof.jobUrl,job.url);assert.equal(f.state.pages,29);assert.equal(f.state.resets,2);
 assert.equal(f.state.calls.filter(Array.isArray).filter(([name])=>name==='chooseModernConversationDOM').length,31);
 assert.deepEqual(f.waits,[]);noMessageActions(f);
});

test('final top reset finds a row inserted at the synchronization deadline despite a retained virtual-list anchor',async()=>{
 const f=lookupFixture();f.state.progress={complete:true,moved:false,changed:false};
 f.state.choose=()=>f.state.resets>=3&&f.now()===40?{ok:true,found:true}:missing;
 assert.equal((await f.adapter.prove(job)).jobUrl,job.url);assert.equal(f.state.resets,3);assert.equal(f.now(),40);
 assert.deepEqual(f.waits,[10,10,10,10]);noMessageActions(f);
});

test('missing target remains bounded and reports only structural lookup counts without reaching proof or send',async()=>{
 const f=lookupFixture();f.state.progress={complete:true,moved:false,changed:false};f.state.choose=()=>missing;
 await assert.rejects(f.adapter.prove(job),error=>{
  assert.equal(error.code,'GREETING_TARGET_UNAVAILABLE');assert.equal(error.notSent,true);
  assert.equal(error.lookup.stopReason,'sync_timeout');assert.equal(error.lookup.initialStopReason,'complete');
  assert.equal(error.lookup.resets,3);assert.equal(error.lookup.rows,6);assert.equal(error.lookup.parsedRows,6);
  assert.equal(error.lookup.nameMatches,0);assert.equal(error.lookup.companyMatches,0);assert.equal(error.lookup.exactMatches,0);
  assert.ok(error.lookup.pages<=7);assert.match(error.message,/已检查 \d+ 屏，回顶 3 次/);
  assert.equal(JSON.stringify(error.lookup).includes(job.hrName),false);assert.equal(JSON.stringify(error.lookup).includes(job.company),false);return true;
 });
 assert.equal(f.now(),40);assert.equal(f.state.calls.filter(Array.isArray).some(([name])=>name==='modernChatDOM'||name==='modernJobProofDOM'),false);
 noMessageActions(f);
});

test('stalled lookup gets a final top rescan even when the synchronization wait is disabled',async()=>{
 const f=lookupFixture(0);f.state.progress={complete:false,moved:false,changed:false};f.state.choose=()=>missing;
 await assert.rejects(f.adapter.prove(job),error=>error.lookup.initialStopReason==='stalled'&&error.lookup.stopReason==='sync_timeout'&&error.lookup.pages===4);
 assert.equal(f.state.pages,3);assert.equal(f.state.resets,2);assert.deepEqual(f.waits,[]);noMessageActions(f);
});

test('cancellation during synchronization stops before another lookup, popup or message action',async()=>{
 const f=lookupFixture();f.state.progress={complete:true,moved:false,changed:false};f.state.choose=()=>missing;
 f.state.onWait=()=>{f.state.active=false;};
 await assert.rejects(f.adapter.prove(job),{code:'CANCELLED',notSent:true});
 assert.equal(f.state.calls.filter(Array.isArray).filter(([name])=>name==='chooseModernConversationDOM').length,2);
 assert.equal(f.state.resets,2);assert.deepEqual(f.waits,[10]);noMessageActions(f);
});

test('exact HR/company mismatches produce counts but never select an approximate recipient',async()=>{
 for(const [contact,company,counts] of [[job.hrName,'另一公司',[1,0]],['另一 HR',job.company,[0,1]]]){
  const target=row(contact,company),list=node(),document=node();list.selectors={'li[role="listitem"]':[target]};document.selectors={'.user-list-content':[list]};
  const f=lookupFixture(0);f.state.progress={complete:true,moved:false,changed:false};
  f.state.choose=()=>runDOM(chooseModernConversationDOM,document,{contact:job.hrName,company:job.company});
  await assert.rejects(f.adapter.prove(job),error=>{
   assert.equal(error.lookup.nameMatches,counts[0]);assert.equal(error.lookup.companyMatches,counts[1]);assert.equal(error.lookup.exactMatches,0);
   assert.match(error.message,counts[0]?/公司未精确匹配/:/HR 未精确匹配/);return true;
  });
  assert.equal(target.clicks,0);noMessageActions(f);
 }
});

test('one guarded refresh after exhausted synchronization restarts lookup and still requires full job proof',async()=>{
 const f=lookupFixture(20);f.state.progress={complete:true,moved:false,changed:false};let refreshes=0;
 f.state.choose=()=>refreshes?{ok:true,found:true}:missing;
 f.browser.refreshGreetingChat=async options=>{
  assert.equal(options.targetId,'chat');assert.equal(options.generation,1);assert.equal(options.lookupFailed,true);options.guard();
  assert.equal(f.now(),20);assert.equal(f.state.resets,3);assert.equal(f.state.calls.filter(Array.isArray).some(([name])=>name==='modernChatDOM'),false);
  refreshes++;return {refreshed:true,targetId:'chat',generation:1};
 };
 const proof=await f.adapter.prove(job);assert.equal(proof.jobUrl,job.url);assert.equal(refreshes,1);assert.equal(f.state.resets,4);
 assert.ok(f.state.calls.some(call=>Array.isArray(call)&&call[0]==='modernJobProofDOM'&&call[1].expectedJobUrl===job.url));noMessageActions(f);
});

test('a permanently missing target refreshes at most once and returns bounded no-match diagnostics',async()=>{
 const f=lookupFixture(20);f.state.progress={complete:true,moved:false,changed:false};f.state.choose=()=>missing;let refreshes=0;
 f.browser.refreshGreetingChat=async()=>{refreshes++;return {refreshed:true,targetId:'chat',generation:1};};
 await assert.rejects(f.adapter.prove(job),error=>error.code==='GREETING_TARGET_UNAVAILABLE'&&error.notSent===true&&
  error.lookup.stopReason==='sync_timeout'&&error.lookup.refreshedStopReason==='complete'&&error.lookup.refreshAttempts===1&&error.lookup.refreshes===1);
 assert.equal(refreshes,1);assert.equal(f.now(),40);assert.equal(f.state.resets,6);noMessageActions(f);
});

test('refresh refusal for human draft, cancellation, login or transport preserves its code without another attempt',async()=>{
 for(const code of ['GREETING_TARGET_UNAVAILABLE','CANCELLED','AUTH_REQUIRED','VERIFICATION_REQUIRED','RATE_LIMITED','CDP_DISCONNECTED']){
  const f=lookupFixture(0);f.state.progress={complete:true,moved:false,changed:false};f.state.choose=()=>missing;let attempts=0;
  f.browser.refreshGreetingChat=async()=>{attempts++;throw Object.assign(Error(code==='GREETING_TARGET_UNAVAILABLE'?'存在人工草稿，不刷新':'fixture refusal'),{code,notSent:true});};
  await assert.rejects(f.adapter.prove(job),error=>error.code===code&&error.notSent===true&&error.lookup.refreshAttempts===1&&error.lookup.stopReason==='refresh_failed');
  assert.equal(attempts,1);assert.equal(f.state.resets,2);noMessageActions(f);
 }
});

test('unconfirmed refresh or changed target/generation cannot advance into another lookup or message action',async()=>{
 for(const result of [{refreshed:false,targetId:'chat',generation:1},{refreshed:true,targetId:'other',generation:1},
  {refreshed:true,targetId:'chat',generation:2},undefined]){
  const f=lookupFixture(0);f.state.progress={complete:true,moved:false,changed:false};f.state.choose=()=>missing;
  f.browser.refreshGreetingChat=async()=>result;
  await assert.rejects(f.adapter.prove(job),{code:'GREETING_TARGET_UNAVAILABLE'});assert.equal(f.state.resets,2);noMessageActions(f);
 }
});

test('an already located recipient never triggers the refresh recovery path',async()=>{
 const f=lookupFixture();f.browser.refreshGreetingChat=async()=>assert.fail('refresh is allowed only after a lookup miss');
 await f.adapter.prove(job);assert.equal(f.state.resets,1);noMessageActions(f);
});

test('human draft refusal blocks even the first recipient selection without a refresh',async()=>{
 const f=lookupFixture();let checks=0;
 f.browser.assertGreetingChatIdle=async options=>{
  assert.equal(options.targetId,'chat');assert.equal(options.generation,1);options.guard();checks++;
  throw Object.assign(Error('当前输入框存在人工草稿，未切换会话'),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
 };
 f.browser.refreshGreetingChat=async()=>assert.fail('draft refusal must not trigger refresh');
 await assert.rejects(f.adapter.prove(job),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});assert.equal(checks,1);
 assert.equal(f.state.calls.filter(Array.isArray).some(([name])=>name==='chooseModernConversationDOM'),false);noMessageActions(f);
});

test('idle state is rechecked after synchronization waits before a newly appearing row can be selected',async()=>{
 const f=lookupFixture();f.state.progress={complete:true,moved:false,changed:false};f.state.choose=()=>f.now()>0?{ok:true,found:true}:missing;
 f.browser.assertGreetingChatIdle=async()=>{
  if(f.now()>0)throw Object.assign(Error('用户刚输入草稿，未切换会话'),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
  return {idle:true,targetId:'chat',generation:1};
 };
 f.browser.refreshGreetingChat=async()=>assert.fail('draft refusal must not trigger refresh');
 await assert.rejects(f.adapter.prove(job),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
 assert.equal(f.state.calls.filter(Array.isArray).filter(([name])=>name==='chooseModernConversationDOM').length,2);noMessageActions(f);
});

test('an idle probe must confirm the pinned target and generation',async()=>{
 for(const result of [{idle:false,targetId:'chat',generation:1},{idle:true,targetId:'other',generation:1},{idle:true,targetId:'chat',generation:2}]){
  const f=lookupFixture();f.browser.assertGreetingChatIdle=async()=>result;
  await assert.rejects(f.adapter.prove(job),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
  assert.equal(f.state.calls.filter(Array.isArray).some(([name])=>name==='chooseModernConversationDOM'),false);noMessageActions(f);
 }
});
