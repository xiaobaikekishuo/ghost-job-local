import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createStore,defaults,filterJob} from '../lib/store.mjs';
import {analyze,parseAnalysis,aiUrl} from '../lib/ai.mjs';

test('database persists records and encrypted credentials across reopen',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ghost-local-test-'));let s=createStore(dir);
 s.saveSettings({keywords:'Python',apiKey:'test-secret-not-real',minScore:75});
 assert.equal(s.settings().hasApiKey,true);assert.equal(s.settings().apiKey,undefined);
 assert.equal(s.settings(true).apiKey,'test-secret-not-real');
 assert.ok(!s.db.prepare('SELECT value FROM settings WHERE id=1').get().value.includes('test-secret-not-real'));
 const j=s.upsertJob({title:'工程师',company:'测试公司',url:'https://www.zhipin.com/job_detail/test.html'});
 s.upsertJob({...j,status:'合适',score:80});assert.equal(s.jobs().length,1);
 const msg=s.addMessage({contact:'测试 HR',text:'测试消息',role:'user'});assert.equal(msg.id,1);
 s.close();s=createStore(dir);assert.equal(s.settings().keywords,'Python');assert.equal(s.settings(true).apiKey,'test-secret-not-real');assert.equal(s.getJob(j.id).score,80);assert.equal(s.messages()[0].text,'测试消息');
 s.saveSettings({apiKey:''});assert.equal(s.settings().hasApiKey,false);s.close();
 fs.rmSync(dir,{recursive:true,force:true});
});
test('delivery reservation prevents retries, including uncertain outcomes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ghost-local-test-'));const s=createStore(dir);
 s.reserveDelivery('one',2);assert.throws(()=>s.reserveDelivery('one',2),/重复/);s.finishDelivery('one','uncertain');assert.throws(()=>s.reserveDelivery('one',2),/重复/);
 s.reserveDelivery('two',2);assert.throws(()=>s.reserveDelivery('three',2),/上限/);assert.equal(s.deliveryCount(),2);s.close();fs.rmSync(dir,{recursive:true,force:true});
});
test('filter does not confuse unknown salary with zero and supports company exclusions',()=>{
 assert.equal(filterJob({title:'开发',salary:'面议'}, {...defaults,minSalary:20000}),null);
 assert.equal(filterJob({title:'销售工程师'},defaults).status,'不合适');
 assert.equal(filterJob({title:'开发',salary:'10-15K'}, {...defaults,minSalary:20000}).reason,'薪资范围不匹配');
 assert.equal(filterJob({title:'开发',company:'外包测试有限公司'}, {...defaults,excludedCompanies:'外包'}).status,'不合适');
});
test('malformed model output cannot become a successful match',()=>{
 assert.throws(()=>parseAnalysis('{"suitable":"yes","score":99,"reason":"ok"}'));
 assert.throws(()=>parseAnalysis('unable to analyze'));
 assert.equal(parseAnalysis('```json\n{"suitable":true,"score":120,"reason":"test"}\n```').score,100);
 assert.throws(()=>aiUrl('http://remote.example','models'),/HTTPS/);
 assert.equal(aiUrl('http://localhost:11434/v1/','models').href,'http://localhost:11434/v1/models');
});
test('AI adapter handles a real local HTTP exchange and applies minimum score',async()=>{
 let received;const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;received=JSON.parse(raw);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'{"suitable":true,"score":70,"reason":"经验部分匹配"}'}}]}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const r=await analyze({title:'Python开发',description:'测试岗位描述'}, {...defaults,aiBase:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'fake',resume:'测试简历',minScore:80});assert.equal(r.status,'不合适');assert.equal(r.score,70);assert.equal(received.model,'deepseek-chat');assert.ok(received.messages[1].content.includes('测试简历'));}finally{await new Promise(r=>server.close(r));}
});
