// Continuous delivery: one job's problem skips that job; platform problems still pause.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createStore} from '../lib/store.mjs';
import {SimulationBrowser,simulationSettings} from '../lib/simulation.mjs';
import {createWorkflows} from '../lib/workflows.mjs';
import {chat} from '../lib/ai.mjs';
import {Browser,chatButtonStateDOM,clickChatButtonDOM,chatConfirmationDOM} from '../lib/browser.mjs';

const coded=(message,code,extra={})=>Object.assign(Error(message),{code,...extra});
function fixture(t,{settings={},pick=[0,4,5],simulation=true,options}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'continuous-delivery-')),store=createStore(dir);
 store.saveSettings({...simulationSettings(),...settings});
 const browser=new SimulationBrowser(dir),world=browser.world();
 world.jobs=pick.map(index=>world.jobs[index]);browser.save(world);
 const flow=createWorkflows(store,browser,browser,browser,simulation,options);
 const contacts=[],communicate=browser.communicate.bind(browser);
 browser.communicate=async(job,...args)=>{contacts.push(job.url);return communicate(job,...args);};
 t.after(()=>{store.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'continuous-delivery-'));fs.rmSync(dir,{recursive:true,force:true});});
 const byUrl=url=>store.jobs().find(job=>job.url===url);
 return {store,browser,flow,jobs:world.jobs,contacts,communicate,byUrl,getJob:index=>byUrl(world.jobs[index].url),
  ledger:id=>store.db.prepare('SELECT status FROM deliveries WHERE id=?').get(id)?.status};
}
// Make the first contact attempt fail in a given way, then behave normally.
function failFirstContact(f,fail){let calls=0;const normal=f.browser.communicate;f.browser.communicate=async(job,...args)=>{if(calls++===0){f.contacts.push(job.url);return fail(job,...args);}return normal(job,...args);};}

test('a keyword or city without results is skipped and the remaining searches still run',async t=>{
 const f=fixture(t,{settings:{keywords:'不存在的岗位,采购',cities:'火星,广州'}});
 const search=f.browser.search.bind(f.browser),searched=[];
 f.browser.search=async(keyword,city,options)=>{
  searched.push(keyword+'@'+city);
  if(city==='火星')throw coded('暂不支持城市：火星；请从配置中心的城市列表选择','CITY_UNSUPPORTED');
  if(keyword==='不存在的岗位')throw coded('当前搜索没有匹配岗位，请调整关键词或城市。','SEARCH_EMPTY');
  return search(keyword,city,options);
 };
 const result=await f.flow.scan();
 assert.equal(result.phase,'本轮已完成');assert.equal(result.error,null);
 assert.deepEqual(searched,['不存在的岗位@火星','不存在的岗位@广州','采购@火星','采购@广州']);
 assert.equal(result.searchesSkipped,3);assert.equal(result.sent,3);assert.match(result.message,/3 个关键词\/城市组合/);
});

test('a real search failure (verification, redirect, transport) still pauses',async t=>{
 for(const code of ['VERIFICATION_REQUIRED','SEARCH_REDIRECTED',undefined]){
  const f=fixture(t);f.browser.search=async()=>{throw coded('search failed '+code,code);};
  const result=await f.flow.scan();
  assert.equal(result.phase,'已暂停',String(code));assert.equal(result.sent,0);assert.deepEqual(f.contacts,[]);
 }
});

test('an HR already in conversation ("继续沟通") is skipped without quota, then deduplicated on restart',async t=>{
 const f=fixture(t);
 failFirstContact(f,async()=>{throw coded('页面显示「继续沟通」：之前已与该 HR 建立会话，本次未重复发起','ALREADY_CONTACTED',{notSent:true});});
 const result=await f.flow.scan(),first=f.getJob(0);
 assert.equal(result.phase,'本轮已完成');assert.equal(result.error,null);
 assert.equal(result.sent,2);assert.equal(result.alreadyContacted,1);assert.equal(result.duplicates,1);
 assert.equal(first.status,'合适');assert.equal(first.alreadyContacted,true);assert.equal(first.attemptedAt,undefined);
 assert.equal(f.ledger(first.id),undefined);assert.equal(f.store.deliveryCount(),2);
 assert.match(result.message,/继续沟通/);
 const restarted=await f.flow.scan();
 assert.equal(restarted.sent,0);assert.equal(restarted.duplicates,3);assert.equal(f.contacts.length,3);
});

