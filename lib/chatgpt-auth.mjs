import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,randomUUID,createHash,createCipheriv,createDecipheriv,createPublicKey,verify,timingSafeEqual} from 'node:crypto';

// Public-client SIWC flow; no Codex credential import and no client secret.
// https://developers.openai.com/siwc/token-sharing-open-source/sign-in
const ISSUER='https://auth.openai.com';
const AUTHORIZE=ISSUER+'/api/accounts/authorize',TOKEN=ISSUER+'/api/accounts/oauth/token';
const DISCOVERY=ISSUER+'/.well-known/openid-configuration',JWKS=ISSUER+'/.well-known/jwks.json';
const RESOURCE='https://api.openai.com/v1',SCOPES='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const AAD=Buffer.from('A border Job/chatgpt-auth/v1'),TEN_MINUTES=600000;
const terminalRefresh=new Set(['invalid_grant','invalid_refresh_token','token_expired','refresh_token_expired','refresh_token_invalidated','refresh_token_reused']);
const messages={CLOSED:'认证模块已关闭',BUSY:'另一个本地实例正在管理 ChatGPT 登录，请使用已打开的应用',STORAGE:'无法读取或保存 ChatGPT 加密账户，请检查本机数据目录',
 STATE:'登录请求已失效、已取消或已使用，请重新登录',DENIED:'已取消 ChatGPT 授权',CLIENT:'ChatGPT 客户端注册不完整或与所选账户不一致，请重新登录',
 IDENTITY:'ChatGPT 身份校验失败，未保存本次凭证',MISMATCH:'本次登录的账户与所选注册不一致，原账户未被替换',NETWORK:'无法连接 ChatGPT 授权服务，请稍后重试',
 RESPONSE:'ChatGPT 授权服务返回无效响应，未使用该凭证',LOGIN:'请先登录所选 ChatGPT 账户',PLAN:'当前账户未授予 ChatGPT 订阅使用权限，请重新授权',
 CHANGED:'ChatGPT 账户或登录状态已变化，请重试',EXPIRED:'ChatGPT 会话已失效，请重新登录',REVOKE:'已在本机退出；远端撤销未确认，可在 ChatGPT 设置中断开此应用',
 REFRESH:'ChatGPT 暂时无法刷新授权，请稍后重试',ACCOUNT:'未找到所选 ChatGPT 账户'};
const problem=key=>Object.assign(new Error(messages[key]||messages.RESPONSE),{code:'CHATGPT_AUTH_'+key});
const text=value=>typeof value==='string'?value:'';
const cleanLabel=value=>text(value).replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,160);
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const validClient=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(value)&&value!=='dynamic_agent_client';
const freshState=()=>({version:1,hostId:null,activeId:null,registrationClientId:null,accounts:[]});

