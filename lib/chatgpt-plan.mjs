// Official local-app plan usage; no Codex credential reading or API-key fallback.
const endpoint='https://api.openai.com/v1';
const ownFault=Symbol('chatgptPlanFault');
const fault=(message,code='CHATGPT_REQUEST_FAILED')=>Object.assign(Error(message),{code,[ownFault]:true});
const transientNetworkCodes=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','EAI_AGAIN','EHOSTUNREACH','ENETUNREACH',
 'UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET','ERR_STREAM_PREMATURE_CLOSE']);
const knownTLSCodes=new Set(['ERR_TLS_CERT_ALTNAME_INVALID','ERR_TLS_HANDSHAKE_TIMEOUT','CERT_HAS_EXPIRED','CERT_NOT_YET_VALID',
 'DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT',
 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY','CERT_UNTRUSTED','CERT_REVOKED']);
const temporaryServiceCodes=new Set(['subscription_sharing_usage_unavailable','subscription_sharing_user_unavailable']);
const authErrors={CHATGPT_AUTH_CHANGED:'ChatGPT 账号已变化，未继续请求或使用旧账号结果。',
 CHATGPT_AUTH_LOGIN:'请先登录所选 ChatGPT 账号。',CHATGPT_AUTH_PLAN:'当前账号未授予 ChatGPT 订阅使用权限，请重新授权。',
 CHATGPT_AUTH_EXPIRED:'ChatGPT 授权已失效，请重新登录。',CHATGPT_AUTH_CLOSED:'ChatGPT 授权模块已关闭。',
 CHATGPT_AUTH_STATE:'ChatGPT 登录请求已失效，请重新登录。',CHATGPT_AUTH_NETWORK:'ChatGPT 授权服务连接失败，请稍后重试。',
 CHATGPT_AUTH_STORAGE:'无法读取或保存本机 ChatGPT 加密账户。',CHATGPT_AUTH_BUSY:'另一实例正在管理 ChatGPT 账户，请使用已打开的应用。',
 CHATGPT_AUTH_IDENTITY:'ChatGPT 身份校验失败，未使用该凭证。',CHATGPT_AUTH_MISMATCH:'ChatGPT 账户身份不匹配，未继续请求。',
 CHATGPT_AUTH_REFRESH:'ChatGPT 授权刷新暂未成功，请稍后重试。',CHATGPT_AUTH_RESPONSE:'ChatGPT 授权服务响应无效。'};
function safeFailure(error){
 if(error?.[ownFault])return error;
 if(authErrors[error?.code])return fault(authErrors[error.code],error.code);
 const chain=[],queue=[error];
 while(queue.length&&chain.length<10){
  const item=queue.shift();if(!item||chain.includes(item))continue;chain.push(item);
  if(item.cause)queue.push(item.cause);
  if(Array.isArray(item.errors))queue.push(...item.errors.slice(0,10));
 }
 const codes=chain.map(item=>typeof item.code==='string'?item.code:'');
 if(codes.some(code=>/^ERR_TLS_|^CERT_|^ERR_SSL_|^UNABLE_TO_|^DEPTH_ZERO_SELF_SIGNED_CERT$|^SELF_SIGNED_CERT_IN_CHAIN$/.test(code))){
  const networkCode=codes.find(code=>knownTLSCodes.has(code));
  return Object.assign(fault('ChatGPT TLS 证书校验失败，请检查系统时间、代理和证书设置'+(networkCode?'（'+networkCode+'）':'')+'。','CHATGPT_TLS_ERROR'),networkCode?{networkCode}:{});
 }
 if(codes.includes('ENOTFOUND'))return Object.assign(fault('无法解析 ChatGPT 服务地址，请检查本机网络或代理配置（ENOTFOUND）。','CHATGPT_DNS_ERROR'),{networkCode:'ENOTFOUND'});
 if(chain.some(item=>item.name==='AbortError')||codes.some(code=>['ABORT_ERR','UND_ERR_ABORTED','ERR_ABORTED'].includes(code)))return fault('ChatGPT 请求已取消，未使用部分结果。','CHATGPT_CANCELLED');
 if(chain.some(item=>item.name==='TimeoutError'))return timeout();
 const explicitNetwork=codes.some(code=>transientNetworkCodes.has(code));
 // Native fetch may omit its cause. Match only its fixed transport errors;
 // never echo the original error, URL, response body or credential.
 const genericFetch=chain.some(item=>item instanceof TypeError&&['fetch failed','terminated'].includes(item.message))&&codes.every(code=>!code||transientNetworkCodes.has(code));
 if(explicitNetwork||genericFetch){
  const networkCode=codes.find(code=>transientNetworkCodes.has(code));
  return Object.assign(fault('ChatGPT 网络连接中断，请检查代理或网络后重试'+(networkCode?'（'+networkCode+'）':'')+'。','CHATGPT_NETWORK_ERROR'),{retryable:true},networkCode?{networkCode}:{});
 }
 return fault('ChatGPT 请求未完成，未使用部分结果。');
}
const timeout=()=>fault('ChatGPT 请求已超过本次总等待时间，未使用部分结果。','CHATGPT_TIMEOUT');
async function abortable(operation,signal){
 if(!signal)return operation();
 if(signal.aborted)throw timeout();
 let abort;
 const interrupted=new Promise((_,reject)=>{abort=()=>reject(timeout());signal.addEventListener('abort',abort,{once:true});});
 try{return await Promise.race([Promise.resolve().then(operation),interrupted]);}
 finally{signal.removeEventListener('abort',abort);}
}
function requestError(status,code){
 if(code==='subscription_sharing_usage_limit_exceeded'||status===429)
  return fault('ChatGPT 额度已达到限制，请在 ChatGPT 设置 → 使用情况中查看；未切换到付费 API。','CHATGPT_USAGE_LIMIT');
 if(status===401)return fault('ChatGPT 授权已失效，请在 AI 服务中重新登录。','CHATGPT_AUTH_REQUIRED');
 if(status===403)return fault('当前 ChatGPT 账号、工作区或策略暂不允许使用订阅额度。','CHATGPT_ACCESS_DENIED');
 if(temporaryServiceCodes.has(code)||[408,500,502,503,504].includes(status))return Object.assign(fault('ChatGPT 服务暂时不可用，请稍后重试'+(status?'（HTTP '+status+'）':'')+'。','CHATGPT_SERVICE_UNAVAILABLE'),{retryable:true});
 return fault('ChatGPT 请求未完成，请稍后重试'+(status?'（HTTP '+status+'）':'')+'。');
}
async function checkResponse(response){
 if(response.ok)return;
 let code;try{code=(await response.json())?.error?.code;}catch{}
 throw requestError(response.status,code);
}
export async function readPlanResponse(response,{signal}={}){
 await checkResponse(response);
 if(!response.body)throw fault('ChatGPT 未返回响应流。');
 const reader=response.body.getReader(),decoder=new TextDecoder();
 let buffer='',size=0,completed=false,answer='';
 const textParts=new Map();
 const consume=frame=>{
  const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
  if(!data||data==='[DONE]')return;
  let event;try{event=JSON.parse(data);}catch{throw fault('ChatGPT 响应格式不完整，请重试。');}
  if(event.type==='response.failed'||event.type==='error')throw requestError(null,event.response?.error?.code||event.code);
  if(event.type==='response.incomplete')throw fault('ChatGPT 输出未完成，未使用部分结果。');
  if(event.type==='response.output_text.delta'||event.type==='response.output_text.done'){
   if(completed)throw fault('ChatGPT 完成状态后仍返回了文本，未使用该结果。');
   const outputIndex=event.output_index??0,contentIndex=event.content_index??0;
   const value=event.type==='response.output_text.delta'?event.delta:event.text;
   if(!Number.isInteger(outputIndex)||outputIndex<0||!Number.isInteger(contentIndex)||contentIndex<0||typeof value!=='string')throw fault('ChatGPT 返回了无效文本片段。');
   const key=outputIndex+':'+contentIndex,previous=textParts.get(key);
   if(previous?.done)throw fault('ChatGPT 重复返回了已结束的文本片段。');
   const text=event.type==='response.output_text.delta'?(previous?.text||'')+value:value;
   if(text.length>100000)throw fault('ChatGPT 响应过大，已停止读取。');
   textParts.set(key,{outputIndex,contentIndex,text,done:event.type==='response.output_text.done'});
  }
  if(event.type==='response.completed'){
   if(completed||event.response?.status!=='completed')throw fault('ChatGPT 返回了无效的完成状态。');
   if(event.response.output!==undefined&&!Array.isArray(event.response.output))throw fault('ChatGPT 未返回有效的输出结构。');
   const parts=(event.response.output||[]).filter(item=>item?.type==='message'&&item.role==='assistant')
    .flatMap(item=>Array.isArray(item.content)?item.content:[]).filter(item=>item?.type==='output_text');
   if(parts.some(item=>typeof item.text!=='string'))throw fault('ChatGPT 返回了无效文本。');
   answer=parts.map(item=>item.text).join('\n').trim();
   // Plan streams can deliver text only in delta/done events, with an empty
   // terminal output array. Release it only after response.completed, never
   // on an interrupted stream or a later usage-limit/error event.
   if(event.response.output===undefined||event.response.output.length===0)answer=[...textParts.values()].sort((a,b)=>a.outputIndex-b.outputIndex||a.contentIndex-b.contentIndex).map(part=>part.text).join('\n').trim();
   if(!answer||answer.length>100000)throw fault('ChatGPT 未返回可用文本。');
   completed=true;
  }
 };
 try{
  while(true){
   let chunk;try{chunk=await abortable(()=>reader.read(),signal);}catch(error){throw safeFailure(error);}
   const {value,done}=chunk;buffer+=decoder.decode(value,{stream:!done});size+=value?.byteLength||0;
   if(size>4_000_000)throw fault('ChatGPT 响应过大，已停止读取。');
   buffer=buffer.replace(/\r\n/g,'\n');let boundary;
   while((boundary=buffer.indexOf('\n\n'))>=0){consume(buffer.slice(0,boundary));buffer=buffer.slice(boundary+2);}
   if(done)break;
  }
  if(buffer.trim())consume(buffer);
  if(!completed)throw fault('ChatGPT 连接在完成前中断，未使用部分结果。');
  return answer;
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function createChatGPTPlanClient(auth,{fetchImpl=(...args)=>fetch(...args),now=()=>Date.now(),waitImpl=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 let catalog=null;
 const guard=identity=>{if(auth.identityKey()!==identity)throw fault(authErrors.CHATGPT_AUTH_CHANGED,'CHATGPT_AUTH_CHANGED');};
 async function request(identity,step,budgetMs,operation){
  const controller=new AbortController(),deadline=now()+budgetMs;let attempts=0;
  const timer=setTimeout(()=>controller.abort(),budgetMs);timer.unref?.();
  const check=()=>{guard(identity);if(controller.signal.aborted||now()>=deadline){controller.abort();throw timeout();}};
  try{
   while(attempts<3){
    check();attempts++;
    try{
     const result=await abortable(()=>operation(controller.signal,()=>{check();}),controller.signal);
     check();return result;
    }catch(error){
     check();const failure=safeFailure(error);
     if(!failure.retryable||attempts>=3)throw failure;
     const remaining=deadline-now();
     await abortable(()=>waitImpl(Math.min(1000*2**(attempts-1),remaining)),controller.signal);
    }
   }
  }catch(error){
   const failure=auth.identityKey()!==identity?fault(authErrors.CHATGPT_AUTH_CHANGED,'CHATGPT_AUTH_CHANGED'):safeFailure(error);
   const label=step==='models'?'模型列表':'AI 生成';
   throw Object.assign(fault(failure.message+'（步骤：'+label+'；错误码：'+failure.code+'；已尝试 '+attempts+' 次）',failure.code),{step,attempts},failure.networkCode?{networkCode:failure.networkCode}:{});
  }finally{clearTimeout(timer);controller.abort();}
 }
 async function models(){
  const identity=auth.identityKey();
  const choices=await request(identity,'models',15000,async(signal,check)=>{
   const token=await auth.accessToken();check();
   const response=await fetchImpl(endpoint+'/models',{headers:{Authorization:'Bearer '+token},signal,redirect:'error'});check();
   await checkResponse(response);let data;
   try{data=await response.json();}catch(error){if(error instanceof SyntaxError)throw fault('ChatGPT 可用模型列表格式无效。');throw error;}
   check();if(!Array.isArray(data?.models)||data.models.some(model=>!model||typeof model!=='object'))throw fault('ChatGPT 可用模型列表格式无效。');
   const choices=data.models.filter(model=>model.visibility==='list'&&typeof model.slug==='string'&&model.slug.trim()).map(model=>model.slug);
   if(!choices.length)throw fault('当前 ChatGPT 账号没有可用的订阅模型。','CHATGPT_ACCESS_DENIED');
   return choices;
  });
  catalog={identity,time:now(),choices};return choices;
 }
 async function chat(settings,messages){
  const model=String(settings.chatgptModel||'').trim();
  if(!model)throw fault('请在 AI 服务中获取并选择 ChatGPT 账号可用的模型。','CHATGPT_MODEL_REQUIRED');
  const identity=auth.identityKey();
  const choices=catalog?.identity===identity&&now()-catalog.time<300000?catalog.choices:await models();
  guard(identity);
  if(!choices.includes(model))throw fault('所选模型不在当前 ChatGPT 账号的可用列表中，请重新获取模型。','CHATGPT_MODEL_REQUIRED');
  const input=messages.map(message=>{
   if(!['system','developer','user','assistant'].includes(message.role)||typeof message.content!=='string')throw fault('AI 输入格式无效。');
   return {role:message.role==='system'?'developer':message.role,content:message.content};
  });
  return request(identity,'responses',90000,async(signal,check)=>{
   const token=await auth.accessToken();check();
   const response=await fetchImpl(endpoint+'/responses',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify({model,input,store:false,stream:true}),signal,redirect:'error'});check();
   const answer=await readPlanResponse(response,{signal});check();return answer;
  });
 }
 return {chat,models};
}
