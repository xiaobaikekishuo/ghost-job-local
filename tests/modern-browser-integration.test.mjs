import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Browser} from '../lib/browser.mjs';
import {modernChatDOM} from '../lib/modern-chat-dom.mjs';
import {chatRefreshDOM} from '../lib/chat-refresh.mjs';
import {modernJobProofDOM} from '../lib/modern-job-proof-dom.mjs';
import {chooseModernConversationDOM,modernGreetingCapabilityDOM} from '../lib/modern-greeting-adapter.mjs';

const job={url:'https://www.zhipin.com/job_detail/fixture-full-job-id.html',title:'采购专员',company:'虚构公司',hrName:'林女士'};
function fixture({wrongJob=false,lostAfterClick=false}={}){
 const browser=new Browser('unused-modern-integration');
 browser.connection={generation:7};browser.connectionGeneration=7;
 browser.chatTargetId='chat';browser.activeTargetId='chat';
 browser.openChat=async()=>{};
 browser.waitForConversationList=async()=>({modernWithoutIds:true,conversations:[{contact:job.hrName,company:job.company}]});
 browser.targets=async()=>[{id:'chat',type:'page',url:'https://www.zhipin.com/web/geek/chat'}];
 browser.resetConversations=async()=>{};
 const events=[],state={modern:true,contact:job.hrName,company:job.company,jobTitle:job.title,anchorIds:['platform-old'],
  latestTail:{atBottom:true,loading:false,signature:'tail-old'},messages:[{remoteId:'platform-old',platformMessageId:true,role:'user',text:'此前消息',deliveryStatus:'unknown'}]};
 browser.command=async(method,params,target)=>{
  assert.equal(target.id,'chat');
  if(method==='Input.dispatchMouseEvent'){
   assert.ok(['mousePressed','mouseReleased'].includes(params.type));assert.equal(params.x,100);assert.equal(params.y,100);assert.equal(params.button,'left');
   if(params.type==='mouseReleased')events.push('open-job');return {};
  }
  assert.equal(method,'Page.bringToFront');assert.deepEqual(params,{});events.push('focus');return {};
 };
 browser.evaluateOn=async(target,fn,args)=>{
  assert.equal(target.id,'chat');
  if(fn===chatRefreshDOM){
   assert.equal(args.action,'inspect','An existing target match must never reload the page');events.push('inspect-idle');
   return {ok:true,timeOrigin:100,href:'https://www.zhipin.com/web/geek/chat',readyState:'complete',safeToRefresh:true,ready:true};
  }
  if(fn===modernGreetingCapabilityDOM)return {available:true,modern:true,requiresJobProof:true};
  if(fn===chooseModernConversationDOM){events.push('select');return {ok:true,found:true};}
  if(fn===modernJobProofDOM){
   if(wrongJob)return {ok:true,jobUrl:'https://www.zhipin.com/job_detail/other-job.html'};
   if(args.action==='close'){events.push('close-verified-popup');return {ok:true,jobUrl:job.url,closeClicked:true,closed:true};}
   return {ok:true,jobUrl:job.url,closed:args.action==='closed'};
  }
  assert.equal(fn,modernChatDOM);
  if(args.action==='read')return structuredClone(state);
  if(args.action==='locateJobEntry')return {modern:true,ok:true,x:100,y:100,viewport:{width:1280,height:800}};
  if(args.action==='openJob'){events.push('open-job');return {ok:true,openedJob:true};}
  if(args.action==='fill'){events.push('fill');return {ok:true,filled:true};}
  if(args.action==='send'){
   events.push('send');
   if(lostAfterClick)throw Object.assign(Error('lost response after dispatch'),{code:'CDP_ERROR'});
   state.anchorIds.push('platform-new');
   state.messages.push({remoteId:'platform-new',platformMessageId:true,role:'assistant',text:args.text,deliveryStatus:'confirmed'});
   state.latestTail.signature='tail-new';return {ok:true,clicked:true};
  }
  assert.fail('Unexpected action');
 };
 return {browser,events};
}
test('Browser modern entry proves the job and records a real receipt without a fabricated conversation ID',async()=>{
 const {browser,events}=fixture();let attempts=0;
 const result=await browser.sendJobGreeting(job,'根据岗位要求生成的已确认招呼',{onAttempt:()=>attempts++});
 assert.equal(result.verified,true);assert.equal(result.receiptId,'platform-new');assert.equal(attempts,1);
 assert.equal(result.conversation.id,undefined);assert.equal(result.conversation.remoteId,undefined);
 assert.equal(result.conversation.jobUrl,job.url);
 assert.deepEqual(events,['focus','inspect-idle','select','open-job','close-verified-popup','fill','send']);
});
test('Modern capability detection does not send or select a recipient and still requires a complete target',async()=>{
 const {browser,events}=fixture();
 assert.deepEqual(await browser.assertGreetingAvailable({job}),{available:true,modern:true,requiresJobProof:true});
 assert.deepEqual(events,['inspect-idle']);
 await assert.rejects(browser.assertGreetingAvailable({job:{...job,hrName:''}}),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
 assert.deepEqual(events,['inspect-idle']);
});

test('Pre-contact capability preserves a human draft without selecting or contacting an HR',async()=>{
 const {browser,events}=fixture(),evaluate=browser.evaluateOn;
 browser.evaluateOn=async(target,fn,args)=>{
  if(fn===chatRefreshDOM){events.push('draft-check');return {ok:false,code:'GREETING_TARGET_UNAVAILABLE',notSent:true,error:'消息输入框已有未发送草稿，已保留原稿，未刷新'};}
  return evaluate(target,fn,args);
 };
 await assert.rejects(browser.assertGreetingAvailable({job}),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
 assert.deepEqual(events,['draft-check']);
});

test('Pre-contact capability rejects a connection change during the idle check',async()=>{
 const {browser,events}=fixture();
 browser.assertGreetingChatIdle=async options=>{browser.connection.generation++;return {idle:true,targetId:options.targetId,generation:options.generation};};
 await assert.rejects(browser.assertGreetingAvailable({job}),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
 assert.deepEqual(events,[]);
});
test('A transport failure after dispatch is never exposed as safe to retry',async()=>{
 const {browser,events}=fixture({lostAfterClick:true});let attempts=0;
 await assert.rejects(browser.sendJobGreeting(job,'专属正文',{onAttempt:()=>attempts++}),e=>e.code==='CDP_ERROR'&&e.notSent!==true);
 assert.equal(attempts,1);assert.equal(events.filter(x=>x==='send').length,1);
});

test('Company labels and truncated brands cannot pass pre-contact checks or select an HR',async()=>{
 for(const company of ['公司名称','企业名称：','祥行科技...','未知公司']){
  const {browser,events}=fixture();let attempts=0;
  await assert.rejects(browser.assertGreetingAvailable({job:{...job,company}}),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
  await assert.rejects(browser.sendJobGreeting({...job,company},'专属正文',{onAttempt:()=>attempts++}),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
  assert.equal(attempts,0);assert.deepEqual(events,[]);
 }
});
