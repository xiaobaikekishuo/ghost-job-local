import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateKeyPairSync,sign,createHash,randomBytes,createDecipheriv} from 'node:crypto';
import {createChatGPTAuth} from '../lib/chatgpt-auth.mjs';

const ISSUER='https://auth.openai.com',TOKEN=ISSUER+'/api/accounts/oauth/token';
const DISCOVERY=ISSUER+'/.well-known/openid-configuration',JWKS=ISSUER+'/.well-known/jwks.json';
const REVOKE=ISSUER+'/api/accounts/oauth/revoke',RESOURCE='https://api.openai.com/v1';
const SCOPE='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const temporaryRoot=fileURLToPath(new URL('../work/',import.meta.url));
const pair=generateKeyPairSync('rsa',{modulusLength:2048});
const otherPair=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...pair.publicKey.export({format:'jwk'}),kid:'fixture-rsa',use:'sig',alg:'RS256'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const code=key=>({code:'CHATGPT_AUTH_'+key});
function jwt(claims,header={},privateKey=pair.privateKey){
 const prefix=[{alg:'RS256',kid:jwk.kid,...header},claims].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
 return prefix+'.'+sign('RSA-SHA256',Buffer.from(prefix),privateKey).toString('base64url');
}
function fixture(t){
 fs.mkdirSync(temporaryRoot,{recursive:true});const dataDir=fs.mkdtempSync(path.join(temporaryRoot,'ghost-chatgpt-auth-test-'));
 const calls=[],grants=new Map(),instances=[];
 const h={dataDir,calls,grants,keys:[jwk],metadata:{issuer:ISSUER,jwks_uri:JWKS,revocation_endpoint:REVOKE},serial:0};
 h.payload=(grant,extra={})=>{
  const now=Math.floor(Date.now()/1000);
  return {access_token:'opaque-access-secret-'+grant.clientId,refresh_token:'refresh-secret-'+grant.clientId,
   id_token:jwt({iss:ISSUER,aud:grant.clientId,sub:grant.sub||'subject-one',iat:now,exp:now+3600,nonce:grant.nonce,
    email:'same@example.test',name:'Example Person',...grant.claims},grant.header,grant.privateKey),
   token_type:'Bearer',expires_in:3600,scope:SCOPE,...grant.payload,...extra};
 };
 h.fetch=async(url,options={})=>{
  const call={url:String(url),options,form:options.body?Object.fromEntries(options.body):null};calls.push(call);
  if(url===DISCOVERY)return h.onDiscovery?h.onDiscovery(call):json(h.metadata);
  if(url===JWKS)return json({keys:h.keys});
  if(url===REVOKE)return h.onRevoke?h.onRevoke(call):new Response('',{status:200});
  if(url===TOKEN){
   if(call.form.grant_type==='refresh_token')return h.onRefresh?h.onRefresh(call):json({access_token:'opaque-rotated-access',refresh_token:'rotated-refresh',token_type:'Bearer',expires_in:3600,scope:SCOPE});
   const grant=grants.get(call.form.code);assert.ok(grant,'only a fixture authorization code may be used');
   return h.onExchange?h.onExchange(call,grant):json(h.payload(grant));
  }
  throw new Error('unexpected fixture network destination');
 };
 h.create=()=>{const auth=createChatGPTAuth({dataDir,fetchImpl:h.fetch});instances.push(auth);return auth;};
 h.auth=h.create();
 h.begin=(options={},grant={})=>{
  const url=new URL(h.auth.start(options).url),clientId=grant.clientId||(url.searchParams.get('client_id')==='dynamic_agent_client'?'issued_client_'+(++h.serial):url.searchParams.get('client_id'));
  const record={clientId,nonce:url.searchParams.get('nonce'),...grant},authorizationCode='fixture-code-'+grants.size;
  grants.set(authorizationCode,record);
  return {url,grant:record,parameters:new URLSearchParams({state:url.searchParams.get('state'),code:authorizationCode,client_id:clientId})};
 };
 h.login=async(options={},grant={})=>{const attempt=h.begin(options,grant);return {...attempt,summary:await h.auth.callback(attempt.parameters)};};
 h.readVault=()=>{
  const envelope=JSON.parse(fs.readFileSync(path.join(dataDir,'chatgpt-accounts.enc.json'),'utf8'));
  const decipher=createDecipheriv('aes-256-gcm',fs.readFileSync(path.join(dataDir,'local.key')),Buffer.from(envelope.iv,'base64'));
  decipher.setAAD(Buffer.from('A border Job/chatgpt-auth/v1'));decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data,'base64')),decipher.final()]).toString());
 };
 t.after(()=>{for(const auth of instances)auth.close();const resolved=path.resolve(dataDir);assert.equal(path.dirname(resolved),path.resolve(temporaryRoot));assert.ok(path.basename(resolved).startsWith('ghost-chatgpt-auth-test-'));fs.rmSync(resolved,{recursive:true,force:true});});
 return h;
}

