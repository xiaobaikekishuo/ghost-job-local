import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sendModernGreeting} from '../lib/modern-greeting-delivery.mjs';

const job = {url: 'https://www.zhipin.com/job_detail/modern-fixture.html', title: '采购经理', company: '虚构采购公司', hrName: '王 HR'};
const text = '您好，我有供应商开发与采购询价经验。';
const clone = value => structuredClone(value);
const message = (remoteId, patch = {}) => ({remoteId, platformMessageId: true, role: 'assistant', text, deliveryStatus: 'confirmed', ...patch});
const beforeMessages = [message('old1', {role: 'user', text: '您好，请介绍一下经验。'}), message('old2', {role:'user',text: '期待您的介绍。'})];

function fixture() {
  const proof = {targetId: 'chat', generation: 1, jobUrl: job.url, createdAt: Date.now(),
    expected: {contact: job.hrName, company: job.company, jobTitle: job.title, anchorIds: ['old1', 'old2']}};
  const state = {
    active: true, proof, proofs: [], actions: [], events: [], attempts: 0,
    fills: 0, sendRequests: 0, clicks: 0, reads: 0, postReads: 0,
    current: {contact: job.hrName, company: job.company, jobTitle: job.title, anchorIds: ['old1', 'old2'], messages: clone(beforeMessages)},
  };
  const adapter = {
    async prove(receivedJob) {
      assert.equal(receivedJob, job);
      state.events.push('prove');
      return proof;
    },
    async read(receivedProof) {
      assert.equal(receivedProof.targetId, 'chat');
      assert.equal(receivedProof.generation, 1);
      state.reads++;
      if (state.clicks) state.postReads++;
      state.events.push('read');
      const value = state.onRead ? await state.onRead(receivedProof) : state.current;
      const snapshot=clone(value);
      if(state.withTail!==false&&!Object.hasOwn(snapshot,'latestTail'))snapshot.latestTail={atBottom:true,loading:false,signature:JSON.stringify(snapshot.anchorIds)};
      return snapshot;
    },
    async action(receivedProof, action, receivedText) {
      assert.equal(receivedText, text);
      assert.ok(['fill', 'send'].includes(action));
      state.events.push(action);
      state.actions.push(action);
      state.proofs.push({action, proof: clone(receivedProof)});
      if (action === 'fill') {
        state.fills++;
        return state.onFill ? state.onFill(receivedProof) : {ok: true};
      }
      state.sendRequests++;
      assert.equal(state.attempts, 1, 'onAttempt must run exactly once before the send action');
      if (state.onSend) return state.onSend(receivedProof);
      state.clicks++;
      state.current.anchorIds.push('receipt-1');
      state.current.messages.push(message('receipt-1'));
      return {ok: true, clicked: true};
    },
  };
  const options = {
    timeoutMs: 30, pollMs: 1, tailTimeoutMs:50,tailPollMs:1,
    guard: () => state.active,
    onAttempt: () => { state.attempts++; state.events.push('attempt'); },
  };
  return {state, adapter, options, run: extra => sendModernGreeting(adapter, job, text, {...options, ...extra})};
}

function assertUncertain(result) {
  assert.equal(result.verified, false);
  assert.equal(result.code, 'GREETING_UNCERTAIN');
  assert.notEqual(result.notSent, true);
  assert.equal(result.receiptId, undefined);
}

test('fresh confirmed real MID verifies delivery, using one strengthened proof without mutating the original', async () => {
  const f = fixture(), originalProof = clone(f.state.proof);
  const result = await f.run();
  assert.equal(result.verified, true);
  assert.equal(result.receiptId, 'receipt-1');
  assert.equal(typeof result.reason, 'string');
  assert.deepEqual(result.conversation, {jobUrl: job.url, contact: job.hrName, company: job.company, jobTitle: job.title, modernProofVerified: true});
  assert.equal(result.conversation.id, undefined);
  assert.equal(result.conversation.remoteId, undefined);
  assert.deepEqual(f.state.proof, originalProof);
  assert.deepEqual(f.state.proofs.find(entry => entry.action === 'send').proof.expected.anchorIds, ['old2']);
  assert.equal(f.state.proofs.find(entry=>entry.action==='send').proof.expected.requireLatestTail,true);
  assert.equal(f.state.proofs.find(entry=>entry.action==='send').proof.expected.tailSignature,JSON.stringify(['old1','old2']));
  assert.equal(f.state.proofs.find(entry=>entry.action==='fill').proof.expected.requireLatestTail,true);
  assert.deepEqual(f.state.actions, ['fill', 'send']);
  assert.equal(f.state.attempts, 1);
  assert.equal(f.state.clicks, 1);
  assert.ok(f.state.events.indexOf('attempt') < f.state.events.indexOf('send'));
});

