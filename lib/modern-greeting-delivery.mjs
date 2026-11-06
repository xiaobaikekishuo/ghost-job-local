import {jobUrlKey} from './job-greeting-browser.mjs';

const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
const label = value => typeof value==='string' ? value.trim().replace(/\s+/g,' ') : '';
const id = value => typeof value==='string' && value.trim() ? value : '';
const problem = (message,code='GREETING_TARGET_UNAVAILABLE') => Object.assign(Error(message),{code});
const asError = value => value instanceof Error ? value : Object.assign(Error(value?.message||String(value)),value&&typeof value==='object'?value:{});
const responseError = (result,fallback) => Object.assign(Error(result?.error||fallback),
  result?.code?{code:result.code}:{},result?.notSent===true?{notSent:true}:{});
const uniqueIds = values => Array.isArray(values) ? [...new Set(values.map(id).filter(Boolean))] : [];

function validateProof(proof,job,maxAgeMs) {
  const key=jobUrlKey(job?.url);
  if (!key || jobUrlKey(proof?.jobUrl)!==key)
    throw problem('当前会话证明的公开岗位链接与目标岗位不一致，未发送专属招呼');
  if (!id(proof?.targetId) || !(typeof proof.generation==='number'&&Number.isFinite(proof.generation) || typeof proof.generation==='string'&&proof.generation.trim()))
    throw problem('会话证明缺少固定标签页或连接代次，未发送专属招呼');
  const created=typeof proof.createdAt==='number'?proof.createdAt:Date.parse(proof.createdAt);
  if (!Number.isFinite(created) || Date.now()-created>maxAgeMs || created-Date.now()>5000)
    throw problem('当前会话证明已过期，请重新核对岗位后发送');
  if (['contact','company','jobTitle'].some(key=>!label(proof.expected?.[key])) || !uniqueIds(proof.expected?.anchorIds).length)
    throw problem('会话证明缺少 HR、公司、岗位或消息锚点，未发送专属招呼');
  for (const [jobKey,contextKey] of [['title','jobTitle'],['company','company'],['hrName','contact']])
    if (label(job[jobKey]) && label(job[jobKey])!==label(proof.expected[contextKey]))
      throw problem('会话证明的 HR、公司或岗位与目标信息不一致，未发送专属招呼');
}

function verifyContext(proof,context) {
  if (!context || context.error) throw responseError(context,'无法读取已核对的岗位会话');
  if (['contact','company','jobTitle'].some(key=>label(context[key])!==label(proof.expected[key])))
    throw problem('当前 HR、公司或岗位已变化，无法继续确认专属招呼');
  if (context.jobUrl && jobUrlKey(context.jobUrl)!==jobUrlKey(proof.jobUrl))
    throw problem('当前会话岗位链接已变化，无法继续确认专属招呼');
  // Adapters must enforce these against the actual page on EVERY read/action.
  // If they also return metadata, do not silently accept a mismatched target.
  if (context.targetId!==undefined && context.targetId!==proof.targetId ||
      context.generation!==undefined && context.generation!==proof.generation)
    throw problem('会话标签页或浏览器连接已变化，无法继续确认专属招呼');
  const anchors=uniqueIds(context.anchorIds);
  if (!uniqueIds(proof.expected.anchorIds).some(anchor=>anchors.includes(anchor)))
    throw problem('已核对的会话消息锚点已失效，无法继续确认专属招呼');
  if (!Array.isArray(context.messages)) throw problem('会话消息结构不可读，无法确认专属招呼');
  const seen=new Map();
  for (const message of context.messages) {
    if (!message?.platformMessageId) continue;
    if (message.platformMessageId!==true || !id(message.remoteId) || !anchors.includes(message.remoteId))
      throw problem('消息编号缺少可核对的平台锚点，无法确认专属招呼');
    const signature=JSON.stringify([message.role,message.text,message.deliveryStatus]);
    if (seen.has(message.remoteId) && seen.get(message.remoteId)!==signature)
      throw problem('同一消息编号对应不同内容，无法确认专属招呼');
    seen.set(message.remoteId,signature);
  }
  return {context,anchors};
}

const conversationOf = (proof,context) => ({jobUrl:'https://www.zhipin.com'+jobUrlKey(proof.jobUrl),
  contact:context.contact,company:context.company,jobTitle:context.jobTitle,modernProofVerified:true});

