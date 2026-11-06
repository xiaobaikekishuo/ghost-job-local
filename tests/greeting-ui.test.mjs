import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createGreetingUI, greetingReviewReason} from '../public/greeting-ui.mjs';
import {createJobListUI} from '../public/job-list-ui.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const btn = (text, action, style = '', icon = '', attrs = '') => `<button data-action="${action}" ${attrs}>${text}</button>`;
const validGreeting = () => ({status:'草稿',text:'您好，岗位涉及供应商开发，我有供应商开发经历，希望进一步沟通。',
  matches:[{requirement:'供应商开发',evidence:'供应商开发'}],generatorVersion:4,revision:'current-revision',reviewRequired:false});
const noMatch = () => ({...validGreeting(),text:'',matches:[],reviewRequired:true,reviewReason:'no_match'});

function fixture({greeting = validGreeting(), status = '合适', personalized = true} = {}) {
  const previousDocument = globalThis.document;
  const job = {id:'job-one',title:'采购专员',company:'虚构公司',status,greeting};
  const state = {task:{busy:false},replyTask:{busy:false},syncTask:{busy:false},settings:{personalizedGreeting:personalized}};
  const calls = [], confirmations = [], toasts = [], opened = [];
  const editor = {dataset:{jobId:job.id},value:greeting?.text || '',readOnly:false};
  const send = {disabled:false,innerHTML:'确认沟通'}, targetResult={textContent:'',className:''};
  let currentResult=targetResult,checkResponse={verified:true,sent:false,reason:'已核对 HR 和岗位，未发送消息'};
  let html = '', generated = greeting;
  const body = {querySelector:() => ({before:section => { html = section.innerHTML; }})};
  globalThis.document = {
    querySelector(selector) {
      if (selector === '#job-greeting-text') return editor;
      if (selector === '#modal-content .modal-body') return body;
      if (selector === '#modal-content [data-action="send-job"]') return send;
      if (selector === '[data-greeting-target-result]') return currentResult;
      assert.fail('Unexpected DOM lookup: ' + selector);
    },
    createElement:() => ({className:'',innerHTML:''})
  };
  const api = async (route, payload) => {
    calls.push({route,payload});
    if (route === 'jobs/greeting/save') {
      if (payload.text !== job.greeting.text) job.greeting = {...job.greeting,text:payload.text,edited:true,reviewRequired:true,reviewReason:'edited',revision:'edited-revision'};
      return job.greeting;
    }
    if (route === 'jobs/greeting') { job.greeting = generated; return generated; }
    if (route === 'jobs/send' || route === 'jobs/greeting/send') return {verified:true,greetingVerified:true,reason:'fixture success'};
    if (route === 'jobs/greeting/check-target') return checkResponse;
    assert.fail('Unexpected API route: ' + route);
  };
  const ui = createGreetingUI({getContext:() => ({state,jobs:[job]}),api,btn,esc,
    confirmAction:async (title,description) => { confirmations.push({title,description}); return true; },
    toast:(text,error) => toasts.push({text,error}),closeModal:() => {},reload:async () => {},openJob:id => opened.push(id)});
  return {ui,job,state,editor,send,targetResult,calls,confirmations,toasts,opened,
    changeResult:value=>{currentResult=value;},setCheckResponse:value=>{checkResponse=value;},
    get html(){return html;},setGenerated:value => {generated=value;},
    close(){if (previousDocument === undefined) delete globalThis.document; else globalThis.document=previousDocument;}};
}

test('Draft quality reasons distinguish missing evidence, edited review and legacy text without relabelling sent records', () => {
  assert.match(greetingReviewReason(noMatch()),/匹配证据/);
  assert.match(greetingReviewReason({...validGreeting(),reviewRequired:true,reviewReason:'edited'}),/人工修改/);
  assert.match(greetingReviewReason({...validGreeting(),generatorVersion:1}),/旧版/);
  assert.match(greetingReviewReason({...validGreeting(),generatorVersion:3}),/旧版/);
  assert.match(greetingReviewReason({...validGreeting(),matches:[null]}),/匹配证据/);
  assert.equal(greetingReviewReason(validGreeting()),'');
  assert.equal(greetingReviewReason({...noMatch(),status:'已发送'}),'');
});

