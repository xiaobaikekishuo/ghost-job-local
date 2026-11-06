import {assertConversation} from './conversation.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalized = value => String(value || '').trim().replace(/\s+/g, ' ');
const identity = conversation => String(conversation?.remoteId || conversation?.id || '');
const notSent = message => Object.assign(Error(message), {notSent: true});
export function greetingTargetUnavailable(message, cause) {
  // Coded failures may require a hard stop (including future auth/transport
  // codes). Never downgrade them into a recoverable recipient lookup failure.
  if (cause?.code) return cause;
  return Object.assign(Error(message, cause ? {cause} : undefined), {code: 'GREETING_TARGET_UNAVAILABLE', notSent: true});
}
const assertRecipient = (expected, current) => {
  try { assertConversation(expected, current); }
  catch (error) { throw greetingTargetUnavailable(error.message, error); }
};

async function advanceList(browser, guard, targetId) {
  if (!browser.scrollConversations) throw greetingTargetUnavailable('无法完整核对会话列表，未发送定制招呼');
  const progress = await browser.scrollConversations({progress: true, targetId, guard}); guard();
  if (typeof progress === 'boolean') return progress;
  if (!progress || progress.unavailable) throw greetingTargetUnavailable('无法确认会话列表的滚动位置，未发送定制招呼');
  // A stalled or bouncing viewport is not proof that the list is complete.
  return progress.complete !== true;
}

export function jobUrlKey(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && ['www.zhipin.com', 'zhipin.com'].includes(url.hostname) &&
        !url.username && !url.password && !url.port && /^\/job_detail\/[^/]+\.html$/.test(url.pathname)) return url.pathname;
  } catch {}
  return '';
}

// A prior outgoing text is a reason not to add another opening. Synthetic
// message identifiers and unknown delivery states never become sent receipts.
export function greetingOpeningPresence(conversation) {
 const messages=Array.isArray(conversation?.messages)?conversation.messages:[];
 const own=messages.filter(message=>message.role==='assistant'&&message.kind!=='attachment'&&message.visible!==false&&
  typeof message.text==='string'&&message.text.trim());
 if(!own.length)return null;
 const confirmed=own.find(message=>message.platformMessageId===true&&typeof message.remoteId==='string'&&message.remoteId.trim()&&
  message.deliveryStatus==='confirmed'&&!messages.some(other=>other.remoteId===message.remoteId&&
   (other.role!==message.role||other.text!==message.text)));
 return {verified:false,notSent:true,conversation,
  ...(confirmed?{code:'GREETING_ALREADY_PRESENT',alreadyGreeted:true,receiptId:confirmed.remoteId,
   reason:'已在目标会话看到本人已发送的文字开场，本次不再追加专属招呼'}:
   {code:'GREETING_PRESENCE_UNCERTAIN',presenceUnknown:true,
    reason:'目标会话已有本人文字，但平台编号或送达状态尚未可靠核实，本次不再追加开场'})};
}

// A conflicting URL always wins over similar labels. Display-name matching is
// only a fallback and must be unique across a completely read conversation list.
export function jobConversationMatch(job, conversation) {
  if (!identity(conversation) || conversation?.error) return '';
  const expectedUrl = jobUrlKey(job.url), actualUrl = jobUrlKey(conversation.jobUrl);
  if (job.url && !expectedUrl || conversation.jobUrl && !actualUrl) return '';
  if (expectedUrl && actualUrl && expectedUrl !== actualUrl) return '';
  const title = normalized(job.title), company = normalized(job.company), hr = normalized(job.hrName);
  const actualTitle = normalized(conversation.jobTitle), actualCompany = normalized(conversation.company);
  if (hr && hr !== normalized(conversation.contact)) return '';
  if (expectedUrl && actualUrl) {
    if (title && actualTitle && title !== actualTitle || company && actualCompany && company !== actualCompany) return '';
    return 'url';
  }
  return title && company && title === actualTitle && company === actualCompany ? 'identity' : '';
}

