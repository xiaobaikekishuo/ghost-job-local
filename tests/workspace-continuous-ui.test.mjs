import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceUI} from '../public/workspace-ui.mjs';

function dashboard(task = {}, stats = {}) {
  const state = {
    settings:{autoSend:true,personalizedGreeting:true,greetingFallback:true,resume:'演练简历',
      aiBase:'http://localhost:11434/v1',aiModel:'fixture',keywords:'采购',cities:'广州'},
    task:{phase:'运行中',running:true,...task},stats:{...stats},
    browser:{connected:true,mode:'existing'},replyTask:{},syncTask:{},logs:[],simulation:true
  };
  return createWorkspaceUI({getContext:()=>({state}),icon:()=>'',
    btn:(label,action)=>`<button data-action="${action}">${label}</button>`,
    pill:label=>`<span>${label}</span>`,color:()=>'',esc:value=>String(value??''),
    heading:()=>'',empty:()=>''}).dashboard();
}

test('automatic fallback shows platform-only mode without presenting retained greetings as delivered',()=>{
  const html=dashboard({personalizedPaused:true},{greetingPending:2});
  assert.match(html,/本轮仅平台沟通/);
  assert.match(html,/不保证 BOSS 默认消息送达/);
  assert.match(html,/2 个岗位专属招呼待核对/);
  assert.match(html,/已有开场时不追加，结果不明时不补发/);
  assert.match(html,/data-action="go-pending-greetings"/);
  assert.doesNotMatch(html,/2 个岗位待补招呼/);
});

test('screening-only mode takes precedence over an earlier personalized pause',()=>{
  const html=dashboard({communicationDeferred:true,personalizedPaused:true});
  assert.match(html,/本轮仅筛选/);
  assert.match(html,/本轮暂不发起新的沟通/);
  assert.doesNotMatch(html,/本轮仅平台沟通|后续合适岗位仅发起平台沟通/);
});

test('a stopped fallback task no longer claims it will continue platform contacts',()=>{
  const html=dashboard({personalizedPaused:true,running:false,phase:'已停止'});
  assert.match(html,/任务已结束/);
  assert.match(html,/data-action="start-task"/);
  assert.doesNotMatch(html,/后续合适岗位仅发起平台沟通/);
});

test('a known foreground pause shows the dynamic recovery interval without promising to resend older jobs',()=>{
  for(const remaining of [1,6]){
    const html=dashboard({personalizedPaused:true,personalizedRecoveryReason:'CHAT_NOT_FOREGROUND',
      foregroundRecoveryStatus:'waiting',foregroundRecoveryAttempts:1,foregroundRecoveryJobsLeft:remaining});
    assert.match(html,/等待恢复专属招呼/);
    assert.ok(html.includes(`再遇到 ${remaining} 个新合适岗位`));
    assert.match(html,/本轮已检查 1 \/ 2 次/);
    assert.match(html,/不会补发旧岗位/);
    assert.doesNotMatch(html,/本轮仅平台沟通/);
  }
});

test('an in-flight foreground check explains that it is read-only and still requires recipient verification',()=>{
  const html=dashboard({personalizedPaused:true,personalizedRecoveryReason:'CHAT_NOT_FOREGROUND',
    foregroundRecoveryStatus:'checking',foregroundRecoveryAttempts:2,foregroundRecoveryJobsLeft:0});
  assert.match(html,/正在检查前台状态/);
  assert.match(html,/第 2 \/ 2 次只读前台检查/);
  assert.match(html,/本次检查不会发送消息/);
  assert.match(html,/仍须核对发送对象/);
  assert.doesNotMatch(html,/再遇到 0 个/);
});

test('stopped, screening-only and nonrecoverable states cannot claim a foreground recovery is pending',()=>{
  const recovering={personalizedPaused:true,personalizedRecoveryReason:'CHAT_NOT_FOREGROUND',
    foregroundRecoveryStatus:'waiting',foregroundRecoveryAttempts:1,foregroundRecoveryJobsLeft:2};
  for(const override of [{running:false},{communicationDeferred:true},
    {foregroundRecoveryStatus:'exhausted'},{foregroundRecoveryStatus:'blocked'},
    {personalizedRecoveryReason:null}]){
    const html=dashboard({...recovering,...override});
    assert.doesNotMatch(html,/等待恢复专属招呼|再遇到 2 个新合适岗位/);
  }
});

test('successful foreground recovery restores the mode and keeps its no-backfill explanation visible',()=>{
  const html=dashboard({personalizedPaused:false,personalizedRecoveryReason:null,
    foregroundRecoveryStatus:'recovered',foregroundRecoveryAttempts:1,
    message:'前台检查已通过，仅后续新岗位恢复专属流程，不补发旧岗位。'});
  assert.match(html,/自动沟通模式/);
  assert.match(html,/前台检查已通过/);
  assert.match(html,/不补发旧岗位/);
  assert.doesNotMatch(html,/等待恢复专属招呼|本轮仅平台沟通/);
});
