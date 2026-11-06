import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chat,analyze} from '../lib/ai.mjs';
const settings={aiProvider:'api',aiBase:'https://api.fixture.invalid/v1',apiKey:'fixture-key-not-real',aiModel:'fixture-model',resumeMatch:false,aiEnabled:true};
const reply=content=>({ok:true,json:async()=>({choices:[{message:{content}}]})});
function fakeFetch(t,impl){const prior=globalThis.fetch;t.after(()=>{globalThis.fetch=prior;});globalThis.fetch=impl;}

test('AI transient classification permits 429 and 5xx but not configuration, authorization or invalid model statuses',async t=>{
 let status;fakeFetch(t,async()=>({ok:false,status}));
 for(const [code,retry] of [[400,false],[401,false],[402,false],[403,false],[404,false],[408,true],[409,true],[425,true],[429,true],[500,true],[502,true],[503,true],[599,true],[600,false]]){
  status=code;await assert.rejects(chat(settings,[]),{code:'AI_HTTP_ERROR',status:code,transient:retry});
 }
});

test('AI network errors retain only known safe codes and never raw URL credentials or exception text',async t=>{
 let error;fakeFetch(t,async()=>{throw error;});
 for(const cause of ['ECONNRESET','sensitive-user:secret@private.invalid']){
  error=Object.assign(Error('https://secret-token@private.invalid/?key=private'),{cause:{code:cause}});
  await assert.rejects(chat(settings,[]),e=>{
   assert.equal(e.code,'AI_NETWORK');assert.equal(e.transient,true);
   assert.doesNotMatch(e.message,/secret|private|sensitive/);
   assert.equal(e.networkCode,cause==='ECONNRESET'?cause:undefined);return true;
  });
 }
});

test('invalid or credential-bearing AI URLs fail without issuing a request or marking a retryable network error',async t=>{
 fakeFetch(t,()=>assert.fail('Invalid configuration must not invoke fetch'));
 for(const aiBase of ['not-a-url','http://remote.invalid/v1','https://u:p@api.fixture.invalid/v1'])
  await assert.rejects(chat({...settings,aiBase},[]),{code:'AI_CONFIG',transient:false});
});

test('null, nonobject, malformed JSON, missing text and token limits have explicit distinct retry classifications',async t=>{
 let response;fakeFetch(t,async()=>response);
 for(const json of [null,[],17,'text']){response={ok:true,json:async()=>json};await assert.rejects(chat(settings,[]),{code:'AI_FORMAT',transient:true});}
 response={ok:true,json:async()=>{throw Error('untrusted invalid body');}};await assert.rejects(chat(settings,[]),{code:'AI_FORMAT',transient:true});
 response=reply(' ');await assert.rejects(chat(settings,[]),{code:'AI_EMPTY',transient:true});
 response={ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:'partial'}}]})};
 await assert.rejects(chat(settings,[]),{code:'AI_LENGTH',transient:false});
 response=reply('complete');assert.equal(await chat(settings,[]),'complete');
 response=reply('not-json');await assert.rejects(analyze({title:'fixture'},settings),{code:'AI_FORMAT',transient:true});
});