function openingResult(proof,context,{receiptId,unknown=false,draftRetained=false}={}) {
  return {verified:false,notSent:true,conversation:conversationOf(proof,context),
    ...(unknown?{presenceUnknown:true,code:'GREETING_PRESENCE_UNCERTAIN'}:{alreadyGreeted:true,code:'GREETING_ALREADY_PRESENT',receiptId}),
    ...(draftRetained?{draftRetained:true}:{}),
    reason:(unknown?'目标会话已有本人文本，但送达状态或平台消息编号尚未确认；本次未发送，请先核实。':
      '目标会话已有已确认的本人开场，本次未追加专属招呼。')+
      (draftRetained?' 本次填入的草稿已保留，未点击发送。':'')};
}

function existingOpening(proof,read,draftRetained=false) {
  const own=read.context.messages.filter(message=>message?.role==='assistant'&&label(message.text));
  const confirmed=own.find(message=>message.platformMessageId===true&&id(message.remoteId)&&
    read.anchors.includes(message.remoteId)&&message.deliveryStatus==='confirmed');
  if(confirmed)return openingResult(proof,read.context,{receiptId:confirmed.remoteId,draftRetained});
  if(own.length||read.context.ownTextUnknownCount!==undefined&&read.context.ownTextUnknownCount!==0)
    return openingResult(proof,read.context,{unknown:true,draftRetained});
  return null;
}

function refusedOpening(proof,context,result,draftRetained=false) {
  if(result?.notSent!==true)return null;
  if(result.code==='GREETING_ALREADY_PRESENT'&&result.alreadyGreeted===true&&id(result.receiptId))
    return openingResult(proof,context,{receiptId:result.receiptId,draftRetained});
  if(result.code==='GREETING_PRESENCE_UNCERTAIN'||result.code==='GREETING_ALREADY_PRESENT')
    return openingResult(proof,context,{unknown:true,draftRetained});
  return null;
}

// Read-only preview uses the exact same recipient and opening checks as delivery.
export function inspectGreetingOpening(proof,job,context) {
  validateProof(proof,job,60000);
  return existingOpening(proof,verifyContext(proof,context));
}

/**
 * The adapter establishes public job ownership and atomically verifies proof,
 * target, generation and live DOM identity on each read/action. It must return
 * modernChatDOM-shaped results. This helper never selects a recipient or retries
 * a send. anchorIds and messages are in the page's chronological DOM order.
 */
