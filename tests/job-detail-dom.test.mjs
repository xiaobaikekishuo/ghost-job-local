import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {jobDetailDOM} from '../lib/job-detail-dom.mjs';

// A DOM tree fixture with real selector ancestry and text-node traversal. The
// page parser itself runs unchanged in a VM; no parsed result is substituted.
class Element {
  constructor(tag, attrs = {}, text = '', children = []) {
    this.nodeType=1;this.tagName=tag.toUpperCase();this.attrs={...attrs};this._text=text;
    this.children=[];this.parentElement=null;this.hidden=false;this.style={};children.forEach(child=>this.append(child));
  }
  append(child){child.parentElement=this;this.children.push(child);return child;}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null;}
  get className(){return this.attrs.class||'';}
  get classList(){return {contains:name=>this.className.split(/\s+/).includes(name)};}
  get id(){return this.attrs.id||'';}
  get href(){return this.attrs.href||'';}
  get innerText(){return this.hidden||this.style.display==='none'?'':this._text+this.children.map(child=>child.innerText).join('\n');}
  get childNodes(){return [...(this._text?[{nodeType:3,nodeValue:this._text,parentElement:this}]:[]),...this.children];}
  get previousElementSibling(){const siblings=this.parentElement?.children||[],index=siblings.indexOf(this);return index>0?siblings[index-1]:null;}
  getAttribute(name){return Object.hasOwn(this.attrs,name)?String(this.attrs[name]):null;}
  getBoundingClientRect(){for(let node=this;node;node=node.parentElement)if(node.hidden||node.style.display==='none'||node.style.visibility==='hidden')return {height:0,width:0};return {height:20,width:100};}
  querySelectorAll(selector){const nodes=[];const visit=node=>{for(const child of node.children){nodes.push(child);visit(child);}};visit(this);return nodes.filter(node=>selector.split(',').some(part=>matchesSelector(node,part.trim(),this)));}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  closest(selector){for(let node=this;node;node=node.parentElement)if(matchesSelector(node,selector,node))return node;return null;}
  contains(other){for(let node=other;node;node=node.parentElement)if(node===this)return true;return false;}
}
function matchesSimple(node,selector,scope){
  if(selector===':scope')return node===scope;
  const tag=/^[a-z][a-z0-9-]*/i.exec(selector)?.[0];if(tag&&node.tagName!==tag.toUpperCase())return false;
  for(const [,id] of selector.matchAll(/#([\w-]+)/g))if(node.id!==id)return false;
  for(const [,name] of selector.matchAll(/\.([\w-]+)/g))if(!node.classList.contains(name))return false;
  for(const [,name,operator,quoted,bare] of selector.matchAll(/\[([\w-]+)(?:(\*?=)(?:"([^"]*)"|([^\]]+)))?\]/g)){
    const actual=node.getAttribute(name),expected=quoted??bare;
    if(actual===null||operator==='='&&actual!==expected||operator==='*='&&!actual.includes(expected))return false;
  }
  return true;
}
function matchesSelector(node,selector,scope){
  const tokens=selector.replace(/>/g,' > ').split(/\s+/).filter(Boolean);let index=tokens.length-1,current=node;
  if(!matchesSimple(current,tokens[index--],scope))return false;
  while(index>=0){if(tokens[index]==='>'){current=current.parentElement;index--;if(!current||!matchesSimple(current,tokens[index--],scope))return false;}
    else{const token=tokens[index--];current=current.parentElement;while(current&&!matchesSimple(current,token,scope))current=current.parentElement;if(!current)return false;}}
  return true;
}
const el=(tag,attrs={},text='',children=[])=>new Element(tag,attrs,text,children);
const section=(heading,body,attrs={class:'job-detail-section'},textClass='text')=>el('section',attrs,'',[el('h3',{},heading),el('div',{class:textClass},body)]);
function fixture({url='https://www.zhipin.com/job_detail/current-job.html?tracking=1#description',sections=[]}={}){
  const title=el('h1',{},'采购专员\n10-15K·13薪');
  const recruiter=el('div',{class:'boss-info'},'',[el('span',{class:'name'},'陈女士\n今日活跃')]);
  const company=el('div',{class:'company-info'},'',[el('div',{class:'name'},'当前采购公司\n制造业'),el('a',{href:'https://www.zhipin.com/gongsi/current-company.html?x=1#info'},'公司主页')]);
  const main=el('main',{class:'job-detail'},'',[el('div',{class:'job-name'},'',[title]),recruiter,...sections,company]);
  const body=el('body',{},'', [main]),document=el('document',{},'',[body]);document.body=body;
  const run=()=>structuredClone(vm.runInNewContext(`(${jobDetailDOM.toString()})()`,{document,location:{href:url},URL,
    getComputedStyle:element=>({display:'block',visibility:'visible',...element.style})}));
  return {document,body,main,title,recruiter,company,run};
}

test('Detail parser merges visible responsibility and requirement sections and returns canonical sourced metadata',()=>{
  const f=fixture({sections:[section('岗位职责','负责供应商开发与采购订单跟进。'),section('任职要求','熟悉询价比价和 ERP 系统。')]});
  const result=f.run();
  assert.equal(result.description,'负责供应商开发与采购订单跟进。\n\n熟悉询价比价和 ERP 系统。');
  assert.equal(result.title,'采购专员');assert.equal(result.hrName,'陈女士');assert.equal(result.hrActivity,'今日活跃');
  assert.equal(result.company,'当前采购公司');assert.equal(result.companyUrl,'https://www.zhipin.com/gongsi/current-company.html');
  assert.equal(result.detailSource,'job-detail-dom');assert.equal(result.detailUrl,'https://www.zhipin.com/job_detail/current-job.html');
});

test('Recommendations, welfare and company/business introductions cannot enter the JD even when using text selectors',()=>{
  const recommendation=el('div',{class:'job-recommend'},'',[
    el('div',{class:'job-name'},'',[el('h1',{},'错误推荐岗位')]),el('div',{class:'company-name'},'错误推荐公司'),
    el('div',{class:'job-sec-text'},'RECOMMENDED_JOB_CONTENT')]);
  const f=fixture({sections:[recommendation,section('福利待遇','WELFARE_CONTENT'),section('公司简介','COMPANY_INTRO_CONTENT'),
    section('工商信息','BUSINESS_RECORD_CONTENT'),section('推荐职位','RECOMMEND_HEADING_CONTENT'),section('岗位职责','仅此职责是有效岗位正文。')]});
  assert.equal(f.run().description,'仅此职责是有效岗位正文。');
  assert.equal(f.run().title,'采购专员');assert.equal(f.run().company,'当前采购公司');
});

test('Nested excluded blocks and heading-delimited introductions are removed without dropping later requirements',()=>{
  const description=el('div',{class:'job-sec-text'},'',[
    el('h3',{},'岗位职责'),el('p',{},'负责采购供应商管理。'),
    el('div',{class:'company-intro'},'NESTED_COMPANY_CONTENT'),el('div',{class:'job-welfare'},'NESTED_WELFARE_CONTENT'),
    el('h3',{},'公司介绍'),el('p',{},'HEADING_COMPANY_CONTENT'),
    el('h3',{},'任职要求'),el('p',{},'熟悉订单交付流程。')]);
  const f=fixture({sections:[description]});
  const result=f.run();
  assert.match(result.description,/负责采购供应商管理/);assert.match(result.description,/熟悉订单交付流程/);
  assert.doesNotMatch(result.description,/NESTED_|HEADING_COMPANY/);
});

test('Duplicate and nested JD nodes are deduplicated while separate requirements remain',()=>{
  const nested=el('div',{class:'job-sec-text'},'供应商开发职责。',[el('div',{class:'text'},'采购交付职责。')]);
  const f=fixture({sections:[nested,section('岗位职责','供应商开发职责。\n采购交付职责。'),section('任职要求','熟悉 ERP 记录维护。')]});
  const result=f.run();
  assert.equal(result.description.match(/采购交付职责/g)?.length,1);
  assert.equal(result.description.match(/供应商开发职责/g)?.length,1);
  assert.match(result.description,/ERP 记录维护/);
});

test('Absent or hidden JD returns an empty description without a full-page or listing-card fallback',()=>{
  const f=fixture();f.body._text='全页存在大量采购岗位文字，但没有岗位正文节点。';
  f.main.append(el('div',{class:'job-list-box'},'',[el('div',{class:'job-sec-text'},'列表卡片不是岗位详情')]));
  const hidden=f.main.append(el('div',{class:'job-sec-text'},'隐藏的职位职责'));hidden.hidden=true;
  f.main.append(section('公司介绍','只有公司简介不能作为岗位要求。'));
  assert.equal(f.run().description,'');
});

test('Only exact HTTPS BOSS job-detail URLs can label a detail result',()=>{
  for(const url of ['http://www.zhipin.com/job_detail/a.html','https://zhipin.com.example.org/job_detail/a.html',
    'https://user:password@www.zhipin.com/job_detail/a.html','https://www.zhipin.com:8443/job_detail/a.html',
    'https://www.zhipin.com/web/geek/jobs','https://www.zhipin.com/job_detail/a.html/extra']){
    const result=fixture({url,sections:[section('岗位职责','有效样式的文字但来自错误页面。')]}).run();
    assert.equal(result.detailUrl,'');assert.equal(result.description,'');assert.equal(result.title,'');
  }
  const result=fixture({url:'https://zhipin.com/job_detail/abc.html?x=1#popup'}).run();
  assert.equal(result.detailUrl,'https://zhipin.com/job_detail/abc.html');
  assert.equal(fixture({url:'https://www.zhipin.com/job_detail/security.html'}).run().detailUrl,'https://www.zhipin.com/job_detail/security.html');
});

test('Metadata uses explicit visible fields and never treats the job title or hostile company links as company identity',()=>{
  const f=fixture({sections:[section('职位描述','负责合规采购与供应商开发。')]});
  f.company.remove();
  f.main.querySelector('.job-name').append(el('span',{class:'company-name'},'岗位区域的伪公司名'));
  const company=f.main.append(el('div',{class:'job-company'},'',[el('span',{class:'name'},'合法公司'),
    el('a',{href:'https://www.zhipin.com.evil.example/gongsi/wrong.html'},'外站'),
    el('a',{href:'http://www.zhipin.com/gongsi/wrong.html'},'明文链接')]));
  const result=f.run();assert.equal(result.company,'合法公司');assert.equal(result.companyUrl,'');
  company.hidden=true;assert.equal(f.run().company,'');
  f.title._text='采购工程师 12-18K';f.recruiter.querySelector('.name')._text='陈女士 · 当前在线';
  assert.equal(f.run().title,'采购工程师');assert.equal(f.run().hrName,'陈女士');assert.equal(f.run().hrActivity,'当前在线');
});

test('A real job-company brand link outranks registration labels and legal names regardless of their DOM order',()=>{
  for(const brandFirst of [false,true])for(const labelFirst of [false,true]){
    const f=fixture();f.company.remove();
    const fields=[el('span',{class:'company-name'},'公司名称'),el('span',{class:'name'},'广州某注册主体有限公司')];
    const business=el('section',{class:'job-sec'},'',[el('h3',{},'工商信息'),el('div',{class:'company-info'},'',labelFirst?fields:fields.toReversed())]);
    const brand=el('div',{class:'job-company'},'',[el('a',{href:'https://www.zhipin.com/gongsi/real-brand.html?from=job'},'真实招聘品牌')]);
    for(const element of brandFirst?[brand,business]:[business,brand])f.main.append(element);
    const result=f.run();assert.equal(result.company,'真实招聘品牌');assert.equal(result.companyUrl,'https://www.zhipin.com/gongsi/real-brand.html');
  }
});

test('Recruiter brand fields are preferred to a generic company card and never read a legal-name field',()=>{
  const f=fixture();f.company.remove();
  f.main.append(el('div',{class:'business-info'},'',[el('span',{class:'company-name'},'公司名称'),el('span',{class:'name'},'注册主体有限公司')]));
  f.main.append(el('div',{class:'company-info'},'',[el('span',{class:'name'},'通用公司卡名称')]));
  f.recruiter.append(el('span',{class:'company-name'},'招聘者实际品牌'));
  assert.equal(f.run().company,'招聘者实际品牌');assert.equal(f.run().companyUrl,'');
});

test('Unscoped names and label-value legal records cannot become a recruiting brand',()=>{
  for(const label of ['公司名称','公司名称：','企业名称','注册名称']){
    const f=fixture();f.company.remove();
    f.main.append(el('span',{class:'company-name'},'未限定来源的公司名'));
    f.main.append(el('div',{class:'company-info'},'',[el('span',{class:'label'},label),el('span',{class:'name'},'法定注册主体有限公司'),
      el('a',{href:'https://www.zhipin.com/gongsi/legal-company.html'},'企业主页')]));
    assert.equal(f.run().company,'',label);assert.equal(f.run().companyUrl,'',label);
  }
  const inline=fixture();inline.company.remove();inline.main.append(el('div',{class:'job-company'},'',[el('span',{class:'name'},'公司名称：注册主体有限公司')]));
  assert.equal(inline.run().company,'');
});

test('Company-page navigation labels are never brands, while a genuine full company brand is retained',()=>{
  const f=fixture();f.company.remove();
  f.main.append(el('div',{class:'job-company'},'',[el('a',{href:'https://www.zhipin.com/gongsi/brand.html'},'公司主页'),
    el('span',{class:'name'},'广东真实招聘品牌有限公司')]));
  assert.equal(f.run().company,'广东真实招聘品牌有限公司');assert.equal(f.run().companyUrl,'https://www.zhipin.com/gongsi/brand.html');
  const onlyLabel=fixture();onlyLabel.company.remove();onlyLabel.main.append(el('div',{class:'job-company'},'',[el('a',{href:'https://www.zhipin.com/gongsi/brand.html'},'公司主页')]));
  assert.equal(onlyLabel.run().company,'');
});

test('Recommended, hidden and business-block brand-shaped links cannot displace the real brand',()=>{
  const f=fixture();f.company.remove();
  for(const name of ['job-recommend','business-info','company-business','registration-info'])
    f.main.append(el('div',{class:name},'',[el('div',{class:'job-company'},'',[el('a',{href:'https://www.zhipin.com/gongsi/wrong.html'},'错误来源公司')])]));
  const hidden=f.main.append(el('div',{class:'job-company'},'',[el('a',{href:'https://www.zhipin.com/gongsi/hidden.html'},'隐藏公司')]));hidden.hidden=true;
  f.main.append(el('div',{class:'job-company'},'',[el('a',{href:'https://www.zhipin.com/gongsi/current.html'},'当前招聘品牌')]));
  assert.equal(f.run().company,'当前招聘品牌');assert.equal(f.run().companyUrl,'https://www.zhipin.com/gongsi/current.html');
});

test('Conflicting brands at the same priority remain unknown instead of trusting first DOM order',()=>{
  const f=fixture();
  for(const [name,id] of [['甲招聘品牌','a'],['乙招聘品牌','b']])
    f.main.append(el('div',{class:'job-company'},'',[el('a',{href:'https://www.zhipin.com/gongsi/'+id+'.html'},name)]));
  assert.equal(f.run().company,'');assert.equal(f.run().companyUrl,'');
});

test('Sampled company custom-page link wins over a company-name LI label and a job-title/salary .name',()=>{
  for(const brandFirst of [false,true])for(const titleFirst of [false,true]){
    const f=fixture();f.company.remove();
    const label=el('span',{},'公司名称'),legal=el('li',{class:'company-name'},'', [label]);
    Object.defineProperty(legal,'innerText',{get:()=> '公司名称\n广州示例注册主体有限公司'});
    Object.defineProperty(legal,'childNodes',{get:()=>[label,{nodeType:3,nodeValue:'广州示例注册主体有限公司'}]});
    const business=el('ul',{class:'business-info'},'',[legal]);
    const links=[el('a',{href:'/gongsi/brand-current.html',ka:'job-detail-company_custompage',title:'祥行科技'},'',[el('img',{})]),
      el('a',{href:'/gongsi/brand-current.html',ka:'job-detail-company_custompage',title:'祥行科技'},'祥行科技')];
    const title=el('div',{class:'name'},'',[el('span',{class:'job-title'},'采购跟单'),el('span',{class:'badge'},'6-7K')]);
    const card=el('div',{class:'company-info'},'',titleFirst?[title,...links]:[...links,title]);
    for(const element of brandFirst?[card,business]:[business,card])f.main.append(element);
    f.main.append(el('div',{class:'job-recommend'},'',[el('span',{class:'company-name'},'推荐品牌')]));
    const result=f.run();assert.equal(result.company,'祥行科技');assert.equal(result.companyUrl,'https://www.zhipin.com/gongsi/brand-current.html');
  }
});

test('Sampled boss-info-attr reads only recruiting brand before the explicit vdot and never the recruiter role',()=>{
  const f=fixture();f.company.remove();f.recruiter.attrs.class='job-boss-info';
  const dot=el('em',{class:'vdot'},'·'),attr=el('div',{class:'boss-info-attr'},'',[dot]);
  Object.defineProperty(attr,'innerText',{get:()=> '祥行科技·招聘者'});
  Object.defineProperty(attr,'childNodes',{get:()=>[{nodeType:3,nodeValue:'祥行科技'},dot,{nodeType:3,nodeValue:'招聘者'}]});
  f.recruiter.append(attr);
  const result=f.run();assert.equal(result.company,'祥行科技');assert.equal(result.hrName,'陈女士');assert.equal(result.companyUrl,'');
  dot.attrs.class='unconfirmed-separator';assert.equal(f.run().company,'');
});

test('A company-info .name containing a job title or salary badge is never a company fallback',()=>{
  for(const className of ['job-title','badge']){
    const f=fixture();f.company.remove();
    f.main.append(el('div',{class:'company-info'},'',[el('div',{class:'name'},'采购跟单',[el('span',{class:className},'6-7K')])]));
    assert.equal(f.run().company,'');assert.equal(f.run().companyUrl,'');
  }
});

test('Explicit authentication/security routes and visible blocking dialogs throw typed errors',()=>{
  for(const [url,code] of [['https://www.zhipin.com/web/passport/zp/security.html','VERIFICATION_REQUIRED'],
    ['https://www.zhipin.com/web/passport/login','AUTH_REQUIRED']])assert.throws(()=>fixture({url}).run(),{code});
  for(const [message,code] of [['请完成安全验证，拖动滑块','VERIFICATION_REQUIRED'],['扫码登录后查看','AUTH_REQUIRED'],['访问过于频繁，请稍后重试','RATE_LIMITED']]){
    const f=fixture();f.body.append(el('div',{role:'dialog'},message));assert.throws(()=>f.run(),{code});
  }
});

test('JD mentions of verification or login and hidden dialogs are not mistaken for access barriers',()=>{
  const f=fixture({sections:[section('岗位职责','负责账号登录、验证码及安全验证流程的开发与测试。')]});
  const hidden=f.body.append(el('div',{role:'dialog'},'扫码登录并完成安全验证'));hidden.hidden=true;
  assert.match(f.run().description,/账号登录、验证码及安全验证流程/);
});
