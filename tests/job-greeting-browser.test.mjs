import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {Browser, conversationListDOM} from '../lib/browser.mjs';
import {jobUrlKey, jobConversationMatch, greetingTargetUnavailable} from '../lib/job-greeting-browser.mjs';
import {assertActive} from '../lib/conversation.mjs';

const job = {url:'https://www.zhipin.com/job_detail/fixture.html',title:'采购经理',company:'虚构甲公司'};
const desired = {id:'wanted',remoteId:'wanted',contact:'王 HR',company:job.company,jobTitle:job.title,jobUrl:job.url,messages:[]};
const unrelated = {id:'other',remoteId:'other',contact:'李 HR',company:'虚构乙公司',jobTitle:'销售',jobUrl:'https://www.zhipin.com/job_detail/other.html',messages:[]};
const clone = value => structuredClone(value);

function fixture(pages = [[desired]]) {
  const browser = new Browser('unused-fixture-directory');
  let current = clone(unrelated), index = 0, active = true, attempts = 0, clicks = 0;
  const events = [];
  browser.chatTargetId = 'old-chat'; browser.activeTargetId = 'job-detail';
  browser.openChat = async () => { events.push('open'); browser.chatTargetId = 'pinned-chat'; browser.activeTargetId = 'pinned-chat'; };
  browser.resetConversations = async () => { index = 0; };
  browser.listConversations = async () => clone(pages[index]);
  browser.scrollConversations = async () => index + 1 < pages.length ? (++index, true) : false;
  browser.selectConversation = async conversation => { events.push('select:' + conversation.id); current = clone(conversation); current.messages ||= []; };
  browser.targets = async () => [{id:'old-chat',type:'page',url:'https://www.zhipin.com/web/geek/chat'}, {id:'pinned-chat',type:'page',url:'https://www.zhipin.com/web/geek/chat'}];
  browser.evaluate = async () => assert.fail('Pinned operations must not use the implicit active target');
  browser.evaluateOn = async (target, fn, args) => {
    assert.equal(target.id, 'pinned-chat');
    if (!args?.action) return clone(current);
    events.push(args.action);
    if (args.expected.remoteId !== current.remoteId) return {error:'当前会话已切换，未执行发送'};
    if (args.action === 'fill') return {ok:true};
    if (args.action === 'send') {
      clicks++;
      current.messages.push({remoteId:'fixture-receipt-' + clicks,role:'assistant',text:args.text,deliveryStatus:'confirmed'});
      return {ok:true};
    }
    assert.fail('Unexpected action');
  };
  return {browser, events, options:{guard:()=>assertActive(()=>active),onAttempt:()=>attempts++},
    stop:()=>{active=false;}, setCurrent:value=>{current=clone(value);},
    get attempts(){return attempts;},get clicks(){return clicks;}};
}

test('job identity requires the real job URL or exact title and company; contradictory URLs and HRs block', () => {
  assert.equal(jobUrlKey(job.url+'?tracking=1#section'),'/job_detail/fixture.html');
  assert.equal(jobConversationMatch(job,{...desired,jobUrl:'https://zhipin.com/job_detail/fixture.html?x=1'}),'url');
  assert.equal(jobConversationMatch(job,{...desired,jobUrl:''}),'identity');
  for (const changed of [{jobUrl:unrelated.jobUrl},{jobUrl:'https://zhipin.com.example.org/job_detail/fixture.html'},{company:'虚构乙公司'},{jobTitle:'销售'}])
    assert.equal(jobConversationMatch(job,{...desired,...changed}),'');
  assert.equal(jobConversationMatch({...job,hrName:'另一 HR'},desired),'');
  assert.equal(jobConversationMatch({...job,url:'',company:''},{...desired,jobUrl:''}),'');
});

test('a greeting selects the job conversation, pins its tab, and returns the fresh receipt', async () => {
  const f=fixture([[unrelated,desired]]);
  const result=await f.browser.sendJobGreeting(job,'您好，我有相关采购经验。',f.options);
  assert.equal(result.verified,true); assert.equal(result.conversation.id,desired.id);
  assert.equal(result.receiptId,'fixture-receipt-1');
  assert.equal(result.conversation.messages.at(-1).text,'您好，我有相关采购经验。');
  assert.deepEqual(f.events,['open','select:wanted','fill','send']);
  assert.equal(f.attempts,1);assert.equal(f.clicks,1);
});

