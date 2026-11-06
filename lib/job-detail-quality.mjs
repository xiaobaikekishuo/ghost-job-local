import {jobUrlKey} from './job-greeting-browser.mjs';

export const JOB_DETAIL_VERSION = 2;

const salaryAmount = String.raw`(?:[¥￥]?\d+(?:\.\d+)?\s*(?:[kKwW]|千|万|元)?\s*[-~～至]\s*[¥￥]?\d+(?:\.\d+)?\s*(?:[kKwW]|千|万|元)|[¥￥]?\d+(?:\.\d+)?\s*(?:[kKwW]|千|万|元))(?:\s*[/／]\s*(?:月|年|天|日|小时|时))?(?:\s*[·•]\s*\d+\s*薪)?`;
const salary = `(?:${salaryAmount}|薪资面议|面议|PUA薪资)`;
const salaryOnly = new RegExp(`^(?:薪资|薪酬|工资|待遇)?[：:\\s]*${salary}$`, 'i');
const salaryTail = new RegExp(`\\s*(?:[（(]\\s*)?${salary}\\s*[）)]?\\s*$`, 'i');
const activity = String.raw`(?:当前在线|正在活跃|刚刚活跃|(?:今日|今天|昨日|昨天|本周|本月|近期|很久未|\d+天内|\d+日内|三日内|\d+周内)活跃)`;
const activityOnly = new RegExp(`^(?:${activity}|在线|活跃|离线|未活跃)$`);
const activityTail = new RegExp(`\\s*(?:[·•|｜,，·]\\s*)?${activity}\\s*$`);
const recruiterRole = /^(?:HR|HRBP|BOSS|招聘者|招聘官|招聘经理|招聘主管|招聘专员|人事|人事经理|人事主管|人事专员|人力资源|老板)$/i;
const heading = /^(?:(?:岗位|职位|工作|任职|招聘|技能|资格)(?:职责|要求|内容|资格|描述|任务)|职责|要求|工作任务|任职资格|任职条件)[：:]?$/;
const headingPrefix = /^(?:(?:岗位|职位|工作|任职|招聘|技能|资格)(?:职责|要求|内容|资格|描述|任务)|职责|要求|工作任务|任职资格|任职条件)[：:]\s*/;

function cleanText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u00a0\u200b\ufeff]/g, ' ').trim();
}

function metadataLine(value) {
  const line = value.trim().replace(/[。.!！；;]$/, '').trim();
  return !line || salaryOnly.test(line) || activityOnly.test(line) || heading.test(line) ||
    /^(?:经验|工作经验|学历|教育背景|薪资|工作地点|城市)?[：:\s]*(?:(?:经验|学历)?不限|无经验|应届(?:生|毕业生)?|在校(?:生)?|实习生|初中|高中|中专|中技|大专|本科|硕士|博士|研究生|MBA)(?:及以上|以上|学历|毕业)?$/.test(line) ||
    /^(?:(?:经验|工作经验)[：:\s]*)?\d+\s*(?:[-~～至]\s*\d+)?\s*年(?:以上|以下|以内|及以上)?(?:工作)?经验?$/.test(line) ||
    /^\d+\s*(?:[-~～至]\s*\d+)?\s*年$/.test(line) ||
    /^(?:全职|兼职|实习|五险一金|周末双休|双休|带薪年假|包吃|包住|年终奖|立即沟通|继续沟通|投递简历|收藏|举报|职位详情)$/.test(line) ||
    /^[^\n。；;，,:：]{1,20}[·•][^\n。；;，,:：]{1,24}(?:[·•][^\n。；;，,:：]{1,24})+$/.test(line) ||
    /^(?:未融资|不需要融资|已上市|[A-F]轮|天使轮|\d+[-~～]\d+人|\d+人以上|少于\d+人)$/i.test(line);
}

