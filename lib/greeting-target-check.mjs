import {createModernGreetingAdapter} from './modern-greeting-adapter.mjs';
import {inspectGreetingOpening} from './modern-greeting-delivery.mjs';

// Probe the same recipient proof used by delivery, without generating content,
// creating contact, filling the composer, sending, or changing the delivery ledger.
export async function checkGreetingTarget(browser,job,{guard=()=>true,onDiagnostic,...options}={}) {
  if (!job || job.status!=='已沟通' || job.demo || job.simulation)
    throw Error('请从已沟通的真实岗位中选择一条待补招呼');
  const active=()=>{if(guard()===false)throw Object.assign(Error('操作已停止'),{code:'CANCELLED',notSent:true});};
  active(); await browser.openChat(); active();
  const targetId=browser.chatTargetId;
  const generation=browser.connection?.generation??browser.connectionGeneration??0;
  const diagnosticGuard=()=>{
    active();
    if(browser.connection?.session?.connected===false||(browser.connection?.generation??browser.connectionGeneration??0)!==generation||
       browser.chatTargetId!==targetId||browser.activeTargetId!==targetId)
      throw Object.assign(Error('本次消息页或浏览器连接已变更'),{code:'DIAGNOSTIC_TARGET_CHANGED'});
    return true;
  };
  const list=await browser.waitForConversationList({targetId,guard:active});active();
  if(!list.modernWithoutIds)throw Error('当前消息页不是支持预检查的新版会话列表，请使用页面诊断核对');
  let proof,opening;
  try {
    const adapter=createModernGreetingAdapter(browser,{...options,targetId,guard:active});
    proof=await adapter.prove(job);active();
    opening=inspectGreetingOpening(proof,job,await adapter.read(proof));active();
  } catch(error) {
    // Best-effort local diagnostics must never replace the recipient failure,
    // continue a cancelled operation, or inspect a different browser document.
    if(typeof onDiagnostic==='function'&&typeof browser.captureDiagnostics==='function'&&
       !['CANCELLED','CDP_DISCONNECTED','CDP_CONNECTION_FAILED','CDP_CONNECT_TIMEOUT','CDP_SESSION_DETACHED'].includes(error?.code)) {
      try {
        diagnosticGuard();
        const diagnostic=await browser.captureDiagnostics({targetId,generation,guard:diagnosticGuard});
        diagnosticGuard();
        if(diagnostic?.usable===true)await onDiagnostic({version:1,kind:'greeting-target-check',capturedAt:new Date().toISOString(),
          targetId,generation,errorCode:/^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code||'')?error.code:'GREETING_TARGET_UNAVAILABLE',diagnostic});
      } catch {}
    }
    throw error;
  }
  active();
  return {ok:true,verified:true,sent:false,jobUrl:proof.jobUrl,alreadyGreeted:opening?.alreadyGreeted===true,presenceUnknown:opening?.presenceUnknown===true,
    contact:proof.expected.contact,company:proof.expected.company,jobTitle:proof.expected.jobTitle,
    reason:opening?.alreadyGreeted?'已核对 HR、公司和岗位，并检测到已有本人开场。软件会跳过追加招呼；本次检查未发送消息。':
      opening?.presenceUnknown?'已核对岗位，但本人消息状态待确认。软件会阻止追加；本次检查未发送消息。':
      '已核对 HR、公司和公开岗位链接。尚未发送消息；发送时会再次核对。'};
}