test('constructor and status are read-only; PKCE binds a persistent host and exact loopback URI',t=>{
 const h=fixture(t);assert.deepEqual(fs.readdirSync(h.dataDir),[]);assert.equal(h.auth.status().pending,false);assert.equal(h.calls.length,0);
 const first=h.begin(),second=h.begin();
 assert.equal(first.url.origin,ISSUER);assert.equal(first.url.pathname,'/api/accounts/authorize');
 assert.equal(first.url.searchParams.get('client_id'),'dynamic_agent_client');assert.equal(first.url.searchParams.get('agent_name_hint'),'A border Job');
 assert.equal(first.url.searchParams.get('scope'),SCOPE);assert.equal(first.url.searchParams.get('resource'),RESOURCE);
 assert.equal(first.url.searchParams.get('redirect_uri'),'http://127.0.0.1:17839/auth/chatgpt/callback');
 assert.equal(first.url.searchParams.get('code_challenge_method'),'S256');assert.match(first.url.searchParams.get('code_challenge'),/^[\w-]{43}$/);
 assert.match(first.url.searchParams.get('ext_agent_host_id'),/^urn:uuid:/);assert.equal(first.url.searchParams.get('ext_agent_host_id'),second.url.searchParams.get('ext_agent_host_id'));
 assert.notEqual(first.url.searchParams.get('state'),second.url.searchParams.get('state'));assert.notEqual(first.url.searchParams.get('nonce'),second.url.searchParams.get('nonce'));
 assert.equal(h.calls.length,0);
});

test('code exchange verifies ID token, permits opaque bearer and encrypts all account details',async t=>{
 const h=fixture(t),key=randomBytes(32);fs.writeFileSync(path.join(h.dataDir,'local.key'),key);
 const {url,summary,grant}=await h.login();
 assert.equal(summary.connected,true);assert.equal(summary.planEnabled,true);assert.equal(summary.pending,false);
 const tokenCall=h.calls.find(c=>c.url===TOKEN);
 assert.equal(createHash('sha256').update(tokenCall.form.code_verifier).digest('base64url'),url.searchParams.get('code_challenge'));
 assert.equal(tokenCall.form.client_id,grant.clientId);assert.equal(tokenCall.form.redirect_uri,url.searchParams.get('redirect_uri'));assert.equal(tokenCall.form.resource,RESOURCE);
 assert.equal(await h.auth.accessToken(),'opaque-access-secret-'+grant.clientId);
 assert.deepEqual(Object.keys(summary).sort(),['accounts','activeId','connected','error','pending','planEnabled']);
 assert.deepEqual(Object.keys(summary.accounts[0]).sort(),['connected','email','id','label','planEnabled']);
 const rendered=JSON.stringify(summary),disk=fs.readFileSync(path.join(h.dataDir,'chatgpt-accounts.enc.json'),'utf8');
 for(const secret of [h.payload(grant).access_token,h.payload(grant).refresh_token,h.payload(grant).id_token,grant.clientId,grant.nonce]){assert.equal(rendered.includes(secret),false);assert.equal(disk.includes(secret),false);}
 assert.equal(disk.includes('same@example.test'),false);assert.deepEqual(fs.readFileSync(path.join(h.dataDir,'local.key')),key);
 assert.equal(h.readVault().accounts[0].subject,'subject-one');
 const host=url.searchParams.get('ext_agent_host_id');h.auth.close();h.auth=h.create();
 assert.equal(h.auth.status().connected,true);assert.equal(h.auth.identityKey(),summary.activeId);
 const repeat=h.begin({accountId:summary.activeId});
 assert.equal(repeat.url.searchParams.get('ext_agent_host_id'),host);assert.equal(repeat.url.searchParams.get('client_id'),grant.clientId);
 assert.equal(repeat.url.searchParams.has('agent_name_hint'),false);assert.equal(repeat.url.searchParams.has('id_token_hint'),false);
 assert.equal(repeat.url.searchParams.get('login_hint'),'same@example.test');repeat.parameters.delete('client_id');
 assert.equal((await h.auth.callback(repeat.parameters)).accounts.length,1);
});

