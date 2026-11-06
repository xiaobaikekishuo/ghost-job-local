import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Browser, conversationListDOM} from '../lib/browser.mjs';
import {chatDOM} from '../lib/chat-dom.mjs';
import {createStore} from '../lib/store.mjs';
import {createWorkflows} from '../lib/workflows.mjs';
import {SimulationBrowser, simulationSettings} from '../lib/simulation.mjs';

const clone = value => structuredClone(value);

// Exercise the real workflows -> greeting manager -> Browser.sendJobGreeting ->
// reset/list/read/send pipeline. All page transport is local fixture data, and
// the search/contact prerequisites are already-verified simulation operations.
function fixture({stage = 'reset', code = 'CHAT_LIST_UNAVAILABLE'} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'greeting-loading-test-'));
  const store = createStore(dir);
  store.saveSettings({...simulationSettings(), personalizedGreeting: true, greetingFallback: false});
  const source = new SimulationBrowser(dir).world().jobs;
  const jobs = [source[0], source[4]].map(job => ({...job, detailsAt: new Date().toISOString()}));
  const browser = new Browser(dir), contacts = [], clicks = [], listOperations = [];
  const conversations = new Map(jobs.map((job, index) => [job.url, {
    id: 'loading-fixture-' + index, remoteId: 'loading-fixture-' + index,
    contact: job.hrName || '虚构 HR ' + index, company: job.company,
    jobTitle: job.title, jobUrl: job.url, messages: []
  }]));
  // Without an exact URL the real adapter must finish the list before it can
  // trust display-name matching, which drives both real scroll error exits.
  if (stage.startsWith('scroll-')) conversations.get(jobs[0].url).jobUrl = '';
  let currentJob = jobs[0], selected;
  const current = () => conversations.get(currentJob.url);
  const firstJob = () => currentJob.url === jobs[0].url;
  const unavailable = () => ({error: '会话列表尚未加载：' + code, code});
  const snapshot = () => ({top: 0, height: 100, viewport: 100, atBottom: true,
    loading: false, signature: JSON.stringify([current().remoteId])});

  // No real Chrome, network connection, filesystem profile or external model.
  browser.launch = async () => {};
  browser.search = async (keyword, city, options) => { assert.equal(options.active(), true); };
  browser.navigate = async url => {currentJob=jobs.find(job=>job.url===url)||currentJob;};
  browser.readJobs = async () => ({jobs: clone(jobs)});
  browser.target = async () => ({id: 'jobs-fixture', url: 'https://www.zhipin.com/web/geek/jobs?query=采购&city=101280100'});
  browser.nextPage = async () => false;
  browser.detail = async () => clone(currentJob);
  browser.assertGreetingAvailable = async ({active}) => { assert.equal(active(), true); };
  browser.communicate = async (job, {guard}) => {
    guard(); contacts.push(job.url); currentJob = job; selected = undefined;
    return {verified: true, reason: '模拟确认已发起沟通'};
  };
  browser.openChat = async () => { browser.chatTargetId = 'chat-fixture'; browser.activeTargetId = 'chat-fixture'; };
  browser.targets = async () => [{id: 'chat-fixture', type: 'page', url: 'https://www.zhipin.com/web/geek/chat'}];

  // Keep the real readiness/reset implementation while bounding a deliberately
  // permanent missing-list fixture to zero milliseconds. The first DOM probe
  // still runs; waiting behavior itself has separate Browser unit coverage.
  if (typeof browser.waitForConversationList === 'function') {
    const wait = browser.waitForConversationList.bind(browser);
    browser.waitForConversationList = options => wait({...options, timeoutMs: 0, pollMs: 1});
  }
  const transport = async (fn, args) => {
    if (fn === conversationListDOM) {
      const mode = args?.mode || 'read';
      listOperations.push({jobUrl: currentJob.url, mode});
      if (firstJob() && (stage === 'reset' && mode !== 'read' || stage === 'list' && mode === 'read' ||
          stage === 'scroll-initial' && mode === 'scroll' || stage === 'scroll-settled' && mode === 'snapshot')) return unavailable();
      if (mode === 'read') return {conversations: [clone(current())], modernWithoutIds: false};
      if (mode === 'snapshot') return snapshot();
      if (mode === 'reset' || mode === 'scroll') return {before: snapshot(), after: snapshot()};
      assert.fail('Unexpected conversation list mode: ' + mode);
    }
    if (fn === chatDOM) {
      assert.equal(selected, current().remoteId, 'Chat must be explicitly selected before reading or sending');
      if (!args?.action) {
        if (stage === 'after-click' && firstJob() && clicks.includes(currentJob.url)) return unavailable();
        return clone(current());
      }
      assert.equal(args.expected.remoteId, current().remoteId);
      if (args.action === 'fill') return {ok: true};
      if (args.action === 'send') {
        clicks.push(currentJob.url);
        current().messages.push({remoteId: 'fixture-receipt-' + clicks.length, role: 'assistant', text: args.text, deliveryStatus: 'confirmed'});
        return {ok: true};
      }
      assert.fail('Unexpected chat action: ' + args.action);
    }
    // Browser.selectConversation's page function receives the verified row.
    assert.equal(args?.remoteId, current().remoteId);
    selected = args.remoteId;
    return true;
  };
  browser.evaluate = transport;
  browser.evaluateOn = async (target, fn, args) => {
    assert.equal(target.id, 'chat-fixture');
    return transport(fn, args);
  };
  const flow = createWorkflows(store, browser, browser, browser, true);
  return {browser, store, flow, jobs, contacts, clicks, listOperations,
    getJob: index => store.jobs().find(job => job.url === jobs[index].url),
    close() {
      store.close();
      assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'greeting-loading-test-'));
      fs.rmSync(dir, {recursive: true, force: true});
    }
  };
}

