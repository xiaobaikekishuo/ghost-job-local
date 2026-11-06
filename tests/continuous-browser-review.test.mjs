import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {Browser,chatButtonStateDOM,clickChatButtonDOM,chatConfirmationDOM} from '../lib/browser.mjs';

const job={url:'https://www.zhipin.com/job_detail/review-full-stem.html'},path='/job_detail/review-full-stem.html';
const fast={readyTimeoutMs:0,confirmTimeoutMs:0,pollMs:1};
function fixture(){
 const target={id:'fixed-job',type:'page',url:job.url},events=[];
 const connection={mode:'existing',generation:3,createdTargets:new Set(),session:{connected:true}};
 const b=new Browser('unused-offline-review','jobs',connection);
 const f={b,target,connection,events,reads:0,onTargets:null,afterState:null,click:{clicked:true,marks:0},confirmation:'sent'};
 b.navigate=async()=>{b.activeTargetId=target.id;};
 b.targets=async()=>{await f.onTargets?.(++f.reads);return [{...target},{id:'other-chat',type:'page',url:'https://www.zhipin.com/web/geek/chat'}];};
 connection.session.pageCommand=async(id,method,params)=>{
  assert.equal(id,'fixed-job');assert.equal(method,'Runtime.evaluate');
  const fn=[chatButtonStateDOM,clickChatButtonDOM,chatConfirmationDOM].find(fn=>params.expression.startsWith('('+fn.toString()+')('));
  assert.ok(fn);
  const kind=fn===chatButtonStateDOM?'state':fn===clickChatButtonDOM?'click':'confirm';events.push(kind);
  if(kind==='state'){await f.afterState?.();return {result:{value:'ready'}};}
  const value=kind==='click'?f.click:f.confirmation;if(value instanceof Error)throw value;
  return {result:{value}};
 };
 return f;
}

test('communication uses one pinned target and one click, never dynamically follows another chat',async()=>{
 const f=fixture();assert.equal((await f.b.communicate(job,fast)).verified,true);
 assert.deepEqual(f.events,['state','click','confirm']);
 for(const change of [f=>{f.b.activeTargetId='other-chat';},f=>{f.connection.generation++;},f=>{f.connection.session.connected=false;}]){
  const x=fixture();x.afterState=()=>change(x);
  await assert.rejects(x.b.communicate(job,fast),error=>error.notSent===true);
  assert.deepEqual(x.events,['state']);
 }
});

test('the final command target await rechecks cancellation and connection before any click dispatch',async()=>{
 for(const kind of ['cancel','generation','connection','active']){
  const f=fixture();let stopped=false;
  f.onTargets=n=>{if(n===4){if(kind==='cancel')stopped=true;if(kind==='generation')f.connection.generation++;
   if(kind==='connection')f.b.connection={...f.connection};if(kind==='active')f.b.activeTargetId='other-chat';}};
  await assert.rejects(f.b.communicate(job,{...fast,guard:()=>!stopped}));
  assert.deepEqual(f.events,['state'],kind);
 }
});

test('a pinned job redirect, unsafe origin or closed target cannot receive the first contact',async()=>{
 for(const url of ['https://www.zhipin.com/job_detail/other.html','https://www.zhipin.com/web/geek/chat','https://www.zhipin.com.evil.test'+path,'https://user:pass@www.zhipin.com'+path]){
  const f=fixture();f.target.url=url;await assert.rejects(f.b.communicate(job,fast),error=>error.notSent===true);
  assert.deepEqual(f.events,[]);
 }
});

test('missing or malformed click results remain uncertain; only an explicit no-click result permits notSent',async()=>{
 for(const value of [undefined,null,{},true,{clicked:'true'}]){
  const f=fixture();f.click=value;assert.equal((await f.b.communicate(job,fast)).verified,false);
  assert.deepEqual(f.events,['state','click']);
 }
 for(const value of [false,{clicked:false,code:'AUTH_REQUIRED'},{clicked:false,code:'RATE_LIMITED'}]){
  const f=fixture();f.click=value;await assert.rejects(f.b.communicate(job,fast),error=>error.notSent===true);
  assert.deepEqual(f.events,['state','click']);
 }
});

test('lost click or post-click failures cannot keep an inherited notSent flag or trigger a retry',async()=>{
 for(const at of ['click','confirmation'])for(const code of ['CDP_ERROR','CANCELLED','RATE_LIMITED','NAVIGATION_FAILED']){
  const f=fixture();f[at]=Object.assign(Error(code==='CDP_ERROR'?'Execution context was destroyed.':'fixture failure'),{code,notSent:true});
  await assert.rejects(f.b.communicate(job,fast),e=>e.code===code&&e.notSent!==true&&e.uncertain===true);
  assert.equal(f.events.filter(x=>x==='click').length,1);
  if(at==='click')assert.equal(f.events.includes('confirm'),false);
 }
});

function page(url=job.url){
 const button={innerText:'立即沟通',attrs:{},clicks:0,getBoundingClientRect:()=>({height:20}),
  getAttribute(k){return this.attrs[k]??null;},setAttribute(k,v){this.attrs[k]=v;},click(){this.clicks++;}};
 const document={body:{innerText:'岗位详情'},readyState:'complete',querySelectorAll:selector=>selector==='[data-abj-chat]'?(button.attrs['data-abj-chat']?[button]:[]):[button]};
 const context={document,location:new URL(url),URL};
 return {button,document,run:(fn,...args)=>vm.runInNewContext('('+fn.toString()+')(...args)',{...context,args})};
}

test('atomic contact click refuses similar domains, credentials, missing target proof and newly appeared auth barriers',()=>{
 for(const url of ['http://www.zhipin.com'+path,'https://www.zhipin.com.evil.test'+path,'https://u:p@www.zhipin.com'+path,'https://www.zhipin.com/job_detail/other.html']){
  const f=page(url);assert.equal(f.run(chatButtonStateDOM,path),'redirected');assert.equal(f.run(clickChatButtonDOM,path,'attempt'),false);assert.equal(f.button.clicks,0);
 }
 for(const text of ['安全验证','扫码登录','今日沟通人数已达上限']){
  const f=page();f.document.body.innerText=text;assert.equal(f.run(clickChatButtonDOM,path,'attempt').clicked,false);assert.equal(f.button.clicks,0);
 }
 const f=page();assert.equal(f.run(clickChatButtonDOM),false);assert.equal(f.button.clicks,0);
});

test('confirmation requires the attempt marker on the exact job or its pinned exact chat route, never page text counts',()=>{
 const f=page();f.run(clickChatButtonDOM,path,'fresh-attempt');f.document.body.innerText='推荐 已沟通 继续沟通 已沟通';
 assert.equal(f.run(chatConfirmationDOM,0,path,'fresh-attempt'),'pending');
 f.button.innerText='继续沟通';assert.equal(f.run(chatConfirmationDOM,0,path,'other-attempt'),'pending');
 assert.equal(f.run(chatConfirmationDOM,0,path,'fresh-attempt'),'sent');
 for(const url of ['https://www.zhipin.com/job_detail/other.html','https://www.zhipin.com/chat-help','https://evil.test/web/geek/chat']){
  const x=page(url);x.button.setAttribute('data-abj-chat','fresh-attempt');x.button.innerText='继续沟通';
  assert.equal(x.run(chatConfirmationDOM,0,path,'fresh-attempt'),'pending');
 }
 assert.equal(page('https://www.zhipin.com/web/geek/chat').run(chatConfirmationDOM,0,path,'fresh-attempt'),'sent');
});