test('a missing chat button only fails that job, gives the quota back and is retried next run',async t=>{
 const f=fixture(t);
 failFirstContact(f,async()=>{throw coded('等待 10 秒仍未找到「立即沟通」按钮，未执行发送','CHAT_BUTTON_MISSING',{notSent:true});});
 const result=await f.flow.scan(),first=f.getJob(0);
 assert.equal(result.phase,'本轮已完成');assert.equal(result.sent,2);assert.equal(result.failed,1);
 assert.equal(first.status,'分析失败');assert.match(first.reason,/沟通按钮未就绪/);
 assert.equal(f.ledger(first.id),undefined);assert.equal(f.store.deliveryCount(),2);
 const retry=await f.flow.scan();
 assert.equal(retry.sent,1);assert.equal(f.getJob(0).status,'已沟通');assert.equal(f.store.deliveryCount(),3);
});

test('a closed job becomes 不合适 without quota and is not contacted again',async t=>{
 const f=fixture(t);
 failFirstContact(f,async()=>{throw coded('岗位已关闭或下线，未发起沟通','JOB_CLOSED',{notSent:true});});
 const result=await f.flow.scan(),first=f.getJob(0);
 assert.equal(result.phase,'本轮已完成');assert.equal(result.sent,2);assert.equal(result.skipped,1);
 assert.equal(first.status,'不合适');assert.equal(first.jobClosed,true);assert.equal(f.ledger(first.id),undefined);
 await f.flow.scan();assert.equal(f.contacts.filter(url=>url===first.url).length,1);
});

test('one unconfirmed click is marked 待核实 and the batch continues; two in a row pause',async t=>{
 const f=fixture(t);
 failFirstContact(f,async job=>({verified:false,reason:'已点击沟通，但 8 秒内页面未确认成功'}));
 const result=await f.flow.scan(),first=f.getJob(0);
 assert.equal(result.phase,'本轮已完成');assert.equal(result.sent,2);assert.equal(result.uncertain,1);
 assert.equal(first.status,'待核实');assert.ok(first.attemptedAt);assert.equal(f.ledger(first.id),'uncertain');
 assert.match(result.message,/待核实/);
 const again=await f.flow.scan();assert.equal(again.duplicates,3);assert.equal(f.contacts.filter(url=>url===first.url).length,1);

 const g=fixture(t);g.browser.communicate=async job=>{g.contacts.push(job.url);return {verified:false,reason:'未确认'};};
 const paused=await g.flow.scan();
 assert.equal(paused.phase,'已暂停');assert.match(paused.error,/连续 2 个岗位/);assert.equal(paused.uncertain,2);
 assert.equal(g.contacts.length,2);assert.equal(g.store.jobs().filter(job=>job.status==='待核实').length,2);
});

test('click-time failures without a no-send guarantee stay 待核实 and pause',async t=>{
 for(const error of [Error('unknown click transport failure'),coded('点击沟通后 BOSS 提示今日沟通已达上限','RATE_LIMITED'),coded('点击后要求验证','VERIFICATION_REQUIRED')]){
  const f=fixture(t);f.browser.communicate=async job=>{f.contacts.push(job.url);throw error;};
  const result=await f.flow.scan(),first=f.getJob(0);
  assert.equal(result.phase,'已暂停',error.message);assert.equal(first.status,'待核实');assert.equal(f.ledger(first.id),'uncertain');
  assert.equal(f.contacts.length,1);
 }
});