test('bad state, duplicates, missing issued client, denial and replay never exchange a code',async t=>{
 const h=fixture(t),attempt=h.begin();
 const bad=new URLSearchParams(attempt.parameters);bad.set('state','wrong');await assert.rejects(h.auth.callback(bad),code('STATE'));assert.equal(h.calls.length,0);
 const duplicate=new URLSearchParams(attempt.parameters);duplicate.append('state',duplicate.get('state'));await assert.rejects(h.auth.callback(duplicate),code('STATE'));assert.equal(h.calls.length,0);
 const missing=new URLSearchParams(attempt.parameters);missing.delete('client_id');await assert.rejects(h.auth.callback(missing),code('CLIENT'));assert.equal(h.calls.length,0);
 await assert.rejects(h.auth.callback(attempt.parameters),code('STATE'));
 const denied=h.begin();denied.parameters.set('error','access_denied');denied.parameters.set('error_description','secret-do-not-display');
 await assert.rejects(h.auth.callback(denied.parameters),code('DENIED'));assert.equal(h.calls.length,0);assert.equal(JSON.stringify(h.auth.status()).includes('secret-do-not-display'),false);
 const success=await h.login();const calls=h.calls.length;await assert.rejects(h.auth.callback(success.parameters),code('STATE'));assert.equal(h.calls.length,calls);
});

test('cancel, restart, expiry and close invalidate the pending attempt before any HTTP',async t=>{
 const h=fixture(t),first=h.begin();assert.equal(h.auth.cancel().pending,false);await assert.rejects(h.auth.callback(first.parameters),code('STATE'));
 const second=h.begin();h.begin();await assert.rejects(h.auth.callback(second.parameters),code('STATE'));
 const expired=h.begin(),now=Date.now();t.mock.method(Date,'now',()=>now+600001);
 await assert.rejects(h.auth.callback(expired.parameters),code('STATE'));assert.equal(h.auth.status().pending,false);
 h.auth.close();await assert.rejects(h.auth.accessToken(),code('CLOSED'));assert.throws(()=>h.auth.start(),code('CLOSED'));assert.equal(h.calls.length,0);
});

test('replayed or forged callbacks cannot pollute the status of a connected account',async t=>{
 const h=fixture(t),logged=await h.login(),before=h.auth.status(),calls=h.calls.length;
 const stored=fs.readFileSync(path.join(h.dataDir,'chatgpt-accounts.enc.json'),'utf8');
 const forged=new URLSearchParams({state:'unrelated-state',code:'unrelated-code',client_id:'unrelated-client'});
 for(const parameters of [logged.parameters,forged,new URLSearchParams(),null]){
  await assert.rejects(h.auth.callback(parameters),code('STATE'));
  assert.deepEqual(h.auth.status(),before);
 }
 assert.equal(h.calls.length,calls);assert.equal(h.auth.status().error,null);
 assert.equal(fs.readFileSync(path.join(h.dataDir,'chatgpt-accounts.enc.json'),'utf8'),stored);
 assert.equal(await h.auth.accessToken(),'opaque-access-secret-'+logged.grant.clientId);
});

test('forged state while adding an account neither changes status nor consumes the real attempt',async t=>{
 const h=fixture(t),logged=await h.login(),next=h.begin({}, {sub:'second-account'});
 const before=h.auth.status(),calls=h.calls.length,wrong=new URLSearchParams(next.parameters);wrong.set('state','forged-state');
 const duplicate=new URLSearchParams(next.parameters);duplicate.append('state',duplicate.get('state'));
 for(const parameters of [logged.parameters,wrong,duplicate]){
  await assert.rejects(h.auth.callback(parameters),code('STATE'));assert.deepEqual(h.auth.status(),before);
 }
 assert.equal(h.calls.length,calls);const completed=await h.auth.callback(next.parameters);
 assert.equal(completed.connected,true);assert.equal(completed.planEnabled,true);assert.equal(completed.pending,false);assert.equal(completed.error,null);assert.equal(completed.accounts.length,2);
});

