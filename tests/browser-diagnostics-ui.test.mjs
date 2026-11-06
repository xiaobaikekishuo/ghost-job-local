import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createBrowserDiagnosticsAction, browserDiagnosticsInstructions} from '../public/browser-diagnostics-ui.mjs';
import {createWorkspaceUI} from '../public/workspace-ui.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const btn = (text,action,style='',icon='',attrs='') => `<button data-action="${action}" ${attrs}>${text}</button>`;

test('The diagnostics action only posts diagnostics and reports the local saved file without sending or starting a task', async () => {
  const requests=[],modals=[],toasts=[];
  const result={ok:true,path:'C:\\fixture\\diagnostics.json',summary:{pages:1,note:'<img src=x onerror=alert(1)>'}};
  const action=createBrowserDiagnosticsAction({api:async(route,body)=>{requests.push({route,body});return result;},
    modal:(...args)=>modals.push(args),btn,esc,toast:(...args)=>toasts.push(args)});
  assert.equal(await action(),result);
  assert.deepEqual(requests,[{route:'browser/diagnostics',body:{}}]);
  assert.equal(modals.length,1);assert.match(modals[0][1],/本机保存位置/);
  assert.ok(modals[0][1].includes(esc(result.path)));assert.match(modals[0][1],/&lt;img/);
  assert.doesNotMatch(modals[0][1],/<img/);assert.match(modals[0][1],/没有发送 HR 消息，也没有启动任务/);
  assert.match(toasts.at(-1)[0],/保存到本机/);assert.match(toasts.at(-1)[0],/未发送 HR 消息，未启动任务/);
});

test('A diagnostics API failure cannot produce a saved-file dialog or success toast', async () => {
  const modals=[],toasts=[],failure=Error('请先连接浏览器');
  const action=createBrowserDiagnosticsAction({api:async()=>{throw failure;},modal:(...args)=>modals.push(args),btn,esc,toast:text=>toasts.push(text)});
  await assert.rejects(action(),error=>error===failure);
  assert.equal(modals.length,0);assert.ok(toasts.every(text=>!text.includes('已保存')));
});

test('An incomplete diagnostics response never claims that a usable file was saved', async () => {
  for(const result of [{ok:false,path:'fixture.json'},{ok:true,path:''},{ok:true},{path:'fixture.json'}]) {
    let dialogs=0;
    const action=createBrowserDiagnosticsAction({api:async()=>result,modal:()=>dialogs++,btn,esc,toast:()=>{}});
    await assert.rejects(action(),/有效的保存位置/);assert.equal(dialogs,0);
  }
});

test('The existing connection manager exposes diagnostics with the required HR/job-popup instructions', () => {
  const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const start=source.indexOf('function existingBrowserGuide(){'),end=source.indexOf('async function connectExistingBrowser(',start);
  assert.ok(start>=0&&end>start);
  for(const connected of [true,false]) {
    let shown;
    const context={state:{browser:{connected}},modal:(...args)=>{shown=args;},btn,esc,browserDiagnosticsInstructions};
    vm.runInNewContext(source.slice(start,end)+'\nexistingBrowserGuide();',context);
    assert.match(shown[1],/先连接正确的 BOSS 消息页/);assert.match(shown[1],/选中一个 HR/);assert.match(shown[1],/点击“查看职位”/);
    assert.match(shown[1],/保持当前页的职位弹窗打开/);assert.match(shown[1],/再回到本机工作台/);
    assert.match(shown[2],/data-action="browser-diagnostics"/);
    assert.equal(/data-action="browser-diagnostics"[^>]*disabled/.test(shown[2]),!connected);
  }
  assert.match(source,/'browser-diagnostics':createBrowserDiagnosticsAction\(\{api,modal,btn,esc,toast\}\)/);
});

test('The dashboard exposes diagnostics directly with instructions and disables it while disconnected or busy', () => {
  for(const [connected,busy,simulation] of [[true,false,false],[false,false,false],[true,true,false],[true,false,true]]) {
    const state={settings:{},stats:{},task:{busy},replyTask:{busy:false},syncTask:{busy:false},logs:[],
      browser:{connected,mode:'existing'},simulation};
    const ui=createWorkspaceUI({getContext:()=>({state}),icon:()=>'',btn,pill:text=>esc(text),color:()=>'',esc,heading:()=>'',empty:()=>''});
    const html=ui.dashboard();
    if(simulation){assert.doesNotMatch(html,/data-action="browser-diagnostics"/);continue;}
    assert.match(html,/class="browser-tools"[^]*data-action="browser-diagnostics"/);
    assert.match(html,/先连接正确的 BOSS 消息页/);assert.match(html,/保持当前页的职位弹窗打开/);
    assert.match(html,/诊断仅保存本机，不发送 HR 消息，不启动任务/);
    assert.equal(/data-action="browser-diagnostics"[^>]*disabled/.test(html),!connected||busy);
  }
});