test('verification or platform limits seen before the click pause, but the job stays retryable',async t=>{
 for(const code of ['VERIFICATION_REQUIRED','RATE_LIMITED']){
  const f=fixture(t);f.browser.communicate=async job=>{f.contacts.push(job.url);throw coded('blocked '+code,code,{notSent:true});};
  const result=await f.flow.scan(),first=f.getJob(0);
  assert.equal(result.phase,'已暂停',code);assert.equal(first.status,'合适');assert.equal(f.ledger(first.id),undefined);
  assert.equal(f.store.deliveryCount(),0);
 }
});

test('the daily limit stops before spending another analysis and says how to raise it',async t=>{
 const f=fixture(t,{settings:{dailyLimit:2}});
 const result=await f.flow.scan();
 assert.equal(result.phase,'今日已达上限');assert.equal(result.sent,2);assert.match(result.error,/2\/2.*每日沟通上限/);
 assert.equal(f.getJob(2),undefined);
});

test('five systemic skips in a row pause instead of burning through the list',async t=>{
 const world=new SimulationBrowser(fs.mkdtempSync(path.join(os.tmpdir(),'continuous-delivery-'))).world();
 const f=fixture(t,{pick:[0,4,5,0,4,5]});
 const jobs=[0,4,5,0,4,5].map((index,n)=>({...world.jobs[index],url:`https://www.zhipin.com/job_detail/streak-${n}.html`}));
 const w=f.browser.world();w.jobs=jobs;f.browser.save(w);
 f.browser.communicate=async job=>{f.contacts.push(job.url);throw coded('页面未加载','CHAT_BUTTON_MISSING',{notSent:true});};
 const result=await f.flow.scan();
 assert.equal(result.phase,'已暂停');assert.match(result.error,/连续 5 个岗位/);assert.equal(result.failed,5);
 assert.equal(f.contacts.length,5);assert.equal(f.store.deliveryCount(),0);
});

test('a late-loading infinite list gets more scroll rounds before the search is considered finished',async t=>{
 const f=fixture(t);let rounds=0;
 f.browser.readJobs=async()=>({jobs:rounds<2?f.jobs.slice(0,1):f.jobs,blocked:''});
 f.browser.nextPage=async()=>++rounds<4;
 const result=await f.flow.scan();
 assert.equal(result.phase,'本轮已完成');assert.equal(result.seen,3);assert.equal(result.sent,3);
});

test('fallback mode: a no-match job is contacted with the platform greeting and keeps its draft for review',async t=>{
 const f=fixture(t,{settings:{personalizedGreeting:true},pick:[0,4]});
 const w=f.browser.world();
 w.jobs[0].description='【虚构演练岗位】负责仓库盘点、物流配送调度和出入库管理，熟悉 WMS 系统与叉车操作规范，要求吃苦耐劳。';f.browser.save(w);
 const result=await f.flow.scan(),first=f.getJob(0),second=f.getJob(1);
 assert.equal(result.phase,'本轮已完成');assert.equal(result.error,null);assert.equal(result.sent,2);assert.equal(result.personalizedPaused,false);
 assert.equal(first.status,'已沟通');assert.equal(first.greeting.status,'草稿');assert.equal(first.greeting.reviewRequired,true);
 assert.equal(second.status,'已沟通');assert.equal(second.greeting.status,'已发送');
});