const priorOpening=(patch={})=>({role:'assistant',kind:'text',text:'平台原有开场',remoteId:'platform-opening-1',platformMessageId:true,deliveryStatus:'confirmed',...patch});
const fullJob={...job,hrName:desired.contact};

test('legacy prior confirmed opening returns an observed skip without filling, attempting or sending',async()=>{
 const current={...desired,messages:[priorOpening()]},f=fixture([[current]]);
 const result=await f.browser.sendJobGreeting(fullJob,'另一段专属开场',f.options);
 assert.equal(result.verified,false);assert.equal(result.code,'GREETING_ALREADY_PRESENT');assert.equal(result.notSent,true);assert.equal(result.alreadyGreeted,true);
 assert.equal(result.receiptId,'platform-opening-1');assert.equal(result.conversation.legacyProofVerified,true);assert.equal(result.conversation.jobUrl,job.url);
 assert.equal(f.attempts,0);assert.equal(f.clicks,0);assert.deepEqual(f.events,['open','select:wanted']);
});

test('legacy synthetic message IDs, unconfirmed delivery or incomplete job evidence never authorize another opening',async()=>{
 const variants=[
  {message:priorOpening({platformMessageId:false})},{message:priorOpening({remoteId:''})},
  ...['unknown','pending','failed'].map(deliveryStatus=>({message:priorOpening({deliveryStatus})})),
  {message:priorOpening(),missingUrl:true},{message:priorOpening(),missingHR:true}
 ];
 for(const variant of variants){const current={...desired,...variant.missingUrl?{jobUrl:''}:{},messages:[variant.message]},f=fixture([[current]]);
  const result=await f.browser.sendJobGreeting(variant.missingHR?job:fullJob,'专属正文',f.options);
  assert.equal(result.code,'GREETING_PRESENCE_UNCERTAIN');assert.equal(result.presenceUnknown,true);assert.equal(result.notSent,true);
  assert.equal(result.receiptId,undefined);assert.equal(result.conversation.legacyProofVerified,undefined);
  assert.equal(f.attempts,0);assert.equal(f.clicks,0);assert.equal(f.events.includes('fill'),false);
 }
});

test('legacy fill and send atomically return a late opening result before the click while preserving the attempt boundary',async()=>{
 for(const phase of ['fill','send'])for(const trusted of [true,false]){
  const f=fixture(),evaluate=f.browser.evaluateOn,current={...desired,messages:[priorOpening({platformMessageId:trusted})]};
  f.browser.evaluateOn=async(target,fn,args)=>{
   if(args?.action===phase){
    assert.equal(args.expected.noExistingOpening,true);
    return {error:'已有开场',notSent:true,conversation:clone(current),
      ...trusted?{code:'GREETING_ALREADY_PRESENT',alreadyGreeted:true,receiptId:'platform-opening-1'}:
       {code:'GREETING_PRESENCE_UNCERTAIN',presenceUnknown:true}};
   }
   return evaluate(target,fn,args);
  };
  const result=await f.browser.sendJobGreeting(fullJob,'专属正文',f.options);
  assert.equal(result.code,trusted?'GREETING_ALREADY_PRESENT':'GREETING_PRESENCE_UNCERTAIN');assert.equal(result.notSent,true);
  assert.equal(result.conversation.legacyProofVerified,trusted?true:undefined);
  assert.equal(f.attempts,phase==='send'?1:0);assert.equal(f.clicks,0);assert.equal(f.events.includes('send'),false);
 }
});