test('missing, loading or non-bottom tail evidence blocks before filling or attempting a send',async()=>{
  for(const tail of [undefined,{atBottom:false,loading:false,signature:'old'}, {atBottom:true,loading:true,signature:'old'}, {atBottom:true,loading:false,signature:''}]){
    const f=fixture();f.state.withTail=false;if(tail)f.state.current.latestTail=tail;
    await assert.rejects(f.run({tailTimeoutMs:3}),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
    assert.equal(f.state.fills,0);assert.equal(f.state.attempts,0);assert.equal(f.state.sendRequests,0);
  }
});

test('a changing tail must stabilize twice before fill and again after fill',async()=>{
  const f=fixture();let sinceFill=0;
  f.state.onRead=()=>{
    const signature=f.state.fills?(++sinceFill<3?'changing-after-'+sinceFill:'stable-after'):(f.state.reads<3?'changing-before-'+f.state.reads:'stable-before');
    return {...f.state.current,latestTail:{atBottom:true,loading:false,signature}};
  };
  f.state.onFill=()=>{assert.ok(f.state.reads>=4);return {ok:true};};
  const result=await f.run({tailTimeoutMs:100});assert.equal(result.verified,true);
  const proof=f.state.proofs.find(entry=>entry.action==='send').proof;
  assert.equal(proof.expected.tailSignature,'stable-after');assert.ok(sinceFill>=4);
});

test('tail loss after filling blocks the send and the attempt ledger',async()=>{
  const f=fixture();f.state.onFill=()=>{f.state.current.latestTail={atBottom:false,loading:false,signature:'not-latest'};return {ok:true};};
  await assert.rejects(f.run({tailTimeoutMs:100}),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
  assert.equal(f.state.fills,1);assert.equal(f.state.attempts,0);assert.equal(f.state.clicks,0);
});

test('late-loading old identical text after the boundary cannot trigger any send without proven latest tail',async()=>{
  const f=fixture();f.state.withTail=false;
  f.state.onRead=()=>{
    if(f.state.reads>1&&!f.state.current.anchorIds.includes('historical-after')){
      f.state.current.anchorIds.push('historical-after');f.state.current.messages.push(message('historical-after'));
    }
    return f.state.current;
  };
  await assert.rejects(f.run({tailTimeoutMs:5}),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
  assert.equal(f.state.attempts,0);assert.equal(f.state.clicks,0);assert.equal(f.state.fills,0);
});

test('coded proof failures retain their account or transport classification before any action',async()=>{
  for(const code of ['AUTH_REQUIRED','VERIFICATION_REQUIRED','RATE_LIMITED','CDP_ERROR']){
    const f=fixture();f.adapter.prove=async()=>({error:'Explicit proof failure',code});
    await assert.rejects(f.run(),{code,notSent:true});
    assert.equal(f.state.attempts,0);assert.deepEqual(f.state.actions,[]);
  }
});

test('last anchor and old message IDs are refreshed after fill before sending', async () => {
  const f = fixture();
  f.state.onFill = () => {
    f.state.current.anchorIds.push('arrived-before-send');
    f.state.current.messages.push(message('arrived-before-send', {role: 'user', text: '刚收到的提问。'}));
    return {ok: true};
  };
  const result = await f.run();
  assert.equal(result.verified, true);
  assert.deepEqual(f.state.proofs.find(entry => entry.action === 'send').proof.expected.anchorIds, ['arrived-before-send']);
  assert.deepEqual(f.state.proof.expected.anchorIds, ['old1', 'old2']);
  const fillIndex = f.state.events.indexOf('fill'), sendIndex = f.state.events.indexOf('send');
  assert.ok(f.state.events.slice(fillIndex + 1, sendIndex).includes('read'));
});

test('recipient labels changing after fill stop before onAttempt and send', async () => {
  for (const patch of [{contact: '另一 HR'}, {company: '另一家公司'}, {jobTitle: '销售主管'}]) {
    const f = fixture();
    f.state.onFill = () => { Object.assign(f.state.current, patch); return {ok: true}; };
    await assert.rejects(f.run(), {code: 'GREETING_TARGET_UNAVAILABLE', notSent: true});
    assert.equal(f.state.attempts, 0);
    assert.equal(f.state.sendRequests, 0);
    assert.equal(f.state.clicks, 0);
  }
});

test('missing proof anchors before send fail closed', async () => {
  const f = fixture();
  f.state.onFill = () => {
    f.state.current.anchorIds = ['unrelated-anchor'];
    f.state.current.messages = [message('unrelated-anchor', {role: 'user', text: '另一段会话。'})];
    return {ok: true};
  };
  await assert.rejects(f.run(), {code: 'GREETING_TARGET_UNAVAILABLE', notSent: true});
  assert.equal(f.state.attempts, 0);
  assert.equal(f.state.sendRequests, 0);
});

test('a newly loaded historical identical message before the last anchor is not a delivery receipt', async () => {
  const f = fixture();
  f.state.onSend = () => {
    f.state.clicks++;
    f.state.current.anchorIds.unshift('older-loaded-now');
    f.state.current.messages.unshift(message('older-loaded-now'));
    return {ok: true, clicked: true};
  };
  assertUncertain(await f.run());
  assert.equal(f.state.sendRequests, 1);
  assert.equal(f.state.attempts, 1);
});

test('a pending new real MID remains uncertain on timeout and is never resent', async () => {
  const f = fixture();
  f.state.onSend = () => {
    f.state.clicks++;
    f.state.current.anchorIds.push('new-pending');
    f.state.current.messages.push(message('new-pending', {deliveryStatus: 'pending'}));
    return {ok: true, clicked: true};
  };
  assertUncertain(await f.run());
  assert.equal(f.state.sendRequests, 1);
  assert.equal(f.state.attempts, 1);
});

test('a pending receipt is verified only once its real MID becomes confirmed', async () => {
  const f = fixture();
  f.state.onRead = () => {
    if (f.state.clicks) f.state.current.messages.at(-1).deliveryStatus = f.state.postReads < 2 ? 'pending' : 'confirmed';
    return f.state.current;
  };
  const result = await f.run();
  assert.equal(result.verified, true);
  assert.equal(result.receiptId, 'receipt-1');
  assert.ok(f.state.postReads >= 2);
  assert.equal(f.state.sendRequests, 1);
  assert.equal(f.state.attempts, 1);
});

test('guard returning false or throwing CANCELLED before entry blocks all fill and send actions', async () => {
  for (const throws of [false, true]) {
    const f = fixture();
    await assert.rejects(f.run({guard: () => {
      if (throws) throw Object.assign(new Error('停止'), {code: 'CANCELLED'});
      return false;
    }}), {code: 'CANCELLED', notSent: true});
    assert.deepEqual(f.state.actions, []);
    assert.equal(f.state.attempts, 0);
  }
});

test('stop after fill is notSent and prevents the attempt callback', async () => {
  const f = fixture();
  f.state.onFill = () => { f.state.active = false; return {ok: true}; };
  await assert.rejects(f.run(), {code: 'CANCELLED', notSent: true});
  assert.deepEqual(f.state.actions, ['fill']);
  assert.equal(f.state.attempts, 0);
});

test('post-click CDP read failure keeps its error code and never claims notSent', async () => {
  const f = fixture();
  f.state.onRead = () => {
    if (f.state.clicks) throw Object.assign(new Error('调试连接断开'), {code: 'CDP_DISCONNECTED'});
    return f.state.current;
  };
  await assert.rejects(f.run(), error => error.code === 'CDP_DISCONNECTED' && error.notSent !== true);
  assert.equal(f.state.attempts, 1);
  assert.equal(f.state.sendRequests, 1);
  assert.equal(f.state.clicks, 1);
});

test('proof for a different job URL is refused before filling', async () => {
  const f = fixture();
  f.state.proof.jobUrl = 'https://www.zhipin.com/job_detail/different.html';
  await assert.rejects(f.run(), {code: 'GREETING_TARGET_UNAVAILABLE', notSent: true});
  assert.deepEqual(f.state.actions, []);
  assert.equal(f.state.attempts, 0);
});

test('explicit DOM refusal remains notSent, including refusal inside the final send action', async () => {
  for (const action of ['fill', 'send']) {
    const f = fixture();
    f.state[action === 'fill' ? 'onFill' : 'onSend'] = () => ({error: '收件人已变化，未执行点击', code: 'GREETING_TARGET_UNAVAILABLE', notSent: true});
    await assert.rejects(f.run(), {code: 'GREETING_TARGET_UNAVAILABLE', notSent: true});
    assert.equal(f.state.attempts, action === 'send' ? 1 : 0);
    assert.equal(f.state.sendRequests, action === 'send' ? 1 : 0);
    assert.equal(f.state.clicks, 0);
  }
});

test('an absent send result or unknown send exception stays uncertain and never triggers a retry', async () => {
  for (const throws of [false, true]) {
    const f = fixture();
    f.state.onSend = () => {
      if (throws) throw Object.assign(new Error('发送结果未知'), {code: 'CDP_CONNECTION_FAILED'});
      return undefined;
    };
    const outcome = await f.run().then(result => ({result}), error => ({error}));
    if (outcome.error) assert.notEqual(outcome.error.notSent, true);
    else { assert.equal(outcome.result.verified, false); assert.notEqual(outcome.result.notSent, true); }
    assert.equal(f.state.attempts, 1);
    assert.equal(f.state.sendRequests, 1);
  }
});

test('only a new confirmed assistant message with a genuine platform MID can verify', async () => {
  for (const patch of [{platformMessageId: undefined}, {platformMessageId: false}, {platformMessageId: 'true'},
    {remoteId: ''}, {role: 'user'}, {deliveryStatus: 'unknown'}, {deliveryStatus: 'failed'}, {text: '不同的文本。'}]) {
    const f = fixture();
    f.state.onSend = () => {
      f.state.clicks++;
      const candidate = message('candidate', patch);
      f.state.current.anchorIds.push(candidate.remoteId || 'unproven-node');
      f.state.current.messages.push(candidate);
      return {ok: true, clicked: true};
    };
    if (patch.platformMessageId === 'true' || patch.remoteId === '') {
      await assert.rejects(f.run(), error => error.code === 'GREETING_TARGET_UNAVAILABLE' && error.notSent !== true);
    } else assertUncertain(await f.run());
    assert.equal(f.state.sendRequests, 1);
  }
});

test('reusing an old MID for identical text does not manufacture a fresh receipt', async () => {
  const f = fixture();
  f.state.onSend = () => {
    f.state.clicks++;
    f.state.current.messages[1] = message('old2');
    return {ok: true, clicked: true};
  };
  assertUncertain(await f.run());
  assert.equal(f.state.sendRequests, 1);
});

test('confirmed platform or custom opening prevents fill and never claims this software sent it',async()=>{
  for(const existingText of ['您好，我对这个职位很感兴趣，想和您进一步沟通。',text,'之前已经介绍过工作经历。']){
    const f=fixture();f.state.current.messages[1]=message('old2',{text:existingText});
    const result=await f.run();
    assert.equal(result.verified,false);assert.equal(result.notSent,true);assert.equal(result.alreadyGreeted,true);
    assert.equal(result.code,'GREETING_ALREADY_PRESENT');assert.equal(result.receiptId,'old2');
    assert.equal(result.conversation.modernProofVerified,true);assert.equal(result.conversation.jobUrl,job.url);
    assert.equal(result.conversation.id,undefined);assert.equal(result.conversation.remoteId,undefined);
    assert.deepEqual(f.state.actions,[]);assert.equal(f.state.attempts,0);assert.equal(f.state.clicks,0);
  }
});

test('unconfirmed or unnumbered own text blocks opening with an explicitly unknown result',async()=>{
  for(const patch of [{deliveryStatus:'unknown'},{deliveryStatus:'pending'},{deliveryStatus:'failed'},
    {deliveryStatus:undefined},{platformMessageId:false},{platformMessageId:undefined,remoteId:''}]){
    const f=fixture();f.state.current.messages[1]=message('old2',patch);
    const result=await f.run();
    assert.equal(result.verified,false);assert.equal(result.notSent,true);assert.equal(result.presenceUnknown,true);
    assert.equal(result.code,'GREETING_PRESENCE_UNCERTAIN');assert.equal(result.receiptId,undefined);
    assert.notEqual(result.alreadyGreeted,true);assert.deepEqual(f.state.actions,[]);assert.equal(f.state.attempts,0);
  }
  const f=fixture();f.state.current.ownTextUnknownCount=1;
  assert.equal((await f.run()).code,'GREETING_PRESENCE_UNCERTAIN');assert.deepEqual(f.state.actions,[]);assert.equal(f.state.attempts,0);
});

test('HR text and empty own nodes do not impersonate an existing opening',async()=>{
  const f=fixture();f.state.current.messages.push(message('old2',{text:' \n '}));
  // A distinct anchored empty own node is allowed; duplicate conflicting MID is not.
  f.state.current.messages.at(-1).remoteId='empty';f.state.current.anchorIds.push('empty');
  const result=await f.run();assert.equal(result.verified,true);assert.equal(f.state.clicks,1);
  assert.equal(f.state.proofs[0].proof.expected.noExistingOpening,true);
  assert.equal(f.state.proofs.at(-1).proof.expected.noExistingOpening,true);
});

test('an opening arriving after fill keeps the new draft and prevents onAttempt and send',async()=>{
  for(const status of ['confirmed','pending']){
    const f=fixture();
    f.state.onFill=()=>{f.state.current.anchorIds.push('platform-opening');f.state.current.messages.push(message('platform-opening',{text:'平台固定开场',deliveryStatus:status}));return {ok:true};};
    const result=await f.run();
    assert.equal(result.code,status==='confirmed'?'GREETING_ALREADY_PRESENT':'GREETING_PRESENCE_UNCERTAIN');
    assert.equal(result.notSent,true);assert.equal(result.verified,false);assert.equal(result.draftRetained,true);assert.match(result.reason,/草稿已保留/);
    assert.deepEqual(f.state.actions,['fill']);assert.equal(f.state.attempts,0);assert.equal(f.state.sendRequests,0);
  }
});

test('same-name different company, wrong job proof or missing anchors cannot claim another conversation was greeted',async()=>{
  for(const mutate of [f=>{f.state.current.company='另一家公司';},f=>{f.state.proof.jobUrl='https://www.zhipin.com/job_detail/other.html';},
    f=>{f.state.current.anchorIds=['other'];f.state.current.messages=[message('other')];}]){
    const f=fixture();f.state.current.messages[1]=message('old2');mutate(f);
    await assert.rejects(f.run(),{code:'GREETING_TARGET_UNAVAILABLE',notSent:true});
    assert.deepEqual(f.state.actions,[]);assert.equal(f.state.attempts,0);
  }
});

test('atomic fill and send refusals become no-send dedup results even when the adapter throws them',async()=>{
  for(const action of ['fill','send'])for(const throws of [false,true])for(const unknown of [false,true]){
    const f=fixture();
    const refusal={error:'已检测到本人文本',notSent:true,...(unknown?{code:'GREETING_PRESENCE_UNCERTAIN',presenceUnknown:true}:
      {code:'GREETING_ALREADY_PRESENT',alreadyGreeted:true,receiptId:'late-platform-mid'})};
    f.state[action==='fill'?'onFill':'onSend']=()=>{if(throws)throw Object.assign(Error(refusal.error),refusal);return refusal;};
    const result=await f.run();
    assert.equal(result.verified,false);assert.equal(result.notSent,true);assert.equal(result.code,refusal.code);
    assert.equal(result.receiptId,unknown?undefined:'late-platform-mid');assert.equal(result.conversation.modernProofVerified,true);
    assert.equal(f.state.clicks,0);assert.equal(f.state.attempts,action==='send'?1:0);
    assert.equal(result.draftRetained,action==='send'?true:undefined);
  }
});

test('an incomplete already-present receipt remains unknown and is not fabricated',async()=>{
  const f=fixture();f.state.onFill=()=>({error:'缺少编号',code:'GREETING_ALREADY_PRESENT',alreadyGreeted:true,notSent:true});
  const result=await f.run();assert.equal(result.code,'GREETING_PRESENCE_UNCERTAIN');assert.equal(result.receiptId,undefined);
  assert.equal(result.verified,false);assert.equal(f.state.attempts,0);assert.equal(f.state.clicks,0);
});