test('fallback mode: an unverifiable chat page pauses only personalized greetings, never contact',async t=>{
 const f=fixture(t,{settings:{personalizedGreeting:true}});let checks=0,greetings=0;
 f.browser.assertGreetingAvailable=async()=>{checks++;throw coded('未能核对唯一岗位对应的 HR，确认未发送','GREETING_TARGET_UNAVAILABLE',{notSent:true});};
 const send=f.browser.sendJobGreeting.bind(f.browser);f.browser.sendJobGreeting=async(...args)=>{greetings++;return send(...args);};
 const result=await f.flow.scan();
 assert.equal(result.phase,'本轮已完成');assert.equal(result.error,null);assert.equal(result.communicationDeferred,false);
 assert.equal(result.personalizedPaused,true);assert.equal(result.sent,3);assert.equal(checks,1);assert.equal(greetings,0);
 assert.match(result.message,/专属招呼本轮已暂停.*BOSS 默认招呼/);
 // The first job's draft was prepared before the check failed; later jobs are
 // contacted plainly without spending AI on drafts BOSS's opening would block.
 for(const index of [0,1,2])assert.equal(f.getJob(index).status,'已沟通');
 assert.equal(f.getJob(0).greeting.status,'草稿');assert.equal(f.getJob(1).greeting,undefined);
});

test('fallback mode: an unconfirmed personalized send after contact pauses greetings but keeps contacting',async t=>{
 const f=fixture(t,{settings:{personalizedGreeting:true}});let attempts=0;
 f.browser.sendJobGreeting=async(job,text,options)=>{attempts++;options.onAttempt();return {verified:false,code:'GREETING_UNCERTAIN',reason:'未取得唯一、已确认的新消息回执'};};
 const result=await f.flow.scan(),first=f.getJob(0);
 assert.equal(result.phase,'本轮已完成');assert.equal(result.sent,3);assert.equal(attempts,1);assert.equal(result.personalizedPaused,true);
 assert.equal(first.status,'已沟通');assert.equal(first.greeting.status,'待核实');
 const ledgers=f.store.db.prepare("SELECT value FROM metadata WHERE id LIKE 'job-greeting-delivery:%'").all();
 assert.equal(ledgers.length,1);assert.equal(JSON.parse(ledgers[0].value).status,'待核实');
 await assert.rejects(f.flow.greetings.send(first.id),/不会重复发送/);
});

test('fallback mode still pauses on login, verification, limits and ambiguous pre-contact failures',async t=>{
 for(const [code,notSent] of [['AUTH_REQUIRED',true],['VERIFICATION_REQUIRED',true],['RATE_LIMITED',true],['GREETING_TARGET_UNAVAILABLE',false]]){
  const f=fixture(t,{settings:{personalizedGreeting:true}});
  f.browser.assertGreetingAvailable=async()=>{throw coded(code,code,{notSent});};
  const result=await f.flow.scan();
  assert.equal(result.phase,'已暂停',code);assert.deepEqual(f.contacts,[]);assert.equal(f.store.deliveryCount(),0);
 }
});

async function aiServer(t,handler){
 const server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>handler(req,res,body));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 return 'http://127.0.0.1:'+server.address().port;
}
const answer=(res,content)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content}}]}));};
function realModeFixture(t,base){
 const f=fixture(t,{simulation:false,options:{aiRetryDelays:[0,0]},settings:{aiBase:base,aiModel:'fixture-model',activityEnabled:false}});
 const readJobs=f.browser.readJobs.bind(f.browser);
 f.browser.readJobs=async(...args)=>{const r=await readJobs(...args);return {...r,jobs:r.jobs.map(({simulation,...job})=>job)};};
 return f;
}

test('transient AI failures are retried; a job that keeps failing is skipped and the batch continues',async t=>{
 const calls={};
 const base=await aiServer(t,(req,res,body)=>{
  const title=JSON.parse(JSON.parse(body).messages[1].content).job.title;calls[title]=(calls[title]||0)+1;
  if(title==='采购专员'){res.writeHead(503);return res.end();}
  if(title==='采购工程师'&&calls[title]===1){res.writeHead(429);return res.end();}
  answer(res,'{"suitable":true,"score":90,"reason":"fixture"}');
 });
 const f=realModeFixture(t,base);
 const result=await f.flow.scan();
 assert.equal(result.phase,'本轮已完成');assert.equal(result.error,null);
 assert.equal(calls['采购专员'],3);assert.equal(calls['采购工程师'],2);
 assert.equal(f.getJob(0).status,'分析失败');assert.match(f.getJob(0).reason,/AI 暂时不可用.*已重试 2 次.*503/);
 assert.equal(f.getJob(1).status,'已沟通');assert.equal(f.getJob(2).status,'已沟通');assert.equal(result.failed,1);
});

