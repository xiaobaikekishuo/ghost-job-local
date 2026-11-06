import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Browser} from '../lib/browser.mjs';

const requested='https://www.zhipin.com/web/geek/jobs?query=fixture&city=101280600';
const page=(id,url)=>({id,type:'page',url:url.startsWith('http')||url==='about:blank'?url:'https://www.zhipin.com'+url});
const regional=page('regional','/shenzhen/?seoRefer=index');
const chat=page('chat','/web/geek/chat');
const detail=page('detail','/job_detail/fixture.html');
function fixture(pages=[regional,chat,detail]){
 const state={pages:structuredClone(pages),created:[],commands:[],onTargets:()=>{},onCreate:()=>{},onCommand:()=>{},redirect:''};
 const connection={mode:'existing',generation:1,preferredTargetId:pages[0]?.id,createdTargets:new Set(),connect:async()=>{},
  session:{connected:true,targets:async()=>{await state.onTargets();return structuredClone(state.pages);},
   createTarget:async url=>{
    const id='created-'+(state.created.length+1);state.created.push({id,url});await state.onCreate(url);
    state.pages.push(page(id,state.redirect||url));return page(id,url);
   },
   pageCommand:async(id,method,params)=>{
    state.commands.push({id,method,params});
    assert.equal(method,'Page.navigate');const target=state.pages.find(item=>item.id===id);if(target)target.url=params.url;
    await state.onCommand();return {};
   }}};
 const browser=new Browser('unused','jobs',connection);browser.activeTargetId=connection.preferredTargetId;
 return {browser,connection,state};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('final search dispatch refuses a main page that changed roles during command target discovery',async()=>{
 for(const [url,code]of [
  ['/web/geek/chat','SEARCH_TARGET_CHANGED'],['/job_detail/other.html','SEARCH_TARGET_CHANGED'],
  ['/web/passport/zp/security.html','VERIFICATION_REQUIRED'],['/web/passport/login','AUTH_REQUIRED'],
  ['https://example.invalid/','SEARCH_TARGET_CHANGED'],['about:blank','SEARCH_TARGET_CHANGED'],[null,'SEARCH_TARGET_CHANGED']
 ]){
  const f=fixture([page('main','/web/geek/jobs?query=before')]);f.browser.mainTargetId='main';
  const command=f.browser.command.bind(f.browser);
  f.browser.command=async(...args)=>{f.state.onTargets=()=>{f.state.pages=url?[page('main',url)]:[];};return command(...args);};
  await assert.rejects(f.browser.navigate(requested),{code});
  assert.equal(f.state.commands.length,0,url);assert.equal(f.state.created.length,0);
 }
});

test('final search dispatch rechecks task cancellation and connection ownership after target discovery',async()=>{
 for(const mode of ['cancel','generation','disconnected','connection']){
  const f=fixture([page('main','/web/geek/jobs?query=before')]);f.browser.mainTargetId='main';let active=true;
  const command=f.browser.command.bind(f.browser);
  f.browser.command=async(...args)=>{
   f.state.onTargets=()=>{
    if(mode==='cancel')active=false;
    if(mode==='generation')f.connection.generation++;
    if(mode==='disconnected')f.connection.session.connected=false;
    if(mode==='connection')f.browser.connection={...f.connection,generation:2};
   };
   return command(...args);
  };
  await assert.rejects(f.browser.navigate(requested,{active:()=>active}),{code:mode==='cancel'?'CANCELLED':'SEARCH_CONNECTION_CHANGED'});
  assert.equal(f.state.commands.length,0,mode);assert.equal(f.state.created.length,0);
 }
});

test('regional homepage creates a dedicated exact search URL once and subsequent calls reuse it',async()=>{
 const f=fixture();await f.browser.navigate(requested);await f.browser.navigate(requested);
 assert.deepEqual(f.state.created,[{id:'created-1',url:'about:blank'}]);
 assert.deepEqual(f.state.commands,[{id:'created-1',method:'Page.navigate',params:{url:requested}}]);
 assert.equal(f.browser.mainTargetId,'created-1');assert.equal(f.browser.activeTargetId,'created-1');
 assert.equal(f.state.pages.find(item=>item.id==='regional').url,regional.url);
});

test('selected chat and job-detail pages are preserved while search gets its own target',async()=>{
 for(const selected of [chat,detail]){
  const f=fixture([selected,regional]);f.browser.chatTargetId=selected.id==='chat'?'chat':null;
  await f.browser.navigate(requested);
  assert.equal(f.state.created.length,1);assert.equal(f.state.created[0].url,'about:blank');
  assert.deepEqual(f.state.commands,[{id:'created-1',method:'Page.navigate',params:{url:requested}}]);
  assert.equal(f.state.pages.find(item=>item.id===selected.id).url,selected.url);
  assert.equal(f.browser.mainTargetId,'created-1');
 }
});

test('validated main memory wins over invalid preference, and a preferred homepage can host search',async()=>{
 const f=fixture([page('main',requested),page('offsite','https://example.invalid/'),chat]);
 f.connection.preferredTargetId='offsite';f.browser.mainTargetId='main';
 await f.browser.navigate(requested);
 assert.equal(f.browser.mainTargetId,'main');assert.equal(f.browser.activeTargetId,'main');
 assert.equal(f.state.created.length,0);assert.equal(f.state.commands.length,0);
 const g=fixture([page('home','/'),chat]);
 await g.browser.navigate(requested);
 assert.equal(g.state.created.length,0);assert.deepEqual(g.state.commands,[{id:'home',method:'Page.navigate',params:{url:requested}}]);
 assert.equal(g.browser.mainTargetId,'home');
});

test('concurrent search recovery shares exactly one pending target creation',async()=>{
 const f=fixture(),entered=deferred(),release=deferred();
 f.state.onCreate=async()=>{entered.resolve();await release.promise;};
 const first=f.browser.navigate(requested);
 await Promise.race([entered.promise,first.then(()=>assert.fail('Creation must be pending'))]);
 const second=f.browser.navigate(requested);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.state.created.length,1);release.resolve();await Promise.all([first,second]);
 assert.equal(f.state.created.length,1);assert.equal(f.browser.mainTargetId,'created-1');
 assert.ok(f.state.commands.length>=1&&f.state.commands.length<=2);
 for(const command of f.state.commands)assert.deepEqual(command,{id:'created-1',method:'Page.navigate',params:{url:requested}});
});