export async function sendJobGreeting(browser, job, text, options = {}) {
  let attempted = false;
  const check = () => {
    if (options.guard?.() === false) throw Object.assign(Error('操作已停止'), {code: 'CANCELLED'});
  };
  try {
    check();
    if (typeof text !== 'string' || !text.trim()) throw notSent('定制招呼为空，未执行发送');
    if (!job || !jobUrlKey(job.url) && !(normalized(job.title) && normalized(job.company)))
      throw greetingTargetUnavailable('岗位缺少可核对的链接或名称与公司，未发送定制招呼');

    // Deliberately select from the chat list; never send to whichever HR was
    // left active in an older chat tab after the job's communicate button.
    if (options.openedTargetId) {
      if (browser.chatTargetId !== options.openedTargetId || browser.activeTargetId !== options.openedTargetId)
        throw greetingTargetUnavailable('已打开的消息标签页已变化，未发送定制招呼');
    } else await browser.openChat();
    check();
    const targetId = browser.chatTargetId || browser.activeTargetId || undefined;
    const guard = () => {
      check();
      if (targetId && (browser.chatTargetId !== targetId || browser.activeTargetId !== targetId))
        throw greetingTargetUnavailable('会话标签页已切换，未继续发送定制招呼');
    };
    if (browser.resetConversations) { await browser.resetConversations({targetId, guard}); guard(); }
    const seen = new Map();
    let candidate, exhausted = false, lastList = [], previousSignature = '', stagnant = 0;
    for (let page = 0; page < 60; page++) {
      guard();
      const list = await browser.listConversations({forGreeting: true, targetId, guard}); guard();
      lastList = list;
      for (const item of list) {
        const key = identity(item);
        if (!key) continue;
        const previous = seen.get(key);
        if (previous) assertRecipient(previous, item);
        seen.set(key, item);
      }
      const byUrl = [...seen.values()].filter(item => jobConversationMatch(job, item) === 'url');
      if (byUrl.length > 1) throw greetingTargetUnavailable('同一岗位对应多个会话，无法唯一确认 HR，未发送定制招呼');
      if (byUrl.length === 1) { candidate = byUrl[0]; break; }
      guard();
      const signature = JSON.stringify(list.map(identity));
      stagnant = signature === previousSignature ? stagnant + 1 : 0;
      previousSignature = signature;
      if (stagnant >= 3) throw greetingTargetUnavailable('会话列表读取停滞，未能确认完整列表；定制招呼未发送');
      const more = await advanceList(browser, guard, targetId);
      if (!more) { exhausted = true; break; }
      await pause(300); guard();
    }
    if (!candidate) {
      if (!exhausted) throw greetingTargetUnavailable('会话列表尚未完整读取，无法确认岗位对应的唯一 HR');
      const matches = [...seen.values()].filter(item => jobConversationMatch(job, item) === 'identity');
      if (matches.length !== 1) throw greetingTargetUnavailable(matches.length ? '岗位名称与公司匹配多个 HR，未发送定制招呼' : '未找到能确认属于该岗位的会话，未发送定制招呼');
      candidate = matches[0];
    }

    // A complete fallback scan may leave the desired row outside the viewport.
    if (!lastList.some(item => identity(item) === identity(candidate))) {
      if (!browser.resetConversations) throw greetingTargetUnavailable('目标会话不在当前列表，未发送定制招呼');
      await browser.resetConversations({targetId, guard}); guard();
      let found = false; previousSignature = ''; stagnant = 0;
      for (let page = 0; page < 60; page++) {
        const list = await browser.listConversations({forGreeting: true, targetId, guard}); guard();
        const matching = list.filter(item => identity(item) === identity(candidate));
        if (matching.length > 1) throw greetingTargetUnavailable('目标会话出现重复身份，未发送定制招呼');
        if (matching.length === 1) { assertRecipient(candidate, matching[0]); found = true; break; }
        const signature = JSON.stringify(list.map(identity));
        stagnant = signature === previousSignature ? stagnant + 1 : 0;
        previousSignature = signature;
        if (stagnant >= 3) throw greetingTargetUnavailable('重新定位会话时列表停滞，定制招呼未发送');
        const more = await advanceList(browser, guard, targetId);
        if (!more) break;
        await pause(300); guard();
      }
      if (!found) throw greetingTargetUnavailable('目标会话已离开列表，未发送定制招呼');
    }
    guard();
    await browser.selectConversation(candidate, {forGreeting: true, targetId}); guard();
    const before = await browser.readChat({targetId, forGreeting: true}); guard();
    assertRecipient(candidate, before);
    if (!jobConversationMatch(job, before)) throw greetingTargetUnavailable('当前 HR 的岗位信息与目标岗位不一致，未发送定制招呼');
    const expected = Object.fromEntries(['id', 'remoteId', 'contact', 'company', 'jobTitle', 'jobUrl'].map(key => [key, before[key]]));
    const openingResult=(result,current)=>{
      guard();assertRecipient(expected,current);
      if(!jobConversationMatch(job,current))throw greetingTargetUnavailable('已有开场所在会话与目标岗位不一致，未执行发送');
      const observed=greetingOpeningPresence(current);
      const exact=jobConversationMatch(job,current)==='url'&&identity(current)&&
        normalized(job.hrName)&&normalized(job.hrName)===normalized(current.contact)&&
        normalized(job.company)&&normalized(job.company)===normalized(current.company)&&
        normalized(job.title)&&normalized(job.title)===normalized(current.jobTitle);
      if(exact&&result.code==='GREETING_ALREADY_PRESENT'&&result.alreadyGreeted===true&&result.notSent===true&&
        observed?.code==='GREETING_ALREADY_PRESENT'&&observed.receiptId===result.receiptId)
        return {...observed,conversation:{...current,jobUrl:'https://www.zhipin.com'+jobUrlKey(current.jobUrl),legacyProofVerified:true}};
      return {verified:false,notSent:true,code:'GREETING_PRESENCE_UNCERTAIN',presenceUnknown:true,conversation:current,
        reason:'发现本人已有文字开场，但岗位或真实平台回执未能完整核对，本次不再追加消息'};
    };
    const existing=greetingOpeningPresence(before);
    if(existing)return openingResult(existing,before);
    const sent = await browser.sendChat(expected, text, {
      ...options, targetId, guard, forGreeting: true,
      onAttempt() {
        guard();
        options.onAttempt?.();
        attempted = true;
      }
    });
    if(sent?.notSent===true&&['GREETING_ALREADY_PRESENT','GREETING_PRESENCE_UNCERTAIN'].includes(sent.code))
      return openingResult(sent,sent.conversation);
    // No cancellation check after the click: read the outcome without sending
    // anything else. An unreadable result remains uncertain rather than retryable.
    const after = await browser.readChat({targetId});
    assertConversation(expected, after);
    if (!jobConversationMatch(job, after)) throw Error('发送后的岗位会话信息变化，定制招呼状态待核实');
    const matchingMessages = conversation => (conversation.messages || []).filter(message => message.role === 'assistant' && message.text === text);
    const old = matchingMessages(before), current = matchingMessages(after);
    const receipt = current.findLast(message => message.remoteId && !old.some(previous => previous.remoteId === message.remoteId)) || (current.length > old.length ? current.at(-1) : undefined);
    const verified = sent === true && current.length > old.length && !!receipt && receipt.deliveryStatus !== 'failed';
    return {verified, conversation: after,
      reason: verified ? '已在目标岗位会话中确认定制招呼' : '未确认定制招呼发送成功，请到目标会话核实；不会自动重发',
      ...(verified && receipt.remoteId ? {receiptId: receipt.remoteId} : {})};
  } catch (error) {
    if (!attempted) {
      try { check(); } catch (cancelled) { cancelled.notSent = true; throw cancelled; }
      // Reset, read, and scroll all report this typed DOM availability error.
      // Only before any send attempt may it become a deferred greeting. Never
      // reclassify transport/account errors or a missing post-click receipt.
      if (error.code === 'CHAT_LIST_UNAVAILABLE')
        throw greetingTargetUnavailable('消息列表暂不可读，专属招呼未发送：' + error.message);
      error.notSent = true;
    }
    throw error;
  }
}
