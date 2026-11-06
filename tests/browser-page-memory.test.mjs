import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Browser,rememberBrowserSelection} from '../lib/browser.mjs';

const page=(id,path)=>({id,type:'page',url:path.startsWith('http')?path:'https://www.zhipin.com'+path});
const search=page('search','/web/geek/jobs?query=fixture');
const secondSearch=page('search-two','/web/geek/jobs?query=second');
const chatA=page('chat-a','/web/geek/chat');
const chatB=page('chat-b','/web/geek/chat?view=fixture');
const home=page('home','/');
function fixture(pages=[search,secondSearch,chatA,chatB,home]){
 const calls=[];
 const connection={mode:'existing',generation:1,preferredTargetId:search.id,createdTargets:new Set(),
  connect:async()=>{},session:{connected:true,targets:async()=>pages,
   pageCommand:async(...args)=>{calls.push(args);return {};},
   createTarget:async()=>assert.fail('No tab may be created by page-memory tests')}};
 const clients=[new Browser('unused','jobs',connection),new Browser('unused','company',connection)];
 return {connection,clients,browser:clients[0],calls,pages};
}
async function select(f,selected){
 f.connection.preferredTargetId=selected.id;
 await rememberBrowserSelection(f.clients,selected,f.pages);
}

test('explicit search and chat selections retain separate validated page memories across clients',async()=>{
 const f=fixture();
 for(const client of f.clients){client.activeTargetId='old-active';client.detailTargetId='old-detail';}
 await select(f,search);await select(f,chatB);await select(f,secondSearch);
 for(const client of f.clients){
  assert.equal(client.mainTargetId,secondSearch.id);assert.equal(client.chatTargetId,chatB.id);
  assert.equal(client.activeTargetId,null);assert.equal(client.detailTargetId,null);
 }
 assert.equal(f.calls.length,0);
});

test('launch with a preferred chat preserves a valid search or homepage without inventing a main page',async()=>{
 for(const main of [search,home,null]){
  const f=fixture();f.connection.preferredTargetId=chatB.id;f.browser.mainTargetId=main?.id??null;
  await f.browser.launch();
  assert.equal(f.browser.mainTargetId,main?.id??null);assert.equal(f.browser.activeTargetId,chatB.id);
  assert.equal(f.calls.length,0);
 }
});

test('openChat uses the explicitly remembered chat among multiple chats even while search is preferred',async()=>{
 const f=fixture();await select(f,search);await select(f,chatB);await select(f,search);
 await f.browser.openChat();
 assert.equal(f.browser.chatTargetId,chatB.id);assert.equal(f.browser.activeTargetId,chatB.id);
 assert.equal(f.browser.mainTargetId,search.id);assert.equal(f.connection.preferredTargetId,search.id);
 assert.equal(f.calls.length,0);
});

test('search navigation creates its own search tab without repurposing a preferred chat or unrelated page',async()=>{
 for(const invalidMain of [null,chatB.id,'closed-search']){
  const f=fixture();f.connection.preferredTargetId=chatB.id;f.browser.mainTargetId=invalidMain;
  f.browser.chatTargetId=chatB.id;
  const requested='https://www.zhipin.com/web/geek/jobs?query=next',created=[];
  f.connection.session.createTarget=async url=>{created.push(url);const target={id:'dedicated-search',type:'page',url};f.pages.push(target);return target;};
  f.connection.session.pageCommand=async(id,method,params)=>{f.calls.push([id,method,params]);f.pages.find(target=>target.id===id).url=params.url;return {};};
  await f.browser.navigate(requested);
  assert.deepEqual(created,['about:blank']);assert.equal(f.browser.mainTargetId,'dedicated-search');assert.equal(f.browser.activeTargetId,'dedicated-search');
  assert.deepEqual(f.calls,[['dedicated-search','Page.navigate',{url:requested}]]);assert.equal(f.browser.chatTargetId,chatB.id);
 }
});

test('a new connection generation clears old page memory before recording the current selection',async()=>{
 const f=fixture();await select(f,search);await select(f,chatB);
 for(const client of f.clients){client.activeTargetId=chatB.id;client.detailTargetId='old-detail';}
 f.connection.generation++;
 await select(f,secondSearch);
 for(const client of f.clients){
  assert.equal(client.connectionGeneration,2);assert.equal(client.mainTargetId,secondSearch.id);
  assert.equal(client.chatTargetId,null);assert.equal(client.activeTargetId,null);assert.equal(client.detailTargetId,null);
 }
 assert.equal(f.calls.length,0);
});

test('closed, offsite and wrong-route memories are discarded without choosing a replacement',async()=>{
 const detail=page('detail','/job_detail/fixture.html');
 for(const oldPages of [
  [],
  [page('old-chat','https://example.invalid/web/geek/chat'),page('old-main','https://example.invalid/web/geek/jobs')],
  [page('old-chat','/web/geek/jobs'),page('old-main','/web/geek/chat')],
  [page('old-chat','/web/passport/zp/security.html'),page('old-main','/job_detail/old.html')]
 ]){
  const f=fixture([...oldPages,detail,search,chatA]);
  for(const client of f.clients){client.chatTargetId='old-chat';client.mainTargetId='old-main';}
  await select(f,detail);
  for(const client of f.clients){assert.equal(client.chatTargetId,null);assert.equal(client.mainTargetId,null);}
  assert.equal(f.calls.length,0);
 }
});

test('remembered chat and main pages require exact secure BOSS routes',async()=>{
 const detail=page('detail','/job_detail/fixture.html');
 for(const origin of ['http://www.zhipin.com','https://www.zhipin.com.evil.invalid','https://user:pass@www.zhipin.com','https://www.zhipin.com:8443']){
  const f=fixture([page('old-chat',origin+'/web/geek/chat'),page('old-main',origin+'/web/geek/jobs'),detail]);
  for(const client of f.clients){client.chatTargetId='old-chat';client.mainTargetId='old-main';}
  await select(f,detail);
  for(const client of f.clients){assert.equal(client.chatTargetId,null,origin);assert.equal(client.mainTargetId,null,origin);}
 }
});
