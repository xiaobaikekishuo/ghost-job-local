import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {Browser} from '../lib/browser.mjs';
import {createWorkflows} from '../lib/workflows.mjs';
import {JOB_DETAIL_VERSION} from '../lib/job-detail-quality.mjs';

const url='https://www.zhipin.com/job_detail/fixture-job.html';
const otherURL='https://www.zhipin.com/job_detail/other-job.html';
const description='负责供应商开发与采购订单跟进，熟悉询价比价和 ERP 系统。';

// Execute the real serialized parser through Browser.evaluateOn. This fixture
// substitutes only CDP and its visible page DOM, never parsed detail results.
function page(frame, pageURL){
 const node=(text,className='')=>({nodeType:1,tagName:'DIV',innerText:text,className,
  childNodes:[{nodeType:3,nodeValue:text}],classList:{contains:name=>className.split(' ').includes(name)},
  getAttribute:()=>null,getBoundingClientRect:()=>({width:200,height:30}),querySelectorAll:()=>[],contains:()=>false});
 const body=node(''),jd=node(frame.description||'','job-sec-text'),title=node('采购专员\n10-15K'),dialog=node(frame.dialog||'');
 jd.parentElement=body;title.parentElement=body;dialog.parentElement=body;
 const document={body,querySelectorAll(selector){
  if(selector==='.job-sec-text,.job-detail-section .text,.job-detail .text')return frame.description?[jd]:[];
  if(selector==='.job-name h1,.name h1')return [title];
  if(selector.includes('[role="dialog"]'))return frame.dialog?[dialog]:[];
  return [];
 }};
 return {document,location:{href:pageURL},URL,getComputedStyle:()=>({display:'block',visibility:'visible'})};
}
function fixture(frames=[{description}],initialURL=url){
 const browser=new Browser('unused-fixture-directory');browser.port=1;browser.activeTargetId='detail';browser.detailTargetId='detail';
 let current={id:'detail',type:'page',url:initialURL},calls=0,targetReads=0;
 const other={id:'other',type:'page',url:otherURL},targetIds=[];
 const f={browser,targetIds,get calls(){return calls;},get targetReads(){return targetReads;},
  set current(value){current=value;},get current(){return current;}};
 browser.targets=async()=>{targetReads++;return current?[{...current},other]:[other];};
 browser.command=async(method,params,target)=>{
  assert.equal(method,'Runtime.evaluate');targetIds.push(target.id);
  const frame=frames[Math.min(calls++,frames.length-1)];
  if(frame.error)throw frame.error;
  if(frame.pending)return new Promise(()=>{});
  let result;
  try{result={result:{value:structuredClone(vm.runInNewContext(params.expression,page(frame,frame.url||current.url)))}};}
  catch(error){result={exceptionDetails:{text:error.message}};}
  frame.after?.(f);return result;
 };
 return f;
}
const read=f=>f.browser.detail({timeoutMs:150,pollMs:1,expectedUrl:url});

test('detail waits through empty and tag-only DOM and stays pinned when another page becomes active',async()=>{
 const f=fixture([{after:f=>{f.browser.activeTargetId='other';}},{description:'采购专员\n10-15K\n广州\n本科'},{description}]);
 const result=await read(f);
 assert.equal(result.description,description);assert.equal(result.title,'采购专员');
 assert.equal(result.detailSource,'job-detail-dom');assert.equal(result.detailUrl,url);
 assert.equal(f.calls,3);assert.deepEqual(f.targetIds,['detail','detail','detail']);
});

test('empty or card-only pages time out without certifying them as details',async()=>{
 for(const description of ['','采购专员\n10-15K\n广州\n本科']){
  const f=fixture([{description}]);
  await assert.rejects(f.browser.detail({timeoutMs:0,expectedUrl:url}),{code:'JOB_DETAIL_REQUIRED',notSent:true});
  assert.equal(f.calls,1);
 }
});

test('serialized parser preserves auth, verification and rate-limit codes without polling again',async()=>{
 for(const [frame,code] of [
  [{url:'https://www.zhipin.com/web/passport/login'},'AUTH_REQUIRED'],
  [{url:'https://www.zhipin.com/web/passport/zp/security.html'},'VERIFICATION_REQUIRED'],
  [{description,dialog:'访问过于频繁，请稍后重试'},'RATE_LIMITED'],
 ]){
  const f=fixture([frame,{description}]);
  await assert.rejects(read(f),{code,notSent:true});assert.equal(f.calls,1);
 }
});

test('only navigation execution-context errors are retried',async()=>{
 const f=fixture([{error:Object.assign(Error('Execution context was destroyed'),{code:'CDP_ERROR'})},{description}]);
 assert.equal((await read(f)).description,description);assert.equal(f.calls,2);
 for(const error of [Object.assign(Error('Permission denied'),{code:'CDP_ERROR'}),Error('Execution context was destroyed')]){
  const bad=fixture([{error},{description}]);
  await assert.rejects(read(bad),e=>e===error);assert.equal(bad.calls,1);
 }
});

test('the detail deadline also bounds a stalled CDP read and repeated context destruction',async()=>{
 const stalled=fixture([{pending:true}]),started=Date.now();
 await assert.rejects(stalled.browser.detail({expectedUrl:url,timeoutMs:25,pollMs:1}),{code:'JOB_DETAIL_REQUIRED'});
 assert.ok(Date.now()-started<250,'A stalled read must not wait for the 15-second transport timeout');
 assert.equal(stalled.calls,1);
 const repeated=fixture([{error:Object.assign(Error('Cannot find context with specified id'),{code:'CDP_ERROR'})}]);
 await assert.rejects(repeated.browser.detail({expectedUrl:url,timeoutMs:0,pollMs:1}),{code:'JOB_DETAIL_REQUIRED'});
 assert.equal(repeated.calls,1);
});

