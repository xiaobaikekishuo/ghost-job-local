import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Browser,isBossPage} from '../lib/browser.mjs';

test('browser launch waits for the job tab instead of racing its blank startup page',async()=>{
 const browser=new Browser('unused-test-directory');
 browser.owned=async()=>true;
 let polls=0,opened='';
 browser.targets=async()=>++polls<3?[{id:'loading',type:'page',url:'about:blank'}]:[{id:'ready',type:'page',url:'https://www.zhipin.com/web/geek/jobs'}];
 browser.newTab=async url=>{opened=url;return {id:'loading'};};
 await browser.launch();
 assert.equal(opened,'https://www.zhipin.com/web/geek/jobs');
 assert.equal(browser.activeTargetId,'ready');
 assert.equal((await browser.target()).id,'ready');
});

test('job searches use the current jobs route and retain the requested city and keyword',async()=>{
 const browser=new Browser('unused-test-directory');
 let navigated='';
 browser.navigate=async url=>{navigated=url;};
 browser.readJobs=async options=>{assert.deepEqual(options.expectedSearch,{keyword:'采购 & 供应链',city:'广州'});return {jobs:[{title:'采购'}],blocked:''};};
 await browser.search('采购 & 供应链','广州');
 const url=new URL(navigated);
 assert.equal(url.pathname,'/web/geek/jobs');
 assert.equal(url.searchParams.get('query'),'采购 & 供应链');
 assert.equal(url.searchParams.get('city'),'101280100');
 await assert.rejects(browser.search('采购','不存在的城市'),/暂不支持城市/);
});

test('browser does not treat a URL mentioning zhipin.com as a BOSS page',async()=>{
 assert.equal(isBossPage('https://www.zhipin.com/web/geek/job'),true);
 for(const url of ['about:blank','https://zhipin.com.example.org/','https://example.org/?redirect=zhipin.com','http://www.zhipin.com/'])assert.equal(isBossPage(url),false);
 const browser=new Browser('unused-test-directory');browser.port=12345;browser.activeTargetId='redirected';
 browser.targets=async()=>[{id:'redirected',type:'page',url:'https://example.org/?zhipin.com'}];
 await assert.rejects(browser.target(),/等待 BOSS 直聘页面加载/);
 await assert.rejects(browser.waitForBossPage(1),/页面尚未加载/);
});

test('navigation reports transport failures and unexpected downloads instead of reading the old page',async()=>{
 for(const response of [{errorText:'net::ERR_CONNECTION_RESET'},{isDownload:true}]){
  const browser=new Browser('unused-test-directory');browser.port=1;
  browser.targets=async()=>[{id:'main',type:'page',url:'https://www.zhipin.com/web/geek/jobs'}];
  let commandCount=0;
  browser.command=async(method,params,target)=>{commandCount++;assert.equal(method,'Page.navigate');assert.equal(target.id,'main');return response;};
  await assert.rejects(browser.navigate('https://www.zhipin.com/web/geek/jobs?query=test'),error=>{
   assert.equal(error.code,response.errorText?'NAVIGATION_FAILED':'NAVIGATION_DOWNLOAD');
   if(response.errorText)assert.match(error.message,/ERR_CONNECTION_RESET/);
   return true;
  });
  assert.equal(commandCount,1);
 }
});

test('cancellation before search or during target discovery never navigates',async()=>{
 const before=new Browser('unused-test-directory');
 before.navigate=async()=>assert.fail('Cancelled search navigated');
 await assert.rejects(before.search('采购','广州',{active:()=>false}),{code:'CANCELLED'});
 const during=new Browser('unused-test-directory');during.port=1;
 let active=true;
 during.targets=async()=>{active=false;return [{id:'main',type:'page',url:'https://www.zhipin.com/web/geek/jobs'}];};
 during.command=async()=>assert.fail('Navigation was issued after cancellation');
 await assert.rejects(during.navigate('https://www.zhipin.com/web/geek/jobs?query=test',{active:()=>active}),{code:'CANCELLED'});
});

test('search does not start reading after cancellation during navigation',async()=>{
 const browser=new Browser('unused-test-directory');let active=true;
 browser.navigate=async(url,options)=>{assert.equal(options.active(),true);active=false;};
 browser.readJobs=async()=>assert.fail('Reading started after cancellation');
 await assert.rejects(browser.search('采购','广州',{active:()=>active}),{code:'CANCELLED'});
});
