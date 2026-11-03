import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('HTTP API: CRUD, export, CSRF, demo send guard, resume extraction, restart persistence',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ghost-http-test-')),port=17841,base=`http://127.0.0.1:${port}`;
 let proc;
 const start=()=>new Promise((resolve,reject)=>{proc=spawn(process.execPath,[path.join(root,'server.mjs')],{env:{...process.env,PORT:String(port),GHOST_DATA_DIR:dir},stdio:['ignore','pipe','pipe'],windowsHide:true});const timer=setTimeout(()=>reject(Error('Server startup timeout')),10000);proc.on('error',reject);proc.stdout.on('data',data=>{if(String(data).includes(base)){clearTimeout(timer);resolve();}});proc.on('exit',code=>{clearTimeout(timer);if(code)reject(Error('Server exit '+code));});});
 const req=async(p,b,headers={})=>{const r=await fetch(base+'/api/'+p,b===undefined?{headers}:{method:'POST',headers:{'Content-Type':'application/json','X-Local-App':'ghost-job',...headers},body:JSON.stringify(b)});return {status:r.status,data:await r.json()};};
 try{
 await start();assert.equal((await fetch(base)).status,200);
 assert.equal((await req('state',undefined,{Origin:'https://unrelated.example'})).status,403);
 assert.equal((await fetch(base+'/api/settings',{method:'POST',body:'{}'})).status,403);
 assert.equal((await req('settings',{keywords:'测试开发',resume:'测试简历，仅用于验证',apiKey:'fake-credential'})).status,200);
 assert.equal((await req('state')).data.settings.apiKey,undefined);
 const a=(await req('jobs/save',{title:'本地测试岗位',company:'测试公司',description:'公开测试数据，无个人信息'})).data;
 assert.ok(a.id);assert.equal((await req('jobs')).data[0].status,'待分析');
 await req('demo',{});const demo=(await req('jobs')).data.find(j=>j.demo);assert.equal((await req('jobs/send',{id:demo.id})).status,400);
 assert.equal((await req('state')).data.stats.today,0);
 assert.equal((await req('messages/add',{contact:'测试联系人',text:'测试内容'})).status,200);
 const exported=(await req('export')).data;assert.equal(exported.messages.length,1);assert.equal(exported.jobs.length,4);assert.ok(!JSON.stringify(exported).includes('fake-credential'));
 const pdf='%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n5 0 obj\n<< /Length 49 >>\nstream\nBT /F1 12 Tf 50 700 Td (Test Resume Python) Tj ET\nendstream\nendobj\ntrailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n0\n%%EOF';
 const extracted=await req('resume/pdf',{base64:Buffer.from(pdf).toString('base64')});assert.equal(extracted.status,200,JSON.stringify(extracted));assert.match(extracted.data.text,/Test Resume Python/);
 const done=new Promise(r=>proc.once('exit',r));await req('shutdown',{});await done;await start();assert.equal((await req('state')).data.settings.keywords,'测试开发');assert.equal((await req('jobs')).data.length,4);
 await req('jobs/delete',{ids:[a.id]});assert.equal((await req('jobs')).data.length,3);
 }finally{if(proc?.exitCode===null){const done=new Promise(r=>proc.once('exit',r));try{await req('shutdown',{});}catch{proc.kill();}await done;}const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'ghost-http-test-'));fs.rmSync(resolved,{recursive:true,force:true});}
});
