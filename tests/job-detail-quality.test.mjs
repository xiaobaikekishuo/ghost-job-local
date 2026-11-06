import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JOB_DETAIL_VERSION, normalizeJobTitle, normalizeHRName, isUsableCompanyName, trustedListCompany, isJobDescription, hasUsableJobDetail, mergeJobListItem} from '../lib/job-detail-quality.mjs';

const card = '材料采购员\nPUA薪资\n1-3年\n本科\n胜美达\n广州·番禺区·番禺广场';
const job = {title: '材料采购员', company: '胜美达', salary: 'PUA薪资', city: '广州·番禺区·番禺广场'};

test('card summaries do not count as job descriptions regardless of length or a detail timestamp', () => {
  assert.equal(isJobDescription(card), false);
  assert.equal(isJobDescription(card.repeat(40), job), false);
  assert.equal(isJobDescription('岗位职责\n' + card, job), false);
  assert.equal(isJobDescription('薪资：10-15K\n学历：本科\n经验：3年以上经验\n五险一金'), false);
  assert.equal(hasUsableJobDetail({...job, description: card, detailsAt: '2026-11-04', detailVersion: 2}), false);
});

test('short clear tasks, skills, and relevant experience are sufficient', () => {
  for (const description of ['负责采购。', '负责采购订单跟进。', '熟悉 ERP 系统。', '熟悉供应商管理，能独立完成询价。',
    '要求：有三年以上采购经验。', '本科及以上学历，熟悉 ERP 系统。', '岗位职责：供应商开发',
    '工作内容\n采购合同审核', '1、负责需求整理和供应商对接。', 'Responsible for purchase orders.',
    'Manage purchase orders and coordinate suppliers.']) {
    assert.equal(isJobDescription(description, job), true, description);
  }
  for (const description of ['', '岗位职责', '负责', '熟悉', '本科', '要求：本科', '3年以上经验', '有三年以上相关工作经验。']) {
    assert.equal(isJobDescription(description, job), false, description);
  }
});

test('detail certification requires the current version, timestamp, and substantive text', () => {
  const valid = {...job, description: '负责采购订单跟进。', detailsAt: '2026-11-04T12:00:00Z', detailVersion: JOB_DETAIL_VERSION};
  assert.equal(hasUsableJobDetail(valid), true);
  assert.equal(hasUsableJobDetail({...valid, detailVersion: undefined}), false);
  assert.equal(hasUsableJobDetail({...valid, detailVersion: 1}), false);
  assert.equal(hasUsableJobDetail({...valid, detailVersion: '2'}), false);
  assert.equal(hasUsableJobDetail({...valid, detailsAt: ''}), false);
  assert.equal(hasUsableJobDetail({...valid, company: '公司名称'}), false);
  assert.equal(hasUsableJobDetail(null), false);
});

test('title normalization drops standalone metadata and salary tails without changing real role names', () => {
  assert.equal(normalizeJobTitle('当前在线\n材料采购员 7-10K·13薪\n本科'), '材料采购员');
  assert.equal(normalizeJobTitle('10-15K\n采购经理（10-15K）'), '采购经理');
  assert.equal(normalizeJobTitle('岗位名称：采购主管5千-8千\n经验不限'), '采购主管');
  assert.equal(normalizeJobTitle('采购专员 PUA薪资'), '采购专员');
  assert.equal(normalizeJobTitle('采购主管 20-30万/年'), '采购主管');
  assert.equal(normalizeJobTitle('在线教育采购经理'), '在线教育采购经理');
  assert.equal(normalizeJobTitle('数字化采购经理'), '数字化采购经理');
  assert.equal(normalizeJobTitle('HRBP'), 'HRBP');
  assert.equal(normalizeJobTitle(null), '');
});

test('HR normalization keeps contact identity while removing standalone metadata and activity indicators', () => {
  assert.equal(normalizeHRName('当前在线\n王女士\nHR'), '王女士');
  assert.equal(normalizeHRName('招聘人：陈女士 · HR'), '陈女士 · HR');
  assert.equal(normalizeHRName('陈女士刚刚活跃'), '陈女士');
  assert.equal(normalizeHRName('李先生在线'), '李先生');
  assert.equal(normalizeHRName('赵女士（招聘经理）'), '赵女士（招聘经理）');
  assert.equal(normalizeHRName('HR\n孙先生\n本周活跃'), '孙先生');
  assert.equal(normalizeHRName('李在线'), '李在线');
  assert.equal(normalizeHRName('林 HR'), '林 HR');
  assert.equal(normalizeHRName('陈 HR\n当前在线'), '陈 HR');
});