test('a non-transient AI error (bad key or balance) still pauses the batch',async t=>{
 const base=await aiServer(t,(req,res)=>{res.writeHead(401);res.end();});
 const f=realModeFixture(t,base);
 const result=await f.flow.scan();
 assert.equal(result.phase,'已暂停');assert.match(result.error,/HTTP 401/);assert.deepEqual(f.contacts,[]);
});

test('chat() marks network, 5xx/429 and malformed answers as transient but not 4xx',async t=>{
 let status=503;
 const base=await aiServer(t,(req,res)=>{if(status===200)return answer(res,'');res.writeHead(status);res.end();});
 const s={aiBase:base,aiModel:'m'};
 await assert.rejects(chat(s,[]),{code:'AI_HTTP_ERROR',status:503,transient:true});
 status=429;await assert.rejects(chat(s,[]),{transient:true});
 status=402;await assert.rejects(chat(s,[]),{status:402,transient:false});
 status=200;await assert.rejects(chat(s,[]),{code:'AI_EMPTY',transient:true});
 await assert.rejects(chat({aiBase:'http://127.0.0.1:9',aiModel:'m'},[]),{code:'AI_NETWORK',transient:true});
});

test('releaseDelivery only returns pending reservations; the daily-limit error is coded',async t=>{
 const f=fixture(t);
 f.store.reserveDelivery('a',2);assert.equal(f.store.releaseDelivery('a'),true);assert.equal(f.store.deliveryCount(),0);
 f.store.reserveDelivery('b',2);f.store.finishDelivery('b','uncertain');assert.equal(f.store.releaseDelivery('b'),false);
 f.store.reserveDelivery('c',2);
 assert.throws(()=>f.store.reserveDelivery('d',2),{code:'DAILY_LIMIT',notSent:true});
});

// ---- Browser.communicate against a scripted page ----
function scriptedBrowser({states,confirmations,clickResult={clicked:true,marks:0}}){
 const b=new Browser('unused-fixture-directory'),log=[];
 b.navigate=async()=>{log.push('navigate');b.activeTargetId='fixed-job';};
 b.targets=async()=>[{id:'fixed-job',type:'page',url:job.url}];
 b.evaluate=async(fn,...args)=>{
  if(fn===chatButtonStateDOM){const s=states.length>1?states.shift():states[0];log.push('state:'+s);if(s instanceof Error)throw s;return s;}
  if(fn===clickChatButtonDOM){log.push('click');if(clickResult instanceof Error)throw clickResult;return clickResult;}
  if(fn===chatConfirmationDOM){const s=confirmations.length>1?confirmations.shift():confirmations[0];log.push('confirm:'+s+':'+args[0]);if(s instanceof Error)throw s;return s;}
  throw Error('unexpected evaluate');
 };
 b.command=async(method,params,target,{guard}={})=>{
  assert.equal(method,'Runtime.evaluate');assert.equal(target.id,'fixed-job');guard?.();
  const fn=[chatButtonStateDOM,clickChatButtonDOM,chatConfirmationDOM].find(fn=>params.expression.startsWith('('+fn.toString()+')('));
  assert.ok(fn);const prefix='('+fn.toString()+')(';
  const args=JSON.parse('['+params.expression.slice(prefix.length,-1)+']');
  return {result:{value:await b.evaluate(fn,...args)}};
 };
 return {b,log};
}
const job={url:'https://www.zhipin.com/job_detail/fixture.html',title:'虚构岗位'};
const fast={readyTimeoutMs:300,confirmTimeoutMs:900,pollMs:5};
const contextLost=()=>Object.assign(Error('Execution context was destroyed.'),{code:'CDP_ERROR'});