function normalizeName(value, kind) {
  for (let line of cleanText(value).split('\n')) {
    line = line.trim();
    if (metadataLine(line) || kind === 'hr' && recruiterRole.test(line)) continue;
    line = line.replace(kind === 'hr' ? /^(?:招聘者|招聘人|联系人|招聘官|HR)[：:]\s*/i : /^(?:职位名称|岗位名称|招聘职位|职位|岗位)[：:]\s*/, '');
    line = line.replace(activityTail, '').replace(/\s+[·•|｜]?\s*(?:在线|活跃|离线)$/, '').trim();
    if (kind === 'title') {
      line = line.replace(salaryTail, '').trim().replace(/[·•|｜]+$/, '').trim();
    } else {
      line = line.replace(/((?:先生|女士|小姐|老师|经理|主管|总))在线$/, '$1');
      // Same-line role text can be part of the chat contact's exact identity
      // (e.g. "林 HR"). Only remove standalone role lines, never that suffix.
      line = line.replace(salaryTail, '').trim();
    }
    if (line && !metadataLine(line) && !(kind === 'hr' && recruiterRole.test(line))) return line;
  }
  return '';
}

export function normalizeJobTitle(value) { return normalizeName(value, 'title'); }
export function normalizeHRName(value) { return normalizeName(value, 'hr'); }

export function isUsableCompanyName(value) {
  if (typeof value !== 'string') return false;
  const name = cleanText(value);
  if (!name || /[\r\n]/.test(name) || /(?:\.{2,}|…|⋯|。{2,})$/.test(name) || /^[\s\p{P}\p{S}\uE000-\uF8FF]+$/u.test(name)) return false;
  const label = name.replace(/[：:]$/, '').trim();
  if (/^(?:公司|企业|公司名称|企业名称|公司名|企业名|公司全称|企业全称|工商信息|公司信息|公司介绍|企业介绍|公司简介|企业简介|公司地址|注册地址|法定代表人|统一社会信用代码|企业类型|公司类型|经营状态|注册资本|成立日期|成立时间|公司规模|公司行业|所属行业|融资阶段)$/.test(label)) return false;
  if (/^(?:公司名称|企业名称|公司全称|企业全称)[：:]/.test(name)) return false;
  return !/^(?:暂无(?:信息|数据|公司|公司信息|公司名称)?|未知|未知公司|公司未知|未填写|未提供|未公开|未获取|待完善|待补充|加载中[.。…]*|null|undefined|none|unknown|n\/?a)$/i.test(label);
}

// This is evidence from a list card for this exact public job, not an alias
// assertion between a recruiting brand and a legal company name.
export function trustedListCompany(job) {
  const key = jobUrlKey(job?.url);
  return key && key === jobUrlKey(job?.listCompanyJobUrl) && isUsableCompanyName(job?.listCompany)
    ? cleanText(job.listCompany) : '';
}

// A title/tag/company/location stack is not a job description, however long it
// is. Require an actual task or skill clause; short, clear duties still count.
export function isJobDescription(value, job = {}) {
  const input = cleanText(value);
  if (!input) return false;
  const identity = new Set([
    job.title, normalizeJobTitle(job.title), job.company, job.hrName,
    normalizeHRName(job.hrName), job.salary, job.city, job.location,
  ].map(cleanText).filter(Boolean));
  let inSection = false;
  for (let line of input.split('\n')) {
    line = line.trim().replace(/^(?:[-*•●]|\(?\d+[.)、）]|[一二三四五六七八九十]+[、.])\s*/, '').trim();
    if (heading.test(line)) { inSection = true; continue; }
    const hasHeading = headingPrefix.test(line);
    if (hasHeading) { inSection = true; line = line.replace(headingPrefix, ''); }
    if (identity.has(line) || metadataLine(line)) continue;
    for (const rawClause of line.split(/[。！？!?；;\n]/)) {
      const clause = rawClause.trim();
      if (!clause || identity.has(clause) || metadataLine(clause)) continue;
      const duty = clause.match(/(?:^|[，,：:\s])(?:主要|日常|独立|协同|按时|定期)?(?:负责|承担|参与|协助|完成|跟进|跟踪|统筹|主导|对接|处理|制定|编制|审核|维护|优化|设计|实施|建立|开展|整理|核对|协调|执行|监督|检查|接待|撰写|推进|确保|保障)(.+)$/);
      if (duty && duty[1].replace(/[\s，,：:、]/g, '').length >= 2 && !metadataLine(duty[1])) return true;
      const skill = clause.match(/(?:熟悉|熟练(?:使用|掌握|操作)?|掌握|具备|擅长|能够|能独立)(.+)$/);
      if (skill && skill[1].replace(/[\s，,：:、]/g, '').length >= 2 && !metadataLine(skill[1])) return true;
      if (/(?:有|具有|拥有|具备)?(?:\d+|[一二三四五六七八九十]+)?(?:年|年以上|年以上的)?[\p{Script=Han}A-Za-z\s]{2,30}(?:工作)?经验/u.test(clause)) {
        const domain = clause.replace(/相关|工作|行业|岗位|经验|要求|具有|拥有|具备|有|至少|以上|以下|以内|及|年|[\d一二三四五六七八九十\s，,：:。]/g, '');
        if (domain.length >= 2) return true;
      }
      if (/\b(?:responsible for|manage|coordinate|develop|maintain|design|implement|review|prepare|track|negotiate|familiar with|proficient (?:in|with)|experience (?:in|with)|knowledge of)\s+[a-z][a-z\s/-]{2,}/i.test(clause)) return true;
      if (inSection && /^[\p{Script=Han}A-Za-z\s]{2,30}(?:开发|维护|审核|管理|跟进|分析|设计|测试|实施|交付|培训|谈判|对接)(?:及[\p{Script=Han}A-Za-z\s]{2,30})?(?:等|工作|任务)?$/u.test(clause)) return true;
    }
  }
  return false;
}