test('closed or off-site pinned targets never fall back to another open job',async()=>{
 for(const change of [f=>{f.current=null;},f=>{f.current={...f.current,url:'https://example.org/'};}]){
  const f=fixture([{after:change},{description}]);
  await assert.rejects(read(f),{code:'JOB_DETAIL_TARGET_CHANGED'});
  assert.deepEqual(f.targetIds,['detail']);
 }
 const closed=fixture();closed.current=null;
 await assert.rejects(read(closed),{code:'JOB_DETAIL_TARGET_CHANGED'});assert.equal(closed.calls,0);
});

test('changing job URL in the pinned tab or only in its DOM discards even a complete result',async()=>{
 for(const frame of [
  {description,after:f=>{f.current={...f.current,url:otherURL};}},
  {description,url:otherURL},
 ]){
  const f=fixture([frame]);await assert.rejects(read(f),{code:'JOB_DETAIL_TARGET_CHANGED'});
 }
});

test('reconnecting during a read discards the previous connection result',async()=>{
 const f=fixture([{description,after:f=>{f.browser.connection.generation++;}}]);
 f.browser.connection={generation:1};
 await assert.rejects(read(f),{code:'JOB_DETAIL_TARGET_CHANGED'});
});

test('cancellation before any read and after DOM evaluation prevents accepting a result',async()=>{
 const before=fixture();
 await assert.rejects(before.browser.detail({active:()=>false}),{code:'CANCELLED'});
 assert.equal(before.calls,0);assert.equal(before.targetReads,0);
 let active=true;const during=fixture([{description,after:()=>{active=false;}}]);
 await assert.rejects(during.browser.detail({active:()=>active,expectedUrl:url}),{code:'CANCELLED'});
 assert.equal(during.calls,1);
});

test('an expected navigation waits past the previous job DOM and accepts only its destination',async()=>{
 const f=fixture([{description:'负责旧岗位合同审核。',after:f=>{f.current={...f.current,url};}},{description}],otherURL);
 const result=await read(f);assert.equal(result.description,description);assert.equal(result.detailUrl,url);assert.equal(f.calls,2);
});

function workflowFixture(f){
 let job={id:'fixture',url,title:'采购专员',company:'虚构采购公司',status:'待分析'},writes=0;
 const store={settings:()=>({keywords:'采购',cities:'广州',activityEnabled:true,aiEnabled:false,resumeMatch:false,autoSend:false}),
  getJob:()=>job,jobs:()=>[job],upsertJob:value=>{writes++;job={...job,...value};return job;},deliveryCount:()=>0,log:()=>{}};
 const flow=createWorkflows(store,f.browser,f.browser,f.browser,true);
 f.browser.navigate=async(destination,options)=>{assert.equal(destination,url);assert.equal(options.active(),true);};
 return {flow,store,get job(){return job;},get writes(){return writes;}};
}

test('workflow uses the real detail reader and stores only its verified description and provenance',async()=>{
 const f=fixture([{}, {description}]),w=workflowFixture(f);
 const detail=f.browser.detail.bind(f.browser);
 f.browser.detail=options=>{assert.equal(options.expectedUrl,url);assert.equal(options.active(),true);return detail({...options,timeoutMs:150,pollMs:1});};
 const result=await w.flow.detail(w.job);
 assert.equal(result.description,description);assert.equal(result.detailSource,'job-detail-dom');
 assert.equal(result.detailUrl,url);assert.equal(result.detailVersion,JOB_DETAIL_VERSION);assert.ok(result.detailsAt);
 assert.equal(w.writes,1);
});

test('workflow and checkJob forward the same active guard and never save cancelled details',async()=>{
 for(const mode of ['detail','checkJob']){
  let active=true;const f=fixture([{description,after:()=>{active=false;}}]),w=workflowFixture(f),guard=()=>active;
  const detail=f.browser.detail.bind(f.browser);
  f.browser.detail=options=>{assert.equal(options.active,guard);return detail(options);};
  const action=mode==='detail'?w.flow.detail(w.job,f.browser,{active:guard}):w.flow.checkJob(w.job,false,f.browser,{active:guard});
  await assert.rejects(action,{code:'CANCELLED'});assert.equal(w.writes,0);assert.equal(w.job.detailsAt,undefined);
 }
});

test('scan stops during detail polling without recording analysis failure or continuing to another job',async()=>{
 let flow;const f=fixture([{after:()=>flow.stop()},{description}]),w=workflowFixture(f);flow=w.flow;
 f.browser.launch=async()=>{};f.browser.search=async()=>{};
 f.browser.readJobs=async()=>({jobs:[w.job,{...w.job,id:'second',url:otherURL}],blocked:''});
 f.browser.target=async()=>({url:'https://www.zhipin.com/web/geek/jobs'});
 const state=await flow.scan();
 assert.equal(state.running,false);assert.equal(state.phase,'已停止');assert.equal(state.error,null);
 assert.equal(w.job.status,'待分析');assert.equal(w.job.detailsAt,undefined);assert.equal(f.calls,1);
});