test('recipient check only invokes the non-sending check endpoint and leaves unsaved local text intact',async()=>{
 const f=fixture({status:'已沟通'});
 try{
  f.editor.value='尚未保存的本地草稿';
  const element={dataset:{id:f.job.id},disabled:false};
  await f.ui.actions['check-greeting-target'](element);
  assert.deepEqual(f.calls.map(c=>c.route),['jobs/greeting/check-target']);
  assert.equal(f.confirmations.length,0);assert.equal(f.editor.value,'尚未保存的本地草稿');
  assert.match(f.targetResult.textContent,/未发送消息/);assert.equal(element.disabled,false);
 }finally{f.close();}
});

test('source labels describe the saved generation, not the currently selected provider', () => {
 const f=fixture({greeting:{...validGreeting(),generationProvider:'chatgpt-plan',generationModel:'gpt-6-astra'}});
 try{
  f.state.settings.aiProvider='api';
  f.ui.decorate(f.job.id);
  assert.match(f.html,/生成来源：ChatGPT 订阅 · gpt-6-astra/);
  assert.match(f.html,/AI 撰写与事实核对/);
  f.job.greeting={...validGreeting(),generatorVersion:3};
  f.ui.decorate(f.job.id);
  assert.doesNotMatch(f.html,/生成来源：/);
  assert.match(f.html,/旧版招呼草稿/);
 }finally{f.close();}
});

test('generation source metadata is escaped and edited text is not labelled AI reviewed', () => {
 const f=fixture({greeting:{...validGreeting(),generationProvider:'api',generationModel:'<img src=x>',edited:true,reviewRequired:true,reviewReason:'edited'}});
 try{
  f.ui.decorate(f.job.id);
  assert.match(f.html,/API 服务 · &lt;img src=x&gt;/);
  assert.match(f.html,/正文已手动修改/);
  assert.doesNotMatch(f.html,/AI 撰写与事实核对/);
 }finally{f.close();}
});

test('a late recipient check cannot mark a different job dialog as verified',async()=>{
 const f=fixture({status:'已沟通'});let resolve;
 try{
  f.setCheckResponse(new Promise(done=>{resolve=done;}));
  const pending=f.ui.actions['check-greeting-target']({dataset:{id:f.job.id},disabled:false});
  const otherResult={textContent:'另一岗位尚未核对',className:''};f.changeResult(otherResult);
  resolve({verified:true,sent:false,reason:'原岗位核对通过'});await pending;
  assert.equal(otherResult.textContent,'另一岗位尚未核对');assert.equal(f.toasts.length,0);
 }finally{f.close();}
});

test('an existing opening locks sending without labelling the retained custom draft as sent', () => {
 const f=fixture({status:'已沟通',greeting:{...validGreeting(),status:'已有开场',skipReason:'已有本人开场，未追加'}});
 try{
  f.ui.decorate(f.job.id);assert.match(f.html,/已有开场/);assert.match(f.html,/不代表已发送/);
  assert.doesNotMatch(f.html,/data-action="send-greeting"/);assert.doesNotMatch(f.html,/data-action="confirm-manual-greeting"/);
  assert.match(f.html,/data-action="generate-greeting"[^>]*disabled/);
 }finally{f.close();}
});

test('Unmatched drafts display review guidance and disable greeting send while leaving regeneration available', () => {
  const f=fixture({greeting:noMatch(),status:'已沟通'});
  try {
    f.ui.decorate(f.job.id);
    assert.match(f.html,/招呼待确认/);assert.match(f.html,/补充资料后重新生成/);
    assert.match(f.html,/data-action="send-greeting"[^>]*disabled/);
    assert.doesNotMatch(f.html,/data-action="generate-greeting"[^>]*disabled/);
    assert.match(f.html,/BOSS 自动发出的固定开场/);assert.match(f.html,/不再追加招呼/);assert.match(f.html,/专属文案保留在本机/);
    assert.doesNotMatch(f.html,/发起沟通时会使用专属招呼/);
  } finally {f.close();}
});

test('Personalized contact is disabled for review drafts but ordinary contact mode remains available', () => {
  for (const personalized of [true,false]) {
    const f=fixture({greeting:noMatch(),personalized});
    try {f.ui.decorate(f.job.id);assert.equal(f.send.disabled,personalized);}
    finally {f.close();}
  }
});

