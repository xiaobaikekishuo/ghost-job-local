import {generateGreeting, GREETING_GENERATOR_VERSION, validateGreetingMatches, validateGeneratedGreeting} from './greeting.mjs';
import {chat} from './ai.mjs';
import {createHash} from 'node:crypto';
import {simulationGreetingMatches} from './simulation.mjs';
import {identity} from './store.mjs';
import {assertActive} from './conversation.mjs';
import {jobUrlKey} from './job-greeting-browser.mjs';
import {hasUsableJobDetail,normalizeJobTitle,normalizeHRName} from './job-detail-quality.mjs';

const now = () => new Date().toISOString();
const fingerprint = (job, settings) => identity(JSON.stringify([jobUrlKey(job.url) || job.url, job.hrName, job.title, job.company, job.detailVersion, job.description, settings.resume,
  ...(settings.aiProvider==='chatgpt-plan'?['chatgpt-plan',settings.chatgptModel,settings.chatgptAccountId]:['api',String(settings.aiBase||'').trim().replace(/\/+$/u,''),settings.aiModel])]));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contentRevision = greeting => digest([greeting.text,greeting.matches,greeting.audit,greeting.fingerprint,
  greeting.generatorVersion,greeting.generationProvider,greeting.generationModel,greeting.generatedAt,greeting.edited===true]);
