import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {Browser} from '../lib/browser.mjs';
import {createWorkflows} from '../lib/workflows.mjs';

const searchURL='https://www.zhipin.com/web/geek/jobs?query=%E9%87%87%E8%B4%AD&city=101280100';
const expectedSearch={keyword:'采购',city:'广州'};
const job={title:'采购专员',url:'https://www.zhipin.com/job_detail/test-job.html'};
const snapshot=(patch={})=>({url:searchURL,loading:false,jobs:[],blocked:'',...patch});
function reader(sequence){
 const browser=new Browser('unused-test-directory');
 let calls=0;
 browser.readJobsSnapshot=async()=>sequence[Math.min(calls++,sequence.length-1)];
 return {browser,calls:()=>calls};
}

test('job reader waits through navigation and asynchronous empty results before accepting jobs',async()=>{
 const f=reader([snapshot({loading:true}),snapshot(),snapshot({jobs:[job]})]);
 const result=await f.browser.readJobs({timeoutMs:200,pollMs:1,expectedSearch});
 assert.deepEqual(result.jobs,[job]);
 assert.equal(result.blocked,'');
 assert.equal(f.calls(),3);
});

test('automatic search rejects homepage recommendations after a redirect',async()=>{
 const f=reader([snapshot({loading:true}),snapshot({url:'https://www.zhipin.com/',jobs:[job]})]);
 const result=await f.browser.readJobs({timeoutMs:200,pollMs:1,expectedSearch});
 assert.deepEqual(result.jobs,[]);
 assert.match(result.blocked,/跳转.*首页/);
 assert.equal(f.calls(),2);
});

test('manual collection can read the loaded homepage without claiming it matches a search',async()=>{
 const f=reader([snapshot({url:'https://www.zhipin.com/',jobs:[job]})]);
 const result=await f.browser.readJobs({timeoutMs:200,pollMs:1});
 assert.deepEqual(result.jobs,[job]);
 assert.equal(result.blocked,'');
 assert.equal(f.calls(),1);
});

test('job reader distinguishes loading timeout from unsupported loaded page',async()=>{
 const loading=reader([snapshot({loading:true})]);
 const pending=await loading.browser.readJobs({timeoutMs:0,pollMs:1,expectedSearch});
 assert.deepEqual(pending.jobs,[]);
 assert.match(pending.blocked,/仍在加载/);
 assert.equal(loading.calls(),1);
 const loaded=reader([snapshot()]);
 const missing=await loaded.browser.readJobs({timeoutMs:0,pollMs:1,expectedSearch});
 assert.deepEqual(missing.jobs,[]);
 assert.match(missing.blocked,/未识别到岗位卡片/);
 assert.equal(loaded.calls(),1);
});

test('stopping a read prevents polling and discards a result that arrived after cancellation',async()=>{
 const before=reader([snapshot({jobs:[job]})]);
 const stopped=await before.browser.readJobs({active:()=>false});
 assert.deepEqual(stopped.jobs,[]);
 assert.match(stopped.blocked,/停止/);
 assert.equal(before.calls(),0);
 let active=true;
 const during=new Browser('unused-test-directory');
 during.readJobsSnapshot=async()=>{active=false;return snapshot({jobs:[job]});};
 const cancelled=await during.readJobs({active:()=>active,expectedSearch});
 assert.deepEqual(cancelled.jobs,[]);
 assert.match(cancelled.blocked,/停止/);
});

test('login and verification requirements terminate the wait immediately',async()=>{
 for(const blocked of ['请在浏览器中完成 BOSS 直聘登录','页面要求验证，请在浏览器中手动完成后继续']){
  const f=reader([snapshot({blocked}),snapshot({jobs:[job]})]);
  const result=await f.browser.readJobs({timeoutMs:200,pollMs:1,expectedSearch});
  assert.deepEqual(result.jobs,[]);
  assert.equal(result.blocked,blocked);
  assert.equal(f.calls(),1);
 }
});

test('automatic search rejects a different keyword or city even when jobs are present',async()=>{
 for(const [key,value] of [['query','运营'],['city','101280600']]){
  const url=new URL(searchURL);url.searchParams.set(key,value);
  const f=reader([snapshot({url:url.href,jobs:[job]})]);
  const result=await f.browser.readJobs({timeoutMs:200,pollMs:1,expectedSearch});
  assert.deepEqual(result.jobs,[]);
  assert.match(result.blocked,/关键词或城市.*不一致/);
  assert.equal(f.calls(),1);
 }
});

test('an explicit empty search result does not wait until timeout',async()=>{
 const f=reader([snapshot({empty:true})]);
 const result=await f.browser.readJobs({timeoutMs:200,pollMs:1,expectedSearch});
 assert.deepEqual(result.jobs,[]);
 assert.match(result.blocked,/没有匹配岗位/);
 assert.equal(f.calls(),1);
});

test('search propagates a redirect error instead of reporting navigation as success',async()=>{
 const f=reader([snapshot({url:'https://www.zhipin.com/',jobs:[job]})]);
 let navigated='';
 f.browser.navigate=async url=>{navigated=url;};
 await assert.rejects(f.browser.search('采购','广州',{timeoutMs:200,pollMs:1}),/跳转.*首页/);
 assert.equal(new URL(navigated).pathname,'/web/geek/jobs');
});