export function hasUsableJobDetail(job) {
  return Boolean(job && job.detailVersion === JOB_DETAIL_VERSION &&
    cleanText(job.detailsAt) && isUsableCompanyName(job.company) && isJobDescription(job.description, job));
}

const listFields = new Set([
  'id', 'url', 'title', 'company', 'companyUrl', 'hrName', 'description',
  'salary', 'city', 'location', 'hrActivity', 'activity', 'tags', 'experience',
  'education', 'industry', 'companySize', 'financing', 'jobType', 'source',
  'listUrl', 'listKind', 'lastSeenAt', 'seenAt', 'scannedAt',
  'simulation', 'simulationScore', 'demo',
]);
const refreshedFields = new Set([
  'salary', 'city', 'location', 'hrActivity', 'activity', 'tags', 'experience',
  'education', 'jobType', 'listUrl', 'listKind', 'lastSeenAt', 'seenAt', 'scannedAt',
]);
const detailProofFields = ['detailsAt', 'detailVersion', 'detailSource', 'detailUrl'];
function nonempty(value) {
  return value != null && (typeof value !== 'string' || value.trim() !== '') &&
    (!Array.isArray(value) || value.length > 0);
}

export function mergeJobListItem(existing, item = {}) {
  const incoming = Object.fromEntries(Object.entries(item ?? {}).filter(([key]) => listFields.has(key)));
  // Keep these exclusions explicit: list extraction cannot certify a detail read.
  for (const key of detailProofFields) delete incoming[key];
  if ('title' in incoming) incoming.title = normalizeJobTitle(incoming.title);
  if ('hrName' in incoming) incoming.hrName = normalizeHRName(incoming.hrName);
  if (!isUsableCompanyName(incoming.company)) delete incoming.company;
  else incoming.company = cleanText(incoming.company);
  const listJobKey = jobUrlKey(incoming.url);
  const sameJob = listJobKey && (!existing || listJobKey === jobUrlKey(existing.url));
  if (sameJob && incoming.company) {
    incoming.listCompany = incoming.company;
    incoming.listCompanyJobUrl = 'https://www.zhipin.com' + listJobKey;
  }
  if (!existing) return incoming;
  const merged = {...existing};
  if ('title' in merged) merged.title = normalizeJobTitle(merged.title);
  if ('hrName' in merged) merged.hrName = normalizeHRName(merged.hrName);
  const preserveDescription = nonempty(existing.detailsAt) || isJobDescription(existing.description, existing);
  for (const [key, value] of Object.entries(incoming)) {
    if (!nonempty(value)) continue;
    if (key === 'description') {
      if (!preserveDescription) merged.description = value;
    } else if (key === 'company') {
      if (sameJob && !isUsableCompanyName(merged.company)) merged.company = value;
    } else if (key === 'listCompany' || key === 'listCompanyJobUrl' || refreshedFields.has(key) || !nonempty(merged[key])) {
      merged[key] = value;
    }
  }
  return merged;
}