test('unbound callbacks preserve genuine login-flow errors instead of replacing or clearing them',async t=>{
 const h=fixture(t),logged=await h.login(),attempt=h.begin({accountId:logged.summary.activeId});attempt.parameters.set('error','access_denied');
 await assert.rejects(h.auth.callback(attempt.parameters),code('DENIED'));const before=h.auth.status();
 assert.equal(before.connected,true);assert.match(before.error,/已取消/);
 await assert.rejects(h.auth.callback(logged.parameters),code('STATE'));assert.deepEqual(h.auth.status(),before);
});

test('cancelling an in-flight exchange aborts it and late replies cannot save credentials',async t=>{
 const h=fixture(t),started=deferred(),finish=deferred();
 h.onExchange=async(call,grant)=>{started.resolve(call);await finish.promise;return json(h.payload(grant));};
 const attempt=h.begin(),result=h.auth.callback(attempt.parameters);const request=await started.promise;
 h.auth.cancel();assert.equal(request.options.signal.aborted,true);finish.resolve();
 await assert.rejects(result,code('STATE'));assert.equal(h.auth.status().accounts.length,0);assert.equal(h.auth.status().pending,false);
});

for(const [name,claims,header,privateKey] of [
 ['nonce',{nonce:'wrong'}],['issuer',{iss:'https://attacker.test'}],['audience',{aud:'another-client'}],
 ['expired',{exp:1}],['future issued time',{iat:Math.floor(Date.now()/1000)+3600}],['not-before',{nbf:Math.floor(Date.now()/1000)+3600}],
 ['missing subject',{sub:''}],['multi audience without azp',{aud:['issued_client_1','other']}],
 ['untrusted signature',{}, {},otherPair.privateKey],['algorithm confusion',{}, {alg:'HS256'}],['remote key header',{}, {jku:'https://attacker.test/jwks'}]
])test('ID token rejects '+name,async t=>{
 const h=fixture(t),attempt=h.begin({}, {claims,header,privateKey});
 await assert.rejects(h.auth.callback(attempt.parameters),code('IDENTITY'));assert.equal(h.auth.status().connected,false);assert.equal(h.readVault().accounts.length,0);
 assert.ok(h.calls.every(c=>c.url.startsWith(ISSUER+'/')));
});

test('duplicate signing keys and poisoned discovery are rejected without fetching attacker keys',async t=>{
 const h=fixture(t);h.keys=[jwk,jwk];let attempt=h.begin();await assert.rejects(h.auth.callback(attempt.parameters),code('IDENTITY'));
 h.auth.close();h.auth=h.create();h.metadata.jwks_uri='https://attacker.test/jwks';attempt=h.begin();
 await assert.rejects(h.auth.callback(attempt.parameters),code('IDENTITY'));assert.equal(h.calls.some(c=>c.url.startsWith('https://attacker')),false);
});

test('only token-response scopes enable plan use; callback and ID claims cannot grant it',async t=>{
 const h=fixture(t),attempt=h.begin({}, {claims:{scope:SCOPE},payload:{scope:'openid email profile'}});attempt.parameters.set('scope',SCOPE);
 const summary=await h.auth.callback(attempt.parameters);assert.equal(summary.connected,true);assert.equal(summary.planEnabled,false);
 const count=h.calls.length;await assert.rejects(h.auth.accessToken(),code('PLAN'));assert.equal(h.calls.length,count);
});

test('identity-only authorization is stored safely and cannot invoke models',async t=>{
 const h=fixture(t),attempt=h.begin({}, {payload:{access_token:undefined,refresh_token:undefined,scope:'openid profile email'}});
 const result=await h.auth.callback(attempt.parameters);assert.equal(result.connected,true);assert.equal(result.planEnabled,false);
 const calls=h.calls.length;await assert.rejects(h.auth.accessToken(),code('PLAN'));assert.equal(h.calls.length,calls);
});