test('communicate waits for the button to render and for the confirmation instead of judging once',async()=>{
 const {b,log}=scriptedBrowser({states:['loading','missing','ready'],confirmations:['pending','pending','sent'],clickResult:{clicked:true,marks:1}});
 const result=await b.communicate(job,fast);
 assert.equal(result.verified,true);
 assert.deepEqual(log.filter(x=>x.startsWith('state')),['state:loading','state:missing','state:ready']);
 assert.equal(log.filter(x=>x==='click').length,1);assert.ok(log.includes('confirm:sent:1'));
});

test('communicate reports already-contacted, closed and missing pages as notSent without clicking',async()=>{
 for(const [state,code] of [['already','ALREADY_CONTACTED'],['closed','JOB_CLOSED'],['missing','CHAT_BUTTON_MISSING'],['loading','CHAT_BUTTON_MISSING'],['blocked','VERIFICATION_REQUIRED'],['limit','RATE_LIMITED']]){
  const {b,log}=scriptedBrowser({states:[state],confirmations:['sent']});
  await assert.rejects(b.communicate(job,fast),{code,notSent:true});
  assert.equal(log.includes('click'),false,state);
 }
});

test('communicate keeps a click that never confirms uncertain, and post-click limits are not notSent',async()=>{
 let {b}=scriptedBrowser({states:['ready'],confirmations:['pending']});
 const result=await b.communicate(job,fast);assert.equal(result.verified,false);assert.match(result.reason,/未确认成功/);
 for(const [state,code] of [['limit','RATE_LIMITED'],['blocked','VERIFICATION_REQUIRED']]){
  ({b}=scriptedBrowser({states:['ready'],confirmations:[state]}));
  await assert.rejects(b.communicate(job,fast),error=>error.code===code&&error.notSent!==true);
 }
});

test('communicate keeps a lost click response uncertain and never invents confirmation or retries',async()=>{
 const {b,log}=scriptedBrowser({states:[contextLost(),'ready'],confirmations:[contextLost(),'sent'],clickResult:contextLost()});
 await assert.rejects(b.communicate(job,fast),error=>error.code==='CDP_ERROR'&&error.notSent!==true&&error.uncertain===true);
 assert.equal(log.filter(x=>x==='click').length,1);assert.equal(log.some(x=>x.startsWith('confirm:')),false);
});

// ---- the in-page readers against a tiny fake DOM ----
function fakePage({body,buttons=[],path='/job_detail/x.html',readyState='complete'}){
 const elements=buttons.map(text=>({innerText:text,attrs:{},clicked:0,getBoundingClientRect:()=>({height:20}),
  setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k]??null;},click(){this.clicked++;}}));
 globalThis.document={readyState,body:{innerText:body},querySelectorAll:()=>elements,
  querySelector:sel=>elements.find(e=>sel.includes('data-abj-chat')&&e.attrs['data-abj-chat']==='clicked')||null};
 globalThis.location=new URL('https://www.zhipin.com'+path);
 return elements;
}
test('page readers classify job pages and confirm only on new continue markers',t=>{
 t.after(()=>{delete globalThis.document;delete globalThis.location;});
 fakePage({body:'岗位职责……',buttons:['感兴趣',' 立即沟通 ']});assert.equal(chatButtonStateDOM(),'ready');
 fakePage({body:'岗位职责……',buttons:['继续沟通']});assert.equal(chatButtonStateDOM(),'already');
 fakePage({body:'该职位已关闭',buttons:['返回']});assert.equal(chatButtonStateDOM(),'closed');
 fakePage({body:'',buttons:[]});assert.equal(chatButtonStateDOM(),'loading');
 fakePage({body:'请完成安全验证',buttons:['立即沟通']});assert.equal(chatButtonStateDOM(),'blocked');
 const [button]=fakePage({body:'推荐：已沟通 岗位职责',buttons:['立即沟通']});
 assert.deepEqual(clickChatButtonDOM('/job_detail/x.html','fixture-attempt'),{clicked:true,marks:1});assert.equal(button.clicked,1);
 assert.equal(chatConfirmationDOM(1,'/job_detail/x.html','fixture-attempt'),'pending');
 button.innerText='继续沟通';assert.equal(chatConfirmationDOM(1,'/job_detail/x.html','fixture-attempt'),'sent');
 fakePage({body:'推荐：已沟通 已向BOSS发送消息 继续沟通',buttons:['立即沟通']});assert.equal(chatConfirmationDOM(1,'/job_detail/x.html','fixture-attempt'),'pending');
 fakePage({body:'今日沟通人数已达上限',buttons:['立即沟通']});assert.equal(chatConfirmationDOM(0),'limit');
 fakePage({body:'',path:'/web/geek/chat'});assert.equal(chatConfirmationDOM(0,'/job_detail/x.html','fixture-attempt'),'sent');
});

