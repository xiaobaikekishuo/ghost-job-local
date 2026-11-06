import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Browser} from '../lib/browser.mjs';
import {BrowserConnection,readBrowserEndpoint} from '../lib/browser-connection.mjs';

const page=(id,url='https://www.zhipin.com/')=>({id,type:'page',url,title:id});
const jobsURL='https://www.zhipin.com/web/geek/jobs?query=test&city=101280100';
function fixture(initial=[page('selected')]){
 const calls=[];
 const session={
  connected:true,pages:[...initial],
  async targets(){calls.push({method:'targets'});return this.pages;},
  async createTarget(url){const target=page('created-'+this.pages.length,url);this.pages.push(target);calls.push({method:'createTarget',url});return target;},
  async call(method,params){calls.push({method,params});return {success:true};},
  async pageCommand(id,method,params){calls.push({id,method,params});return {result:{value:{jobs:[],blocked:'',url:jobsURL,loading:false}}};},
  disconnect(){calls.push({method:'disconnect'});this.connected=false;},
 };
 const connection={
  mode:'existing',session,generation:0,preferredTargetId:null,createdTargets:new Set(),
  async connect(){calls.push({method:'connect'});session.connected=true;},
  disconnect(){session.disconnect();this.generation++;this.preferredTargetId=null;this.createdTargets.clear();},
 };
 const browser=new Browser('unused-test-directory','jobs',connection);
 return {browser,connection,session,calls};
}

test('existing launch uses the approved Chrome and never invokes dedicated startup or opens a tab',async()=>{
 const f=fixture();
 f.browser.owned=async()=>assert.fail('Existing mode entered dedicated startup');
 f.browser.newTab=async()=>assert.fail('Existing launch opened a new tab');
 await f.browser.launch();
 assert.equal(f.connection.preferredTargetId,'selected');
 assert.equal(f.browser.mainTargetId,'selected');
 assert.equal(f.browser.activeTargetId,'selected');
 assert.equal(f.browser.process,null);
 assert.deepEqual(f.calls.map(c=>c.method),['connect','targets']);
});

test('failed existing connection does not fall back to dedicated startup',async()=>{
 const f=fixture();f.session.connected=false;
 const failure=Error('Connection denied');
 f.connection.connect=async()=>{throw failure;};
 f.browser.owned=async()=>assert.fail('Fell back to a dedicated profile');
 f.browser.newTab=async()=>assert.fail('Opened a new tab after connection failure');
 await assert.rejects(f.browser.launch(),e=>e===failure);
 assert.equal(f.browser.process,null);
 assert.equal(f.calls.length,0);
});

test('explicit connection can open BOSS in the approved browser without another profile',async()=>{
 const f=fixture([page('settings','chrome://inspect/#remote-debugging')]);
 const result=await f.browser.openExistingBossPage();
 assert.equal(result.url,'https://www.zhipin.com/');
 assert.ok(f.connection.createdTargets.has(result.id));
 assert.equal(f.browser.process,null);
 assert.equal(f.calls.filter(c=>c.method==='createTarget').length,1);
 f.session.connected=false;
 await assert.rejects(f.browser.openExistingBossPage(),/先允许连接/);
 assert.equal(f.calls.filter(c=>c.method==='createTarget').length,1);
});

test('multiple BOSS pages require an explicit shared preferred target',async()=>{
 const f=fixture([page('first'),page('selected',jobsURL)]);
 await assert.rejects(f.browser.launch(),/多个 BOSS 页面/);
 assert.equal(f.connection.preferredTargetId,null);
 f.connection.preferredTargetId='selected';
 const chat=new Browser('unused-test-directory','chat',f.connection);
 await f.browser.launch();await chat.launch();
 assert.equal(f.browser.mainTargetId,'selected');assert.equal(chat.mainTargetId,'selected');
 assert.equal(f.browser.activeTargetId,'selected');assert.equal(chat.activeTargetId,'selected');
 assert.ok(!f.calls.some(c=>c.method==='createTarget'));
});

test('existing launch with no BOSS page asks for a page instead of opening a new profile',async()=>{
 const f=fixture([page('unrelated','https://example.org/')]);
 f.browser.newTab=async()=>assert.fail('Must not create a BOSS tab in an unselected browser');
 await assert.rejects(f.browser.launch(),/日常 Chrome.*BOSS/);
 assert.equal(f.connection.preferredTargetId,null);
});

test('closed selected page is never replaced by a different BOSS page',async()=>{
 const f=fixture([page('other',jobsURL)]);f.connection.preferredTargetId='closed';
 f.browser.activeTargetId='closed';
 await assert.rejects(f.browser.launch(),/已关闭|不可用/);
 await assert.rejects(f.browser.target(),/不可用/);
 assert.equal(f.connection.preferredTargetId,'closed');
 assert.ok(!f.calls.some(c=>c.method==='Page.navigate'||c.method==='Runtime.evaluate'||c.method==='createTarget'));
});

test('disconnecting an existing browser preserves Chrome and invalidates all role caches',async()=>{
 const f=fixture();
 const connection=new BrowserConnection({mode:'existing',session:f.session,portFile:'unused-port-file'});
 connection.preferredTargetId='selected';connection.createdTargets.add('created');
 const roles=['jobs','chat','company'].map(role=>new Browser('unused-test-directory',role,connection));
 for(const browser of roles){browser.port=9999;browser.activeTargetId='active';browser.mainTargetId='main';browser.chatTargetId='chat';browser.detailTargetId='detail';}
 await roles[0].close();
 assert.deepEqual(f.calls.map(c=>c.method),['disconnect']);
 assert.equal(connection.preferredTargetId,null);assert.equal(connection.createdTargets.size,0);
 for(const browser of roles){browser.syncConnection();assert.equal(browser.port,0);for(const key of ['activeTargetId','mainTargetId','chatTargetId','detailTargetId'])assert.equal(browser[key],null);}
});