test('a claimed legacy opening cannot override a recipient change or manufacture a trusted receipt',async()=>{
 for(const changed of ['recipient','receipt']){
  const f=fixture(),evaluate=f.browser.evaluateOn;
  f.browser.evaluateOn=async(target,fn,args)=>args?.action==='fill'?{error:'已有开场',notSent:true,code:'GREETING_ALREADY_PRESENT',alreadyGreeted:true,
   receiptId:'platform-opening-1',conversation:{...(changed==='recipient'?unrelated:desired),messages:[priorOpening({remoteId:changed==='receipt'?'different-platform-id':'platform-opening-1'})]}}:evaluate(target,fn,args);
  if(changed==='recipient')await assert.rejects(f.browser.sendJobGreeting(fullJob,'专属正文',f.options));
  else assert.equal((await f.browser.sendJobGreeting(fullJob,'专属正文',f.options)).code,'GREETING_PRESENCE_UNCERTAIN');
  assert.equal(f.attempts,0);assert.equal(f.clicks,0);
 }
});

test('legacy ordinary replies remain available when a conversation already has an opening',async()=>{
 const f=fixture();await f.browser.openChat();f.setCurrent({...desired,messages:[priorOpening()]});
 assert.equal(await f.browser.sendChat(desired,'答复 HR 的问题',{...f.options,targetId:'pinned-chat'}),true);
 assert.equal(f.attempts,1);assert.equal(f.clicks,1);
});

test('unique display identity requires a complete list scan and reselects the offscreen row',async()=>{
  const noUrl={...desired,jobUrl:''},f=fixture([[noUrl],[unrelated]]);
  const result=await f.browser.sendJobGreeting(job,'虚构岗位招呼',f.options);
  assert.equal(result.verified,true);assert.ok(f.events.includes('select:wanted'));assert.equal(f.clicks,1);
});