test('cancellation and generation changes stop discovery, creation and post-command adoption',async()=>{
 for(const phase of ['before','discovery','create','command'])for(const change of ['cancel','generation']){
  if(phase==='before'&&change==='generation')continue;
  const f=fixture(phase==='command'?[page('home','/'),chat]:undefined);let active=true;
  const mutate=()=>{if(change==='cancel')active=false;else f.connection.generation++;};
  if(phase==='before')mutate();
  if(phase==='discovery'){let once=true;f.state.onTargets=()=>{if(once){once=false;mutate();}};}
  if(phase==='create')f.state.onCreate=mutate;
  if(phase==='command')f.state.onCommand=mutate;
  await assert.rejects(f.browser.navigate(requested,{active:()=>active}),{code:change==='cancel'?'CANCELLED':'SEARCH_CONNECTION_CHANGED'});
  assert.equal(f.state.created.length,phase==='create'?1:0,phase+' '+change);
  assert.equal(f.state.commands.length,phase==='command'?1:0,phase+' '+change);
  assert.notEqual(f.browser.mainTargetId,'created-1');assert.notEqual(f.browser.activeTargetId,'created-1');
 }
});

test('known preferred, main, chat and active login or verification barriers block new search tabs',async()=>{
 for(const slot of ['preferred','main','chat','active'])for(const [route,code] of [
  ['/web/passport/zp/security.html','VERIFICATION_REQUIRED'],['/web/passport/login','AUTH_REQUIRED']
 ]){
  const f=fixture([regional,page('barrier',route),chat]);
  if(slot==='preferred')f.connection.preferredTargetId='barrier';else f.browser[slot+'TargetId']='barrier';
  await assert.rejects(f.browser.navigate(requested),{code});
  assert.equal(f.state.created.length,0,slot);assert.equal(f.state.commands.length,0,slot);
 }
});

test('newly created targets redirecting to login or verification are never adopted or navigated again',async()=>{
 for(const [route,code] of [['/web/passport/zp/security.html','VERIFICATION_REQUIRED'],['/web/passport/login','AUTH_REQUIRED']]){
  const f=fixture();f.state.redirect=route;
  await assert.rejects(f.browser.navigate(requested),{code});
  assert.equal(f.state.created.length,1);assert.equal(f.state.commands.length,0);
  assert.notEqual(f.browser.mainTargetId,'created-1');assert.notEqual(f.browser.activeTargetId,'created-1');
 }
});