test('list refresh preserves detail identity, company information, proof, and all workflow state', () => {
  const existing = {...job, id: 'existing', url: 'https://example.test/one', hrName: '陈女士', companyUrl: 'https://example.test/company',
    description: '负责采购合同审核及供应商维护。', detailsAt: '2026-11-04', detailVersion: 2, detailSource: 'detail', detailUrl: 'detail-url',
    companySize: '1000-9999人', industry: '电子制造', financing: '已上市', companyDescription: '工商信息',
    status: '已沟通', reason: '已确认', score: 90, sentAt: 'sent', attemptedAt: 'attempt', historicalDelivery: true,
    greeting: {status: '已发送'}, delivery: {status: 'sent'}, deliveryStatus: 'sent', createdAt: 'created', stage: '有面试'};
  const snapshot = structuredClone(existing);
  const item = {...job, id: 'incoming', url: 'https://example.test/wrong', title: '错误标题', hrName: '错误联系人', company: '其他公司', companyUrl: 'wrong',
    description: card, detailsAt: 'forged', detailVersion: 99, detailSource: 'list', detailUrl: 'list-url',
    companySize: '20-99人', industry: '其他行业', financing: '未融资', companyDescription: '错误公司信息',
    salary: '8-12K', city: '深圳', hrActivity: '刚刚活跃', status: '待分析', reason: '', score: 0, sentAt: null,
    attemptedAt: null, historicalDelivery: false, greeting: null, delivery: null, deliveryStatus: 'none', stage: '未标记'};
  const merged = mergeJobListItem(existing, item);
  for (const key of ['id', 'url', 'title', 'hrName', 'company', 'companyUrl', 'description', 'detailsAt', 'detailVersion', 'detailSource', 'detailUrl',
    'companySize', 'industry', 'financing', 'companyDescription', 'status', 'reason', 'score', 'sentAt', 'attemptedAt', 'historicalDelivery',
    'greeting', 'delivery', 'deliveryStatus', 'createdAt', 'stage']) assert.deepEqual(merged[key], existing[key], key);
  assert.equal(merged.salary, '8-12K');
  assert.equal(merged.city, '深圳');
  assert.equal(merged.hrActivity, '刚刚活跃');
  assert.deepEqual(existing, snapshot);
});

test('legacy details are retained for rereading and unmarked genuine descriptions survive scans', () => {
  const legacy = mergeJobListItem({...job, description: '旧详情', detailsAt: 'old'}, {...job, description: card});
  assert.equal(legacy.description, '旧详情');
  assert.equal(hasUsableJobDetail(legacy), false);
  const genuine = mergeJobListItem({...job, description: '负责采购。'}, {...job, description: card});
  assert.equal(genuine.description, '负责采购。');
  assert.equal(genuine.detailsAt, undefined);
  assert.equal(hasUsableJobDetail(genuine), false);
  const refreshed = mergeJobListItem({...job, description: '旧卡片'}, {...job, description: card, salary: ''});
  assert.equal(refreshed.description, card);
  assert.equal(refreshed.salary, job.salary);
});

test('new list records cannot introduce detail proof or workflow and delivery state', () => {
  const item = {...job, title: '材料采购员\n10-15K', hrName: '王女士刚刚活跃', description: card,
    detailsAt: 'forged', detailVersion: 2, detailSource: 'list', detailUrl: 'list-url',
    status: '已沟通', reason: 'forged', score: 100, sentAt: 'forged', attemptedAt: 'forged', historicalDelivery: true,
    greeting: {}, delivery: {}, deliveryStatus: 'sent', deliveryAttempt: 1, greetingSentAt: 'forged'};
  const snapshot = structuredClone(item);
  const merged = mergeJobListItem(null, item);
  assert.equal(merged.title, '材料采购员');
  assert.equal(merged.hrName, '王女士');
  assert.equal(merged.description, card);
  for (const key of ['detailsAt', 'detailVersion', 'detailSource', 'detailUrl', 'status', 'reason', 'score', 'sentAt', 'attemptedAt',
    'historicalDelivery', 'greeting', 'delivery', 'deliveryStatus', 'deliveryAttempt', 'greetingSentAt']) assert.equal(key in merged, false, key);
  assert.deepEqual(item, snapshot);
});

test('list identities supplement empty fields and never replace existing identities', () => {
  const url = 'https://www.zhipin.com/job_detail/company-fill.html';
  const merged = mergeJobListItem({id: 'id', url, title: '采购经理\n当前在线', company: '', hrName: ''},
    {url, title: '错误岗位', company: '公司A', hrName: '张女士 本周活跃', salary: '8-12K'});
  assert.equal(merged.title, '采购经理');
  assert.equal(merged.company, '公司A');
  assert.equal(merged.hrName, '张女士');
});

