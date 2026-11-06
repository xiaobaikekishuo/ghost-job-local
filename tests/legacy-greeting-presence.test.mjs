import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {chatDOM} from '../lib/chat-dom.mjs';

function element(text='',attributes={},queries={}){
 return {innerText:text,textContent:text,className:attributes.class||'',id:attributes.id||'',disabled:false,
  classList:{contains:token=>String(attributes.class||'').split(' ').includes(token)},
  getAttribute:key=>attributes[key]??null,getBoundingClientRect:()=>({height:attributes.hidden?0:20}),
  querySelector:selector=>queries[selector]||null,querySelectorAll:selector=>queries[selector]||[],
  focus(){this.focused=true;},dispatchEvent(){this.inputEvents=(this.inputEvents||0)+1;},click(){this.clicks=(this.clicks||0)+1;}};
}
function fixture({platform='data-mid',status='已发送',role='assistant',kind='text',hidden=false}={}){
 const name=element('王 HR'),company=element('虚构甲公司'),title=element('采购经理');
 const header=element('',{'data-uid':'wanted'},{'.name,.user-name,.nickname':name,'.company,.company-name':company,'.job-name,.job-title':title});
 const row=element('',{'data-uid':'wanted',class:'active'},{'.name,.user-name,.nickname':name,'.company,.company-name':company});
 const list=element('',{}, {'.user-item,.chat-user,.conversation-item,.chat-item,.friend-item,li':[]});
 list.querySelectorAll=()=>[row];
 const body=element('原有开场'),receipt=element(status),card=kind==='attachment'?element('附件简历'):null;
 const message=element('原有开场',{class:role==='assistant'?'message-item item-myself':'message-item',hidden,
  ...(platform?{[platform]:'message-platform-id'}:{})},
  {'.text,.text-content,.message-text':body,'.message-status,.send-status':receipt,
   '.resume-card,.attachment-card,.file-card,[data-type="resume"],[data-type="attachment"],[data-type="file"]':card});
 const root=element('',{}, {'.message-item':[message]});
 const input=element('专属正文'),button=element('发送'),link=element('采购经理');link.href='https://www.zhipin.com/job_detail/fixture.html';
 const queries={'.chat-info,.chat-header,.conversation-header':header,'.user-list,.chat-user-list,.conversation-list,.chat-list':list,
  '.chat-record,.chat-message-list,.message-list,.chat-conversation':root,
  '.chat-job a[href*="/job_detail/"],.job-card a[href*="/job_detail/"],.chat-info a[href*="/job_detail/"]':link,
  '.chat-input[contenteditable],.chat-input textarea,textarea.input-area,[contenteditable="true"].input-area':input,
  'button,.btn-send':[button]};
 const document={querySelector:selector=>queries[selector]||null,querySelectorAll:selector=>queries[selector]||[]};
 const expected={remoteId:'wanted',contact:'王 HR',company:'虚构甲公司',jobTitle:'采购经理',jobUrl:link.href,noExistingOpening:true};
 return {input,button,expected,run:args=>structuredClone(vm.runInNewContext(`(${chatDOM.toString()})(args)`,{document,args,InputEvent:class{}}))};
}

test('legacy DOM fill and send refuse a true platform opening before editing or clicking',()=>{
 for(const action of ['fill','send'])for(const platform of ['data-mid','data-id']){
  const f=fixture({platform}),result=f.run({action,expected:f.expected,text:'专属正文'});
  assert.equal(result.code,'GREETING_ALREADY_PRESENT');assert.equal(result.notSent,true);assert.equal(result.alreadyGreeted,true);
  assert.equal(result.receiptId,'message-platform-id');assert.equal(result.conversation.messages[0].platformMessageId,true);
  assert.equal(f.button.clicks,undefined);assert.equal(f.input.focused,undefined);assert.equal(f.input.inputEvents,undefined);
 }
});

test('legacy DOM synthetic or element IDs and nonconfirmed messages block without inventing delivery proof',()=>{
 for(const options of [{platform:null},{platform:'id'},...['发送中','发送失败',''].map(status=>({status}))]){
  const f=fixture(options),result=f.run({action:'send',expected:f.expected,text:'专属正文'});
  assert.equal(result.code,'GREETING_PRESENCE_UNCERTAIN');assert.equal(result.presenceUnknown,true);assert.equal(result.receiptId,undefined);
  assert.equal(f.button.clicks,undefined);
 }
});

test('legacy opening checks do not mistake HR messages, attachments or hidden rows for a text opening',()=>{
 for(const options of [{role:'user'},{kind:'attachment'},{hidden:true}]){
  const f=fixture(options),result=f.run({action:'send',expected:f.expected,text:'专属正文'});
  assert.equal(result.ok,true);assert.equal(f.button.clicks,1);
 }
});

test('legacy opening checks never bypass recipient identity and do not restrict ordinary replies',()=>{
 const f=fixture();assert.ok(f.run({action:'send',expected:{...f.expected,remoteId:'other'},text:'专属正文'}).error);assert.equal(f.button.clicks,undefined);
 const result=f.run({action:'send',expected:{...f.expected,noExistingOpening:false},text:'专属正文'});
 assert.equal(result.ok,true);assert.equal(f.button.clicks,1);
});