test('same email with distinct registrations stays separate; re-login cannot replace another subject',async t=>{
 const h=fixture(t),one=await h.login(),two=await h.login({}, {sub:'subject-two'});
 assert.equal(two.summary.accounts.length,2);assert.notEqual(one.summary.activeId,two.summary.activeId);
 assert.equal(two.summary.accounts[0].email,two.summary.accounts[1].email);
 h.auth.select(one.summary.activeId);assert.equal(h.auth.identityKey(),one.summary.activeId);
 const mismatch=h.begin({accountId:one.summary.activeId},{sub:'intruder'});
 await assert.rejects(h.auth.callback(mismatch.parameters),code('MISMATCH'));
 assert.equal(await h.auth.accessToken(),'opaque-access-secret-'+one.grant.clientId);
 const wrongClient=h.begin({accountId:one.summary.activeId});wrongClient.parameters.set('client_id',two.grant.clientId);
 const calls=h.calls.length;await assert.rejects(h.auth.callback(wrongClient.parameters),code('CLIENT'));assert.equal(h.calls.length,calls);
});

test('invalid code retry retains the issued registration but discards code/state/PKCE',async t=>{
 const h=fixture(t),first=h.begin();h.onExchange=()=>json({error:'invalid_grant',error_description:'secret-code'},400);
 await assert.rejects(h.auth.callback(first.parameters),code('RESPONSE'));
 assert.equal(h.auth.status().accounts.length,0);h.auth.close();h.auth=h.create();
 const retry=h.begin();assert.equal(retry.url.searchParams.get('client_id'),first.grant.clientId);
 assert.equal(retry.url.searchParams.has('agent_name_hint'),false);assert.notEqual(retry.url.searchParams.get('state'),first.url.searchParams.get('state'));
 assert.notEqual(retry.url.searchParams.get('code_challenge'),first.url.searchParams.get('code_challenge'));
 h.onExchange=null;await h.auth.callback(retry.parameters);assert.equal(h.readVault().registrationClientId,null);
});

test('concurrent requests share one rotating refresh and atomically replace the stored token',async t=>{
 const h=fixture(t);await h.login({}, {payload:{expires_in:30}});const ready=deferred(),finish=deferred();
 h.onRefresh=async()=>{ready.resolve();await finish.promise;return json({access_token:'opaque-new',refresh_token:'new-refresh',token_type:'Bearer',expires_in:3600,scope:SCOPE});};
 const calls=[h.auth.accessToken(),h.auth.accessToken(),h.auth.accessToken()];await ready.promise;finish.resolve();
 assert.deepEqual(await Promise.all(calls),['opaque-new','opaque-new','opaque-new']);
 const refreshCalls=h.calls.filter(c=>c.form?.grant_type==='refresh_token');assert.equal(refreshCalls.length,1);assert.equal(refreshCalls[0].form.resource,RESOURCE);assert.equal('scope' in refreshCalls[0].form,false);
 const stored=h.readVault().accounts[0].credentials;assert.equal(stored.refreshToken,'new-refresh');assert.equal(stored.accessToken,'opaque-new');
});

test('refresh ID-token identity mismatch cannot overwrite old credentials',async t=>{
 const h=fixture(t),logged=await h.login({}, {payload:{expires_in:30}});
 h.onRefresh=()=>json(h.payload({...logged.grant,sub:'another-subject'},{access_token:'untrusted-new-access'}));
 await assert.rejects(h.auth.accessToken(),code('MISMATCH'));assert.equal(h.readVault().accounts[0].credentials.accessToken,'opaque-access-secret-'+logged.grant.clientId);
});

test('omitted refresh scope retains the previously granted response scope; explicit reduction replaces it',async t=>{
 const h=fixture(t);await h.login({}, {payload:{expires_in:30}});
 h.onRefresh=()=>json({access_token:'opaque-new',refresh_token:'new-refresh',token_type:'Bearer',expires_in:30});
 assert.equal(await h.auth.accessToken(),'opaque-new');assert.equal(h.auth.status().planEnabled,true);
 assert.deepEqual(h.readVault().accounts[0].credentials.scopes,SCOPE.split(' '));
 h.onRefresh=()=>json({access_token:'identity-only-access',refresh_token:'reduced-refresh',token_type:'Bearer',expires_in:3600,scope:'openid email'});
 await assert.rejects(h.auth.accessToken(),code('PLAN'));assert.equal(h.auth.status().planEnabled,false);
 const count=h.calls.length;await assert.rejects(h.auth.accessToken(),code('PLAN'));assert.equal(h.calls.length,count);
});

