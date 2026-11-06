import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {modernJobProofDOM} from '../lib/modern-job-proof-dom.mjs';

class Element {
  constructor(tag='div',attrs={},children=[],text=''){
    this.tagName=tag.toUpperCase();this.attrs=attrs;this.children=children;this.label=text;this.clicks=0;
    for(const child of children)child.parentElement=this;
  }
  getAttribute(name){return this.attrs[name]??null;}
  hasAttribute(name){return Object.hasOwn(this.attrs,name);}
  getBoundingClientRect(){return this.box||{width:100,height:30};}
  matches(selector){return selector.split(',').some(value=>{
    value=value.trim();const tag=value.match(/^[a-z][a-z0-9]*/i)?.[0];
    if(tag&&tag.toUpperCase()!==this.tagName)return false;
    for(const [,name]of value.matchAll(/\.([\w-]+)/g))if(!(this.attrs.class||'').split(/\s+/).includes(name))return false;
    for(const [,key,op,double,single,bare]of value.matchAll(/\[([\w-]+)(\*=|=)?(?:"([^"]*)"|'([^']*)'|([^\]]+))?\]/g)){
      if(!this.hasAttribute(key))return false;
      const expected=double??single??bare;
      if(op==='='&&this.getAttribute(key)!==expected||op==='*='&&!this.getAttribute(key).includes(expected))return false;
    }
    return true;
  });}
  closest(selector){for(let node=this;node;node=node.parentElement)if(node.matches(selector))return node;return null;}
  contains(element){for(let node=element;node;node=node.parentElement)if(node===this)return true;return false;}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  get textContent(){return this.label+this.children.map(child=>child.textContent).join('');}
  get contentDocument(){throw Error('Never inspect iframe document');}
  get value(){throw Error('Never inspect composer value');}
  click(){this.clicks++;}
}
const el=(...args)=>new Element(...args);
const stem='abcd1234_full-XYZ_987';
const jobUrl='https://www.zhipin.com/job_detail/'+stem+'.html';
const dialog=(children,attrs={})=>el('div',{role:'dialog',...attrs},children);
const frame=(src,attrs={})=>el('iframe',{src,...attrs});
const close=(attrs={},text='')=>el('button',{'aria-label':'关闭',...attrs},[],text);
function run(children,args={},url='https://www.zhipin.com/web/geek/chat'){
  const document=el('document',{},[el('body',{},children)]);
  Object.defineProperty(document,'cookie',{get(){throw Error('Never read cookies');}});
  const context={document,location:{href:url},URL,getComputedStyle:element=>({display:'block',visibility:'visible',...element.style})};
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${modernJobProofDOM.toString()})(${JSON.stringify(args)})`,context)));
}
function refuses(result){assert.equal(result.ok,false);assert.equal(result.notSent,true);assert.equal(result.code,'GREETING_TARGET_UNAVAILABLE');}

test('direct public iframe proves a canonical URL without expected input and never reads its content or query values',()=>{
  const result=run([dialog([frame(jobUrl+'?securityId=SECRET#PRIVATE')])]);
  assert.equal(result.ok,true);assert.equal(result.jobUrl,jobUrl);assert.equal(result.evidence.kind,'iframe');
  assert.ok(!JSON.stringify(result).includes('SECRET'));assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('internal job frames require one complete matching job ID and an expected public job URL',()=>{
  for(const path of ['/web/frame/job','/web/geek/job','/web/geek/job-detail','/web/geek/jobDetail','/web/geek/job-detail-dialog'])
    for(const key of ['encryptJobId','encryptedJobId','jobId']){
      const dom=[dialog([frame(path+'?'+key+'='+stem+'&securityId=SECRET')])];
      const result=run(dom,{expectedJobUrl:jobUrl});assert.equal(result.ok,true);assert.equal(result.jobUrl,jobUrl);assert.equal(result.evidence.queryKey,key);
      refuses(run(dom));assert.ok(!JSON.stringify(result).includes('SECRET'));
    }
});

test('partial, duplicate and contradictory frame ID parameters never constitute a job proof',()=>{
  for(const query of ['jobId=abcd1234','jobId='+stem+'x','jobId='+stem+'&jobId='+stem,'jobId='+stem+'&encryptJobId='+stem,'positionId='+stem,'encryptJobId=other'])
    refuses(run([dialog([frame('/web/frame/job?'+query)])],{expectedJobUrl:jobUrl}));
});

test('similar domains, external origins, credentials and non-HTTPS URLs are rejected',()=>{
  for(const src of ['https://www.zhipin.com.evil.invalid/job_detail/'+stem+'.html','https://external.invalid/web/frame/job?jobId='+stem,
    'https://user:password@www.zhipin.com/job_detail/'+stem+'.html','http://www.zhipin.com/job_detail/'+stem+'.html',
    'https://zhipin.com/job_detail/'+stem+'.html','javascript:alert(1)'])
    refuses(run([dialog([frame(src)])],{expectedJobUrl:jobUrl}));
});

test('hidden old frames and dialogs are ignored rather than overriding the visible current proof',()=>{
  const old=dialog([frame('https://www.zhipin.com/job_detail/old.html')]);old.style={opacity:'0'};
  const result=run([old,dialog([frame(jobUrl)])],{expectedJobUrl:jobUrl});assert.equal(result.ok,true);assert.equal(result.jobUrl,jobUrl);
  refuses(run([dialog([frame(jobUrl)],{hidden:''})],{expectedJobUrl:jobUrl}));
});

test('multiple frames and mixed public job URLs fail closed',()=>{
  refuses(run([dialog([frame(jobUrl),frame(jobUrl)])],{expectedJobUrl:jobUrl}));
  refuses(run([dialog([frame(jobUrl),el('a',{href:'/job_detail/other.html'})])],{expectedJobUrl:jobUrl}));
  refuses(run([dialog([el('a',{href:jobUrl}),el('a',{href:jobUrl})])],{expectedJobUrl:jobUrl}));
  refuses(run([dialog([frame(jobUrl)])],{expectedJobUrl:'https://www.zhipin.com/job_detail/other.html'}));
});

test('a unique public dialog link can prove the job, but titles, messages and recommendations cannot',()=>{
  assert.equal(run([dialog([el('a',{href:'/job_detail/'+stem+'.html?ka=PRIVATE'})])]).jobUrl,jobUrl);
  refuses(run([el('a',{href:jobUrl})],{expectedJobUrl:jobUrl}));
  refuses(run([dialog([el('h1',{},[],'采购经理')])],{expectedJobUrl:jobUrl}));
  for(const className of ['chat-record','message-item','job-recommend-list'])
    refuses(run([dialog([el('div',{class:className},[el('a',{href:jobUrl})])])],{expectedJobUrl:jobUrl}));
  refuses(run([dialog([el('a',{href:'https://www.zhipin.com.evil.invalid/job_detail/'+stem+'.html'})])],{expectedJobUrl:jobUrl}));
});

test('close rechecks current proof and clicks only the matching modal close control once',()=>{
  const button=close(),source=frame(jobUrl),dom=[dialog([source,button])];
  const result=run(dom,{action:'close',expectedJobUrl:jobUrl});assert.equal(result.closeClicked,true);assert.equal(result.closed,false);assert.equal(button.clicks,1);
  source.attrs.src='https://www.zhipin.com/job_detail/other.html';
  refuses(run(dom,{action:'close',expectedJobUrl:jobUrl}));assert.equal(button.clicks,1);
});

test('two dialogs, a close button in the wrong dialog, and unowned frames never cause a close click',()=>{
  const wrong=close(),right=close();
  refuses(run([dialog([frame(jobUrl)]),dialog([wrong])],{action:'close',expectedJobUrl:jobUrl}));
  refuses(run([dialog([frame(jobUrl),right]),dialog([wrong])],{action:'close',expectedJobUrl:jobUrl}));
  refuses(run([frame(jobUrl),dialog([wrong])],{action:'close',expectedJobUrl:jobUrl}));
  assert.equal(wrong.clicks,0);assert.equal(right.clicks,0);
});

test('ambiguous or non-close controls do not move the page; a short explicit close class works',()=>{
  for(const controls of [[close(),close()],[el('button',{class:'dialog-close'},[],'申请并关闭')],[el('button',{},[],'关闭')],[]]){
    refuses(run([dialog([frame(jobUrl),...controls])],{action:'close',expectedJobUrl:jobUrl}));
    assert.ok(controls.every(control=>control.clicks===0));
  }
  const button=el('span',{class:'dialog-close'},[],'×');
  assert.equal(run([dialog([frame(jobUrl),button])],{action:'close',expectedJobUrl:jobUrl}).closeClicked,true);assert.equal(button.clicks,1);
});

test('nested dialog wrappers count as one popup and fixed unknown overlays can own the proof',()=>{
  const button=close(),inner=el('div',{class:'dialog-content'},[frame(jobUrl),button]);
  assert.equal(run([dialog([inner])],{action:'close',expectedJobUrl:jobUrl}).closeClicked,true);assert.equal(button.clicks,1);
  const fixedClose=close(),overlay=el('div',{class:'unknown-overlay'},[frame(jobUrl),fixedClose]);
  overlay.box={width:600,height:400};overlay.style={position:'fixed',zIndex:'99'};
  assert.equal(run([overlay],{action:'close',expectedJobUrl:jobUrl}).closeClicked,true);assert.equal(fixedClose.clicks,1);
});

test('a verified dialog close class permits one PUA icon but rejects multi-character or unlabelled icons',()=>{
  const icon=el('span',{class:'dialog-close'},[],'\uE60F');
  assert.equal(run([dialog([frame(jobUrl),icon])],{action:'close',expectedJobUrl:jobUrl}).closeClicked,true);
  assert.equal(icon.clicks,1);
  for(const [className,text]of [['dialog-close','\uE60F\uE610'],['dialog-close','\uE60F关闭'],['other-icon','\uE60F']]){
    const control=el('span',{class:className},[],text);
    refuses(run([dialog([frame(jobUrl),control])],{action:'close',expectedJobUrl:jobUrl}));assert.equal(control.clicks,0);
  }
});

test('read-only closed polling requires popup disappearance and never mistakes another job or unsupported frame for closure',()=>{
  const button=close(),owner=dialog([frame(jobUrl),button]),dom=[owner];
  run(dom,{action:'close',expectedJobUrl:jobUrl});assert.equal(button.clicks,1);
  assert.equal(run(dom,{action:'closed',expectedJobUrl:jobUrl}).closed,false);
  owner.attrs.hidden='';assert.equal(run(dom,{action:'closed',expectedJobUrl:jobUrl}).closed,true);assert.equal(button.clicks,1);
  assert.equal(run([dialog([frame('/job_detail/other.html')])],{action:'closed',expectedJobUrl:jobUrl}).closed,false);
  assert.equal(run([frame('https://external.invalid/unknown')],{action:'closed',expectedJobUrl:jobUrl}).closed,false);
  refuses(run([],{action:'closed'}));
});

test('only explicit barrier routes or visible dialog titles classify login and verification',()=>{
  assert.equal(run([],{},'https://www.zhipin.com/web/passport/zp/security.html').code,'VERIFICATION_REQUIRED');
  assert.equal(run([],{},'https://www.zhipin.com/web/passport/login.html').code,'AUTH_REQUIRED');
  for(const [title,code]of [['安全验证','VERIFICATION_REQUIRED'],['请先登录','AUTH_REQUIRED']])
    assert.equal(run([dialog([el('h2',{},[],title),frame(jobUrl)])],{expectedJobUrl:jobUrl}).code,code);
  const result=run([el('div',{class:'chat-record'},[el('h2',{},[],'安全验证')]),dialog([frame(jobUrl)])],{expectedJobUrl:jobUrl});
  assert.equal(result.ok,true);
});
