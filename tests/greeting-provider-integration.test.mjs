import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateGreeting,validateGeneratedGreeting} from '../lib/greeting.mjs';
import {configureChatGPTPlan} from '../lib/ai.mjs';
import {createChatGPTPlanClient} from '../lib/chatgpt-plan.mjs';

const job={title:'采购专员',description:'岗位负责供应商开发和采购询价，跟进采购订单交付。'};
const resume='之前负责供应商开发、询价比价，也跟进过采购订单交付。';
const text='您好，贵岗位需要跟进采购和交付。我之前做过供应商开发、询价比价，也跟进过采购订单交付，希望有机会进一步沟通具体的工作安排。';
const matches=[{requirement:'供应商开发',evidence:'供应商开发、询价比价'},{requirement:'采购订单交付',evidence:'跟进过采购订单交付'}];
const reviewed={approved:true,unsupportedClaims:[],reason:'正文事实由给定简历证据支持，未增加行业背景或经验。'};
const settings={aiProvider:'chatgpt-plan',chatgptModel:'fixture-plan-model',chatgptAccountId:'fixture-account',
 apiKey:'fixture-api-key-must-not-be-used',aiBase:'https://wrong-provider.invalid/v1',aiModel:'wrong-api-model',resume};
function completed(value){
 return new Response('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[{
  type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(value)}]}]}})+'\n\n');
}
function planFixture(t,reviewResponse=()=>completed(reviewed),generation={text,matches}){
 const calls=[];let responses=0;
 const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;configureChatGPTPlan(null);});
 globalThis.fetch=async()=>assert.fail('Plan mode must never fall through to API-key fetch');
 configureChatGPTPlan(createChatGPTPlanClient({identityKey:()=>settings.chatgptAccountId,accessToken:async()=> 'fixture-oauth-token'},
  {fetchImpl:async(url,options)=>{
   calls.push({url,options});
   if(url.endsWith('/models'))return Response.json({models:[{slug:settings.chatgptModel,visibility:'list'}]});
   assert.equal(url,'https://api.openai.com/v1/responses');
   return ++responses===1?completed(generation):reviewResponse();
  }}));
 return {calls,responses:()=>responses};
}

test('natural generation and independent review use the same ChatGPT plan client and never API-key configuration',async t=>{
 const f=planFixture(t);const result=await generateGreeting(job,settings);
 assert.equal(result.text,text);assert.equal(result.generatorVersion,4);assert.equal(result.audit.approved,true);
 assert.equal(f.calls.length,3);assert.equal(f.responses(),2);
 for(const {url,options} of f.calls){
  assert.ok(url.startsWith('https://api.openai.com/v1/'));assert.equal(options.headers.Authorization,'Bearer fixture-oauth-token');
  assert.equal(options.redirect,'error');assert.doesNotMatch(JSON.stringify(options),/fixture-api-key|wrong-provider|wrong-api-model/);
 }
 for(const call of f.calls.filter(call=>call.url.endsWith('/responses'))){
  const body=JSON.parse(call.options.body);assert.equal(body.model,settings.chatgptModel);assert.equal(body.store,false);assert.equal(body.stream,true);
 }
 assert.notEqual(f.calls[1].options.body,f.calls[2].options.body,'Independent review must receive a separate task');
});

test('plan quota refusal during independent review rejects generated prose without API fallback or another inference',async t=>{
 const f=planFixture(t,()=>Response.json({error:{code:'subscription_sharing_usage_limit_exceeded'}},{status:429}));
 await assert.rejects(generateGreeting(job,settings),{code:'CHATGPT_USAGE_LIMIT'});
 assert.equal(f.calls.length,3);assert.equal(f.responses(),2);
});

test('a reviewed plan draft cannot be validated as coming from another provider or model',async t=>{
 planFixture(t);const result=await generateGreeting(job,settings);
 for(const changed of [{...settings,aiProvider:'api'}, {...settings,chatgptModel:'different-plan-model'}])
  assert.throws(()=>validateGeneratedGreeting(job,changed,result),{code:'GREETING_INVALID'});
});

test('no matching evidence returns an empty review-required draft without spending a second inference',async t=>{
 const f=planFixture(t,()=>assert.fail('No-match response must not request review'),{text:'',matches:[]});
 const result=await generateGreeting(job,settings);
 assert.equal(result.text,'');assert.deepEqual(result.matches,[]);assert.equal(result.reviewRequired,true);
 assert.equal(f.calls.length,2);assert.equal(f.responses(),1);
});

test('API mode generates and reviews only on its configured endpoint even when a plan client exists',async t=>{
 const calls=[],originalFetch=globalThis.fetch;
 t.after(()=>{globalThis.fetch=originalFetch;configureChatGPTPlan(null);});
 configureChatGPTPlan({chat:async()=>assert.fail('API mode must not call the plan provider')});
 globalThis.fetch=async(url,options)=>{
  calls.push({url:String(url),options});
  return Response.json({choices:[{message:{content:JSON.stringify(calls.length===1?{text,matches}:reviewed)}}]});
 };
 const result=await generateGreeting(job,{...settings,aiProvider:'api',aiBase:'https://api.fixture.invalid/v1',aiModel:'fixture-api-model'});
 assert.equal(result.text,text);assert.equal(calls.length,2);
 for(const call of calls){
  assert.equal(call.url,'https://api.fixture.invalid/v1/chat/completions');
  assert.equal(JSON.parse(call.options.body).model,'fixture-api-model');assert.equal(call.options.headers.Authorization,'Bearer '+settings.apiKey);
 }
});