test('refresh completing after re-login cannot replace the new session',async t=>{
 const h=fixture(t),one=await h.login({}, {payload:{expires_in:30}}),ready=deferred(),finish=deferred();
 h.onRefresh=async()=>{ready.resolve();await finish.promise;return json({access_token:'stale-refresh-access',refresh_token:'stale-refresh-token',token_type:'Bearer',expires_in:3600,scope:SCOPE});};
 const access=h.auth.accessToken();await ready.promise;
 await h.login({accountId:one.summary.activeId},{payload:{access_token:'fresh-login-access',refresh_token:'fresh-login-refresh'}});
 finish.resolve();await assert.rejects(access,code('CHANGED'));assert.equal(await h.auth.accessToken(),'fresh-login-access');
 assert.equal(h.readVault().accounts[0].credentials.refreshToken,'fresh-login-refresh');
});

test('failed atomic persistence never makes an uncommitted credential usable',async t=>{
 const h=fixture(t),attempt=h.begin();
 const rename=t.mock.method(fs,'renameSync',()=>{throw Object.assign(Error('fixture write error'),{code:'EACCES'});});
 await assert.rejects(h.auth.callback(attempt.parameters),code('STORAGE'));assert.equal(h.auth.status().connected,false);
 const calls=h.calls.length;await assert.rejects(h.auth.accessToken(),code('STORAGE'));assert.equal(h.calls.length,calls);
 rename.mock.restore();assert.equal(h.readVault().accounts.length,0);
});

test('missing replacement refresh token fails safely and transient network errors preserve mapping',async t=>{
 const h=fixture(t);await h.login({}, {payload:{expires_in:30}});
 h.onRefresh=()=>json({access_token:'new',token_type:'Bearer',expires_in:3600,scope:SCOPE});
 await assert.rejects(h.auth.accessToken(),code('RESPONSE'));assert.equal(h.auth.status().connected,true);
 h.onRefresh=()=>{throw Error('upstream secret');};
 await assert.rejects(h.auth.accessToken(),code('NETWORK'));assert.equal(h.auth.status().connected,true);assert.equal(JSON.stringify(h.auth.status()).includes('upstream secret'),false);
});

test('terminal refresh errors clear tokens without changing the selected account or retrying',async t=>{
 const h=fixture(t),logged=await h.login({}, {payload:{expires_in:30}});
 h.onRefresh=()=>json({error:'refresh_token_reused',error_description:'do-not-expose'},400);
 await assert.rejects(h.auth.accessToken(),code('EXPIRED'));const count=h.calls.length;
 await assert.rejects(h.auth.accessToken(),code('LOGIN'));assert.equal(h.calls.length,count);
 assert.equal(h.auth.status().activeId,logged.summary.activeId);assert.equal(h.auth.status().accounts.length,1);assert.equal(h.auth.status().connected,false);
 assert.equal(h.readVault().accounts[0].credentials,null);
});

test('earliest-refresh boundary suppresses premature HTTP; expired tokens are never returned',async t=>{
 const h=fixture(t),now=Date.now();await h.login({}, {payload:{expires_in:30,earliest_refresh_at:Math.floor(now/1000)+300}});
 const count=h.calls.length;assert.match(await h.auth.accessToken(),/^opaque-/);assert.equal(h.calls.length,count);
 t.mock.method(Date,'now',()=>now+40000);await assert.rejects(h.auth.accessToken(),code('EXPIRED'));assert.equal(h.calls.length,count);
});

test('switching account during refresh prevents returning a token for the former selection',async t=>{
 const h=fixture(t),one=await h.login({}, {payload:{expires_in:30}}),two=await h.login({}, {sub:'second'});
 h.auth.select(one.summary.activeId);const ready=deferred(),finish=deferred();
 h.onRefresh=async()=>{ready.resolve();await finish.promise;return json({access_token:'old-account-refreshed',refresh_token:'replacement',token_type:'Bearer',expires_in:3600,scope:SCOPE});};
 const result=h.auth.accessToken();await ready.promise;h.auth.select(two.summary.activeId);finish.resolve();await assert.rejects(result,code('CHANGED'));
 assert.equal(await h.auth.accessToken(),'opaque-access-secret-'+two.grant.clientId);
});