test('Browser.close is refused even when requested directly through command',async()=>{
 const f=fixture();
 await assert.rejects(f.browser.command('Browser.close',{},page('selected')),/只能断开连接/);
 assert.equal(f.calls.length,0);
});

test('only app-created targets may be closed in an existing Chrome',async()=>{
 const f=fixture();
 await assert.rejects(f.browser.command('Target.closeTarget',{targetId:'selected'}),/用户原有标签页/);
 assert.equal(f.calls.length,0);
 const created=await f.browser.newTab('about:blank');
 assert.ok(f.connection.createdTargets.has(created.id));
 await f.browser.command('Target.closeTarget',{targetId:created.id},created);
 assert.ok(!f.connection.createdTargets.has(created.id));
 assert.deepEqual(f.calls.filter(c=>c.method==='Target.closeTarget').map(c=>c.params.targetId),[created.id]);
});

test('existing target inventory excludes unrelated tabs and permits only owned helper pages',async()=>{
 const f=fixture([
  page('selected'),page('unrelated','https://example.org/'),page('spoof','https://zhipin.com.example.org/'),
  page('blank-user','about:blank'),page('blank-owned','about:blank'),
  page('bing-user','https://www.bing.com/search?q=user'),page('bing-owned','https://www.bing.com/search?q=company'),
  {id:'worker',type:'service_worker',url:'https://www.zhipin.com/worker.js'},
 ]);
 f.connection.createdTargets.add('blank-owned');f.connection.createdTargets.add('bing-owned');
 assert.deepEqual((await f.browser.targets()).map(t=>t.id),['selected','blank-owned']);
 const company=new Browser('unused-test-directory','company',f.connection);
 assert.deepEqual((await company.targets()).map(t=>t.id),['selected','blank-owned','bing-owned']);
});

test('a target that has moved off-site cannot receive page commands',async()=>{
 const f=fixture([page('selected','https://example.org/')]);
 await assert.rejects(f.browser.command('Runtime.evaluate',{expression:'document.title'},page('selected')),/离开允许的网站/);
 assert.ok(!f.calls.some(c=>c.method==='Runtime.evaluate'));
});

test('navigation keeps the selected existing main page instead of taking another jobs tab',async()=>{
 const f=fixture([page('other',jobsURL),page('selected')]);f.connection.preferredTargetId='selected';f.browser.activeTargetId='selected';
 // A protocol failure stops after target selection without a real navigation or delay.
 f.session.pageCommand=async(id,method,params)=>{f.calls.push({id,method,params});return {errorText:'test-navigation-stop'};};
 await assert.rejects(f.browser.navigate(jobsURL),{code:'NAVIGATION_FAILED'});
 assert.deepEqual(f.calls.filter(c=>c.method==='Page.navigate').map(c=>c.id),['selected']);
 assert.equal(f.browser.mainTargetId,'selected');
});

test('search creates its own target instead of taking another jobs tab when the selected page closed',async()=>{
 const f=fixture([page('other',jobsURL)]);f.connection.preferredTargetId='closed';f.browser.mainTargetId='closed';f.browser.activeTargetId='closed';
 await f.browser.navigate(jobsURL);
 const created=f.calls.filter(c=>c.method==='createTarget');assert.equal(created.length,1);assert.equal(created[0].url,'about:blank');
 assert.ok(f.connection.createdTargets.has(f.browser.mainTargetId));assert.notEqual(f.browser.mainTargetId,'other');
 assert.deepEqual(f.calls.filter(c=>c.method==='Page.navigate').map(c=>c.id),[f.browser.mainTargetId]);
 assert.equal(f.connection.preferredTargetId,'closed');
});

test('manual collection does not silently read another BOSS page after the selection closes',async()=>{
 const f=fixture([page('other',jobsURL)]);f.connection.preferredTargetId='closed';f.browser.activeTargetId='closed';
 await assert.rejects(f.browser.readJobsSnapshot(),/已关闭|不可用/);
 assert.ok(!f.calls.some(c=>c.method==='Runtime.evaluate'));
});

test('browser endpoint reader accepts only a valid local port and browser capability path',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ghost-existing-browser-test-'));
 t.after(()=>{const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'ghost-existing-browser-test-'));fs.rmSync(resolved,{recursive:true,force:true});});
 const file=path.join(dir,'DevToolsActivePort');
 fs.writeFileSync(file,'9222\r\n/devtools/browser/test-browser-id\r\n');
 assert.equal(readBrowserEndpoint(file),'ws://127.0.0.1:9222/devtools/browser/test-browser-id');
 for(const invalid of ['0\n/devtools/browser/id','65536\n/devtools/browser/id','9222\nws://remote.example/devtools/browser/id','9222\n/devtools/page/id','9222\n/devtools/browser/id?secret=value','9222\n/devtools/browser/../id']){
  fs.writeFileSync(file,invalid);assert.throws(()=>readBrowserEndpoint(file),/连接信息无效/);
 }
 assert.throws(()=>readBrowserEndpoint(path.join(dir,'missing')),/remote-debugging/);
});