export function createChatGPTAuth({dataDir,origin='http://127.0.0.1:17839',fetchImpl=globalThis.fetch}={}){
 let localOrigin;
 try{localOrigin=new URL(origin);}catch{throw problem('CLIENT');}
 if(localOrigin.protocol!=='http:'||localOrigin.hostname!=='127.0.0.1'||localOrigin.username||localOrigin.password||
    localOrigin.pathname!=='/'||localOrigin.search||localOrigin.hash||typeof dataDir!=='string'||!dataDir)throw problem('CLIENT');
 const redirectUri=localOrigin.origin+'/auth/chatgpt/callback';
 const directory=path.resolve(dataDir),vaultFile=path.join(directory,'chatgpt-accounts.enc.json'),keyFile=path.join(directory,'local.key');
 const lockFile=path.join(directory,'chatgpt-auth.lock'),owner=randomUUID();
 let state=freshState(),pending=null,exchange=null,epoch=0,closed=false,locked=false,storageFault=false,error=null,key;
 let discoveryCache,jwksCache,jwksAt=0;
 const controllers=new Set(),refreshes=new Map(),revoking=new Set();
 function available(){if(closed)throw problem('CLOSED');if(storageFault)throw problem('STORAGE');}
 function readKey(create=false){
  if(key)return key;
  try{
   if(!fs.existsSync(keyFile)&&create){try{fs.writeFileSync(keyFile,randomBytes(32),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}}
   key=fs.readFileSync(keyFile);if(key.length!==32)throw Error();return key;
  }catch{key=undefined;throw problem('STORAGE');}
 }
 function load(){
  if(!fs.existsSync(vaultFile)){state=freshState();return;}
  try{
   if(fs.statSync(vaultFile).size>4*1024*1024)throw Error();
   const envelope=JSON.parse(fs.readFileSync(vaultFile,'utf8'));
   if(envelope.version!==1)throw Error();
   const iv=Buffer.from(envelope.iv,'base64'),tag=Buffer.from(envelope.tag,'base64');
   if(iv.length!==12||tag.length!==16)throw Error();
   const decipher=createDecipheriv('aes-256-gcm',readKey(),iv);decipher.setAAD(AAD);decipher.setAuthTag(tag);
   const value=JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data,'base64')),decipher.final()]).toString('utf8'));
   if(value.version!==1||!/^urn:uuid:[0-9a-f-]{36}$/i.test(value.hostId)||!Array.isArray(value.accounts)||value.accounts.length>100)throw Error();
   const ids=new Set();
   for(const account of value.accounts){
    if(typeof account.id!=='string'||ids.has(account.id)||!validClient(account.clientId)||account.issuer!==ISSUER||!text(account.subject))throw Error();
    ids.add(account.id);
   }
   if(value.activeId!==null&&!ids.has(value.activeId)||value.registrationClientId&&!validClient(value.registrationClientId))throw Error();state=value;
  }catch{storageFault=true;error=messages.STORAGE;throw problem('STORAGE');}
 }
 function persist(){
  let temporary;
  try{
   const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',readKey(true),iv);cipher.setAAD(AAD);
   const encrypted=Buffer.concat([cipher.update(JSON.stringify(state),'utf8'),cipher.final()]);
   const value=JSON.stringify({version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')});
   temporary=path.join(directory,'chatgpt-accounts.'+randomUUID()+'.tmp');
   const fd=fs.openSync(temporary,'wx',0o600);
   try{fs.writeFileSync(fd,value);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   fs.renameSync(temporary,vaultFile);temporary=null;
  }catch{storageFault=true;error=messages.STORAGE;throw problem('STORAGE');}
  finally{if(temporary)try{fs.unlinkSync(temporary);}catch{}}
 }
 function release(){
  if(!locked)return;
  try{if(JSON.parse(fs.readFileSync(lockFile,'utf8')).owner===owner)fs.unlinkSync(lockFile);}catch{}
  locked=false;
 }
 function acquire(){
  available();if(locked)return;
  try{
   fs.mkdirSync(directory,{recursive:true});
   for(let attempt=0;attempt<2;attempt++){
    try{fs.writeFileSync(lockFile,JSON.stringify({pid:process.pid,owner}),{flag:'wx',mode:0o600});locked=true;break;}
    catch(e){
     if(e.code!=='EEXIST')throw problem('STORAGE');
     let previous;try{if(fs.statSync(lockFile).size>512)throw Error();previous=JSON.parse(fs.readFileSync(lockFile,'utf8'));}catch{throw problem('BUSY');}
     if(!Number.isInteger(previous.pid)||previous.pid<1||typeof previous.owner!=='string')throw problem('BUSY');
     try{process.kill(previous.pid,0);throw problem('BUSY');}catch(check){if(check.code!=='ESRCH')throw problem('BUSY');}
     // Reclaim only a dead process's unchanged lock, never an active owner.
     if(fs.readFileSync(lockFile,'utf8')!==JSON.stringify(previous))throw problem('BUSY');
     fs.unlinkSync(lockFile);
    }
   }
   if(!locked)throw problem('BUSY');
   load();if(!state.hostId){state.hostId='urn:uuid:'+randomUUID();persist();}
  }catch(e){release();throw e.code?.startsWith('CHATGPT_AUTH_')?e:problem('STORAGE');}
 }
 try{load();}catch{error=messages.STORAGE;}
 const account=id=>state.accounts.find(item=>item.id===id);
 const hasPlan=record=>record?.credentials?.scopes?.includes('chatgpt.tokens.use.direct')&&record.credentials.scopes.includes('resource.invoke');
 const connected=record=>!!record?.credentials&&!revoking.has(record.id)&&!closed&&!storageFault;
 function status(){
  if(!locked&&!closed)try{load();}catch{error=messages.STORAGE;}
  if(pending&&Date.now()>=pending.expiresAt){pending=null;epoch++;error=messages.STATE;}
  const accounts=state.accounts.map(record=>({id:record.id,label:record.label,email:record.email,connected:connected(record),planEnabled:!!(connected(record)&&hasPlan(record))}));
  const active=accounts.find(item=>item.id===state.activeId);
  return {connected:!!active?.connected,planEnabled:!!active?.planEnabled,activeId:state.activeId,accounts,pending:!!pending||!!exchange,error};
 }
 function cancelPending(){epoch++;pending=null;if(exchange){exchange.controller.abort();exchange=null;}}
 function cancel(){available();cancelPending();error=null;return status();}
 function start({accountId}={}){
  acquire();if(accountId!==undefined&&!account(accountId))throw problem('ACCOUNT');
  if(accountId&&revoking.has(accountId))throw problem('BUSY');
  cancelPending();error=null;
  const selected=accountId?account(accountId):null;
  pending={state:randomBytes(32).toString('base64url'),nonce:randomBytes(32).toString('base64url'),verifier:randomBytes(48).toString('base64url'),
   redirectUri,expiresAt:Date.now()+TEN_MINUTES,epoch,accountId:selected?.id||null,clientId:selected?.clientId||state.registrationClientId||null};
  const url=new URL(AUTHORIZE),parameters={client_id:pending.clientId||'dynamic_agent_client',ext_agent_host_id:state.hostId,response_type:'code',
   redirect_uri:redirectUri,scope:SCOPES,resource:RESOURCE,state:pending.state,nonce:pending.nonce,
   code_challenge_method:'S256',code_challenge:createHash('sha256').update(pending.verifier).digest('base64url')};
  if(!pending.clientId)parameters.agent_name_hint='A border Job';
  if(selected?.email)parameters.login_hint=selected.email;
  // id_token_hint is optional. Omit it so the returned URL cannot expose an ID token to UI/logs.
  url.search=new URLSearchParams(parameters).toString();return {url:url.href};
 }
 async function request(url,{form,controller,guard=available,empty=false}={}){
  guard();const local=new AbortController(),signals=[local.signal];if(controller)signals.push(controller.signal);
  controllers.add(local);const timer=setTimeout(()=>local.abort(),15000);timer.unref?.();
  try{
   const response=await fetchImpl(url,{method:form?'POST':'GET',redirect:'error',signal:AbortSignal.any(signals),
    headers:{accept:'application/json',...(form?{'content-type':'application/x-www-form-urlencoded'}:{})},...(form?{body:new URLSearchParams(form)}:{})});
   guard();
   if(empty&&response.status===200)return {};
   let payload;try{const raw=await response.text();if(raw.length>1024*1024)throw Error();payload=JSON.parse(raw);}catch{const failure=problem('RESPONSE');failure.retryable=response.status>=500;throw failure;}
   guard();
   if(response.status!==200){
    const code=typeof payload.error==='string'?payload.error:payload.error?.code;
    const failure=problem(form?.grant_type==='refresh_token'?'REFRESH':'RESPONSE');
    if(terminalRefresh.has(code))failure.terminal=true;
    if(code==='invalid_grant'&&form?.grant_type==='authorization_code')failure.retryClient=true;
    failure.retryable=response.status>=500;throw failure;
   }
   if(!payload||typeof payload!=='object'||Array.isArray(payload))throw problem('RESPONSE');return payload;
  }catch(e){if(e.code?.startsWith('CHATGPT_AUTH_'))throw e;guard();throw problem('NETWORK');}
  finally{clearTimeout(timer);controllers.delete(local);}
 }
 async function discovery(options){
  if(discoveryCache)return discoveryCache;
  const metadata=await request(DISCOVERY,options);
  if(metadata.issuer!==ISSUER||metadata.jwks_uri!==JWKS)throw problem('IDENTITY');
  let revoke;try{revoke=new URL(metadata.revocation_endpoint);}catch{throw problem('IDENTITY');}
  if(revoke.origin!==ISSUER||revoke.username||revoke.password||revoke.search||revoke.hash||revoke.pathname==='/')throw problem('IDENTITY');
  discoveryCache={revocationEndpoint:revoke.href};return discoveryCache;
 }
 async function signingKeys(options,force=false){
  await discovery(options);
  if(!force&&jwksCache&&Date.now()-jwksAt<300000)return jwksCache;
  const result=await request(JWKS,options);if(!Array.isArray(result.keys)||result.keys.length>100)throw problem('IDENTITY');
  jwksCache=result.keys;jwksAt=Date.now();return jwksCache;
 }
 async function validateJWT(token,{audience,nonce,subject,clientId,...options}){
  try{
   if(typeof token!=='string'||token.length>65536)throw problem('IDENTITY');
   const parts=token.split('.');if(parts.length!==3||parts.some(part=>!part||!/^[A-Za-z0-9_-]+$/.test(part)))throw problem('IDENTITY');
   const header=JSON.parse(Buffer.from(parts[0],'base64url').toString()),claims=JSON.parse(Buffer.from(parts[1],'base64url').toString());
   if(header.alg!=='RS256'||!text(header.kid)||header.crit||header.jku||header.x5u||header.b64===false||!claims||Array.isArray(claims))throw problem('IDENTITY');
   let keys=await signingKeys(options),matching=keys.filter(jwk=>jwk.kid===header.kid);
   if(!matching.length){keys=await signingKeys(options,true);matching=keys.filter(jwk=>jwk.kid===header.kid);}
   if(matching.length!==1)throw problem('IDENTITY');const jwk=matching[0];
   if(jwk.kty!=='RSA'||jwk.use&&jwk.use!=='sig'||jwk.alg&&jwk.alg!=='RS256'||jwk.key_ops&&!jwk.key_ops.includes('verify'))throw problem('IDENTITY');
   const publicKey=createPublicKey({key:jwk,format:'jwk'});
   if(publicKey.asymmetricKeyDetails.modulusLength<2048||!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),publicKey,Buffer.from(parts[2],'base64url')))throw problem('IDENTITY');
   const now=Math.floor(Date.now()/1000),aud=typeof claims.aud==='string'?[claims.aud]:claims.aud;
   if(claims.iss!==ISSUER||!Array.isArray(aud)||!aud.length||aud.some(v=>typeof v!=='string')||!aud.includes(audience)||
      (aud.length>1&&claims.azp!==audience)||(claims.azp!==undefined&&claims.azp!==audience)||
      !Number.isInteger(claims.iat)||claims.iat>now+5||!Number.isInteger(claims.exp)||claims.exp<=now-5||claims.exp<=claims.iat||
      (claims.nbf!==undefined&&(!Number.isInteger(claims.nbf)||claims.nbf>now+5))||!text(claims.sub).trim())throw problem('IDENTITY');
   if(nonce!==undefined&&!equal(claims.nonce,nonce))throw problem('IDENTITY');
   if(subject!==undefined&&claims.sub!==subject||clientId!==undefined&&claims.client_id!==clientId)throw problem('MISMATCH');
   return claims;
  }catch(e){if(e.code?.startsWith('CHATGPT_AUTH_'))throw e;throw problem('IDENTITY');}
 }
 async function credentials(payload,{clientId,subject,nonce,refresh=false,prior,...options}){
  let identity;
  if(!refresh||payload.id_token){
   identity=await validateJWT(payload.id_token,{audience:clientId,...(!refresh?{nonce}:{}),subject,...options});
   if(refresh&&identity.nonce!==undefined&&!equal(identity.nonce,nonce))throw problem('IDENTITY');
  }
  if(!refresh&&!identity)throw problem('IDENTITY');
  if(payload.scope!==undefined&&(typeof payload.scope!=='string'||payload.scope.length>8192))throw problem('RESPONSE');
  // OAuth permits omitting unchanged scope on refresh. Only retain scopes that
  // came from this same account's previous token response, never JWT/callback data.
  const scopes=typeof payload.scope==='string'?[...new Set(payload.scope.split(/\s+/).filter(Boolean))]:refresh?[...(prior?.scopes||[])]:[];
  let expiresAt=0;
  if(payload.access_token!==undefined){
   if(typeof payload.token_type!=='string'||payload.token_type.toLowerCase()!=='bearer'||!text(payload.access_token)||
      payload.access_token.length>65536||/[\u0000-\u0020\u007f]/.test(payload.access_token)||
      !Number.isFinite(payload.expires_in)||payload.expires_in<=0||payload.expires_in>86400)throw problem('RESPONSE');
   // The fixed TLS token endpoint binds this opaque bearer to this grant.
   // Only ID tokens are JWT-validated; access-token formats may change.
   expiresAt=Date.now()+payload.expires_in*1000;
  }else if(refresh||scopes.includes('chatgpt.tokens.use.direct'))throw problem('RESPONSE');
  if(payload.refresh_token!==undefined&&(!text(payload.refresh_token)||payload.refresh_token.length>65536))throw problem('RESPONSE');
  if(refresh&&prior?.refreshToken&&!text(payload.refresh_token))throw problem('RESPONSE');
  let earliestRefreshAt=0;
  if(payload.earliest_refresh_at!==undefined){
   earliestRefreshAt=typeof payload.earliest_refresh_at==='number'?payload.earliest_refresh_at*1000:Date.parse(payload.earliest_refresh_at);
   if(!Number.isFinite(earliestRefreshAt))throw problem('RESPONSE');
  }
  return {identity,credentials:{accessToken:payload.access_token||null,refreshToken:payload.refresh_token||null,
   idToken:payload.id_token||prior?.idToken||null,nonce,scopes,expiresAt,earliestRefreshAt,
   refreshExpiresAt:payload.refresh_token?Date.now()+30*86400000:0}};
 }
 async function callback(parameters){
  acquire();const parametersOK=parameters instanceof URLSearchParams;
  const attempt=pending;
  if(!parametersOK||!attempt||Date.now()>=attempt.expiresAt||parameters.getAll('state').length!==1||!equal(parameters.get('state'),attempt.state)){
   // Unbound requests (including a refreshed success page) are rejected locally.
   // They cannot change the account status or the error of an actual login flow.
   throw problem('STATE');
  }
  pending=null;const controller=new AbortController(),transaction={...attempt,controller};exchange=transaction;
  const guard=()=>{available();if(epoch!==attempt.epoch||exchange!==transaction||Date.now()>=attempt.expiresAt||controller.signal.aborted)throw problem('STATE');};
  try{
   if(['error','code','client_id'].some(name=>parameters.getAll(name).length>1))throw problem('STATE');
   if(parameters.has('error'))throw problem('DENIED');
   const supplied=parameters.get('client_id'),clientId=attempt.clientId||supplied;
   if(!validClient(clientId)||attempt.clientId&&supplied!==null&&supplied!==attempt.clientId)throw problem('CLIENT');
   const code=parameters.get('code');if(!code||code.length>8192)throw problem('STATE');
   const payload=await request(TOKEN,{form:{grant_type:'authorization_code',client_id:clientId,code,code_verifier:attempt.verifier,
    redirect_uri:attempt.redirectUri,resource:RESOURCE},controller,guard});
   const selected=attempt.accountId?account(attempt.accountId):null;
   const verified=await credentials(payload,{clientId,subject:selected?.subject,nonce:attempt.nonce,controller,guard});guard();
   if(attempt.accountId&&(!selected||selected.clientId!==clientId||selected.subject!==verified.identity.sub))throw problem('MISMATCH');
   let record=selected||state.accounts.find(item=>item.clientId===clientId&&item.subject===verified.identity.sub);
   if(!record){const id=randomUUID();record={id,clientId,issuer:ISSUER,subject:verified.identity.sub,label:(cleanLabel(verified.identity.name)||cleanLabel(verified.identity.email)||'ChatGPT')+' · '+id.slice(0,8)};state.accounts.push(record);}
   record.email=cleanLabel(verified.identity.email);record.credentials=verified.credentials;state.activeId=record.id;
   if(!attempt.accountId)state.registrationClientId=null;
   error=null;persist();exchange=null;return status();
  }catch(e){
   if(exchange===transaction){
    if(e.retryClient&&!attempt.accountId){state.registrationClientId=attempt.clientId||parameters.get('client_id');persist();}
    error=messages[e.code?.replace('CHATGPT_AUTH_','')]||messages.RESPONSE;
   }
   throw e.code?.startsWith('CHATGPT_AUTH_')?e:problem('RESPONSE');
  }
  finally{if(exchange===transaction)exchange=null;}
 }
 function select(id){acquire();if(!account(id))throw problem('ACCOUNT');if(revoking.has(id))throw problem('BUSY');cancelPending();state.activeId=id;error=null;persist();return status();}
 function identityKey(){return state.activeId||'';}
 async function refresh(record){
  const prior=record.credentials;
  const guard=()=>{available();if(record.credentials!==prior)throw problem('CHANGED');};
  try{
   const payload=await request(TOKEN,{form:{grant_type:'refresh_token',client_id:record.clientId,refresh_token:prior.refreshToken,resource:RESOURCE},guard});
   const verified=await credentials(payload,{clientId:record.clientId,subject:record.subject,nonce:prior.nonce,refresh:true,prior,guard});guard();
   record.credentials=verified.credentials;persist();error=null;
  }catch(e){
   if(e.terminal&&record.credentials===prior){record.credentials=null;persist();error=messages.EXPIRED;throw problem('EXPIRED');}
   error=messages[e.code?.replace('CHATGPT_AUTH_','')]||messages.REFRESH;throw e;
  }
 }
 async function accessToken(){
  acquire();const selected=state.activeId,record=account(selected);
  if(!record?.credentials||revoking.has(selected))throw problem('LOGIN');
  if(!hasPlan(record))throw problem('PLAN');
  let c=record.credentials;
  if(!c.accessToken)throw problem('LOGIN');
  if(c.expiresAt-Date.now()<60000&&Date.now()>=c.earliestRefreshAt){
   if(!c.refreshToken||Date.now()>=c.refreshExpiresAt){if(c.expiresAt<=Date.now())throw problem('EXPIRED');}
   else{
    if(!refreshes.has(selected)){
     const promise=Promise.resolve().then(()=>refresh(record)).finally(()=>{if(refreshes.get(selected)===promise)refreshes.delete(selected);});
     refreshes.set(selected,promise);
    }
    await refreshes.get(selected);
   }
  }
  available();if(state.activeId!==selected||revoking.has(selected))throw problem('CHANGED');
  c=record.credentials;if(!c||!hasPlan(record))throw problem(c?'PLAN':'LOGIN');
  if(c.expiresAt<=Date.now())throw problem('EXPIRED');return c.accessToken;
 }
 async function signOut(id=state.activeId){
  acquire();cancelPending();if(!id){error=null;return status();}
  const record=account(id);if(!record)throw problem('ACCOUNT');if(revoking.has(id))throw problem('BUSY');revoking.add(id);
  let revoked=true;
  try{
   if(refreshes.has(id))try{await refreshes.get(id);}catch{}
   available();const credentials=record.credentials;
   if(credentials?.refreshToken){
    revoked=false;
    for(let attempt=0;attempt<2&&!revoked;attempt++){
     try{const metadata=await discovery();await request(metadata.revocationEndpoint,{form:{token:credentials.refreshToken,token_type_hint:'refresh_token',client_id:record.clientId},empty:true});revoked=true;}
     catch(e){if(attempt===0&&(e.code==='CHATGPT_AUTH_NETWORK'||e.retryable)){await new Promise(resolve=>setTimeout(resolve,250));available();}else break;}
    }
   }
   available();record.credentials=null;error=revoked?null:messages.REVOKE;persist();return status();
  }finally{revoking.delete(id);}
 }
 function close(){if(closed)return;cancelPending();closed=true;for(const controller of controllers)controller.abort();release();if(key)key.fill(0);key=undefined;}
 return {status,start,callback,select,signOut,accessToken,identityKey,cancel,close};
}