// ---- added: wrong-page safety and slow job pages ----
test('communicate never judges or clicks a page that is not the target job',async()=>{
 const {b,log}=scriptedBrowser({states:['redirected'],confirmations:['sent']});
 const seenArgs=[];const evaluate=b.evaluate;b.evaluate=async(fn,...args)=>{if(fn===chatButtonStateDOM)seenArgs.push(args[0]);return evaluate(fn,...args);};
 await assert.rejects(b.communicate(job,fast),{code:'JOB_REDIRECTED',notSent:true});
 assert.equal(log.includes('click'),false);assert.ok(seenArgs.length>1);assert.ok(seenArgs.every(arg=>arg==='/job_detail/fixture.html'));
});

test('page readers report a redirect and refuse to click on another job page',t=>{
 t.after(()=>{delete globalThis.document;delete globalThis.location;});
 fakePage({body:'岗位职责……',buttons:['立即沟通'],path:'/job_detail/other.html'});
 assert.equal(chatButtonStateDOM('/job_detail/target.html'),'redirected');
 const [button]=fakePage({body:'岗位职责……',buttons:['立即沟通'],path:'/job_detail/other.html'});
 assert.equal(clickChatButtonDOM('/job_detail/target.html'),false);assert.equal(button.clicked,0);
 fakePage({body:'岗位职责……',buttons:['立即沟通'],path:'/job_detail/target.html'});
 assert.equal(chatButtonStateDOM('/job_detail/target.html'),'ready');
 fakePage({body:'请完成安全验证',path:'/web/passport/zp/security.html'});
 assert.equal(chatButtonStateDOM('/job_detail/target.html'),'blocked');
});

test('a job page that does not answer in time is a per-job navigation failure; other pages keep their error',async()=>{
 for(const code of ['BROWSER_TIMEOUT','CDP_COMMAND_TIMEOUT']){
  const browser=new Browser('unused-test-directory');browser.port=1;browser.detailTargetId='detail';
  browser.targets=async()=>[{id:'detail',type:'page',url:'about:blank'},{id:'main',type:'page',url:'https://www.zhipin.com/web/geek/jobs'}];
  browser.command=async()=>{throw coded('等待超时',code);};
  await assert.rejects(browser.navigate('https://www.zhipin.com/job_detail/slow.html'),{code:'NAVIGATION_FAILED',notSent:true});
  await assert.rejects(browser.navigate('https://www.zhipin.com/web/geek/jobs?query=test'),{code});
 }
});

test('a redirected job page is skipped with its quota returned and the batch continues',async t=>{
 const f=fixture(t);
 failFirstContact(f,async()=>{throw coded('岗位页面跳转到了其他页面（可能已下线），未在其他页面点击沟通','JOB_REDIRECTED',{notSent:true});});
 const result=await f.flow.scan(),first=f.getJob(0);
 assert.equal(result.phase,'本轮已完成');assert.equal(result.sent,2);assert.equal(result.failed,1);
 assert.equal(first.status,'分析失败');assert.match(first.reason,/页面跳转/);assert.equal(f.ledger(first.id),undefined);
});
