import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {modernChatDOM} from '../lib/modern-chat-dom.mjs';

// Small DOM tree fixture: selectors traverse actual parent/child/class/attribute
// relationships instead of returning pre-parsed chat contexts or selector maps.
// Production modernChatDOM is serialized and executed in the page VM unchanged.
class Element {
  constructor(tag, attrs = {}, text = '', children = []) {
    this.tagName = tag.toUpperCase(); this.attrs = {...attrs}; this._text = text;
    this.children = []; this.parentElement = null; this.hidden = false; this.disabled = false;
    this.style = {}; this.clicks = 0; this.events = []; children.forEach(child => this.append(child));
    this.clientHeight=20;this.scrollHeight=20;this.scrollTop=0;
  }
  append(child) { child.parentElement = this; this.children.push(child); return child; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  get id() { return this.attrs.id || ''; }
  get className() { return this.attrs.class || ''; }
  set className(value) { this.attrs.class = value; }
  get classList() { return {contains: name => this.className.split(/\s+/).includes(name)}; }
  get innerText() { return this.textContent; }
  get childNodes() { return [{nodeType:3,textContent:this._text},...this.children]; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(text) { this._text = text; this.children.forEach(child => { child.parentElement = null; }); this.children = []; }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? String(this.attrs[name]) : null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getBoundingClientRect() {
    for (let node = this; node; node = node.parentElement)
      if (node.hidden || node.style.display === 'none' || node.style.visibility === 'hidden') return {height:0,width:0};
    return this.bounds||{height:20,width:100,left:0,right:100,top:0,bottom:20};
  }
  querySelectorAll(selector) {
    const nodes = [];
    const visit = node => { for (const child of node.children) { nodes.push(child); visit(child); } };
    visit(this);
    return nodes.filter(node => selector.split(',').some(part => matchesSelector(node, part.trim(), this)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.focused = true; }
  dispatchEvent(event) { this.events.push(event); this.onInput?.(event); return true; }
  click() { this.clicks++; this.onClick?.(); }
}
function matchesSimple(node, selector, scope) {
  if (selector === ':scope') return node === scope;
  const tag = /^[a-z][a-z0-9-]*/i.exec(selector)?.[0];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const [, id] of selector.matchAll(/#([\w-]+)/g)) if (node.id !== id) return false;
  for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!node.classList.contains(name)) return false;
  for (const [, name, quoted, bare] of selector.matchAll(/\[([\w-]+)(?:=(?:"([^"]*)"|([^\]]+)))?\]/g)) {
    const actual = node.getAttribute(name), expected = quoted ?? bare;
    if (actual === null || expected !== undefined && actual !== expected) return false;
  }
  return true;
}
function matchesSelector(node, selector, scope) {
  const tokens = selector.replace(/>/g, ' > ').split(/\s+/).filter(Boolean);
  let index = tokens.length - 1, current = node;
  if (!matchesSimple(current, tokens[index--], scope)) return false;
  while (index >= 0) {
    if (tokens[index] === '>') {
      current = current.parentElement; index--;
      if (!current || !matchesSimple(current, tokens[index--], scope)) return false;
    } else {
      const token = tokens[index--]; current = current.parentElement;
      while (current && !matchesSimple(current, token, scope)) current = current.parentElement;
      if (!current) return false;
    }
  }
  return true;
}
const el = (tag, attrs = {}, text = '', children = []) => new Element(tag, attrs, text, children);
function message({id = 'message-1', text = '先前的一条真实消息', role = 'user', status = '', statusClass = ''} = {}) {
  return el('div', {class:'message-item' + (role === 'assistant' ? ' item-myself' : ''), ...(id ? {'data-mid':id} : {})}, '', [
    el('div', {class:'text-content'}, text),
    el('div', {class:'message-status ' + statusClass}, status)
  ]);
}
function row(contact = '林 HR', company = '虚构采购公司', selected = false) {
  return el('li', {role:'listitem', class:selected ? 'active' : ''}, '', [
    el('div', {class:'name-box'}, '', [el('span', {class:'name-text'}, contact), el('span', {}, company)])
  ]);
}
function fixture() {
  const name = el('span', {class:'name-text'}, '林 HR');
  const company = el('span', {}, '虚构采购公司');
  const header = el('div', {class:'top-info-content'}, '', [
    el('div', {class:'name-content'}, '', [name]),
    el('div', {class:'base-info'}, '', [el('span', {class:'base-title'}, '招聘负责人'), company])
  ]);
  const jobName = el('span', {class:'position-name'}, '采购专员');
  const jobControl=el('span',{},'查看职位');
  const jobEntry = el('div', {class:'position-content',ka:'geek_chat_job_detail'}, '', [
    el('div', {class:'left-content'}, '', [jobName, el('span', {class:'salary'}, '8-12K'), el('span', {class:'city'}, '广州')]),
    el('div', {class:'right-content'}, '', [jobControl])
  ]);
  const position = el('div', {class:'chat-position-content'}, '', [jobEntry]);
  const selected = row('林 HR', '虚构采购公司', true);
  const list = el('ul', {class:'user-list-content'}, '', [selected, row('陈 HR', '另一家公司')]);
  const record = el('div', {class:'chat-record'}, '', [message()]);
  const input = el('div', {id:'chat-input',contenteditable:'true'});
  const button = el('button', {type:'send',class:'btn-send'}, '发送');
  const document = el('document', {}, '', [header, position, list, record, input, button]);
  document.visibilityState='visible';document.pointHit=jobControl;document.elementFromPoint=()=>document.pointHit;
  const location = {pathname:'/web/geek/chat'};
  const run = args => structuredClone(vm.runInNewContext(`(${modernChatDOM.toString()})(args)`, {
    document, args, location, innerWidth:1280, innerHeight:800, getComputedStyle: element => ({display:'block',visibility:'visible',...element.style}),
    InputEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } }
  }));
  const proof = () => { const context = run(); return {contact:context.contact,company:context.company,jobTitle:context.jobTitle,anchorIds:context.anchorIds}; };
  return {document,location,header,name,company,jobName,jobEntry,jobControl,position,list,selected,record,input,button,run,proof};
}

test('Authentication and verification routes refuse mounted chat actions and preserve typed read errors', () => {
  for (const [route,code] of [['/web/passport/zp/security.html','VERIFICATION_REQUIRED'],['/web/verify','VERIFICATION_REQUIRED'],
    ['/web/passport/login','AUTH_REQUIRED'],['/login','AUTH_REQUIRED']]) {
    const f=fixture(),expected=f.proof();f.location.pathname=route;
    const read=f.run();assert.equal(read.code,code);assert.equal(read.notSent,undefined);
    for (const action of ['fill','send','openJob']) {
      const result=f.run({action,expected,text:'专属正文'});assert.equal(result.code,code);assert.equal(result.notSent,true);
    }
    assert.equal(f.input.textContent,'');assert.equal(f.input.events.length,0);assert.equal(f.button.clicks,0);assert.equal(f.jobEntry.clicks,0);
  }
});

test('Visible verification/login chrome and explicit dialog restriction titles stop all actions before editing or clicking', () => {
  const cases=[
    [()=>el('div',{class:'captcha-dialog'}),'VERIFICATION_REQUIRED'],
    [()=>el('div',{class:'geetest_panel'}),'VERIFICATION_REQUIRED'],
    [()=>el('div',{class:'login-dialog'}),'AUTH_REQUIRED'],
    [()=>el('div',{role:'dialog'},'',[el('h2',{},'请完成安全验证')]),'VERIFICATION_REQUIRED'],
    [()=>el('div',{class:'dialog-wrap'},'',[el('div',{class:'dialog-title'},'登录已失效')]),'AUTH_REQUIRED'],
    [()=>el('div',{'aria-modal':'true'},'',[el('h3',{},'访问过于频繁，请稍后重试')]),'RATE_LIMITED'],
    [()=>el('div',{class:'dialog-container'},'',[el('h2',{},'今日沟通次数已达上限')]),'RATE_LIMITED'],
  ];
  for(const [make,code] of cases)for(const action of ['fill','send','openJob']) {
    const f=fixture(),expected=f.proof();f.input.textContent='专属正文';f.document.append(make());
    const result=f.run({action,expected,text:'专属正文'});
    assert.equal(result.code,code);assert.equal(result.notSent,true);assert.equal(f.input.textContent,'专属正文');
    assert.equal(f.input.events.length,0);assert.equal(f.input.focused,undefined);assert.equal(f.button.clicks,0);assert.equal(f.jobEntry.clicks,0);
  }
});

test('A challenge appearing after fill is checked again in the actual send evaluation', () => {
  const f=fixture(),expected=f.proof();assert.equal(f.run({action:'fill',expected,text:'专属正文'}).ok,true);
  f.document.append(el('div',{class:'verify-dialog'}));
  const result=f.run({action:'send',expected,text:'专属正文'});
  assert.equal(result.code,'VERIFICATION_REQUIRED');assert.equal(result.notSent,true);assert.equal(f.button.clicks,0);
});

test('Chat text, resume content, normal job titles and hidden dialog chrome cannot impersonate account restrictions', () => {
  const f=fixture();
  f.record.append(message({id:'discussion',text:'岗位涉及登录页面、安全验证、访问过于频繁问题处理。'}));
  f.record.append(el('div',{class:'message-item'},'',[el('div',{class:'captcha-dialog',role:'dialog'},'',[el('h2',{},'安全验证')])]));
  f.document.append(el('div',{class:'resume-card'},'',[el('div',{class:'login-page'})]));
  f.document.append(el('div',{role:'dialog'},'',[el('h2',{},'安全验证产品经理岗位职责')]));
  const hidden=f.document.append(el('div',{'aria-hidden':'true'},'',[el('div',{class:'verify-dialog'})]));
  const stale=f.document.append(el('div',{class:'login-dialog'}));stale.hidden=true;
  const concealed=f.document.append(el('div',{role:'dialog'},'',[el('h2',{},'访问过于频繁')]));concealed.style.display='none';
  const expected=f.proof();assert.equal(f.run().error,undefined);
  assert.equal(f.run({action:'fill',expected,text:'正常专属正文'}).ok,true);assert.equal(f.button.clicks,0);
  hidden.setAttribute('aria-hidden','false');assert.equal(f.run().code,'VERIFICATION_REQUIRED');
});

test('Read uses modern visible identity and genuine data-mid messages without inventing a conversation ID', () => {
  const f=fixture();
  f.record.append(message({id:'message-2',role:'assistant',text:'岗位专属正文',status:'送达',statusClass:'status-delivery'}));
  const withoutId=message({id:'',text:'无平台编号不应合成 ID'});withoutId.setAttribute('data-id','not-a-message-mid');f.record.append(withoutId);
  const result=f.run();
  assert.equal(result.modern,true);assert.equal(result.contact,'林 HR');assert.equal(result.company,'虚构采购公司');assert.equal(result.jobTitle,'采购专员');
  assert.equal(Object.hasOwn(result,'id'),false);assert.equal(Object.hasOwn(result,'remoteId'),false);
  assert.deepEqual(result.anchorIds,['message-1','message-2']);
  assert.deepEqual(result.messages[1],{remoteId:'message-2',platformMessageId:true,text:'岗位专属正文',role:'assistant',deliveryStatus:'confirmed'});
  assert.equal(result.messages[0].role,'user');assert.equal(result.messages.length,2);
});

test('Latest-tail proof uses the real unique scroll container and never moves a history view', () => {
  const f=fixture();f.record.style.overflowY='auto';f.record.scrollHeight=500;f.record.clientHeight=100;f.record.scrollTop=400;
  const result=f.run();assert.equal(result.latestTail.atBottom,true);assert.equal(result.latestTail.loading,false);
  assert.equal(result.latestTail.signature,JSON.stringify([500,100,400,'message-1']));
  const expected={...f.proof(),requireLatestTail:true,tailSignature:result.latestTail.signature};
  f.record.scrollTop=200;
  for(const action of ['fill','send']){
    const blocked=f.run({action,expected,text:'专属正文'});assert.equal(blocked.code,'GREETING_TARGET_UNAVAILABLE');assert.equal(blocked.notSent,true);
  }
  assert.equal(f.record.scrollTop,200);assert.equal(f.input.textContent,'');assert.equal(f.input.events.length,0);assert.equal(f.button.clicks,0);
});

test('Unknown geometry, multiple scroll ancestors, parent clipping and an uncontained record cannot prove the latest tail', () => {
  const mutations=[f=>{f.record.clientHeight=undefined;},f=>{f.record.scrollHeight=100;},
    f=>{f.record.clientHeight=1;f.record.scrollHeight=0;},f=>{f.record.clientHeight=2;f.record.scrollHeight=0;},
    f=>{f.record.bounds={height:20,width:100,top:810,bottom:830};},
    f=>{f.record.style.overflowY='auto';f.record.scrollHeight=100;f.record.scrollTop=80;
      const wrapper=el('div');wrapper.style.overflowY='scroll';wrapper.scrollHeight=100;wrapper.scrollTop=80;
      f.record.remove();wrapper.append(f.record);f.document.append(wrapper);},
    f=>{const wrapper=el('div');wrapper.style.overflowY='hidden';wrapper.scrollHeight=100;
      f.record.remove();wrapper.append(f.record);f.document.append(wrapper);},
    f=>{f.record.style.overflowY='auto';f.record.scrollHeight=100;f.record.scrollTop=80;
      const wrapper=el('div');wrapper.style.overflowY='scroll';wrapper.clientHeight=undefined;
      f.record.remove();wrapper.append(f.record);f.document.append(wrapper);}];
  for(const mutate of mutations){
    const f=fixture(),expected={...f.proof(),requireLatestTail:true};mutate(f);
    assert.equal(f.run().latestTail.atBottom,false);assert.equal(f.run().latestTail.signature,'');
    assert.equal(f.run({action:'fill',expected,text:'专属正文'}).notSent,true);assert.equal(f.input.events.length,0);
  }
  const fits=fixture();assert.equal(fits.run().latestTail.atBottom,true,'A fully contained non-scrolling record can be proven');
});

test('Latest-tail loading state reads list chrome and aria-busy without treating HR message text as a loader', () => {
  for(const mutate of [f=>f.record.setAttribute('aria-busy','true'),f=>f.record.append(el('div',{class:'loading-more'})),
    f=>f.record.append(el('div',{'aria-busy':'true'}))]){
    const f=fixture(),expected={...f.proof(),requireLatestTail:true};mutate(f);
    assert.equal(f.run().latestTail.loading,true);
    assert.equal(f.run({action:'fill',expected,text:'专属正文'}).notSent,true);assert.equal(f.input.events.length,0);
  }
  const f=fixture();f.record.append(message({id:'message-2',text:'招聘项目正在加载中，需要有 loading 组件经验'}));
  f.record.children.at(-1).append(el('span',{class:'loading'}));
  const hidden=f.record.append(el('div',{class:'loading'}));hidden.hidden=true;
  assert.equal(f.run().latestTail.loading,false);assert.equal(f.run().latestTail.atBottom,true);
});

test('Send requires the latest last anchor and unchanged measured tail in the click evaluation', () => {
  const f=fixture(),before=f.run();
  const expected={...f.proof(),requireLatestTail:true,tailSignature:before.latestTail.signature};
  assert.equal(f.run({action:'fill',expected,text:'专属正文'}).ok,true);
  f.record.append(message({id:'arrived-after-boundary',text:'刚到的 HR 问题'}));
  assert.equal(f.run({action:'send',expected,text:'专属正文'}).notSent,true);
  const current=f.run();
  assert.equal(f.run({action:'send',expected:{...expected,tailSignature:current.latestTail.signature},text:'专属正文'}).notSent,true,'Old anchor cannot be accepted with a substituted current signature');
  assert.equal(f.run({action:'send',expected:{...expected,anchorIds:current.anchorIds,tailSignature:undefined},text:'专属正文'}).notSent,true);
  assert.equal(f.button.clicks,0);
  const proven={...expected,anchorIds:[current.anchorIds.at(-1)],tailSignature:current.latestTail.signature};
  assert.equal(f.run({action:'send',expected:proven,text:'专属正文'}).clicked,true);assert.equal(f.button.clicks,1);
});

test('Stable identity alone cannot bypass a changing scroll-tail signature', () => {
  const f=fixture();f.record.style.overflowY='auto';f.record.scrollHeight=200;f.record.clientHeight=100;f.record.scrollTop=100;
  const expected={...f.proof(),requireLatestTail:true,tailSignature:f.run().latestTail.signature};f.input.textContent='专属正文';
  f.record.scrollHeight=240;f.record.scrollTop=140;
  assert.equal(f.run().latestTail.atBottom,true);
  assert.equal(f.run({action:'send',expected,text:'专属正文'}).notSent,true);assert.equal(f.button.clicks,0);
});

test('A different existing manual draft is preserved without focus or input events', () => {
  const f=fixture(),expected=f.proof();f.input.textContent='我正在手动编辑的内容';
  const result=f.run({action:'fill',expected,text:'新的专属招呼'});
  assert.equal(result.notSent,true);assert.equal(result.code,'GREETING_TARGET_UNAVAILABLE');
  assert.equal(f.input.textContent,'我正在手动编辑的内容');assert.equal(f.input.events.length,0);
  assert.equal(f.input.focused,undefined);assert.equal(f.button.clicks,0);
});

test('Receipt status comes from visible status elements, with pending and failure overriding delivery styling', () => {
  for(const [status,statusClass,expected] of [['已读','','confirmed'],['送达','status-delivery','confirmed'],['','status-delivery','confirmed'],['','status-read','confirmed'],
    ['发送中','status-delivery','pending'],['发送失败','status-delivery','failed'],['','status-sending','pending'],['','status-failed','failed'],['','','unknown']]) {
    const f=fixture();f.record.children=[];f.record.append(message({role:'assistant',text:'正文提到发送失败并不等于状态失败',status,statusClass}));
    assert.equal(f.run().messages[0].deliveryStatus,expected,status+' '+statusClass);
  }
});

test('Missing headers, blank fields, multiple selected rows and selected/header conflicts refuse all actions', () => {
  const mutations=[f=>f.header.remove(),f=>{f.name.textContent='';},f=>{f.company.textContent='';},f=>{f.jobName.textContent='';},
    f=>f.list.append(row('陈 HR','另一家公司',true)),f=>{f.selected.querySelector('.name-text').textContent='王 HR';},
    f=>{f.selected.querySelector('.name-box').children[1].textContent='错误公司';},f=>{f.selected.className='';}];
  for(const mutate of mutations) {
    const f=fixture(),expected=f.proof();mutate(f);
    const result=f.run({action:'send',expected,text:'已确认正文'});
    assert.ok(result.error);assert.equal(result.notSent,true);assert.equal(f.button.clicks,0);
  }
});

test('Only same-name same-company rows are ambiguous; other companies and hidden stale rows are safe', () => {
  const f=fixture(),expected=f.proof();
  f.list.append(row('林 HR','另一公司'));
  assert.equal(f.run({action:'fill',expected,text:'专属正文'}).ok,true);
  const duplicate=f.list.append(row('林 HR','虚构采购公司'));
  const priorInputs=f.input.events.length;
  assert.ok(f.run({action:'fill',expected,text:'专属正文'}).error);assert.equal(f.input.events.length,priorInputs);
  duplicate.hidden=true;
  const hiddenHeader=f.document.append(el('div',{class:'top-info-content'}));hiddenHeader.hidden=true;
  assert.equal(f.run({action:'fill',expected,text:'专属正文'}).ok,true);assert.equal(f.button.clicks,0);
});

test('Company parsing stops at vline and never treats the recruiter job title as a company', () => {
  const f=fixture();
  const box=f.selected.querySelector('.name-box');
  box.append(el('i',{class:'vline'}));box.append(el('span',{},'人力资源经理'));
  const base=f.header.querySelector('.base-info');
  base.children=base.children.filter(child=>!child.classList.contains('base-title'));
  base.append(el('i',{class:'vline'}));base.append(el('span',{class:'base-title'},'招聘主管'));
  const result=f.run();
  assert.equal(result.company,'虚构采购公司');assert.equal(result.contact,'林 HR');assert.equal(result.error,undefined);
  box.children[1].textContent='';
  assert.ok(f.run().error,'A recruiter title after vline cannot fill an empty company');
});

test('Explicit selected markers on a friend-content child are supported without guessing from appearance', () => {
  for(const attrs of [{class:'friend-content active'},{class:'friend-content selected'},{class:'friend-content','aria-selected':'true'}]) {
    const f=fixture();f.selected.className='';
    const box=f.selected.querySelector('.name-box');box.remove();f.selected.append(el('div',attrs,'',[box]));
    assert.equal(f.run().contact,'林 HR');assert.equal(f.run().error,undefined);
    f.selected.children[0].className='friend-content highlighted';delete f.selected.children[0].attrs['aria-selected'];
    assert.ok(f.run().error,'Unconfirmed highlight colors/classes are not selected-state evidence');
  }
});

test('The sampled nested user-info/base-info/position layout keeps recruiter title separate from company', () => {
  const f=fixture(),nameContent=f.header.querySelector('.name-content'),base=f.header.querySelector('.base-info');
  nameContent.remove();base.remove();
  const oldTitle=base.querySelector('.base-title');oldTitle.remove();
  base.children.unshift(nameContent);nameContent.parentElement=base;
  base.append(el('i',{class:'vline'}));base.append(oldTitle);
  f.header.append(el('div',{class:'user-info-wrap'},'',[el('div',{class:'user-info'},'',[base])]));
  f.position.remove();f.header.append(f.position);
  const box=f.selected.querySelector('.name-box');box.remove();f.selected.className='';
  f.selected.append(el('div',{class:'friend-content selected'},'',[box]));
  box.append(el('i',{class:'vline'}));box.append(el('span',{},'HRBP'));
  const result=f.run();
  assert.equal(result.contact,'林 HR');assert.equal(result.company,'虚构采购公司');assert.equal(result.jobTitle,'采购专员');
  assert.equal(f.run({action:'openJob',expected:f.proof()}).openedJob,true);assert.equal(f.button.clicks,0);
});

test('Fill and send reread all three fields and reject a coherent switch away from the proven context', () => {
  for(const field of ['contact','company','jobTitle']) for(const action of ['fill','send']) {
    const f=fixture(),expected=f.proof();f.input.textContent='专属正文';
    if(field==='contact'){f.name.textContent='王 HR';f.selected.querySelector('.name-text').textContent='王 HR';}
    if(field==='company'){f.company.textContent='另一采购公司';f.selected.querySelector('.name-box').children[1].textContent='另一采购公司';}
    if(field==='jobTitle')f.jobName.textContent='采购主管';
    assert.ok(f.run({action,expected,text:'专属正文'}).error);assert.equal(f.button.clicks,0);assert.equal(f.input.events.length,0);
  }
});

test('Every action requires nonempty exact expected identity and at least one surviving original message anchor', () => {
  for(const patch of [{contact:''},{company:''},{jobTitle:''},{anchorIds:[]},{anchorIds:['unknown']},{anchorIds:undefined}]) {
    const f=fixture(),expected={...f.proof(),...patch};
    assert.ok(f.run({action:'fill',expected,text:'专属正文'}).error);assert.equal(f.input.events.length,0);
  }
  const f=fixture(),expected=f.proof();f.record.children=[];f.record.append(message({id:'replacement',text:'另一个上下文'}));
  assert.ok(f.run({action:'send',expected,text:'专属正文'}).error);assert.equal(f.button.clicks,0);
  assert.ok(f.run({action:'send',text:'专属正文'}).error);
});

test('Fill writes only the requested text and dispatches input; send clicks once but never claims a verified receipt', () => {
  const f=fixture(),expected=f.proof();
  const fill=f.run({action:'fill',expected,text:'您好，我有相关供应商开发经验。'});
  assert.equal(fill.ok,true);assert.equal(f.input.events.length,1);assert.equal(f.input.events[0].type,'input');
  assert.equal(f.input.events[0].data,f.input.textContent);assert.equal(f.button.clicks,0);
  const sent=f.run({action:'send',expected,text:f.input.textContent});
  assert.equal(sent.ok,true);assert.equal(sent.clicked,true);assert.equal(sent.verified,undefined);assert.equal(f.button.clicks,1);
  assert.deepEqual(f.run().anchorIds,['message-1']);
  f.record.append(message({id:'message-2',role:'assistant',text:f.input.textContent,status:'已读'}));
  assert.equal(f.run().messages.at(-1).remoteId,'message-2');assert.equal(f.run().messages.at(-1).deliveryStatus,'confirmed');
});

test('Send refuses changed input and hidden, disabled or duplicate input/button elements', () => {
  const mutations=[f=>{f.input.textContent='其他正文';},f=>{f.input.hidden=true;},f=>{f.input.disabled=true;},
    f=>f.input.setAttribute('contenteditable','false'),f=>f.input.setAttribute('aria-disabled','true'),f=>{f.input.className='disabled';},
    f=>{f.button.hidden=true;},f=>{f.button.disabled=true;},f=>f.button.setAttribute('disabled',''),
    f=>f.button.setAttribute('aria-disabled','true'),f=>{f.button.className='btn-send disabled';},
    f=>f.document.append(el('div',{id:'chat-input',contenteditable:'true'})),f=>f.document.append(el('button',{type:'send',class:'btn-send'},'发送'))];
  for(const mutate of mutations) {
    const f=fixture(),expected=f.proof();f.input.textContent='专属正文';mutate(f);
    const result=f.run({action:'send',expected,text:'专属正文'});
    assert.ok(result.error);assert.equal(result.notSent,true);assert.equal(f.button.clicks,0);
  }
});

test('Open-job only clicks the unique evidenced current position entry and never sends a message', () => {
  const f=fixture(),expected=f.proof();let popupOpened=false;
  f.jobControl.onClick=()=>{popupOpened=true;};
  assert.equal(f.run({action:'openJob',expected}).openedJob,true);assert.equal(popupOpened,true);
  assert.equal(f.jobControl.clicks,1);assert.equal(f.jobEntry.clicks,0);assert.equal(f.button.clicks,0);
  f.position.append(el('div',{class:'position-content',ka:'geek_chat_job_detail'},'查看职位'));
  assert.ok(f.run({action:'openJob',expected}).error);assert.equal(f.jobEntry.clicks,0);assert.equal(f.jobControl.clicks,1);assert.equal(f.button.clicks,0);
});

test('Open-job refuses missing, duplicate, hidden or out-of-card view-position labels without falling back to the parent',()=>{
 const mutations=[
  f=>f.jobControl.remove(),
  f=>f.jobControl.parentElement.append(el('span',{},'查看职位')),
  f=>{f.jobControl.hidden=true;},
  f=>{f.jobControl.remove();f.document.append(el('div',{class:'right-content'},'',[el('span',{},'查看职位')]));},
  f=>{f.jobControl.textContent='申请并查看职位';},
  f=>{f.jobControl.textContent='';f.jobControl.append(el('b',{},'查看职位'));}
 ];
 for(const mutate of mutations){const f=fixture(),expected=f.proof();mutate(f);
  const result=f.run({action:'openJob',expected});assert.equal(result.code,'MODERN_CHAT_ACTION_UNAVAILABLE');assert.equal(result.notSent,true);
  assert.equal(f.jobEntry.clicks,0);assert.equal(f.jobControl.clicks,0);assert.equal(f.button.clicks,0);
 }
});

test('Open-job clicks the observed label with one decorative iboss-left icon and ignores only private-use glyphs',()=>{
  for(const glyph of ['', '\ue601', '\u{f0001}']){
    const f=fixture(),expected=f.proof();let popupOpened=false;
    f.jobControl.textContent=' 查看职位 ';
    const icon=f.jobControl.append(el('i',{class:'iboss-left'},glyph));
    f.jobControl.onClick=()=>{popupOpened=true;};
    assert.equal(f.run({action:'openJob',expected}).openedJob,true);assert.equal(popupOpened,true);
    assert.equal(f.jobControl.clicks,1);assert.equal(icon.clicks,0);assert.equal(f.jobEntry.clicks,0);assert.equal(f.button.clicks,0);
  }
});

test('Locate-job proves an unobstructed visible viewport point without clicking or modifying the page',()=>{
 const f=fixture(),expected=f.proof();f.jobControl.bounds={left:20,right:100,top:10,bottom:34,width:80,height:24};
 assert.deepEqual(f.run({action:'locateJobEntry',expected}),{modern:true,ok:true,x:60,y:22,viewport:{width:1280,height:800}});
 const icon=f.jobControl.append(el('i',{class:'iboss-left'},'\ue601'));f.document.pointHit=icon;
 assert.deepEqual(f.run({action:'locateJobEntry',expected}),{modern:true,ok:true,x:60,y:22,viewport:{width:1280,height:800}});
 assert.equal(f.jobControl.clicks,0);assert.equal(icon.clicks,0);assert.equal(f.jobEntry.clicks,0);assert.equal(f.button.clicks,0);assert.deepEqual(f.input.events,[]);
});

test('only an explicitly hidden page exposes the typed foreground recovery reason after identity checks',()=>{
 const f=fixture(),expected=f.proof();f.document.visibilityState='hidden';
 const hidden=f.run({action:'locateJobEntry',expected});
 assert.equal(hidden.code,'MODERN_CHAT_ACTION_UNAVAILABLE');assert.equal(hidden.reason,'CHAT_NOT_FOREGROUND');assert.equal(hidden.notSent,true);
 delete f.document.visibilityState;
 assert.equal(f.run({action:'locateJobEntry',expected}).reason,undefined);
 f.document.visibilityState='hidden';
 const changed=f.run({action:'locateJobEntry',expected:{...expected,company:'另一公司'}});
 assert.equal(changed.code,'MODERN_CHAT_IDENTITY_UNAVAILABLE');assert.equal(changed.reason,undefined);
 assert.equal(f.jobControl.clicks,0);assert.equal(f.button.clicks,0);assert.deepEqual(f.input.events,[]);
});

test('Locate-job rejects background pages, invalid or offscreen geometry and any covering element',()=>{
 const mutations=[
  f=>{f.document.visibilityState='hidden';},f=>{delete f.document.visibilityState;},
  f=>{f.jobControl.bounds={left:0,top:0,right:100,bottom:20,width:NaN,height:20};},
  f=>{f.jobControl.bounds={left:-200,top:0,right:-100,bottom:20,width:100,height:20};},
  f=>{f.jobControl.bounds={left:0,top:800,right:100,bottom:820,width:100,height:20};},
  f=>{f.jobControl.bounds={left:0,top:0,right:0,bottom:20,width:100,height:20};},
  f=>{f.document.pointHit=el('div',{},'遮挡');},f=>{f.document.pointHit=null;},
  f=>{f.document.pointHit=f.jobEntry;},f=>{delete f.document.elementFromPoint;},
  f=>{const icon=f.jobControl.append(el('i',{class:'iboss-left'}));icon.hidden=true;f.document.pointHit=icon;},
  f=>{f.jobControl.append(el('button',{},'其他动作'));},
  f=>{f.jobControl.parentElement.append(el('span',{},'查看职位'));},
  f=>{f.jobControl.hidden=true;}
 ];
 for(const mutate of mutations){const f=fixture(),expected=f.proof();mutate(f);
  const result=f.run({action:'locateJobEntry',expected});assert.equal(result.code,'MODERN_CHAT_ACTION_UNAVAILABLE');assert.equal(result.notSent,true);
  assert.equal(f.jobControl.clicks,0);assert.equal(f.jobEntry.clicks,0);assert.equal(f.button.clicks,0);
 }
 for(const key of ['contact','company','jobTitle','anchorIds']){const f=fixture(),expected=f.proof();expected[key]=key==='anchorIds'?['wrong-anchor']:'wrong-label';
  assert.equal(f.run({action:'locateJobEntry',expected}).code,'MODERN_CHAT_IDENTITY_UNAVAILABLE');assert.equal(f.jobControl.clicks,0);
 }
});

test('Open-job rejects nested actions, nondecorative or multiple icons, and duplicate decorated labels',()=>{
  const mutations=[
    f=>f.jobControl.append(el('button',{},'立即沟通')),
    f=>f.jobControl.append(el('span',{},'查看职位')),
    f=>f.jobControl.append(el('i',{class:'iboss-left'},'立即沟通')),
    f=>f.jobControl.append(el('i',{class:'other-icon'})),
    f=>f.jobControl.append(el('i',{class:'iboss-left'},'',[el('a',{href:'/other'},'') ])),
    f=>{f.jobControl.append(el('i',{class:'iboss-left'}));f.jobControl.append(el('i',{class:'iboss-left'}));},
    ...['role','tabindex','contenteditable','href','onclick'].map(attribute=>f=>f.jobControl.append(el('i',{class:'iboss-left',[attribute]:'button'}))),
    f=>{f.jobControl.textContent='';f.jobControl.append(el('i',{class:'iboss-left'},'查看职位'));},
    f=>{f.jobControl.append(el('i',{class:'iboss-left'}));f.jobControl.parentElement.append(el('span',{},'查看职位',[el('i',{class:'iboss-left'})]));},
    f=>{f.jobControl.textContent='查看职位立即沟通\ue601';f.jobControl.append(el('i',{class:'iboss-left'}));},
    f=>{f.jobControl.textContent='查看职位\ue601';f.jobControl.append(el('i',{class:'iboss-left'}));}
  ];
  for(const mutate of mutations){const f=fixture(),expected=f.proof();mutate(f);
    const result=f.run({action:'openJob',expected});assert.equal(result.code,'MODERN_CHAT_ACTION_UNAVAILABLE');assert.equal(result.notSent,true);
    assert.equal(f.jobControl.clicks,0);assert.equal(f.jobEntry.clicks,0);assert.equal(f.button.clicks,0);
  }
});

test('Conflicting duplicate message IDs are rejected and post-click read errors never assert that nothing was sent', () => {
  const f=fixture();f.record.append(message({id:'message-1',text:'另一个消息'}));
  const conflict=f.run();assert.ok(conflict.error);assert.equal(conflict.notSent,undefined);
  const after=fixture(),expected=after.proof();after.input.textContent='专属正文';
  assert.equal(after.run({action:'send',expected,text:'专属正文'}).clicked,true);
  after.name.textContent='';
  const unreadable=after.run();assert.ok(unreadable.error);assert.equal(unreadable.notSent,undefined);assert.equal(after.button.clicks,1);
});

test('unnumbered or ambiguous visible own text exposes only an uncertainty count',()=>{
  const f=fixture();f.record.append(message({id:'',role:'assistant',text:'PRIVATE_UNNUMBERED_OPENING'}));
  const ambiguous=message({id:'ambiguous',role:'assistant',text:'PRIVATE_FIRST'});ambiguous.append(el('div',{class:'text-content'},'PRIVATE_SECOND'));f.record.append(ambiguous);
  const hidden=message({id:'',role:'assistant',text:'PRIVATE_HIDDEN'});hidden.hidden=true;f.record.append(hidden);
  f.record.append(message({id:'',role:'user',text:'PRIVATE_HR'}));
  const result=f.run();assert.equal(result.ownTextUnknownCount,2);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));assert.equal(result.anchorIds.includes('ambiguous'),true);
});

test('automatic opening guard blocks confirmed own text atomically before fill or send',()=>{
  for(const action of ['fill','send']){
    const f=fixture(),expected={...f.proof(),noExistingOpening:true};f.input.textContent=action==='send'?'本次草稿':'';
    f.record.append(message({id:'platform-opening',role:'assistant',text:'您好，我对岗位感兴趣。',status:'已读'}));
    const result=f.run({action,expected,text:'本次草稿'});
    assert.equal(result.code,'GREETING_ALREADY_PRESENT');assert.equal(result.notSent,true);assert.equal(result.alreadyGreeted,true);
    assert.equal(result.receiptId,'platform-opening');assert.equal(f.button.clicks,0);assert.deepEqual(f.input.events,[]);
    assert.equal(f.input.textContent,action==='send'?'本次草稿':'');
  }
});

test('unconfirmed and unnumbered own text block the same-evaluation opening guard without a fake receipt',()=>{
  for(const options of [{id:'own',status:'发送中'},{id:'own',status:'发送失败'},{id:'own',status:''},{id:'',status:'已读'}]){
    const f=fixture(),expected={...f.proof(),noExistingOpening:true};f.input.textContent='本次草稿';
    f.record.append(message({...options,role:'assistant',text:'本人已出现的开场'}));
    const result=f.run({action:'send',expected,text:'本次草稿'});
    assert.equal(result.code,'GREETING_PRESENCE_UNCERTAIN');assert.equal(result.presenceUnknown,true);assert.equal(result.notSent,true);
    assert.equal(result.receiptId,undefined);assert.equal(f.button.clicks,0);assert.equal(f.input.textContent,'本次草稿');
  }
});

test('opening guard follows identity and original-anchor checks, but precedes tail-change rejection',()=>{
  const f=fixture(),expected={...f.proof(),noExistingOpening:true,requireLatestTail:true,tailSignature:'stale'};
  f.input.textContent='本次草稿';f.record.append(message({id:'late-opening',role:'assistant',text:'平台开场',status:'送达'}));
  assert.equal(f.run({action:'send',expected,text:'本次草稿'}).code,'GREETING_ALREADY_PRESENT');
  assert.equal(f.run({action:'send',expected:{...expected,company:'另一公司'},text:'本次草稿'}).code,'MODERN_CHAT_IDENTITY_UNAVAILABLE');
  assert.equal(f.run({action:'send',expected:{...expected,anchorIds:['other']},text:'本次草稿'}).code,'MODERN_CHAT_IDENTITY_UNAVAILABLE');
  assert.equal(f.button.clicks,0);assert.equal(f.input.textContent,'本次草稿');
});