test('job reading retries only transient CDP execution-context errors',async()=>{
 const browser=new Browser('unused-test-directory');let calls=0;
 browser.readJobsSnapshot=async()=>{if(++calls===1)throw Object.assign(Error('Execution context was destroyed.'),{code:'CDP_ERROR'});return snapshot({jobs:[job]});};
 const result=await browser.readJobs({timeoutMs:200,pollMs:1,expectedSearch});
 assert.deepEqual(result.jobs,[job]);assert.equal(calls,2);
 for(const error of [Error('网页解析失败，请刷新页面后重试'),Object.assign(Error('Invalid parameters'),{code:'CDP_ERROR'}),Error('Execution context was destroyed.')]){
  let attempts=0;browser.readJobsSnapshot=async()=>{attempts++;throw error;};
  await assert.rejects(browser.readJobs({timeoutMs:200,pollMs:1,expectedSearch}),e=>e===error);
  assert.equal(attempts,1);
 }
});

test('repeated execution-context errors respect the read deadline',async()=>{
 const browser=new Browser('unused-test-directory');let calls=0;
 browser.readJobsSnapshot=async()=>{calls++;throw Object.assign(Error('Cannot find context with specified id'),{code:'CDP_ERROR'});};
 const result=await browser.readJobs({timeoutMs:0,pollMs:1,expectedSearch});
 assert.equal(calls,1);assert.deepEqual(result.jobs,[]);assert.match(result.blocked,/仍在加载/);
});

test('closed or off-site search targets do not fall back to an unrelated jobs tab',async()=>{
 for(const pinned of [undefined,{id:'pinned',type:'page',url:'https://example.org/'}]){
  const browser=new Browser('unused-test-directory');browser.port=1;browser.mainTargetId='pinned';
  browser.targets=async()=>[...(pinned?[pinned]:[]),{id:'other',type:'page',url:searchURL}];
  browser.evaluateOn=async()=>assert.fail('Read from a fallback page');
  await assert.rejects(browser.readJobsSnapshot({expectedSearch}),{code:pinned?'SEARCH_TARGET_CHANGED':'SEARCH_TARGET_MISSING'});
 }
});

test('snapshot evaluation stays on its pinned target, including same-site redirects',async()=>{
 for(const url of ['https://www.zhipin.com/','https://www.zhipin.com/web/passport/zp/security.html']){
  const browser=new Browser('unused-test-directory');browser.port=1;browser.mainTargetId='pinned';
  browser.activeTargetId='other';
  const pinned={id:'pinned',type:'page',url};
  browser.targets=async()=>[{id:'other',type:'page',url:searchURL},pinned];
  browser.target=async()=>assert.fail('Snapshot must not rediscover/fall back during evaluation');
  browser.command=async(method,params,target)=>{assert.equal(method,'Runtime.evaluate');assert.equal(target,pinned);return {result:{value:snapshot({url})}};};
  const result=await browser.readJobsSnapshot({expectedSearch});
  assert.equal(result.url,url);assert.equal(browser.activeTargetId,'pinned');
 }
});

test('BOSS security-check timeout is reported without reading or interacting with challenge DOM',async()=>{
 const browser=new Browser('unused-test-directory');browser.port=1;browser.mainTargetId='pinned';
 const url='https://www.zhipin.com/web/passport/zp/security.html?name=check';
 const pinned={id:'pinned',type:'page',url};browser.targets=async()=>[pinned];
 browser.command=async(method,params,target)=>{
  assert.equal(method,'Runtime.evaluate');assert.equal(target,pinned);
  // Only location is available: any challenge DOM read/action would throw.
  return {result:{value:vm.runInNewContext(params.expression,{location:new URL(url)})}};
 };
 const result=await browser.readJobs({timeoutMs:10,pollMs:1,expectedSearch});
 assert.equal(result.jobs.length,0);assert.equal(result.loading,true);
 assert.match(result.blocked,/BOSS 安全检查尚未完成/);
 assert.doesNotMatch(result.blocked,/跳转到了首页/);
});

test('a passive BOSS check can finish without the reader prematurely rejecting the transition',async()=>{
 const f=reader([snapshot({url:'https://www.zhipin.com/web/passport/zp/security.html',loading:true,securityCheck:true}),snapshot({jobs:[job]})]);
 const result=await f.browser.readJobs({timeoutMs:200,pollMs:1,expectedSearch});
 assert.deepEqual(result.jobs,[job]);assert.equal(result.blocked,'');
});

test('stopping during search finishes scan as stopped without a failure warning',async()=>{
 const logs=[];
 const store={settings:()=>({keywords:'采购',cities:'广州'}),log:(text,level)=>logs.push({text,level})};
 let flow;
 const browser={launch:async()=>{},search:async(keyword,city,options)=>{assert.equal(options.active(),true);flow.stop();throw Object.assign(Error('操作已停止'),{code:'CANCELLED'});}};
 flow=createWorkflows(store,browser,browser,browser,true);
 const result=await flow.scan();
 assert.equal(result.phase,'已停止');assert.equal(result.error,null);assert.equal(result.running,false);assert.equal(result.busy,false);
 assert.equal(logs.length,0);
});

test('a real search error still pauses scan and records its cause',async()=>{
 const logs=[];
 const store={settings:()=>({keywords:'采购',cities:'广州'}),log:(text,level)=>logs.push({text,level})};
 const browser={launch:async()=>{},search:async()=>{throw Error('岗位页面导航失败：net::ERR_CONNECTION_RESET');}};
 const result=await createWorkflows(store,browser,browser,browser,true).scan();
 assert.equal(result.phase,'已暂停');assert.match(result.error,/ERR_CONNECTION_RESET/);
 assert.equal(result.failedPhase,'搜索 广州 · 采购');
 assert.deepEqual(logs,[{text:result.failedPhase+' · '+result.error,level:'warn'}]);
});