for(const [label,pages] of [
  ['duplicate exact URLs',[[desired,{...desired,id:'second',remoteId:'second',contact:'赵 HR'}]]],
  ['ambiguous labels across pages',[[{...desired,jobUrl:''}],[{...desired,id:'second',remoteId:'second',contact:'赵 HR',jobUrl:''}]]],
  ['no matching job',[[unrelated]]]
])test(label+' never selects or sends',async()=>{
  const f=fixture(pages);
  await assert.rejects(f.browser.sendJobGreeting(job,'虚构招呼',f.options),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
  assert.equal(f.attempts,0);assert.equal(f.clicks,0);assert.ok(!f.events.some(event=>event.startsWith('select:')));
});

test('a changed recipient after selection is rejected before filling',async()=>{
  const f=fixture();f.browser.selectConversation=async()=>f.setCurrent(unrelated);
  await assert.rejects(f.browser.sendJobGreeting(job,'虚构招呼',f.options),error=>error.notSent===true);
  assert.equal(f.attempts,0);assert.equal(f.clicks,0);assert.ok(!f.events.includes('fill'));
});

test('stopping before entry does not even open a chat',async()=>{
  const f=fixture();f.stop();
  await assert.rejects(f.browser.sendJobGreeting(job,'虚构招呼',f.options),{code:'CANCELLED',notSent:true});
  assert.deepEqual(f.events,[]);assert.equal(f.attempts,0);
});

test('stopping after selection or filling never reaches the send attempt',async()=>{
  for(const phase of ['selection','fill']){
    const f=fixture();
    if(phase==='selection'){const original=f.browser.selectConversation;f.browser.selectConversation=async c=>{await original(c);f.stop();};}
    else{const original=f.browser.evaluateOn;f.browser.evaluateOn=async(...args)=>{const result=await original(...args);if(args[2]?.action==='fill')f.stop();return result;};}
    await assert.rejects(f.browser.sendJobGreeting(job,'虚构招呼',f.options),{code:'CANCELLED',notSent:true});
    assert.equal(f.attempts,0);assert.equal(f.clicks,0);
  }
});

test('live DOM identity refusal remains notSent even after the attempt callback',async()=>{
  const f=fixture(),original=f.browser.evaluateOn;
  f.browser.evaluateOn=async(...args)=>{const result=await original(...args);if(args[2]?.action==='fill')f.setCurrent(unrelated);return result;};
  await assert.rejects(f.browser.sendJobGreeting(job,'虚构招呼',f.options),error=>error.notSent===true);
  assert.equal(f.attempts,1);assert.equal(f.clicks,0);
});

test('unknown transport failure after the attempt is uncertain, never labelled notSent',async()=>{
  const f=fixture(),original=f.browser.evaluateOn;
  f.browser.evaluateOn=async(...args)=>{if(args[2]?.action==='send')throw Error('unknown transport failure');return original(...args);};
  await assert.rejects(f.browser.sendJobGreeting(job,'虚构招呼',f.options),error=>error.notSent!==true);
  assert.equal(f.attempts,1);
});

test('a recipient change after clicking remains uncertain',async()=>{
  const f=fixture(),original=f.browser.evaluateOn;
  f.browser.evaluateOn=async(...args)=>{const result=await original(...args);if(args[2]?.action==='send')f.setCurrent(unrelated);return result;};
  await assert.rejects(f.browser.sendJobGreeting(job,'虚构招呼',f.options),error=>error.notSent!==true);
  assert.equal(f.attempts,1);assert.equal(f.clicks,1);
});

test('failure to persist the attempt callback prevents the click and remains notSent',async()=>{
  const f=fixture();
  await assert.rejects(f.browser.sendJobGreeting(job,'虚构招呼',{...f.options,onAttempt:()=>{throw Error('fixture storage failure');}}),error=>error.notSent===true);
  assert.equal(f.clicks,0);
});

test('explicit readChat target does not follow a stale chatTargetId',async()=>{
  const f=fixture();f.browser.chatTargetId='old-chat';
  assert.equal((await f.browser.readChat({targetId:'pinned-chat'})).id,unrelated.id);
  assert.equal(f.browser.chatTargetId,'old-chat');
});

test('communicate guard blocks before navigation and after preflight without a click',async()=>{
  const b=new Browser('unused-fixture-directory');let active=false,evaluations=0;
  b.navigate=async()=>assert.fail('Stopped operation navigated');
  await assert.rejects(b.communicate(job,{guard:()=>assertActive(()=>active)}),{code:'CANCELLED',notSent:true});
  active=true;b.navigate=async()=>{b.activeTargetId='fixed-job';};b.targets=async()=>[{id:'fixed-job',type:'page',url:job.url}];
  b.command=async(_method,_params,target,{guard})=>{assert.equal(target.id,'fixed-job');guard();evaluations++;active=false;return {result:{value:'ready'}};};
  await assert.rejects(b.communicate(job,{guard:()=>assertActive(()=>active)}),{code:'CANCELLED',notSent:true});
  assert.equal(evaluations,1);
});

test('communicate does not mark an unknown click transport error as notSent',async()=>{
  const b=new Browser('unused-fixture-directory');b.navigate=async()=>{b.activeTargetId='fixed-job';};let calls=0;
  b.targets=async()=>[{id:'fixed-job',type:'page',url:job.url}];
  b.command=async(_method,_params,target,{guard})=>{assert.equal(target.id,'fixed-job');guard();if(++calls===1)return {result:{value:'ready'}};throw Error('unknown click transport failure');};
  await assert.rejects(b.communicate(job),error=>error.notSent!==true);
});

test('real Browser.readHistory initializes its identity and returns deduplicated history',async()=>{
  const b=new Browser('unused-fixture-directory');let reads=0,scrolls=0;
  const latest={remoteId:'newer',role:'user',text:'虚构新消息'};
  const older={remoteId:'older',role:'assistant',text:'虚构历史消息'};
  b.readChat=async()=>({...clone(desired),messages:++reads===1?[latest]:[older,latest]});
  b.evaluate=async()=>{scrolls++;};
  const history=await b.readHistory();
  assert.equal(history.historyComplete,true);
  assert.equal(history.remoteId,desired.remoteId);
  assert.deepEqual(history.messages.map(m=>[m.remoteId,m.sequence]),[['older',0],['newer',1]]);
  assert.equal(scrolls,4);
});

test('real Browser.readHistory still rejects a recipient change during history loading',async()=>{
  const b=new Browser('unused-fixture-directory');let reads=0;
  b.readChat=async()=>clone(++reads===1?desired:unrelated);
  b.evaluate=async()=>{};
  await assert.rejects(b.readHistory(),/身份不一致/);
  assert.equal(reads,2);
});

function listDOMFixture({modern=true,remoteId='',route='/web/geek/chat',dialogs=[],rootAvailable=true,readyState='complete',busy=false,lastText=''}={}) {
  const name={innerText:'王 HR',classList:{contains:cls=>cls==='name-text'}};
  const company={innerText:'虚构甲公司',classList:{contains:()=>false}};
  const nameBox={querySelector:selector=>selector==='.name-text'?name:null,querySelectorAll:()=>[name,company]};
  const row={innerText:'王 HR\n虚构甲公司',getBoundingClientRect:()=>({height:50}),getAttribute:key=>key==='data-uid'?remoteId:null,
    querySelector:selector=>selector==='.friend-content .name-box,.name-box'?nameBox:selector==='.friend-content .name-box .name-text'?name:selector==='.name,.user-name,.nickname'?name:selector==='.last-msg,.message,.msg'?{innerText:lastText}:null};
  const scroller={scrollTop:0,scrollHeight:8232,clientHeight:746,dispatchEvent:()=>{}};
  const root={scrollTop:0,scrollHeight:50000,clientHeight:800,parentElement:null,
    getAttribute:key=>key==='aria-busy'&&busy?'true':null,querySelector:selector=>selector===':scope > .user-list-content'&&modern?scroller:null,
    querySelectorAll:selector=>selector.includes('li')?[row]:[]};
  const body={};Object.defineProperty(body,'innerText',{get(){throw Error('Must not classify errors using chat message text');}});
  const document={querySelector:()=>rootAvailable?root:null,body,documentElement:{},readyState,
    querySelectorAll:()=>dialogs.map(dialog=>({innerText:dialog.text,getBoundingClientRect:()=>({height:dialog.visible===false?0:100})}))};
  return {root,scroller,run:options=>vm.runInNewContext(`(${conversationListDOM.toString()})(options)`,{document,location:{pathname:route},options,Event:class{},getComputedStyle:()=>({overflowY:'auto'})})};
}

test('modern conversation rows expose names and companies but missing platform IDs block greeting lookup immediately',async()=>{
  const dom=listDOMFixture(),f=fixture();let scrolls=0,reads=0;
  const originalEvaluateOn=f.browser.evaluateOn;
  f.browser.evaluate=async(fn,options)=>{assert.equal(fn,conversationListDOM);reads++;return dom.run(options);};
  f.browser.evaluateOn=async(target,fn,options)=>{if(fn!==conversationListDOM)return originalEvaluateOn(target,fn,options);assert.equal(target.id,'pinned-chat');reads++;return dom.run(options);};
  f.browser.listConversations=Browser.prototype.listConversations;
  f.browser.scrollConversations=async()=>{scrolls++;return true;};
  const rows=await f.browser.listConversations({targetId:'pinned-chat'});
  assert.equal(rows[0].contact,'王 HR');assert.equal(rows[0].company,'虚构甲公司');assert.equal(rows[0].remoteId,'');
  await assert.rejects(f.browser.sendJobGreeting(job,'虚构招呼',f.options),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
  assert.equal(reads,2);assert.equal(scrolls,0);assert.equal(f.attempts,0);assert.equal(f.clicks,0);
});

test('modern layout without IDs is distinguished from legacy rows and modern rows with real IDs',async()=>{
  for(const options of [{modern:false},{modern:true,remoteId:'platform-fixture'}]){
    const dom=listDOMFixture(options),b=new Browser('unused-fixture-directory');
    b.openChat=async()=>{};b.evaluate=async(fn,args)=>dom.run(args);
    assert.equal((await b.listConversations({forGreeting:true})).length,1);
  }
});

test('conversation scrolling uses the evidenced user-list-content viewport, not the padded list or page',()=>{
  const dom=listDOMFixture();
  const result=dom.run({mode:'scroll'});
  assert.equal(result.before.top,0);assert.equal(dom.scroller.scrollTop,746*.8);
  assert.equal(dom.root.scrollTop,0);
  dom.run({mode:'reset'});assert.equal(dom.scroller.scrollTop,0);
});

test('repeated conversation batches stop early and never prove unique recipient identity',async()=>{
  const f=fixture([[{...desired,jobUrl:''}]]);let reads=0,scrolls=0;
  f.browser.listConversations=async()=>{reads++;return [{...desired,jobUrl:''}];};
  f.browser.scrollConversations=async()=>{scrolls++;return {complete:false,moved:true,changed:false};};
  await assert.rejects(f.browser.sendJobGreeting(job,'虚构招呼',f.options),error=>error.code==='GREETING_TARGET_UNAVAILABLE'&&error.notSent&&/停滞/.test(error.message));
  assert.equal(reads,4);assert.equal(scrolls,3);assert.equal(f.attempts,0);assert.equal(f.clicks,0);
});

test('unavailable scroll position is a recipient lookup failure, never an exhausted list',async()=>{
  const f=fixture([[{...desired,jobUrl:''}]]);
  f.browser.scrollConversations=async()=>({unavailable:true});
  await assert.rejects(f.browser.sendJobGreeting(job,'虚构招呼',f.options),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
  assert.equal(f.attempts,0);
});

test('scroll completion requires a settled bottom; growth and bounce remain incomplete',async()=>{
  const bottom={top:100,height:200,viewport:100,atBottom:true,loading:false,signature:'["one"]'};
  for(const [before,after,settled,complete] of [
    [bottom,bottom,bottom,true],
    [bottom,bottom,{...bottom,height:300,atBottom:false},false],
    [{...bottom,top:0,atBottom:false},bottom,{...bottom,top:0,atBottom:false},false],
    [bottom,bottom,{...bottom,signature:'["two"]'},false]
  ]){
    const b=new Browser('unused-fixture-directory');
    b.evaluate=async(fn,{mode})=>mode==='read'?{conversations:[clone(desired)],loading:false}:mode==='scroll'?{before,after}:settled;
    assert.equal((await b.scrollConversations({progress:true})).complete,complete);
  }
});

test('all coded failures preserve their original classification and cannot be softened into lookup failure',async()=>{
  for(const code of ['CANCELLED','AUTH','AUTH_REQUIRED','VERIFICATION','VERIFICATION_REQUIRED','RATE_LIMIT','RATE_LIMITED','CDP_ERROR','FUTURE_HARD_STOP']){
    const error=Object.assign(Error('当前会话身份不一致'),{code});
    assert.equal(greetingTargetUnavailable('lookup failed',error),error);
    const f=fixture();f.browser.listConversations=async()=>{throw error;};
    await assert.rejects(f.browser.sendJobGreeting(job,'虚构招呼',f.options),value=>value===error&&value.code===code);
    assert.equal(f.attempts,0);
    const b=new Browser('unused-fixture-directory');b.evaluate=async()=>({error:'当前会话身份不一致',code});
    await assert.rejects(b.chatAction(desired,'fill','虚构招呼',{forGreeting:true}),value=>value.code===code);
  }
});

function waitingFixture(snapshot) {
  const browser=new Browser('unused-fixture-directory');let reads=0;
  const pinned={id:'pinned-chat',type:'page',url:'https://www.zhipin.com/web/geek/chat'};
  browser.activeTargetId='other-chat';browser.chatTargetId='old-chat';
  browser.targets=async()=>[pinned,{id:'other-chat',type:'page',url:pinned.url}];
  browser.evaluate=async()=>assert.fail('Readiness must not inspect the implicit active tab');
  browser.evaluateOn=async(target,fn,args)=>{
    assert.equal(target.id,pinned.id);assert.equal(fn,conversationListDOM);assert.equal(args.mode,'read');
    reads++;return snapshot(reads,browser);
  };
  return {browser,options:{targetId:pinned.id,timeoutMs:1000,pollMs:5},get reads(){return reads;}};
}

function preflightFixture(snapshot) {
  const f=waitingFixture(snapshot);
  f.browser.openChat=async()=>{f.browser.chatTargetId='pinned-chat';f.browser.activeTargetId='pinned-chat';};
  f.browser.communicate=async()=>assert.fail('A greeting capability check must never initiate contact');
  f.browser.chatAction=async()=>assert.fail('A greeting capability check must never fill or send a message');
  return f;
}

test('greeting preflight reads the pinned list and allows a supported platform identity without any contact action',async()=>{
  const f=preflightFixture(()=>({conversations:[clone(desired)],loading:false}));
  assert.deepEqual(await f.browser.assertGreetingAvailable(f.options),{available:true});
  assert.equal(f.reads,1);
});

test('greeting preflight rejects modern missing identities and unbindable rows BEFORE new contact',async()=>{
  for(const result of [
    {conversations:[{...desired,remoteId:''}],modernWithoutIds:true,loading:false},
    {conversations:[{...desired,remoteId:''}],loading:false},
    {conversations:[{...desired,jobUrl:'',jobTitle:''}],loading:false}
  ]){
    const f=preflightFixture(()=>result);
    await assert.rejects(f.browser.assertGreetingAvailable(f.options),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
    assert.equal(f.reads,1);
  }
});

test('greeting preflight refuses list mount timeout but preserves auth and transport codes',async()=>{
  for(const code of ['CHAT_LIST_UNAVAILABLE','AUTH_REQUIRED','VERIFICATION_REQUIRED','RATE_LIMITED','CDP_ERROR']){
    const f=preflightFixture(()=>{throw Object.assign(Error('fixture failure'),{code});});
    await assert.rejects(f.browser.assertGreetingAvailable({...f.options,timeoutMs:1}),
      {code:code==='CHAT_LIST_UNAVAILABLE'?'GREETING_TARGET_UNAVAILABLE':code,notSent:true});
  }
});

test('greeting preflight observes stop and tab switching while loading',async()=>{
  for(const mode of ['stop','tab']){
    let active=true;
    const f=preflightFixture((read,browser)=>{
      if(mode==='stop')active=false;else browser.activeTargetId='another-chat';
      return {conversations:[clone(desired)],loading:false};
    });
    await assert.rejects(f.browser.assertGreetingAvailable({...f.options,active:()=>active}),
      {code:mode==='stop'?'CANCELLED':'GREETING_TARGET_UNAVAILABLE',notSent:true});
  }
});

test('waitForConversationList waits through an actual delayed mount and loading phase before returning ready',async t=>{
  let mounted=false,loaded=false;
  const mounting=setTimeout(()=>{mounted=true;},20),loading=setTimeout(()=>{loaded=true;},40);
  t.after(()=>{clearTimeout(mounting);clearTimeout(loading);});
  const ready={conversations:[clone(desired)],loading:false};
  const f=waitingFixture(()=>!mounted?{error:'fixture not mounted',code:'CHAT_LIST_UNAVAILABLE'}:!loaded?{conversations:[],loading:true}:ready);
  assert.equal(await f.browser.waitForConversationList(f.options),ready);
  assert.ok(f.reads>=2);assert.equal(loaded,true);
});

test('waitForConversationList times out an absent root, a still-loading list, and an empty mounted list',async()=>{
  for(const result of [{error:'fixture not mounted',code:'CHAT_LIST_UNAVAILABLE'},{conversations:[],loading:true},{conversations:[],loading:false}]){
    const f=waitingFixture(()=>result);
    await assert.rejects(f.browser.waitForConversationList({...f.options,timeoutMs:20}),{code:'CHAT_LIST_UNAVAILABLE'});
    assert.ok(f.reads>=1);
  }
});

test('waitForConversationList does not treat a newly mounted empty list as complete before rows arrive',async()=>{
  const ready={conversations:[clone(desired)],loading:false};
  const f=waitingFixture(read=>read===1?{conversations:[],loading:false}:ready);
  assert.equal(await f.browser.waitForConversationList(f.options),ready);assert.equal(f.reads,2);
});

test('waitForConversationList immediately stops for explicit verification, authentication, and rate-limit barriers',async()=>{
  for(const options of [
    {route:'/web/passport/zp/security.html',expected:'VERIFICATION_REQUIRED'},
    {dialogs:[{text:'请先登录'}],expected:'AUTH_REQUIRED'},
    {dialogs:[{text:'访问过于频繁，请稍后再试'}],expected:'RATE_LIMITED'}
  ]){
    const dom=listDOMFixture({...options,rootAvailable:false}),f=waitingFixture(()=>dom.run());
    await assert.rejects(f.browser.waitForConversationList(f.options),{code:options.expected});
    assert.equal(f.reads,1);
  }
});

test('waitForConversationList honours cancellation before the first read and during an awaited snapshot',async()=>{
  const before=waitingFixture(()=>assert.fail('A cancelled readiness check read the DOM'));
  await assert.rejects(before.browser.waitForConversationList({...before.options,guard:()=>false}),{code:'CANCELLED'});
  assert.equal(before.reads,0);
  let active=true;
  const during=waitingFixture(async()=>{await Promise.resolve();active=false;return {conversations:[],loading:true};});
  await assert.rejects(during.browser.waitForConversationList({...during.options,guard:()=>assertActive(()=>active)}),{code:'CANCELLED'});
  assert.equal(during.reads,1);
});

test('waitForConversationList recovers from a transient navigation execution-context destruction',async()=>{
  const ready={conversations:[clone(desired)],loading:false};
  const f=waitingFixture(read=>{if(read===1)throw Object.assign(Error('Execution context was destroyed.'),{code:'CDP_ERROR'});return ready;});
  assert.equal(await f.browser.waitForConversationList(f.options),ready);assert.equal(f.reads,2);
});

test('waitForConversationList preserves unknown CDP errors without retrying or reclassifying',async()=>{
  const error=Object.assign(Error('fixture permission denied'),{code:'CDP_ERROR',cdpCode:-32000});
  const f=waitingFixture(()=>{throw error;});
  await assert.rejects(f.browser.waitForConversationList(f.options),value=>value===error);
  assert.equal(f.reads,1);
});

test('waitForConversationList stays on the requested target when cached active/chat targets change',async()=>{
  const f=waitingFixture((read,browser)=>{
    browser.activeTargetId='another-active-'+read;browser.chatTargetId='another-cached-'+read;
    return read===1?{error:'fixture mounting',code:'CHAT_LIST_UNAVAILABLE'}:{conversations:[clone(desired)],loading:false};
  });
  const result=await f.browser.waitForConversationList(f.options);
  assert.equal(result.conversations[0].id,desired.id);assert.equal(f.reads,2);
});

test('conversationListDOM classifies the security route before generic passport authentication',()=>{
  assert.equal(listDOMFixture({route:'/web/passport/zp/security.html',rootAvailable:false}).run().code,'VERIFICATION_REQUIRED');
  assert.equal(listDOMFixture({route:'/login',rootAvailable:false}).run().code,'AUTH_REQUIRED');
});

test('conversationListDOM recognises visible blocking dialogs even before the list mounts',()=>{
  for(const [text,code] of [
    ['请完成验证，拖动滑块','VERIFICATION_REQUIRED'],
    ['登录已失效，请先登录','AUTH_REQUIRED'],
    ['今日沟通次数已达上限','RATE_LIMITED']
  ])assert.equal(listDOMFixture({rootAvailable:false,dialogs:[{text}]}).run().code,code);
});

test('chat message text and hidden dialogs mentioning login, verification, or limits never become barriers',()=>{
  const text='请先登录，安全验证，拖动滑块，访问过于频繁，今日沟通次数已达上限';
  const result=listDOMFixture({remoteId:'platform-fixture',lastText:text,dialogs:[{text,visible:false}]}).run();
  assert.equal(result.error,undefined);assert.equal(result.loading,false);
  assert.equal(result.conversations[0].lastText,text);
});

test('pre-send list availability failures from reset, read, and scroll share the deferred classification',async()=>{
  for(const method of ['resetConversations','listConversations','scrollConversations']){
    const f=fixture([[{...desired,jobUrl:''}]]);
    f.browser[method]=async()=>{throw Object.assign(Error('fixture list unavailable'),{code:'CHAT_LIST_UNAVAILABLE'});};
    await assert.rejects(f.browser.sendJobGreeting(job,'虚构招呼',f.options),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
    assert.equal(f.attempts,0);assert.equal(f.clicks,0);
  }
});

test('cancellation during a pre-send availability failure keeps CANCELLED and notSent instead of deferring',async()=>{
  const f=fixture();
  f.browser.resetConversations=async()=>{f.stop();throw Object.assign(Error('fixture unavailable'),{code:'CHAT_LIST_UNAVAILABLE'});};
  await assert.rejects(f.browser.sendJobGreeting(job,'虚构招呼',f.options),{code:'CANCELLED',notSent:true});
  assert.equal(f.attempts,0);assert.equal(f.clicks,0);
});