export function createJobGreetings({store, browser, detail, simulation = false, generate = generateGreeting}) {
  const get = id => { const job = store.getJob(id); if (!job) throw Error('岗位不存在'); return job; };
  const deliveryKey = job => 'job-greeting-delivery:' + identity(jobUrlKey(job.url) || job.url || job.id);
  const reviewKey = job => 'job-greeting-review:' + identity(jobUrlKey(job.url) || job.url || job.id);
  // Metadata is neither exported nor accepted by /api/import. A self-hashed
  // imported audit cannot stand in for a review actually completed locally.
  const reviewRecord = (job,greeting) => ({version:1,simulation:!!simulation,jobId:job.id,
    sourceFingerprint:greeting.fingerprint,revision:contentRevision(greeting),kind:greeting.edited?'manual':'generated'});
  const isTrusted = (job,greeting) => {
    const record=store.meta(reviewKey(job));
    return !!record && JSON.stringify(record)===JSON.stringify(reviewRecord(job,greeting));
  };
  const rememberReview = (id,greeting) => {const job=get(id);store.meta(reviewKey(job),reviewRecord(job,greeting));return greeting;};
  const ensureUnsent = job => { if (store.meta(deliveryKey(job))) throw Error('此岗位的招呼已有发送或待核实记录，不会重复发送，请到 BOSS 核对'); };
  const canDefer = result => result?.notSent === true && result.code === 'GREETING_TARGET_UNAVAILABLE';
  const update = (id, patch) => {
    const job = get(id);
    const greeting = {...job.greeting, ...patch};
    if (patch.deferred === false) greeting.deferReason = null;
    greeting.revision = contentRevision(greeting);
    return store.upsertJob({...job, greeting}).greeting;
  };
  function verify(id, expectedRevision) {
    const job = get(id), greeting = job.greeting;
    if (!greeting || greeting.status !== '草稿' || greeting.revision !== expectedRevision || greeting.revision !== contentRevision(greeting) || greeting.fingerprint !== fingerprint(job, store.settings(true))) {
      throw Error('招呼或简历岗位资料已变化，请重新预览并确认发送');
    }
    return greeting;
  }
  function assertPersonalized(id, expectedRevision) {
    const job = get(id);
    ensureUnsent(job);
    const greeting = job.greeting;
    const reject = (message, code = 'GREETING_REVIEW_REQUIRED') => { throw Object.assign(Error(message), {code, notSent: true}); };
    if (!hasUsableJobDetail(job)) reject('岗位详情仍是旧版本或列表摘要，请重新获取完整 JD 并生成招呼', 'JOB_DETAIL_REQUIRED');
    if (!greeting || greeting.status !== '草稿' || greeting.generatorVersion !== GREETING_GENERATOR_VERSION)
      reject('专属招呼未生成或属于旧版本，请重新生成并检查后再沟通', 'GREETING_STALE');
    if (greeting.fingerprint !== fingerprint(job, store.settings(true)) ||
        expectedRevision !== undefined && greeting.revision !== expectedRevision)
      reject('招呼或简历岗位资料已变化，请重新预览并确认发送', 'GREETING_STALE');
    let matches;
    try { matches = validateGreetingMatches(job, store.settings(true), greeting.matches); }
    catch (error) { reject('专属招呼证据未通过原文核实：' + error.message, 'GREETING_INVALID'); }
    if (!matches.length) reject('尚未找到岗位要求与简历的直接匹配证据，草稿待确认，未发起沟通', 'GREETING_NO_MATCH');
    if (!isTrusted(job,greeting) || greeting.revision!==contentRevision(greeting))
      reject('专属招呼缺少本机可信审查记录或正文证据已变化，请重新生成', 'GREETING_INVALID');
    const text = typeof greeting.text === 'string' ? greeting.text.trim() : '';
    if (!text || [...text].length > 200) reject('专属招呼正文为空或过长，请重新生成', 'GREETING_INVALID');
    const normalized = value => value.replace(/\s+/gu, '');
    if (greeting.edited) {
      if (!matches.every(match => normalized(text).includes(normalized(match.requirement)) && normalized(text).includes(normalized(match.evidence))))
        reject('正文未保留已核实的岗位要求和简历证据，请重新生成或核对', 'GREETING_INVALID');
      if (expectedRevision === undefined) reject('人工修改的招呼需先预览并明确确认，不会自动发送');
    } else {
      try { validateGeneratedGreeting(job,store.settings(true),greeting); }
      catch (error) { reject('专属招呼未通过当前正文与证据审查，请重新生成', 'GREETING_INVALID'); }
    }
    return greeting;
  }
  async function prepare(id, {force = false, active = () => true} = {}) {
    assertActive(active);
    let job = get(id);
    ensureUnsent(job);
    if (['已发送', '待核实', '已有开场'].includes(job.greeting?.status)) throw Error('此岗位的招呼已有发送记录，请先到 BOSS 核对，不会重复生成发送');
    const settings = store.settings(true);
    if (!String(settings.resume || '').trim()) throw Error('请先填写简历，再生成岗位专属招呼');
    if (!hasUsableJobDetail(job)) {
      if (!job.url) throw Error('请先补充完整岗位要求，再生成招呼');
      job = await detail(job, undefined, {active});
      assertActive(active);
    }
    if (!hasUsableJobDetail(job)) throw Object.assign(Error('未取得完整岗位职责或任职要求，不能用列表摘要生成专属招呼'), {code:'JOB_DETAIL_REQUIRED',notSent:true});
    const title=normalizeJobTitle(job.title),hrName=normalizeHRName(job.hrName);
    if(title!==job.title||hrName!==(job.hrName||''))job=store.upsertJob({...job,title,hrName});
    const key = fingerprint(job, settings);
    if (!force && job.greeting?.status === '草稿' && job.greeting.fingerprint === key &&
        job.greeting.generatorVersion === GREETING_GENERATOR_VERSION && isTrusted(job,job.greeting)) {
      try {
        if(job.greeting.edited)validateGreetingMatches(job,settings,job.greeting.matches);
        else validateGeneratedGreeting(job,settings,job.greeting);
        return job.greeting;
      } catch { /* Invalid or old cache must pass a fresh generation and review. */ }
    }
    const sourceGuard=()=>{
      assertActive(active);
      ensureUnsent(get(id));
      if(fingerprint(get(id),store.settings(true))!==key)
        throw Object.assign(Error('生成期间岗位、简历或模型账号已变化，请重新生成招呼'),{code:'GREETING_STALE',notSent:true});
    };
    let simulationCalls=0;
    const guardedChat=async(...args)=>{
      sourceGuard();
      let result;
      if(simulation){
        simulationCalls++;
        if(simulationCalls===1){
          const matches=simulationGreetingMatches(job,settings);
          const facts=matches.map(match=>match.evidence).join('、');
          const text=matches.length?`您好，我之前做过${facts}，希望进一步了解贵岗位的工作内容和具体安排，方便的话期待与您沟通。`:'';
          result=JSON.stringify({text,matches});
        }else if(simulationCalls===2)result=JSON.stringify({approved:true,unsupportedClaims:[],reason:'隔离模拟：正文仅使用当前样本的已核实事实。'});
        else throw Error('模拟招呼调用阶段超出预期');
      }else result=await chat(...args);
      sourceGuard();
      return result;
    };
    sourceGuard();
    const generated=await generate(job,settings,guardedChat);
    sourceGuard();
    if(generated.generatorVersion!==GREETING_GENERATOR_VERSION)
      throw Object.assign(Error('生成器返回旧版招呼，未保存为已审查草稿'),{code:'GREETING_INVALID',notSent:true});
    const {text,matches}=validateGeneratedGreeting(job,settings,generated),noMatch=!matches.length;
    return rememberReview(id,update(id, {...generated, text: noMatch ? '' : text, matches, generatorVersion: GREETING_GENERATOR_VERSION,
      reviewRequired: noMatch, reviewReason: noMatch ? 'no_match' : null,
      fingerprint: key, status: '草稿', edited: false, deferred: false, deferredAt: null, code: noMatch ? 'GREETING_NO_MATCH' : null,
      error: noMatch ? '未找到岗位要求与简历的直接匹配证据，需人工确认；不会自动发送通用招呼。' : null}));
  }
  function save(id, text) {
    const job = get(id);
    ensureUnsent(job);
    if (!job.greeting || job.greeting.status !== '草稿') throw Error('请先生成尚未发送的招呼草稿');
    if (job.greeting.fingerprint !== fingerprint(job, store.settings(true))) throw Error('简历或岗位已修改，请重新生成招呼');
    if(job.greeting.generatorVersion!==GREETING_GENERATOR_VERSION||!isTrusted(job,job.greeting))throw Error('此草稿缺少本机审查记录，请重新生成后再编辑');
    if (typeof text !== 'string' || !text.trim() || [...text.trim()].length > 200) throw Error('招呼正文需为 1–200 个字符');
    if (text.trim() === job.greeting.text) return job.greeting;
    return rememberReview(id,update(id, {text: text.trim(), edited: true, audit:null, reviewRequired: true,
      reviewReason: job.greeting.matches?.length ? 'edited' : 'no_match', updatedAt: now()}));
  }
  function markManuallySent(id, {expectedRevision} = {}) {
    const job = get(id);
    ensureUnsent(job);
    if (job.status !== '已沟通') throw Error('只能确认已经发起沟通的岗位招呼');
    if (job.demo || job.source === '示例' || (job.simulation && !simulation)) throw Error('体验岗位不能标记为真实 HR 已发送招呼');
    if (typeof expectedRevision !== 'string' || !expectedRevision) throw Error('请先核对当前招呼内容，再确认已手动发送');
    const greeting = verify(id, expectedRevision), confirmedAt = now();
    // This is the user's confirmation, not a browser receipt. Keep it in the
    // independent delivery ledger so restoring an old draft cannot resend it.
    store.meta(deliveryKey(job), {status: '已发送', manualConfirmed: true, time: confirmedAt, revision: greeting.revision});
    const saved = update(id, {status: '已发送', manualConfirmed: true, manualConfirmedAt: confirmedAt,
      deferred: false, deferredAt: null, code: null, error: null});
    store.log(job.title + ' · 用户确认已在 BOSS 手动发送此条招呼，已阻止重复发送', 'success');
    return {ok: true, greeting: saved};
  }
  async function send(id, {active = () => true, expectedRevision} = {}) {
    const guard = () => assertActive(active);
    guard();
    if (expectedRevision !== undefined) verify(id, expectedRevision);
    const job = get(id), greeting = job.greeting;
    ensureUnsent(job);
    if (job.status !== '已沟通') throw Error('请先确认此岗位已成功发起沟通');
    if (job.demo || job.source === '示例' || (job.simulation && !simulation)) throw Error('体验岗位不能向真实 HR 发送招呼');
    if (!greeting || greeting.status !== '草稿') throw Error('请先生成未发送的招呼；已发送或待核实的招呼不会重复发送');
    if (greeting.fingerprint !== fingerprint(job, store.settings(true))) throw Error('简历或岗位已修改，请重新生成招呼');
    assertPersonalized(id, expectedRevision);
    let attempted = false;
    const defer = (reason, refusal) => {
      // This branch requires an explicit browser guarantee that no message was
      // sent. Unknown transport failures and account restrictions never enter it.
      try { guard(); } catch (error) { error.notSent = true; throw error; }
      // Only the explicit foreground refusal before onAttempt can authorize a
      // later readiness probe. Similar wording and post-attempt refusals cannot.
      const deferReason = !attempted && canDefer(refusal) && refusal.reason === 'CHAT_NOT_FOREGROUND'
        ? 'CHAT_NOT_FOREGROUND' : null;
      update(id, {status: '草稿', deferred: true, deferredAt: now(), deferReason, code: 'GREETING_DEFERRED', error: reason});
      const result = {verified: false, notSent: true, deferred: true, code: 'GREETING_DEFERRED',
        deferReason,
        reason: '招呼暂未发送，已保留草稿待补发：' + reason};
      store.log(job.title + ' · ' + result.reason, 'warn');
      return result;
    };
    try {
      const result = await browser.sendJobGreeting(job, greeting.text, {guard, onAttempt: () => {
        guard(); attempted = true;
        store.meta(deliveryKey(job), {status: '待核实', time: now(), revision: greeting.revision});
        update(id, {status: '待核实', attemptedAt: now(), deferred: false, code: null, error: null});
      }});
      if (result.code === 'GREETING_ALREADY_PRESENT' && result.alreadyGreeted === true && result.notSent === true && result.verified === false) {
        const conversation=result.conversation;
        const verifiedIdentity=conversation?.modernProofVerified===true || conversation?.legacyProofVerified===true&&typeof conversation.remoteId==='string'&&conversation.remoteId.trim();
        if (typeof result.receiptId!=='string' || !result.receiptId.trim() || !verifiedIdentity || jobUrlKey(conversation.jobUrl)!==jobUrlKey(job.url) ||
            [['hrName','contact'],['company','company'],['title','jobTitle']].some(([jobKey,contextKey])=>String(job[jobKey]||'').trim()!==String(conversation[contextKey]||'').trim()))
          throw Object.assign(Error('已有开场消息缺少可靠的岗位与会话凭据，未追加招呼'),{code:'GREETING_PRESENCE_UNCERTAIN',notSent:true});
        const reason=result.reason||'已检测到本人开场消息，已跳过追加招呼';
        // This records a pre-existing message, never a receipt for this draft.
        store.meta(deliveryKey(job),{status:'已有开场',time:now(),revision:greeting.revision,existingReceiptId:result.receiptId});
        update(id,{status:'已有开场',existingReceiptId:result.receiptId,skippedAt:now(),deferred:false,deferredAt:null,
          code:'GREETING_ALREADY_PRESENT',error:null,skipReason:reason});
        store.log(job.title+' · '+reason,'info');
        return {...result,deferred:false,reason};
      }
      if (result.verified) {
        const receipt = result.receiptId ? {receiptId: result.receiptId} : {};
        const verifiedRecipient = result.conversation?.modernProofVerified === true && jobUrlKey(result.conversation.jobUrl) === jobUrlKey(job.url)
          ? {verifiedRecipient: {jobUrl: result.conversation.jobUrl, contact: result.conversation.contact,
            company: result.conversation.company, jobTitle: result.conversation.jobTitle}} : {};
        store.meta(deliveryKey(job), {status: '已发送', time: now(), revision: greeting.revision, ...receipt});
        update(id, {status: '已发送', sentAt: now(), deferred: false, deferredAt: null, code: null, error: null, ...receipt, ...verifiedRecipient});
        const conversation = result.conversation;
        if (conversation?.id || conversation?.remoteId) {
          const {messages, ...info} = conversation;
          const c = store.upsertConversation({...info, id: info.remoteId || info.id, jobId: id});
          store.addMessage({contact: c.contact, conversationId: c.id, role: 'assistant', text: greeting.text,
            status: '已发送', kind: 'greeting', autoGenerated: !greeting.edited,
            ...(result.receiptId ? {remoteId: result.receiptId} : {}), sentAt: now()});
        }
      } else {
        if (canDefer(result)) {
          if (attempted) store.meta(deliveryKey(job), null);
          return defer(result.reason || '未确认岗位对应的唯一会话', result);
        }
        update(id, {status: attempted ? '待核实' : '草稿', deferred: false,
          code: result.code || (attempted ? 'GREETING_UNCERTAIN' : 'GREETING_NOT_SENT'),
          error: result.reason || '未确认招呼发送成功'});
      }
      store.log(job.title + ' · ' + (result.verified ? '岗位专属招呼已发送' : '招呼未确认发送，请核对'), result.verified ? 'success' : 'warn');
      return {...result, deferred: false,
        ...!result.verified ? {code: result.code || (attempted ? 'GREETING_UNCERTAIN' : 'GREETING_NOT_SENT')} : {}};
    } catch (error) {
      if (attempted && error.notSent) store.meta(deliveryKey(job), null);
      update(id, {status: !attempted || error.notSent ? '草稿' : '待核实', deferred: false,
        code: error.code || (attempted && !error.notSent ? 'GREETING_UNCERTAIN' : 'GREETING_NOT_SENT'), error: error.message});
      if (canDefer(error)) return defer(error.message, error);
      throw error;
    }
  }
  return {prepare, save, send, verify, markManuallySent, assertPersonalized};
}