test('Stale review-draft action buttons cannot submit a contact or greeting send request', async () => {
  for (const action of ['send-job','send-greeting']) {
    const f=fixture({greeting:noMatch(),status:action==='send-greeting'?'已沟通':'合适'});
    try {
      await assert.rejects(f.ui.actions[action]({dataset:{id:f.job.id}}),/匹配证据/);
      assert.equal(f.calls.length,0);assert.equal(f.confirmations.length,0);
      assert.deepEqual(f.opened,[f.job.id]);
    } finally {f.close();}
  }
});

test('Saving an editor change that becomes review-required cannot fall through to sending', async () => {
  const f=fixture({status:'已沟通'});
  try {
    f.editor.value+='感谢您的时间。';
    await assert.rejects(f.ui.actions['send-greeting']({dataset:{id:f.job.id}}),/人工修改/);
    assert.deepEqual(f.calls.map(call=>call.route),['jobs/greeting/save']);
    assert.equal(f.confirmations.length,0);
  } finally {f.close();}
});

test('Fresh generation that finds no evidence stays review-required without a success toast or send', async () => {
  const f=fixture();
  try {
    f.setGenerated(noMatch());
    await f.ui.actions['generate-greeting']({dataset:{id:f.job.id}});
    assert.deepEqual(f.calls.map(call=>call.route),['jobs/greeting']);
    assert.match(f.toasts.at(-1).text,/匹配证据/);assert.equal(f.toasts.at(-1).error,true);
    assert.equal(f.confirmations.length,0);
  } finally {f.close();}
});

test('Personalized confirmation explains that an existing platform opening prevents an additional greeting', async () => {
  const f=fixture();
  try {
    await f.ui.actions['send-job']({dataset:{id:f.job.id}});
    assert.equal(f.confirmations.length,1);
    assert.match(f.confirmations[0].description,/可能先发送 BOSS 的固定开场/);
    assert.match(f.confirmations[0].description,/已有本人开场就跳过追加/);
    assert.match(f.confirmations[0].description,/没有开场时才发送/);
    assert.equal(f.calls.at(-1).route,'jobs/send');
    assert.equal(f.calls.at(-1).payload.expectedGreetingRevision,'current-revision');
  } finally {f.close();}
});

test('Ordinary contact does not inherit personalized draft restrictions', async () => {
  const f=fixture({greeting:noMatch(),personalized:false});
  try {
    await f.ui.actions['send-job']({dataset:{id:f.job.id}});
    assert.deepEqual(f.calls.map(call=>call.route),['jobs/send']);
    assert.equal(f.calls[0].payload.expectedPersonalizedGreeting,false);
    assert.equal(f.confirmations.length,1);
  } finally {f.close();}
});

test('Copying a greeting only writes the clipboard and never submits or confirms a send', async () => {
  const f=fixture(),previous=Object.getOwnPropertyDescriptor(globalThis,'navigator'),copied=[];
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async text=>copied.push(text)}}});
  try {
    await f.ui.actions['copy-greeting']({dataset:{id:f.job.id}});
    assert.deepEqual(copied,[f.editor.value]);assert.equal(f.calls.length,0);assert.equal(f.confirmations.length,0);
    assert.match(f.toasts.at(-1).text,/核对岗位和 HR 后粘贴/);
  } finally {
    if(previous)Object.defineProperty(globalThis,'navigator',previous);else delete globalThis.navigator;
    f.close();
  }
});

test('The job list exposes a review filter and reason without changing the pending-greeting definition', () => {
  const context={state:{companies:[]},jobs:[
    {id:'review-job',title:'待确认岗位',status:'合适',greeting:noMatch()},
    {id:'pending-job',title:'待补岗位',status:'已沟通',greeting:validGreeting()},
    {id:'sent-job',title:'已发送岗位',status:'已沟通',greeting:{...noMatch(),status:'已发送'}}
  ],selected:new Set(),jobFilter:'招呼待确认',query:''};
  const ui=createJobListUI({getContext:()=>context,icon:()=>'',btn,pill:text=>`<span>${esc(text)}</span>`,color:()=>'',esc,
    heading:()=>'',empty:()=>''});
  const review=ui.jobRows();
  assert.match(review,/data-filter="招呼待确认"/);assert.match(review,/data-id="review-job"/);
  assert.match(review,/检查招呼/);assert.match(review,/补充资料后重新生成/);
  assert.doesNotMatch(review,/data-id="pending-job"|data-id="sent-job"/);
  context.jobFilter='待补招呼';
  const pending=ui.jobRows();
  assert.match(pending,/data-id="pending-job"/);assert.doesNotMatch(pending,/data-id="review-job"|data-id="sent-job"/);
});
