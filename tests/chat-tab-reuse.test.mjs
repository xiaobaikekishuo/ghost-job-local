import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Browser} from '../lib/browser.mjs';

const chat=id=>({id,type:'page',url:'https://www.zhipin.com/web/geek/chat'});
function fixture(pages,preferred){
 const browser=new Browser('.');
 browser.connection={preferredTargetId:preferred};
 browser.launch=async()=>{};
 browser.targets=async()=>pages;
 browser.newTab=async()=>{assert.fail('Existing chat should not spawn a duplicate blank tab');};
 return browser;
}
test('reuse the unique logged-in chat tab when main tab is a job search',async()=>{
 const browser=fixture([chat('existing'),{id:'search',type:'page',url:'https://www.zhipin.com/web/geek/jobs'}],'search');
 await browser.openChat();assert.equal(browser.chatTargetId,'existing');assert.equal(browser.activeTargetId,'existing');
});
test('honor the selected chat instead of an arbitrary first chat',async()=>{
 const browser=fixture([chat('other'),chat('selected')],'selected');
 await browser.openChat();assert.equal(browser.activeTargetId,'selected');
});
test('do not silently choose between two unselected chat tabs',async()=>{
 const browser=fixture([chat('one'),chat('two')],'search');
 await assert.rejects(browser.openChat(),e=>e.code==='GREETING_TARGET_UNAVAILABLE'&&e.notSent===true);
});
test('discard a stale chat handle that has navigated away',async()=>{
 const browser=fixture([{id:'stale',type:'page',url:'https://www.zhipin.com/web/geek/jobs'},chat('live')],'search');
 browser.chatTargetId='stale';await browser.openChat();assert.equal(browser.activeTargetId,'live');
});