for (const stage of ['reset', 'list', 'scroll-initial', 'scroll-settled']) test('A post-contact ' + stage + ' CHAT_LIST_UNAVAILABLE preserves the draft and continues screening without another contact', async () => {
  const f = fixture({stage});
  try {
    const result = await f.flow.scan();
    assert.equal(result.phase, '筛选完成，沟通待核对'); assert.equal(result.error, null);
    assert.equal(result.communicationDeferred, true); assert.match(result.message, /BOSS 可能已发送固定开场.*专属稿已保留/);
    assert.equal(result.sent, 1); assert.equal(result.greetingDeferred, 1);
    assert.deepEqual(f.contacts, [f.jobs[0].url]);
    assert.deepEqual(f.clicks, []);
    assert.equal(f.getJob(0).status, '已沟通'); assert.equal(f.getJob(0).greeting.status, '草稿');
    assert.equal(f.getJob(0).greeting.code, 'GREETING_DEFERRED');
    assert.equal(f.getJob(1).status, '合适'); assert.equal(f.getJob(1).greeting.status, '草稿');
    assert.equal(f.flow.stats().greetingPending, 1);
    const failureMode = {reset: 'reset', list: 'read', 'scroll-initial': 'scroll', 'scroll-settled': 'snapshot'}[stage];
    assert.ok(f.listOperations.some(operation => operation.jobUrl === f.jobs[0].url && operation.mode === failureMode));
    assert.equal(f.store.messages().filter(message => message.kind === 'greeting').length, 0);
    assert.equal(f.store.deliveryCount(), 1);

    await assert.rejects(f.flow.sendJob(f.getJob(0).id), /岗位已经处理/);
    assert.equal(f.store.deliveryCount(), 1); assert.equal(f.contacts.length, 1); assert.equal(f.clicks.length, 0);
  } finally { f.close(); }
});

for (const code of ['VERIFICATION_REQUIRED', 'AUTH_REQUIRED', 'RATE_LIMITED', 'CANCELLED', 'UNRECOGNIZED_ADAPTER_FAILURE']) {
  test('A pre-send list failure with ' + code + ' is never downgraded to a deferred greeting', async () => {
    const f = fixture({code});
    try {
      const result = await f.flow.scan();
      assert.equal(result.phase, code === 'CANCELLED' ? '已停止' : '已暂停');
      assert.equal(result.greetingDeferred, 0); assert.equal(result.sent, 1);
      if (code === 'CANCELLED') assert.equal(result.error, null);
      else assert.match(result.error, new RegExp(code));
      assert.deepEqual(f.contacts, [f.jobs[0].url]); assert.equal(f.clicks.length, 0);
      assert.equal(f.getJob(0).status, '已沟通'); assert.equal(f.getJob(0).greeting.status, '草稿');
      assert.equal(f.getJob(0).greeting.deferred, false);
      assert.equal(f.store.messages().length, 0);
    } finally { f.close(); }
  });
}

test('CHAT_LIST_UNAVAILABLE after the real send attempt remains uncertain and cannot defer or retry', async () => {
  const f = fixture({stage: 'after-click'});
  try {
    const result = await f.flow.scan();
    assert.equal(result.phase, '已暂停'); assert.match(result.error, /CHAT_LIST_UNAVAILABLE/);
    assert.equal(result.sent, 1); assert.equal(result.greetingDeferred, 0);
    assert.deepEqual(f.contacts, [f.jobs[0].url]); assert.deepEqual(f.clicks, [f.jobs[0].url]);
    assert.equal(f.getJob(0).status, '已沟通'); assert.equal(f.getJob(0).greeting.status, '待核实');
    assert.equal(f.flow.stats().greetingPending, 0); assert.equal(f.store.messages().length, 0);
    await assert.rejects(f.flow.greetings.send(f.getJob(0).id), /不会重复发送/);
    await assert.rejects(f.flow.sendJob(f.getJob(0).id), /岗位已经处理/);
    assert.equal(f.contacts.length, 1); assert.equal(f.clicks.length, 1);
  } finally { f.close(); }
});