test('simulation source markers and its real duty text remain usable', () => {
  const description = '【虚构演练岗位】负责供应商开发、采购询价、成本分析、订单交付和合同跟踪，熟悉 Excel、ERP 与采购流程。';
  assert.equal(isJobDescription(description), true);
  const merged = mergeJobListItem(null, {title: '采购专员', description, source: '模拟演练', simulation: true, simulationScore: 55, demo: true});
  assert.equal(merged.simulation, true);
  assert.equal(merged.simulationScore, 55);
  assert.equal(merged.demo, true);
});

test('company names reject field labels, placeholders and truncated brands without altering real names', () => {
  for (const value of [undefined, null, 123, '', ' ', '公司名称', '公司名称：', '企业名称', '公司信息', '公司简介', '注册地址',
    '暂无公司信息', '未知', '--', '—', 'N/A', 'null', '加载中...', '\uE600', '公司名称：胜美达', '公司名称\n胜美达',
    '广州制造...', '广州制造…', '广州制造⋯', '广州制造。。']) assert.equal(isUsableCompanyName(value), false, String(value));
  for (const value of ['胜美达', '广州胜美达电机有限公司', 'N/A Studio', '公司名称设计工作室', '在线教育', '模拟·青禾供应链',
    'A. B. Ltd.', '3M', '株式会社ABC', '未知科技有限公司']) assert.equal(isUsableCompanyName(value), true, value);
});

test('fresh same-job list brands repair invalid companies and retain independent provenance and workflow state', () => {
  const url = 'https://www.zhipin.com/job_detail/company-full-stem.html';
  const existing = {...job, id: 'sent-id', url: url + '?old=1', company: '公司名称', detailsAt: 'old', detailVersion: 2,
    description: '负责采购合同审核。', status: '已沟通', sentAt: 'sent', attemptedAt: 'attempt', historicalDelivery: true,
    greeting: {status: '待核实', text: '原稿', fingerprint: 'old'}, delivery: {status: 'sent'}};
  const before = structuredClone(existing);
  const result = mergeJobListItem(existing, {url: url.replace('www.zhipin.com', 'zhipin.com') + '?new=2', company: '胜美达',
    status: '待分析', sentAt: null, greeting: null, delivery: null, listCompany: '伪造品牌', listCompanyJobUrl: 'wrong'});
  assert.equal(result.company, '胜美达');assert.equal(result.listCompany, '胜美达');assert.equal(result.listCompanyJobUrl, url);
  assert.equal(trustedListCompany(result), '胜美达');assert.deepEqual(existing, before);
  for (const key of ['id', 'url', 'description', 'detailsAt', 'detailVersion', 'status', 'sentAt', 'attemptedAt', 'historicalDelivery', 'greeting', 'delivery']) assert.deepEqual(result[key], existing[key], key);
});

test('list evidence never aliases a valid legal name, crosses jobs, or trusts caller-provided provenance', () => {
  const url = 'https://www.zhipin.com/job_detail/company-proof.html';
  const legal = {...job, url, company: '广州胜美达电机有限公司'};
  const branded = mergeJobListItem(legal, {url, company: '胜美达'});
  assert.equal(branded.company, legal.company);assert.equal(branded.listCompany, '胜美达');assert.equal(trustedListCompany(branded), '胜美达');
  for (const different of ['https://www.zhipin.com/job_detail/company-proof-other.html', 'https://www.zhipin.com.evil.test/job_detail/company-proof.html', undefined]) {
    const unchanged = mergeJobListItem({...legal, company: '公司名称'}, {url: different, company: '错误品牌'});
    assert.equal(unchanged.company, '公司名称');assert.equal(unchanged.listCompany, undefined);
  }
  assert.equal(trustedListCompany({...branded, url: 'https://www.zhipin.com/job_detail/other.html'}), '');
  assert.equal(trustedListCompany({...branded, listCompany: '胜美达…'}), '');
  const forged = mergeJobListItem(null, {url, title: '采购员', company: '公司名称', listCompany: '伪造品牌', listCompanyJobUrl: url});
  assert.equal(forged.company, undefined);assert.equal(forged.listCompany, undefined);assert.equal(forged.listCompanyJobUrl, undefined);
  const stale = mergeJobListItem(branded, {url, company: '胜美达...'});
  assert.equal(stale.company, legal.company);assert.equal(stale.listCompany, '胜美达');
});
