import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createChatGPTPlanClient,readPlanResponse} from '../lib/chatgpt-plan.mjs';
import {chat,models,configureChatGPTPlan} from '../lib/ai.mjs';
const finished=text=>({type:'response.completed',response:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]}});
const stream=(events,{byteChunks=false}={})=>{
 const bytes=new TextEncoder().encode(events.map(event=>'data: '+JSON.stringify(event)+'\r\n\r\n').join(''));
 return new Response(new ReadableStream({start(controller){if(byteChunks)for(const byte of bytes)controller.enqueue(Uint8Array.of(byte));else controller.enqueue(bytes);controller.close();}}),{headers:{'Content-Type':'text/event-stream'}});
};
test('plan client uses only granted bearer and public Responses API with documented fields',async()=>{
 const calls=[],auth={identityKey:()=> 'account-a',accessToken:async()=> 'own-oauth-token'};
 const client=createChatGPTPlanClient(auth,{fetchImpl:async(url,options)=>{
  calls.push({url,options});
  if(url.endsWith('/models'))return Response.json({models:[{slug:'available-model',visibility:'list'},{slug:'hidden-model',visibility:'hide'}]});
  return stream([finished('有效结论')],{byteChunks:true});
 }});
 const result=await client.chat({chatgptModel:'available-model',apiKey:'must-not-use',aiBase:'https://untrusted.invalid'},[{role:'system',content:'规则'},{role:'user',content:'测试资料'}]);
 assert.equal(result,'有效结论');assert.equal(calls.length,2);
 assert.equal(calls[1].url,'https://api.openai.com/v1/responses');
 assert.deepEqual(JSON.parse(calls[1].options.body),{model:'available-model',input:[{role:'developer',content:'规则'},{role:'user',content:'测试资料'}],store:false,stream:true});
 assert.equal(calls[1].options.headers.Authorization,'Bearer own-oauth-token');
 assert.equal(calls[1].options.redirect,'error');
});
test('partial text is never accepted on quota, interrupted, malformed or incomplete stream',async()=>{
 const delta={type:'response.output_text.delta',delta:'cannot trust partial'};
 for(const events of [[delta],[delta,{type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded'}}}],
  [delta,{type:'response.incomplete'}],[finished(''),finished('later')],[{...finished('text'),response:{status:'failed'}}]]){
  await assert.rejects(readPlanResponse(stream(events)));
 }
 await assert.rejects(readPlanResponse(stream([delta,{type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded'}}}])),{code:'CHATGPT_USAGE_LIMIT'});
 await assert.rejects(readPlanResponse(new Response('data: {broken}\n\n')));
});
test('unauthorized, unavailable or unknown model never produces an inference request',async()=>{
 let count=0;const auth={identityKey:()=> 'a',accessToken:async()=>{throw Error('not authorized');}};
 const client=createChatGPTPlanClient(auth,{fetchImpl:async()=>{count++;throw Error('must not call');}});
 await assert.rejects(client.chat({chatgptModel:'x'},[]));assert.equal(count,0);
 const listed=createChatGPTPlanClient({...auth,accessToken:async()=> 'test'},{fetchImpl:async()=>{count++;return Response.json({models:[{slug:'available',visibility:'list'}]});}});
 await assert.rejects(listed.chat({chatgptModel:'guessed'},[]),{code:'CHATGPT_MODEL_REQUIRED'});assert.equal(count,1);
});
test('switching accounts invalidates cached model entitlement and in-flight output',async()=>{
 let account='one',requests=0;
 const auth={identityKey:()=>account,accessToken:async()=>account+'token'};
 const client=createChatGPTPlanClient(auth,{fetchImpl:async url=>{
  if(url.endsWith('/models')){requests++;return Response.json({models:[{slug:account+'model',visibility:'list'}]});}
  account='changed';return stream([finished('old-account-result')]);
 }});
 await client.models();account='two';
 await assert.rejects(client.chat({chatgptModel:'onemodel'},[]),{code:'CHATGPT_MODEL_REQUIRED'});assert.equal(requests,2);
 await assert.rejects(client.chat({chatgptModel:'twomodel'},[]),{code:'CHATGPT_AUTH_CHANGED'});
});
test('AI provider routes analysis/greetings through plan client and never silently falls back',async()=>{
 configureChatGPTPlan({chat:async()=>{throw Object.assign(Error('plan limit'),{code:'CHATGPT_USAGE_LIMIT'});},models:async()=>['plan-model']});
 try{
  assert.deepEqual(await models({aiProvider:'chatgpt-plan'}),['plan-model']);
  await assert.rejects(chat({aiProvider:'chatgpt-plan',apiKey:'must-not-use',aiBase:'https://untrusted.invalid'},[]),{code:'CHATGPT_USAGE_LIMIT'});
  await assert.rejects(chat({aiProvider:'bogus'},[]),/无效/);
 }finally{configureChatGPTPlan(null);}
});

test('account changes during catalog retrieval cannot assign old model permissions to new account',async()=>{
 let account='one',release;
 const auth={identityKey:()=>account,accessToken:async()=>account+'token'};
 const client=createChatGPTPlanClient(auth,{fetchImpl:()=>new Promise(resolve=>{release=resolve;})});
 const first=client.models();await new Promise(resolve=>setImmediate(resolve));account='two';
 release(Response.json({models:[{slug:'one-only',visibility:'list'}]}));
 await assert.rejects(first,{code:'CHATGPT_AUTH_CHANGED'});
 const next=client.chat({chatgptModel:'one-only'},[]);await new Promise(resolve=>setImmediate(resolve));
 release(Response.json({models:[{slug:'two-only',visibility:'list'}]}));
 await assert.rejects(next,{code:'CHATGPT_MODEL_REQUIRED'});
});
test('completed output must contain literal strings, never object coercion',async()=>{
 await assert.rejects(readPlanResponse(stream([finished({text:'invalid object'})])));
});

test('plan text deltas are retained when completed carries no repeated output',async()=>{
 const events=[{type:'response.output_text.delta',output_index:0,content_index:0,delta:'连接'},
  {type:'response.output_text.delta',output_index:0,content_index:0,delta:'成功'},
  {type:'response.output_text.done',output_index:0,content_index:0,text:'连接成功'}];
 for(const output of [[],undefined])assert.equal(await readPlanResponse(stream([...events,{type:'response.completed',response:{status:'completed',output}}],{byteChunks:true})),'连接成功');
 await assert.rejects(readPlanResponse(stream(events)),/完成前中断/);
 await assert.rejects(readPlanResponse(stream([...events,{type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded'}}}])),{code:'CHATGPT_USAGE_LIMIT'});
});

test('streamed content keeps output ordering and rejects malformed or post-completion text',async()=>{
 const delta=(index,text)=>({type:'response.output_text.delta',output_index:index,content_index:0,delta:text});
 const complete={type:'response.completed',response:{status:'completed',output:[]}};
 assert.equal(await readPlanResponse(stream([delta(1,'第二条'),delta(0,'第一条'),complete])),'第一条\n第二条');
 for(const events of [[delta(0,{text:'object'}),complete],[delta(-1,'text'),complete],[delta(0,'text'),complete,delta(0,'extra')],
  [delta(0,'text'),{type:'response.incomplete'}],[delta(0,'text'),complete,{type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded'}}}]])await assert.rejects(readPlanResponse(stream(events)));
});

test('nonempty terminal refusal or malformed output never falls back to earlier text',async()=>{
 const delta={type:'response.output_text.delta',delta:'earlier fragment'};
 for(const output of [[{type:'message',role:'assistant',content:[{type:'refusal',refusal:'refused'}]}],
  [{type:'function_call',name:'unexpected'}],[{type:'message',role:'assistant',content:[]}],
  [{type:'message',role:'assistant',content:'malformed'}]]){
  await assert.rejects(readPlanResponse(stream([delta,{type:'response.completed',response:{status:'completed',output}}])));
 }
});

const listed=()=>Response.json({models:[{slug:'allowed',visibility:'list'}]});
const networkError=(code='UND_ERR_SOCKET')=>new TypeError('fetch failed',{cause:Object.assign(Error('sensitive-upstream-url-and-token'),{code})});
function retryFixture(fetchImpl){
 let time=0,identity='account-a',tokenCalls=0;const waits=[],calls=[];
 const auth={identityKey:()=>identity,accessToken:async()=>{tokenCalls++;return 'private-token-never-in-errors';}};
 const clock={now:()=>time,advance:ms=>{time+=ms;}};
 const client=createChatGPTPlanClient(auth,{fetchImpl:async(url,options)=>{calls.push({url,options});return fetchImpl(url,options,calls.length,clock);},
  now:clock.now,waitImpl:async ms=>{waits.push(ms);clock.advance(ms);}});
 return {client,calls,waits,clock,auth,changeAccount:()=>{identity='account-b';},tokenCalls:()=>tokenCalls};
}

test('transient model-list network failures retry with a single deadline and unchanged account bearer',async()=>{
 const h=retryFixture((url,options,count)=>{if(count===1)throw networkError('ECONNRESET');return listed();});
 assert.deepEqual(await h.client.models(),['allowed']);assert.equal(h.calls.length,2);assert.deepEqual(h.waits,[1000]);
 assert.equal(h.calls[0].options.signal,h.calls[1].options.signal);
 assert.equal(h.calls[0].options.headers.Authorization,h.calls[1].options.headers.Authorization);
 assert.ok(h.calls.every(call=>call.url==='https://api.openai.com/v1/models'));
});

test('exhausted model-list retries report only safe Chinese step, code and attempt count',async()=>{
 const h=retryFixture(()=>{throw networkError('UND_ERR_CONNECT_TIMEOUT');});
 await assert.rejects(h.client.models(),error=>{
  assert.equal(error.code,'CHATGPT_NETWORK_ERROR');assert.equal(error.step,'models');assert.equal(error.attempts,3);
  assert.equal(error.networkCode,'UND_ERR_CONNECT_TIMEOUT');assert.match(error.message,/UND_ERR_CONNECT_TIMEOUT/);
  assert.match(error.message,/模型列表/);assert.match(error.message,/已尝试 3 次/);assert.match(error.message,/CHATGPT_NETWORK_ERROR/);
  for(const secret of ['sensitive-upstream','private-token','https://','fetch failed'])assert.equal(error.message.includes(secret),false);
  assert.equal(error.cause,undefined);return true;
 });
 assert.equal(h.calls.length,3);assert.deepEqual(h.waits,[1000,2000]);
});

test('temporary HTTP service failures retry; successful inference contains only the completed retry output',async()=>{
 let responseCalls=0;const h=retryFixture(url=>{
  if(url.endsWith('/models'))return listed();
  responseCalls++;if(responseCalls===1)return Response.json({error:{message:'secret-response-body'}},{status:503});
  if(responseCalls===2)return Response.json({error:{message:'other-secret'}},{status:502});
  return stream([finished('third-attempt-only')]);
 });
 assert.equal(await h.client.chat({chatgptModel:'allowed',apiKey:'must-not-use'},[]),'third-attempt-only');
 assert.equal(responseCalls,3);assert.deepEqual(h.waits,[1000,2000]);
 assert.ok(h.calls.every(call=>call.url.startsWith('https://api.openai.com/v1/')));
});

test('HTTP quota and authorization errors never retry or fall back to another provider',async()=>{
 for(const [status,code] of [[401,'CHATGPT_AUTH_REQUIRED'],[403,'CHATGPT_ACCESS_DENIED'],[429,'CHATGPT_USAGE_LIMIT'],[400,'CHATGPT_REQUEST_FAILED']]){
  const h=retryFixture(()=>Response.json({error:{message:'sensitive-api-error'}},{status}));
  await assert.rejects(h.client.models(),error=>error.code===code&&error.attempts===1&&!error.message.includes('sensitive-api-error'));
  assert.equal(h.calls.length,1);assert.deepEqual(h.waits,[]);
 }
 const h=retryFixture(()=>Response.json({error:{code:'subscription_sharing_usage_limit_exceeded'}},{status:503}));
 await assert.rejects(h.client.models(),{code:'CHATGPT_USAGE_LIMIT',attempts:1});assert.equal(h.calls.length,1);
});

test('TLS certificate failures take precedence over fetch-failed/network wrappers and never retry',async()=>{
 for(const code of ['CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_VERIFY_LEAF_SIGNATURE']){
  const h=retryFixture(()=>{throw Object.assign(networkError(code),{code:'ECONNRESET'});});
  await assert.rejects(h.client.models(),{code:'CHATGPT_TLS_ERROR',step:'models',attempts:1});
  assert.equal(h.calls.length,1);assert.deepEqual(h.waits,[]);
 }
});

test('model schema or JSON failures do not retry while socket errors during JSON reading do',async()=>{
 for(const make of [()=>Response.json({models:[null]}),()=>Response.json({data:[]}),()=>new Response('{invalid JSON')]){
  const h=retryFixture(make);await assert.rejects(h.client.models(),{code:'CHATGPT_REQUEST_FAILED',attempts:1});assert.equal(h.calls.length,1);assert.deepEqual(h.waits,[]);
 }
 const h=retryFixture((url,options,count)=>count===1?new Response(new ReadableStream({start(controller){controller.error(networkError());}})):listed());
 assert.deepEqual(await h.client.models(),['allowed']);assert.equal(h.calls.length,2);
});

test('socket error while reading SSE permits a fresh generation and discards the earlier partial text',async()=>{
 let generations=0;const h=retryFixture(url=>{
  if(url.endsWith('/models'))return listed();
  if(++generations>1)return stream([finished('verified-new-answer')]);
  let pulls=0;return new Response(new ReadableStream({pull(controller){
   if(pulls++===0)controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'response.output_text.delta',delta:'must-not-leak-partial'})+'\n\n'));
   else controller.error(networkError('UND_ERR_SOCKET'));
  }}));
 });
 assert.equal(await h.client.chat({chatgptModel:'allowed'},[]),'verified-new-answer');assert.equal(generations,2);assert.deepEqual(h.waits,[1000]);
});

test('clean EOF without completion and semantic SSE errors are not retried as network failures',async()=>{
 const delta={type:'response.output_text.delta',delta:'untrusted partial'};
 for(const make of [()=>stream([delta]),()=>new Response('data: {malformed}\n\n'),
  ()=>stream([delta,{type:'response.incomplete'}]),()=>stream([finished('ready'),delta]),
  ()=>stream([delta,{type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded'}}}])]){
  let generations=0;const h=retryFixture(url=>{if(url.endsWith('/models'))return listed();generations++;return make();});
  await assert.rejects(h.client.chat({chatgptModel:'allowed'},[]),error=>error.step==='responses'&&error.attempts===1);
  assert.equal(generations,1);assert.deepEqual(h.waits,[]);
 }
});

test('switching accounts after a failed request aborts retries before another token or request',async()=>{
 let h;h=retryFixture(()=>{h.changeAccount();throw networkError();});
 await assert.rejects(h.client.models(),{code:'CHATGPT_AUTH_CHANGED',step:'models',attempts:1});
 assert.equal(h.calls.length,1);assert.equal(h.tokenCalls(),1);assert.deepEqual(h.waits,[]);
});

test('switching accounts during retry backoff prevents retrying under the new account',async()=>{
 let identity='before',requests=0,tokens=0;
 const client=createChatGPTPlanClient({identityKey:()=>identity,accessToken:async()=>{tokens++;return 'fixture';}},
  {fetchImpl:async()=>{requests++;throw networkError();},waitImpl:async()=>{identity='after';}});
 await assert.rejects(client.models(),{code:'CHATGPT_AUTH_CHANGED',attempts:1});assert.equal(requests,1);assert.equal(tokens,1);
});

test('auth refresh/identity errors are not retried by the AI transport layer',async()=>{
 let tokens=0,requests=0;
 const client=createChatGPTPlanClient({identityKey:()=> 'same',accessToken:async()=>{tokens++;throw Object.assign(Error('do-not-display-raw-token'),{code:'CHATGPT_AUTH_NETWORK'});}},
  {fetchImpl:async()=>{requests++;return listed();},waitImpl:async()=>assert.fail('auth failure must not back off')});
 await assert.rejects(client.models(),error=>error.code==='CHATGPT_AUTH_NETWORK'&&error.attempts===1&&!error.message.includes('do-not-display'));
 assert.equal(tokens,1);assert.equal(requests,0);
});

test('models retries share a 15-second total budget including backoff and body work',async()=>{
 const h=retryFixture((url,options,count,clock)=>{clock.advance(count===1?13000:1100);throw networkError();});
 await assert.rejects(h.client.models(),{code:'CHATGPT_TIMEOUT',step:'models',attempts:2});
 assert.equal(h.calls.length,2);assert.deepEqual(h.waits,[1000]);assert.equal(h.calls[0].options.signal,h.calls[1].options.signal);
 assert.equal(h.calls[1].options.signal.aborted,true);
});

test('generation retries cannot extend the 90-second response deadline or accept late completed output',async()=>{
 let generations=0;const h=retryFixture((url,options,count,clock)=>{
  if(url.endsWith('/models'))return listed();
  generations++;clock.advance(generations===1?88000:1000);
  if(generations===1)throw networkError();return stream([finished('too-late-answer')]);
 });
 await assert.rejects(h.client.chat({chatgptModel:'allowed'},[]),{code:'CHATGPT_TIMEOUT',step:'responses',attempts:2});
 assert.equal(generations,2);assert.deepEqual(h.waits,[1000]);assert.equal(h.calls[1].options.signal,h.calls[2].options.signal);
});

test('budget exhaustion after the first failure cannot start a retry',async()=>{
 const h=retryFixture((url,options,count,clock)=>{clock.advance(15000);throw networkError();});
 await assert.rejects(h.client.models(),{code:'CHATGPT_TIMEOUT',attempts:1});assert.equal(h.calls.length,1);assert.deepEqual(h.waits,[]);
});

test('bounded AggregateError traversal retains only allowlisted network codes and prioritizes TLS',async()=>{
 const transport=new TypeError('fetch failed',{cause:new AggregateError([Object.assign(Error('secret'),{code:'ECONNREFUSED'})],'private-url')});
 let h=retryFixture(()=>{throw transport;});
 await assert.rejects(h.client.models(),{code:'CHATGPT_NETWORK_ERROR',networkCode:'ECONNREFUSED',attempts:3});
 const mixed=new TypeError('fetch failed',{cause:new AggregateError([Object.assign(Error(),{code:'ECONNRESET'}),Object.assign(Error(),{code:'CERT_HAS_EXPIRED'})])});
 h=retryFixture(()=>{throw mixed;});await assert.rejects(h.client.models(),{code:'CHATGPT_TLS_ERROR',networkCode:'CERT_HAS_EXPIRED',attempts:1});
 assert.equal(h.calls.length,1);
 const unknown=Object.assign(Error('private-token'),{code:'ERR_TLS_PRIVATE_TOKEN'});unknown.cause=unknown;
 h=retryFixture(()=>{throw unknown;});await assert.rejects(h.client.models(),error=>error.code==='CHATGPT_TLS_ERROR'&&error.networkCode===undefined&&!error.message.includes('PRIVATE_TOKEN'));
 assert.equal(h.calls.length,1);
});

test('an aborted transport never retries and remains distinct from timeout or certificate errors',async()=>{
 const h=retryFixture(()=>{throw new DOMException('private cancellation details','AbortError');});
 await assert.rejects(h.client.models(),{code:'CHATGPT_CANCELLED',attempts:1});assert.equal(h.calls.length,1);assert.deepEqual(h.waits,[]);
});

test('documented temporary subscription failures retry even when received as SSE events',async()=>{
 for(const code of ['subscription_sharing_usage_unavailable','subscription_sharing_user_unavailable']){
  let generations=0;const h=retryFixture(url=>{
   if(url.endsWith('/models'))return listed();
   if(++generations===1)return stream([{type:'response.failed',response:{error:{code}}}]);
   return stream([finished('recovered')]);
  });
  assert.equal(await h.client.chat({chatgptModel:'allowed'},[]),'recovered');assert.equal(generations,2);assert.deepEqual(h.waits,[1000]);
 }
 for(const code of ['subscription_sharing_user_not_eligible','subscription_sharing_invalid_user','subscription_sharing_unsupported_capability']){
  let generations=0;const h=retryFixture(url=>{if(url.endsWith('/models'))return listed();generations++;return stream([{type:'response.failed',response:{error:{code}}}]);});
  await assert.rejects(h.client.chat({chatgptModel:'allowed'},[]),{code:'CHATGPT_REQUEST_FAILED',attempts:1});assert.equal(generations,1);assert.deepEqual(h.waits,[]);
 }
});