test('logout waits for rotation, revokes the replacement, clears tokens and retains the account mapping',async t=>{
 const h=fixture(t),logged=await h.login({}, {payload:{expires_in:30}}),ready=deferred(),finish=deferred();
 h.onRefresh=async()=>{ready.resolve();await finish.promise;return json({access_token:'new',refresh_token:'refresh-to-revoke',token_type:'Bearer',expires_in:3600,scope:SCOPE});};
 const access=h.auth.accessToken();await ready.promise;const out=h.auth.signOut();finish.resolve();
 await assert.rejects(access,code('CHANGED'));const result=await out;
 assert.equal(result.connected,false);assert.equal(result.activeId,logged.summary.activeId);assert.equal(result.accounts.length,1);
 const revoke=h.calls.find(c=>c.url===REVOKE);assert.equal(revoke.form.token,'refresh-to-revoke');assert.equal(revoke.form.token_type_hint,'refresh_token');assert.equal(revoke.form.client_id,logged.grant.clientId);
 assert.equal(h.readVault().accounts[0].credentials,null);const count=h.calls.length;await h.auth.signOut();assert.equal(h.calls.length,count);
});

test('remote revoke failures are bounded, sanitized and still remove local credentials',async t=>{
 const h=fixture(t);await h.login();h.onRevoke=()=>new Response('upstream-sensitive-secret',{status:503});
 const result=await h.auth.signOut();assert.equal(result.connected,false);assert.equal(h.calls.filter(c=>c.url===REVOKE).length,2);
 assert.match(result.error,/远端撤销未确认/);assert.equal(JSON.stringify(result).includes('upstream-sensitive-secret'),false);assert.equal(h.readVault().accounts[0].credentials,null);
});

test('lazy process lock permits second app status but prevents concurrent mutation and refresh',async t=>{
 const h=fixture(t);await h.login();const other=h.create();assert.equal(other.status().connected,true);
 assert.throws(()=>other.start(),code('BUSY'));await assert.rejects(other.accessToken(),code('BUSY'));
 other.close();assert.equal(fs.existsSync(path.join(h.dataDir,'chatgpt-auth.lock')),true);
 h.auth.close();const next=h.create();assert.equal(next.status().connected,true);assert.equal((new URL(next.start().url)).origin,ISSUER);
});

test('corrupt authenticated vault is reported without throwing from constructor or overwriting it',t=>{
 const h=fixture(t);h.auth.start();h.auth.close();const file=path.join(h.dataDir,'chatgpt-accounts.enc.json');
 const value=JSON.parse(fs.readFileSync(file,'utf8'));value.tag=Buffer.alloc(16).toString('base64');fs.writeFileSync(file,JSON.stringify(value));
 const original=fs.readFileSync(file,'utf8'),next=h.create();assert.match(next.status().error,/加密账户/);assert.throws(()=>next.start(),code('STORAGE'));assert.equal(fs.readFileSync(file,'utf8'),original);assert.equal(h.calls.length,0);
});

test('close aborts an in-flight refresh and a late reply cannot overwrite the stored session',async t=>{
 const h=fixture(t);await h.login({}, {payload:{expires_in:30}});const before=fs.readFileSync(path.join(h.dataDir,'chatgpt-accounts.enc.json'),'utf8'),ready=deferred(),finish=deferred();
 h.onRefresh=async(call)=>{ready.resolve(call);await finish.promise;return json({access_token:'late',refresh_token:'late-refresh',token_type:'Bearer',expires_in:3600,scope:SCOPE});};
 const result=h.auth.accessToken(),request=await ready.promise;h.auth.close();assert.equal(request.options.signal.aborted,true);finish.resolve();await assert.rejects(result,code('CLOSED'));
 assert.equal(fs.readFileSync(path.join(h.dataDir,'chatgpt-accounts.enc.json'),'utf8'),before);
});

test('origin and bearer validation reject unsafe values without leaking upstream content',async t=>{
 const h=fixture(t);for(const origin of ['https://attacker.test','http://localhost:17839','http://127.0.0.1:17839/path','http://user:pass@127.0.0.1:17839'])assert.throws(()=>createChatGPTAuth({dataDir:h.dataDir,origin,fetchImpl:h.fetch}),code('CLIENT'));
 const attempt=h.begin({}, {payload:{access_token:'header\r\ninjection'}});await assert.rejects(h.auth.callback(attempt.parameters),code('RESPONSE'));
 assert.equal(JSON.stringify(h.auth.status()).includes('injection'),false);
});