export async function sendModernGreeting(adapter,job,text,options={}) {
  const timeoutMs=Number.isFinite(options.timeoutMs)?Math.min(30000,Math.max(0,options.timeoutMs)):8000;
  const pollMs=Number.isFinite(options.pollMs)?Math.min(1000,Math.max(1,options.pollMs)):250;
  const tailTimeoutMs=Number.isFinite(options.tailTimeoutMs)?Math.min(5000,Math.max(0,options.tailTimeoutMs)):2000;
  const tailPollMs=Number.isFinite(options.tailPollMs)?Math.min(500,Math.max(1,options.tailPollMs)):Math.min(100,pollMs);
  const proofMaxAgeMs=Number.isFinite(options.proofMaxAgeMs)?Math.min(120000,Math.max(1,options.proofMaxAgeMs)):60000;
  let attempted=false,knownRefusal;
  const guard=()=>{if(options.guard?.()===false)throw problem('操作已停止','CANCELLED');};
  const stableLatest=async proof=>{
    const deadline=Date.now()+tailTimeoutMs;let previous='';
    do{
      guard();validateProof(proof,job,proofMaxAgeMs);
      const read=verifyContext(proof,await adapter.read(proof));guard();
      const tail=read.context.latestTail,last=read.anchors.at(-1);
      const signature=tail?.atBottom===true&&tail.loading===false&&typeof tail.signature==='string'&&tail.signature.trim()&&last?
        JSON.stringify([tail.signature,last]):'';
      if(signature&&signature===previous)return read;
      previous=signature;
      if(Date.now()>=deadline)break;
      await pause(Math.min(tailPollMs,Math.max(0,deadline-Date.now())));
    }while(Date.now()<=deadline);
    guard();throw problem('消息列表尚未稳定处于最新消息尾部，未执行发送；请等待消息加载完成');
  };
  const tailProof=(proof,read)=>({...proof,expected:{...proof.expected,anchorIds:[read.anchors.at(-1)],noExistingOpening:true,
    requireLatestTail:true,tailSignature:read.context.latestTail.signature}});
  try {
    guard();
    if (!adapter || ['prove','read','action'].some(method=>typeof adapter[method]!=='function'))
      throw problem('现代会话发送适配器不可用','GREETING_CAPABILITY_UNAVAILABLE');
    if (typeof text!=='string' || !text.trim()) throw problem('专属招呼为空，未发送','GREETING_INVALID');
    const proof=await adapter.prove(job);guard();
    if(proof?.error)throw responseError(proof,'无法核对岗位会话');
    validateProof(proof,job,proofMaxAgeMs);
    const first=await stableLatest(proof);guard();
    const present=existingOpening(proof,first);if(present)return present;
    let filled;
    try{filled=await adapter.action(tailProof(proof,first),'fill',text);}
    catch(value){const error=asError(value),present=refusedOpening(proof,first.context,error);if(present)return present;throw error;}
    guard();
    const fillRefusal=refusedOpening(proof,first.context,filled);if(fillRefusal)return fillRefusal;
    if (filled?.ok!==true || filled.error) throw responseError(filled,'未确认专属招呼已填入，未执行发送');
    // A new HR message can arrive while filling. Capture the final visible
    // boundary immediately before the click and require it in the click's DOM
    // evaluation as well, rather than accepting any older identity anchor.
    validateProof(proof,job,proofMaxAgeMs);
    const before=await stableLatest(proof);guard();
    const arrived=existingOpening(proof,before,true);if(arrived)return arrived;
    const lastAnchor=before.anchors.at(-1);
    if (!lastAnchor) throw problem('发送前未读取到消息边界，未执行发送');
    const oldIds=new Set([...first.anchors,...before.anchors,
      ...first.context.messages.map(message=>id(message.remoteId)),...before.context.messages.map(message=>id(message.remoteId))]);
    const sendingProof=tailProof(proof,before);
    guard();
    // From this boundary onward an unknown outcome must keep the delivery
    // ledger uncertain. Only an explicit adapter guarantee can prove no click.
    attempted=true;
    await options.onAttempt?.();
    try { guard(); } catch(error) { knownRefusal=asError(error);knownRefusal.notSent=true;throw knownRefusal; }
    let sent;
    try { sent=await adapter.action(sendingProof,'send',text); }
    catch(value) { const error=asError(value),present=refusedOpening(proof,before.context,error,true);if(present)return present;if(error.notSent===true)knownRefusal=error;throw error; }
    const sendRefusal=refusedOpening(proof,before.context,sent,true);if(sendRefusal)return sendRefusal;
    if (sent?.ok!==true || sent.error || sent.clicked!==true) {
      const error=responseError(sent,'发送操作未返回明确点击结果，请到目标会话核实；不会自动重发');
      if(sent?.notSent===true)knownRefusal=error;
      if(!error.code)error.code='GREETING_UNCERTAIN';
      throw error;
    }
    const deadline=Date.now()+timeoutMs;
    let after=before.context;
    do {
      // Do not cancel the receipt observation after a click. A stop cannot undo
      // the message; reading the outcome prevents a blind retry next time.
      const read=verifyContext(sendingProof,await adapter.read(sendingProof));
      after=read.context;
      const boundary=read.anchors.indexOf(lastAnchor);
      const receipts=new Map();
      for(const message of after.messages) {
        if(message.role==='assistant' && message.text===text && message.platformMessageId===true && id(message.remoteId) &&
           !oldIds.has(message.remoteId) && read.anchors.indexOf(message.remoteId)>boundary && message.deliveryStatus==='confirmed')
          receipts.set(message.remoteId,message);
      }
      if(receipts.size===1) {
        return {verified:true,conversation:conversationOf(sendingProof,after),receiptId:[...receipts.keys()][0],
          reason:'已在核对的岗位会话中确认专属招呼的新发送回执'};
      }
      if(Date.now()>=deadline)break;
      await pause(Math.min(pollMs,Math.max(0,deadline-Date.now())));
    } while(Date.now()<=deadline);
    return {verified:false,conversation:conversationOf(sendingProof,after),code:'GREETING_UNCERTAIN',
      reason:'未取得唯一、已确认的新消息回执，请到目标会话核实；不会自动重发'};
  } catch(value) {
    const error=asError(value);
    if(!attempted)error.notSent=true;
    else if(error!==knownRefusal)delete error.notSent;
    throw error;
  }
}