test('launch recovers only validated same-generation main or chat memory after preference disappears',async()=>{
 for(const remembered of ['main','chat'])for(const missing of ['closed','offsite']){
  const f=fixture([page('main',requested),chat,page('extra','/web/geek/jobs?query=other'),
   ...(missing==='offsite'?[page('lost','https://example.invalid/')]:[])]);
  f.connection.preferredTargetId='lost';f.browser[remembered+'TargetId']=remembered;
  await f.browser.launch();assert.equal(f.browser.activeTargetId,remembered);assert.equal(f.state.created.length,0);assert.equal(f.state.commands.length,0);
 }
 for(const changedGeneration of [false,true]){
  const f=fixture([page('main',requested),chat]);f.connection.preferredTargetId='closed';
  if(changedGeneration){f.browser.mainTargetId='main';f.browser.chatTargetId='chat';f.connection.generation++;}
  await assert.rejects(f.browser.launch());assert.equal(f.state.created.length,0);assert.equal(f.state.commands.length,0);
 }
});

test('search-only launch leaves unknown pages and shared preference untouched until navigation creates its own tab',async()=>{
 for(const pages of [[],[chat,page('chat-two','/web/geek/chat')]]){
  const f=fixture(pages);f.connection.preferredTargetId='closed';f.browser.activeTargetId='closed';
  await f.browser.launch({forSearch:true});
  assert.equal(f.browser.activeTargetId,null);assert.equal(f.browser.mainTargetId,null);assert.equal(f.browser.chatTargetId,null);
  assert.equal(f.connection.preferredTargetId,'closed');assert.equal(f.state.created.length,0);assert.equal(f.state.commands.length,0);
  const ordinary=fixture(pages);ordinary.connection.preferredTargetId='closed';
  await assert.rejects(ordinary.browser.launch());assert.equal(ordinary.state.created.length,0);
  await f.browser.navigate(requested);
  assert.equal(f.state.created.length,1);assert.equal(f.browser.mainTargetId,'created-1');
  assert.equal(f.connection.preferredTargetId,'closed');
  assert.deepEqual(f.state.commands,[{id:'created-1',method:'Page.navigate',params:{url:requested}}]);
 }
 const f=fixture([page('known-main',requested),chat]);f.connection.preferredTargetId='closed';f.browser.mainTargetId='known-main';
 await f.browser.launch({forSearch:true});
 assert.equal(f.browser.activeTargetId,'known-main');assert.equal(f.connection.preferredTargetId,'closed');
 assert.equal(f.state.created.length,0);assert.equal(f.state.commands.length,0);
});

test('search-only launch honors stop before or after connect and rejects cancellation or connection change during discovery',async()=>{
 for(const phase of ['before-connect','after-connect','discovery-cancel','discovery-generation']){
  const f=fixture();let active=phase!=='before-connect',connects=0,discoveries=0;
  f.connection.connect=async()=>{connects++;if(phase==='after-connect')active=false;};
  f.state.onTargets=()=>{
   discoveries++;
   if(phase==='discovery-cancel')active=false;
   if(phase==='discovery-generation')f.connection.generation++;
  };
  await assert.rejects(f.browser.launch({forSearch:true,active:()=>active}),
   {code:phase==='discovery-generation'?'SEARCH_CONNECTION_CHANGED':'CANCELLED'});
  assert.equal(connects,phase==='before-connect'?0:1);
  assert.equal(discoveries,phase.startsWith('discovery')?1:0);
  assert.equal(f.state.created.length,0);assert.equal(f.state.commands.length,0);
 }
});

test('search-only launch stops on any explicit BOSS login or verification page even when it is not remembered',async()=>{
 for(const [route,code] of [['/web/passport/zp/security.html','VERIFICATION_REQUIRED'],['/web/passport/login','AUTH_REQUIRED']]){
  const f=fixture([regional,page('unremembered-barrier',route),page('known-main',requested)]);
  f.browser.mainTargetId='known-main';
  assert.notEqual(f.connection.preferredTargetId,'unremembered-barrier');
  await assert.rejects(f.browser.launch({forSearch:true}),{code});
  assert.equal(f.state.created.length,0);assert.equal(f.state.commands.length,0);
  assert.equal(f.connection.preferredTargetId,'regional');
 }
});
