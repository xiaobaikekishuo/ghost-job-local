import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {Browser} from '../lib/browser.mjs';
import {browserDiagnosticsDOM} from '../lib/browser-diagnostics.mjs';

class Element {
  constructor(tag='div',attributes={},children=[],text='') {
    this.tagName=tag.toUpperCase();this.attributes=attributes;this.children=children;this.label=text;
    for(const child of children)child.parentElement=this;
  }
  getAttribute(name){return this.attributes[name]??null;}
  hasAttribute(name){return name in this.attributes;}
  getBoundingClientRect(){return this.attributes.hidden?{height:0,width:0}:this.box||{height:20,width:100};}
  matches(selector){return selector.split(',').some(part=>{
    part=part.trim();
    const tag=part.match(/^[a-z][a-z0-9]*/i)?.[0];if(tag&&this.tagName!==tag.toUpperCase())return false;
    for(const [,name]of part.matchAll(/\.([\w-]+)/g))if(!(this.attributes.class||'').split(/\s+/).includes(name))return false;
    for(const [,name,,value]of part.matchAll(/\[([\w-]+)(?:=(['"]?)(.*?)\2)?\]/g))if(!this.hasAttribute(name)||(value!==undefined&&this.getAttribute(name)!==value))return false;
    return true;
  });}
  closest(selector){for(let node=this;node;node=node.parentElement)if(node.matches(selector))return node;return null;}
  querySelectorAll(selector){const found=[];for(const child of this.children){if(child.matches(selector))found.push(child);found.push(...child.querySelectorAll(selector));}return [...new Set(found)];}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  get textContent(){return this.label+this.children.map(child=>child.textContent).join('');}
  get value(){throw Error('Input values must never be read');}
  get innerHTML(){throw Error('HTML must never be read');}
  click(){throw Error('Diagnostic must never click');}
}
const el=(tag,attributes,children,text)=>new Element(tag,attributes,children,text);
const run=(children,url='https://www.zhipin.com/web/geek/chat?secret=LOCATION_SECRET#secret',metadata={})=>{
  const body=el('body',{},children),document=el('document',{},[body]);document.body=body;document.readyState='complete';Object.assign(document,metadata);
  Object.defineProperty(document,'cookie',{get(){throw Error('Cookies must never be read');}});
  const context={document,location:{href:url},URL,getComputedStyle:element=>({display:'block',visibility:'visible',...element.computedStyle})};
  Object.defineProperty(context,'localStorage',{get(){throw Error('Storage must never be read');}});
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${browserDiagnosticsDOM.toString()})()`,context)));
};

test('diagnostic retains safe structure, public links and modal frame path without private values',()=>{
  const result=run([
    el('div',{class:'top-info-content','data-token':'HEADER_TOKEN'},[el('span',{class:'name-text'},[],'HR_PRIVATE_NAME')]),
    el('div',{class:'user-list'},[el('li',{class:'active',role:'listitem','data-uid':'PRIVATE_UID'},[
      el('span',{class:'name-text'},[],'ROW_PRIVATE_NAME'),el('div',{class:'last-msg'},[],'CHAT_PREVIEW_SECRET')])]),
    el('div',{class:'chat-position-content'},[el('span',{class:'position-name'},[],'采购经理'),el('div',{role:'button'},[],'查看职位')]),
    el('div',{role:'dialog',class:'job-dialog'},[
      el('button',{class:'dialog-close','aria-label':'PRIVATE_LABEL'},[],'关闭'),
      el('a',{href:'/job_detail/public-job.html?token=URL_SECRET#HASH_SECRET'},[],'LINK_TEXT_SECRET'),
      el('a',{href:'/gongsi/public-company.html?securityId=COMPANY_SECRET'},[],'LINK_TEXT_SECRET'),
      el('iframe',{src:'/web/frame/job?token=FRAME_SECRET#FRAME_HASH'}),
      el('iframe',{src:'https://external.invalid/job_detail/private.html?token=EXTERNAL_SECRET'}),
      el('textarea',{},[],'DRAFT_SECRET'),
      el('div',{class:'resume'},[el('a',{href:'/job_detail/private-resume.html'},[],'RESUME_SECRET')])]),
    el('div',{class:'chat-record'},[el('div',{class:'message-item item-myself','data-mid':'PRIVATE_MID'},[
      el('div',{class:'message-text'},[],'CHAT_BODY_SECRET'),el('span',{class:'send-status'},[],'RECEIPT_TEXT_SECRET')])])
  ]);
  assert.equal(result.counts.selectedRows,1);
  assert.equal(result.jobCards[0].children[0].text,'采购经理');
  assert.deepEqual(result.links.map(link=>link.href),['https://www.zhipin.com/job_detail/public-job.html','https://www.zhipin.com/gongsi/public-company.html']);
  assert.deepEqual(result.iframes,[{tag:'iframe',class:'',hasSrc:true,srcPath:'/web/frame/job'},{tag:'iframe',class:'',hasSrc:true}]);
  assert.equal(result.messages.count,1);assert.equal(result.messages.withDataMid,1);
  assert.deepEqual(result.messages.receiptClasses,['send-status']);
  const serialized=JSON.stringify(result);
  assert.match(serialized,/关闭/);
  for(const forbidden of ['SECRET','PRIVATE','TOKEN','HASH','private-resume','external.invalid','data-mid','data-uid','cookie','DRAFT'])assert.ok(!serialized.includes(forbidden),forbidden);
});

test('hidden dialogs and dangerous public-looking URLs are excluded; public iframe is canonicalized',()=>{
  const result=run([
    el('div',{role:'dialog',hidden:'true'},[el('iframe',{src:'/job_detail/hidden.html'})]),
    el('div',{role:'dialog'},[
      el('a',{href:'https://www.zhipin.com.evil.invalid/job_detail/evil.html'}),
      el('a',{href:'https://name:password@www.zhipin.com/job_detail/credentials.html'}),
      el('a',{href:'javascript:alert(1)'}),
      el('iframe',{src:'/job_detail/public.html?secret=removed'}),
      el('iframe',{src:'data:text/html,SECRET'})])
  ]);
  assert.deepEqual(result.links,[]);
  assert.equal(result.dialogs.length,1);
  assert.deepEqual(result.iframes,[{tag:'iframe',class:'',hasSrc:true,srcPath:'/job_detail/public.html',src:'https://www.zhipin.com/job_detail/public.html'},{tag:'iframe',class:'',hasSrc:true}]);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('DOM evaluation refuses a page that navigated away from the approved chat route',()=>{
  assert.equal(run([],'https://www.zhipin.com/web/passport/zp/security.html').code,'VERIFICATION_REQUIRED');
  assert.equal(run([],'https://www.zhipin.com/web/passport/login.html').code,'AUTH_REQUIRED');
  assert.equal(run([],'https://external.invalid/web/geek/chat').code,'DIAGNOSTIC_CHAT_REQUIRED');
});

test('unknown modal classes still expose iframe paths, job structure and public links without JD or message text',()=>{
  const result=run([
    el('div',{class:'new-vendor-overlay'},[
      el('iframe',{src:'/web/frame/job?token=SECRET'}),
      el('div',{class:'job-detail-box'},[el('section',{class:'job-sec-text'},[],'JD_BODY_SECRET')]),
      el('a',{href:'/job_detail/overlay-job.html?token=SECRET'},[],'LINK_LABEL_SECRET')]),
    el('div',{class:'chat-record'},[el('a',{href:'/job_detail/message-link.html'},[],'MESSAGE_BODY_SECRET')])
  ]);
  assert.equal(result.dialogs.length,0);
  assert.equal(result.iframes[0].srcPath,'/web/frame/job');
  assert.equal(result.jobDetails[0].class,'job-detail-box');
  assert.deepEqual(result.links.map(link=>link.href),['https://www.zhipin.com/job_detail/overlay-job.html']);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('the modern right-side chat container exposes job cards and modal links but excludes actual message bodies',()=>{
  const result=run([
    el('div',{class:'user-list'},[el('li',{role:'listitem'},[el('div',{class:'friend-content selected'})])]),
    el('div',{class:'chat-conversation'},[
      el('div',{class:'top-info-content'},[el('div',{class:'chat-position-content'},[el('span',{class:'position-name'},[],'采购经理')])]),
      el('div',{role:'dialog'},[el('div',{class:'job-detail'},[el('a',{href:'/job_detail/current.html?token=SECRET'}),el('iframe',{src:'/web/frame/job?token=SECRET'})])]),
      el('div',{class:'message-item','data-mid':'PRIVATE_MID'},[el('a',{href:'/job_detail/from-message.html'},[],'MESSAGE_SECRET')])])
  ]);
  assert.equal(result.counts.selectedRows,1);assert.equal(result.jobCards.length,1);assert.equal(result.jobDetails.length,1);
  assert.deepEqual(result.links.map(link=>link.href),['https://www.zhipin.com/job_detail/current.html']);
  assert.equal(result.iframes[0].srcPath,'/web/frame/job');
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('unknown aria-modal and large fixed overlays contribute structure without text; ordinary chat and navigation do not',()=>{
  const fixed=(element,width=600,height=400,zIndex='99')=>Object.assign(element,{box:{width,height},computedStyle:{position:'fixed',zIndex}});
  const popup=fixed(el('div',{class:'unknown-position-overlay'},[el('button',{class:'new-close-control'},[],'关闭'),el('h2',{},[],'PRIVATE_POPUP_TITLE')]));
  const modal=el('section',{'aria-modal':'true',class:'unknown-aria-popup'},[el('span',{},[],'PRIVATE_BODY')]);
  const chat=fixed(el('div',{class:'chat-conversation'},[el('div',{class:'message-item'},[],'PRIVATE_CHAT')]));
  const unlabelledChat=fixed(el('div',{class:'ordinary-chat-panel'},[el('div',{class:'chat-record'})]));
  const navigation=fixed(el('nav',{class:'fixed-nav'}));
  const header=fixed(el('header',{class:'fixed-header'}));
  const aside=fixed(el('aside',{class:'fixed-aside'}));
  const small=fixed(el('div',{class:'small-toast'}),200,100);
  const low=fixed(el('div',{class:'low-layer'}),600,400,'1');
  const result=run([popup,modal,chat,unlabelledChat,navigation,header,aside,small,low]);
  assert.deepEqual(result.dialogs.map(item=>item.class),['unknown-aria-popup','unknown-position-overlay']);
  assert.equal(result.dialogs[0].attributes['aria-modal'],true.toString());
  assert.equal(result.dialogs[1].children[0].class,'new-close-control');
  assert.ok(!JSON.stringify(result.dialogs).includes('text'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('same-origin iframe query diagnostics expose only approved parameter names, never any values',()=>{
  const result=run([
    el('iframe',{src:'/web/frame/job?jobId=PRIVATE_ONE&encryptJobId=PRIVATE_TWO&encryptedJobId=PRIVATE_THREE&positionId=PRIVATE_FOUR&jobId=PRIVATE_FIVE&token=SECRET&SECRET_KEY=PRIVATE#PRIVATE_HASH'}),
    el('iframe',{src:'https://external.invalid/frame?jobId=PRIVATE_EXTERNAL&token=SECRET'})
  ]);
  assert.deepEqual(result.iframes[0],{tag:'iframe',class:'',hasSrc:true,srcPath:'/web/frame/job',queryKeys:['jobId','encryptJobId','encryptedJobId','positionId']});
  assert.deepEqual(result.iframes[1],{tag:'iframe',class:'',hasSrc:true});
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.ok(!JSON.stringify(result).includes('SECRET'));assert.ok(!JSON.stringify(result).includes('token'));
});

const page=id=>({id,type:'page',url:'https://www.zhipin.com/web/geek/chat?private=not-returned'});
test('captureDiagnostics uses only targets and pinned evaluateOn, without changing selected tabs',async()=>{
  const browser=new Browser('unused');browser.activeTargetId='chosen';browser.chatTargetId='old';
  browser.targets=async()=>[page('old'),page('chosen')];
  for(const name of ['launch','owned','openChat','navigate','newTab','evaluate'])browser[name]=async()=>assert.fail('Forbidden diagnostic call: '+name);
  browser.evaluateOn=async(target,fn)=>{assert.equal(target.id,'chosen');assert.equal(fn,browserDiagnosticsDOM);return {version:2,usable:true};};
  assert.deepEqual(await browser.captureDiagnostics(),{version:2,usable:true});
  assert.equal(browser.activeTargetId,'chosen');assert.equal(browser.chatTargetId,'old');
});

test('captureDiagnostics never guesses among several unselected chat tabs or opens a missing one',async()=>{
  const browser=new Browser('unused');browser.activeTargetId='jobs';
  browser.evaluateOn=async()=>assert.fail('No page is selected');
  browser.targets=async()=>[page('one'),page('two')];
  await assert.rejects(browser.captureDiagnostics(),{code:'DIAGNOSTIC_SELECTION_REQUIRED'});
  browser.targets=async()=>[{id:'jobs',type:'page',url:'https://www.zhipin.com/web/geek/jobs'}];
  await assert.rejects(browser.captureDiagnostics(),{code:'DIAGNOSTIC_CHAT_REQUIRED'});
});

test('captureDiagnostics surfaces a navigation race without returning page data',async()=>{
  const browser=new Browser('unused');browser.targets=async()=>[page('single')];
  browser.evaluateOn=async()=>({error:'请选择消息页',code:'DIAGNOSTIC_CHAT_REQUIRED'});
  await assert.rejects(browser.captureDiagnostics(),{code:'DIAGNOSTIC_CHAT_REQUIRED'});
});

test('empty, loading and unrecognized structures are not usable and expose only safe counts',()=>{
  const empty=run([]);
  assert.equal(empty.usable,false);assert.equal(empty.state,'empty');assert.equal(empty.structure.bodyChildren,0);
  const loading=run([el('div',{class:'loading'})]);
  assert.equal(loading.usable,false);assert.equal(loading.state,'loading');
  const unknown=run([el('div',{class:'unknown-shell'},[],'PRIVATE_ACCOUNT_TITLE')],undefined,{title:'私人账户 SECRET',visibilityState:'hidden'});
  assert.equal(unknown.state,'unrecognized');assert.equal(unknown.structure.bodyChildren,1);assert.equal(unknown.structure.bodyElements,1);
  assert.equal(unknown.structure.title,undefined);assert.equal(unknown.structure.visibility,'hidden');
  assert.ok(!JSON.stringify(unknown).includes('SECRET'));assert.ok(!JSON.stringify(unknown).includes('PRIVATE'));
  const hidden=run([el('div',{class:'top-info-content',hidden:'true'}),el('iframe',{src:'/web/frame/job?secret=SECRET',hidden:'true'})]);
  assert.equal(hidden.usable,false);assert.equal(hidden.structure.matched.header,1);assert.equal(hidden.structure.visible.header,0);
  assert.equal(hidden.structure.matched.frames,1);assert.equal(hidden.structure.visible.frames,0);assert.deepEqual(hidden.iframes,[]);
  assert.equal(run([],undefined,{title:'消息 - BOSS直聘'}).structure.title,'消息 - BOSS直聘');
});

test('visible login or verification signals block immediately without interpreting chat message prose',()=>{
  for(const [className,code]of [['login-dialog','AUTH_REQUIRED'],['verify-dialog','VERIFICATION_REQUIRED']]){
    assert.equal(run([el('div',{class:className})]).code,code);
    assert.equal(run([el('div',{class:className,hidden:'true'})]).code,undefined);
  }
  for(const [title,code]of [['安全验证','VERIFICATION_REQUIRED'],['扫码登录','AUTH_REQUIRED'],['访问过于频繁','RATE_LIMITED']])
    assert.equal(run([el('div',{role:'dialog'},[el('h2',{},[],title)])]).code,code);
  const result=run([el('div',{class:'chat-record'},[el('div',{class:'message-item','data-mid':'SECRET'},[el('h2',{},[],'安全验证')])])]);
  assert.equal(result.usable,true);assert.equal(result.code,undefined);assert.ok(!JSON.stringify(result).includes('安全验证'));
});

test('captureDiagnostics waits for delayed SPA structure and never returns an empty readyState complete snapshot',async()=>{
  const browser=new Browser('unused');browser.activeTargetId='chat';browser.targets=async()=>[page('chat')];
  let calls=0;
  browser.evaluateOn=async(target)=>{assert.equal(target.id,'chat');return ++calls<3?{usable:false,state:'empty',readyState:'complete'}:{usable:true,state:'ready'};};
  assert.deepEqual(await browser.captureDiagnostics({timeoutMs:100,pollMs:1}),{usable:true,state:'ready'});
  assert.equal(calls,3);
});

test('captureDiagnostics times out with safe metadata rather than saving an empty or list-only diagnostic',async()=>{
  const browser=new Browser('unused');browser.targets=async()=>[page('chat')];
  const result=run([el('div',{class:'user-list'},[el('li',{},[],'PRIVATE_ROW')])]);
  assert.equal(result.usable,false);
  browser.evaluateOn=async()=>result;
  await assert.rejects(browser.captureDiagnostics({timeoutMs:0}),error=>{
    assert.equal(error.code,'DIAGNOSTIC_NOT_READY');assert.equal(error.diagnostic,result);
    assert.match(error.message,/未保存空诊断/);assert.ok(!error.message.includes('PRIVATE'));return true;
  });
});

test('explicitly selected connection page wins over a stale active tab and missing selection never falls back',async()=>{
  const browser=new Browser('unused');browser.activeTargetId='old';browser.connection={preferredTargetId:'chosen',generation:3};
  browser.targets=async()=>[page('old'),page('chosen')];
  browser.evaluateOn=async target=>{assert.equal(target.id,'chosen');return {usable:true};};
  await browser.captureDiagnostics();
  browser.targets=async()=>[page('old')];browser.evaluateOn=async()=>assert.fail('Never choose the other tab');
  await assert.rejects(browser.captureDiagnostics(),{code:'DIAGNOSTIC_SELECTION_REQUIRED'});
});

test('fixed target closing or moving to verification never causes capture of a different chat page',async()=>{
  for(const [second,code]of [[undefined,'DIAGNOSTIC_TARGET_CHANGED'],[{...page('chosen'),url:'https://www.zhipin.com/web/passport/zp/security.html'},'VERIFICATION_REQUIRED']]){
    const browser=new Browser('unused');browser.activeTargetId='chosen';let reads=0,evaluations=0;
    browser.targets=async()=>++reads===1?[page('chosen'),page('other')]:[...(second?[second]:[]),page('other')];
    browser.evaluateOn=async()=>{evaluations++;assert.fail('Do not inspect the wrong page');};
    await assert.rejects(browser.captureDiagnostics(),{code});assert.equal(evaluations,0);
  }
});

test('captureDiagnostics retries known transient navigation contexts but preserves unknown CDP errors',async()=>{
  const browser=new Browser('unused');browser.targets=async()=>[page('chat')];let calls=0;
  browser.evaluateOn=async()=>{if(++calls===1)throw Object.assign(Error('Execution context was destroyed'),{code:'CDP_ERROR'});return {usable:true};};
  await browser.captureDiagnostics({timeoutMs:100,pollMs:1});assert.equal(calls,2);
  const failure=Object.assign(Error('Unknown protocol failure'),{code:'CDP_ERROR',cdpCode:-99});
  browser.evaluateOn=async()=>{throw failure;};
  await assert.rejects(browser.captureDiagnostics({timeoutMs:100,pollMs:1}),error=>error===failure);
});

test('captureDiagnostics stops immediately on explicit login and verification states',async()=>{
  for(const code of ['AUTH_REQUIRED','VERIFICATION_REQUIRED','RATE_LIMITED']){
    const browser=new Browser('unused');browser.targets=async()=>[page('chat')];let calls=0;
    browser.evaluateOn=async()=>{calls++;return {usable:false,error:'Explicit barrier',code};};
    await assert.rejects(browser.captureDiagnostics({timeoutMs:100,pollMs:1}),{code});assert.equal(calls,1);
  }
});

test('explicit diagnostic target overrides preferred and active pages without changing selection',async()=>{
  const browser=new Browser('unused');browser.activeTargetId='other';browser.chatTargetId='probe';
  browser.connection={preferredTargetId:'other',generation:7};
  browser.targets=async()=>[page('other'),page('probe')];
  const evaluated=[];browser.evaluateOn=async target=>{evaluated.push(target.id);return {usable:true};};
  assert.deepEqual(await browser.captureDiagnostics({targetId:'probe',generation:7}),{usable:true});
  assert.deepEqual(evaluated,['probe']);assert.equal(browser.activeTargetId,'other');assert.equal(browser.connection.preferredTargetId,'other');
});

test('missing or non-chat explicit diagnostic target never falls back to another ready chat',async()=>{
  for(const selected of [undefined,{id:'probe',type:'page',url:'https://www.zhipin.com/web/geek/jobs'}]){
    const browser=new Browser('unused');browser.activeTargetId='other';
    browser.targets=async()=>[page('other'),...(selected?[selected]:[])];
    browser.evaluateOn=async()=>assert.fail('Must not read a fallback page');
    await assert.rejects(browser.captureDiagnostics({targetId:'probe'}),{code:'DIAGNOSTIC_TARGET_CHANGED'});
  }
});

test('diagnostic generation and cancellation are checked before reading the target inventory',async()=>{
  const browser=new Browser('unused');browser.connection={generation:2};
  browser.targets=async()=>assert.fail('Changed or cancelled connection must not be read');
  await assert.rejects(browser.captureDiagnostics({targetId:'probe',generation:1}),{code:'DIAGNOSTIC_TARGET_CHANGED'});
  await assert.rejects(browser.captureDiagnostics({targetId:'probe',generation:2,guard:()=>false}),{code:'CANCELLED'});
});

test('generation, cancellation or route changing during evaluation discards the diagnostic',async()=>{
  for(const change of ['generation','cancel','route']){
    const browser=new Browser('unused');browser.connection={generation:3};let active=true,target=page('probe'),evaluations=0;
    browser.targets=async()=>[page('other'),target];
    browser.evaluateOn=async current=>{
      assert.equal(current.id,'probe');evaluations++;
      if(change==='generation')browser.connection.generation++;
      if(change==='cancel')active=false;
      if(change==='route')target={...target,url:'https://www.zhipin.com/web/geek/jobs'};
      return {usable:true};
    };
    await assert.rejects(browser.captureDiagnostics({targetId:'probe',generation:3,guard:()=>active}),
      {code:change==='cancel'?'CANCELLED':'DIAGNOSTIC_TARGET_CHANGED'});
    assert.equal(evaluations,1);
  }
});
