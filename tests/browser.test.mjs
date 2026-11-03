import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Browser,isBossPage} from '../lib/browser.mjs';

test('browser launch waits for the job tab instead of racing its blank startup page',async()=>{
 const browser=new Browser('unused-test-directory');
 browser.owned=async()=>true;
 let polls=0,opened='';
 browser.targets=async()=>++polls<3?[{id:'loading',type:'page',url:'about:blank'}]:[{id:'ready',type:'page',url:'https://www.zhipin.com/web/geek/job'}];
 browser.newTab=async url=>{opened=url;return {id:'loading'};};
 await browser.launch();
 assert.equal(opened,'https://www.zhipin.com/web/geek/job');
 assert.equal(browser.activeTargetId,'ready');
 assert.equal((await browser.target()).id,'ready');
});

test('browser does not treat a URL mentioning zhipin.com as a BOSS page',async()=>{
 assert.equal(isBossPage('https://www.zhipin.com/web/geek/job'),true);
 for(const url of ['about:blank','https://zhipin.com.example.org/','https://example.org/?redirect=zhipin.com','http://www.zhipin.com/'])assert.equal(isBossPage(url),false);
 const browser=new Browser('unused-test-directory');browser.port=12345;browser.activeTargetId='redirected';
 browser.targets=async()=>[{id:'redirected',type:'page',url:'https://example.org/?zhipin.com'}];
 await assert.rejects(browser.target(),/等待 BOSS 直聘页面加载/);
 await assert.rejects(browser.waitForBossPage(1),/页面尚未加载/);
});
