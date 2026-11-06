import {test} from 'node:test';
import assert from 'node:assert/strict';
import {aiServiceReady,officialChatgptAuthUrl,createAIProviderUI,chatgptUsageUrl} from '../public/ai-provider-ui.mjs';

const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const btn=(text,action,style='',icon='',attrs='')=>`<button data-action="${action}" ${attrs}>${text}</button>`;
const field=(label,name,value)=>`<label>${label}<input name="${name}" value="${esc(value)}"></label>`;
function fixture({provider='chatgpt-plan',chatgpt={},model='',storageValues=new Map()}={}){
 const state={settings:{aiProvider:provider,chatgptModel:model,aiBase:'https://api.example.test',aiModel:'api-model',hasApiKey:true},chatgpt};
 const context={state,page:'settings',settingsTab:'ai'},calls=[],toasts=[],writes=[],timers=[],popups=[],events=[];
 let status={connected:false,planEnabled:false,accounts:[],...chatgpt},models=['official-a','official-b'],welcomeCount=0,closed=0;
 const elements=new Map([
  ['[name="aiProvider"]',{value:provider}],['[name="chatgptModel"]',{value:model}],
  ['#api-provider-panel',{hidden:provider!=='api'}],['#chatgpt-provider-panel',{hidden:provider==='api'}],
  ['#chatgpt-account-panel',{innerHTML:''}],['#chatgpt-model-controls',{innerHTML:''}],['#model-list',{innerHTML:''}],
  ['[data-action="ai-models"]',{disabled:false}],['[data-action="ai-test"]',{disabled:false}]
 ]);
 const responses={};
 const api=async(route,payload)=>{calls.push({route,payload});events.push(route);if(responses[route])return responses[route](payload);
  if(route==='chatgpt/status')return status;if(route==='ai/models')return models;if(route==='ai/test')return {message:'fixture'};
  if(route==='chatgpt/start')return {url:'https://auth.openai.com/oauth/authorize?state=fixture'};
  if(route==='chatgpt/select'){status={...status,activeId:payload.id};return {};}
  if(route==='chatgpt/cancel'){status={...status,pending:false};return {};}
  if(route==='chatgpt/signout'){status={connected:false,planEnabled:false,accounts:[],activeId:null};return {};}
  if(route==='settings'){Object.assign(state.settings,payload);return {};}
  assert.fail('Unexpected route '+route);
 };
 const ui=createAIProviderUI({getContext:()=>context,api,esc,btn,field,toast:(...args)=>toasts.push(args),
  getFormValues:()=>({...state.settings,aiProvider:elements.get('[name="aiProvider"]').value,chatgptModel:elements.get('[name="chatgptModel"]').value,apiKey:'typed-api-key'}),
  setSummary:summary=>{state.chatgpt=summary;},showWelcome:()=>{welcomeCount++;return true;},closeWelcome:()=>closed++,
  flushSettings:async()=>{events.push('flush-settings');},
  document:{querySelector:selector=>elements.get(selector)||null},openAuthWindow:()=>{const popup={location:{href:'about:blank'},close(){this.closed=true;}};popups.push(popup);return popup;},
  storage:()=>({getItem:key=>storageValues.get(key),setItem:(key,value)=>{writes.push({key,value});storageValues.set(key,value);}}),
  schedule:(callback,ms)=>{timers.push({callback,ms});return timers.length;},cancel:()=>{}
 });
 return {ui,state,context,calls,elements,toasts,writes,timers,popups,responses,storageValues,events,
  get welcomeCount(){return welcomeCount;},get closed(){return closed;},setStatus:next=>{status=next;},setModels:next=>{models=next;}};
}

test('readiness distinguishes API setup from connected ChatGPT plan permission and a selected model',()=>{
 const api={aiBase:'https://api.example.test',aiModel:'old',hasApiKey:true};assert.equal(aiServiceReady(api),true);
 assert.equal(aiServiceReady({...api,hasApiKey:false}),false);assert.equal(aiServiceReady({...api,hasApiKey:false,aiBase:'http://localhost:11434/v1'}),true);
 const plan={...api,aiProvider:'chatgpt-plan',chatgptModel:'official-a'};
 for(const status of [{},{connected:true},{planEnabled:true},{connected:true,planEnabled:false}])assert.equal(aiServiceReady(plan,status),false);
 assert.equal(aiServiceReady(plan,{connected:true,planEnabled:true}),true);
 assert.equal(aiServiceReady({...plan,chatgptModel:''},{connected:true,planEnabled:true}),false);
 assert.equal(aiServiceReady({...api,aiProvider:'unknown'}),false);
});

test('settings preserve both API and ChatGPT model fields without inventing a default model',()=>{
 const f=fixture(),html=f.ui.fields(f.state.settings);
 assert.match(html,/name="aiProvider"/);assert.match(html,/value="chatgpt-plan" selected/);
 for(const name of ['apiKey','aiModel','aiBase','chatgptModel'])assert.match(html,new RegExp('name="'+name+'"'));
 assert.match(html,/Continue with ChatGPT/);assert.match(html,/授权用途：分析岗位、依据简历事实生成岗位专属招呼/);
 assert.match(html,/仅登录不代表已授权额度/);assert.match(html,/官方限制/);assert.match(html,/https:\/\/chatgpt.com\/settings\/usage/);
 assert.doesNotMatch(html,/gpt-\d|免费无限|typed-api-key/);assert.match(html,/value="">授权后获取可用模型/);
 assert.equal(f.calls.length,0);
});

test('account labels, emails, errors and available model names are escaped',async()=>{
 const f=fixture({chatgpt:{connected:true,planEnabled:true,activeId:'a',error:'<script>bad</script>',accounts:[{id:'a" onfocus="bad',label:'<img src=x>',email:'a<b@example.test',connected:true,planEnabled:true}]}});
 f.setModels(['official-a','<script>model</script>']);await f.ui.mount();const html=f.ui.fields(f.state.settings);
 assert.match(html,/&lt;img src=x&gt;/);assert.match(html,/a&lt;b@example.test/);assert.match(html,/&lt;script&gt;bad/);
 assert.match(html,/&lt;script&gt;model/);assert.doesNotMatch(html,/<script>|<img src=x>| onfocus="bad/);
});

test('unapproved accounts cannot enumerate models or test inference even when an API key exists',async()=>{
 const f=fixture({chatgpt:{connected:true,planEnabled:false,accounts:[]}});await f.ui.mount();
 assert.equal(f.elements.get('[data-action="ai-models"]').disabled,true);assert.equal(f.elements.get('[data-action="ai-test"]').disabled,true);
 await assert.rejects(f.ui.actions['ai-models'](),/授权/);await assert.rejects(f.ui.actions['ai-test'](),/授权/);
 assert.deepEqual(f.calls.map(call=>call.route),['chatgpt/status']);assert.equal(f.welcomeCount,0);
});

test('authorized model loading and explicit test requests exclude all API credentials and configuration',async()=>{
 const f=fixture({model:'official-a',chatgpt:{connected:true,planEnabled:true,activeId:'one'}});await f.ui.mount();
 assert.equal(f.elements.get('[data-action="ai-test"]').disabled,false);await f.ui.actions['ai-test']();
 for(const call of f.calls.filter(call=>call.route.startsWith('ai/')))assert.deepEqual(call.payload,{aiProvider:'chatgpt-plan',chatgptModel:'official-a'});
 f.elements.get('[name="chatgptModel"]').value='invented';await assert.rejects(f.ui.actions['ai-test'](),/可用列表/);
 assert.equal(f.calls.filter(call=>call.route==='ai/test').length,1);
});

test('API mode retains its separate model and typed key, and switching providers does not erase them',async()=>{
 const f=fixture({provider:'api'});await f.ui.mount();assert.equal(f.calls.length,0);
 await f.ui.actions['ai-models']();await f.ui.actions['ai-test']();
 assert.equal(f.calls[0].payload.aiProvider,'api');assert.equal(f.calls[1].payload.aiModel,'api-model');assert.equal(f.calls[1].payload.apiKey,'typed-api-key');
 f.elements.get('[name="aiProvider"]').value='chatgpt-plan';await f.ui.change({name:'aiProvider',value:'chatgpt-plan'});
 assert.equal(f.elements.get('#api-provider-panel').hidden,true);assert.equal(f.elements.get('#chatgpt-provider-panel').hidden,false);
 assert.equal(f.state.settings.aiModel,'api-model');assert.equal(f.state.settings.aiBase,'https://api.example.test');
});

test('official login requires a user action, opens only the returned official URL, and does not auto-test or send tasks',async()=>{
 const f=fixture();assert.equal(f.popups.length,0);await f.ui.actions['chatgpt-start']();
 assert.equal(f.popups.length,1);assert.match(f.popups[0].location.href,/^https:\/\/auth.openai.com\/oauth\/authorize/);
 assert.deepEqual(f.calls.map(call=>call.route),['chatgpt/start','chatgpt/status']);
 for(const url of ['http://auth.openai.com/oauth/authorize','https://auth.openai.com.evil.test/a','https://evil@auth.openai.com/a','javascript:alert(1)','https://auth.openai.com:8443/a'])assert.throws(()=>officialChatgptAuthUrl(url),/官方授权地址/);
 const bad=fixture();bad.responses['chatgpt/start']=()=>({url:'https://example.test/fake-login'});
 await assert.rejects(bad.ui.actions['chatgpt-start'](),/官方授权地址/);assert.equal(bad.popups[0].closed,true);assert.equal(bad.popups[0].location.href,'about:blank');
});

test('first successful plan authorization shows a dismissible welcome and persists only a UI flag',async()=>{
 const f=fixture(),authorized={connected:true,planEnabled:true,activeId:'account-one',accessToken:'must-never-store'};
 f.ui.observeState({connected:true,planEnabled:false});assert.equal(f.welcomeCount,0);
 f.ui.observeState(authorized);f.ui.observeState(authorized);assert.equal(f.welcomeCount,1);assert.equal(f.writes.length,1);
 assert.deepEqual(f.writes[0],{key:'a-border-job.chatgpt-plan-welcome.v1',value:'1'});
 f.ui.actions['chatgpt-welcome-dismiss']();assert.equal(f.closed,1);
 const later=fixture({storageValues:f.storageValues});later.ui.observeState(authorized);assert.equal(later.welcomeCount,0);
 assert.equal(chatgptUsageUrl,'https://chatgpt.com/settings/usage');
});

test('account switching clears the previous selected model and reloads only the new account catalog',async()=>{
 const f=fixture({model:'official-a',chatgpt:{connected:true,planEnabled:true,activeId:'first',accounts:[{id:'first'},{id:'second'}]}});
 await f.ui.mount();f.setModels(['second-model']);await f.ui.change({id:'chatgpt-account',value:'second'});
 assert.equal(f.state.settings.chatgptModel,'');assert.equal(f.state.chatgpt.activeId,'second');
 assert.equal(f.state.settings.aiModel,'api-model');assert.ok(f.calls.some(call=>call.route==='settings'&&call.payload.chatgptModel===''));
 assert.ok(f.events.indexOf('flush-settings')<f.events.indexOf('chatgpt/select'));
 assert.match(f.elements.get('#chatgpt-model-controls').innerHTML,/second-model/);assert.doesNotMatch(f.elements.get('#chatgpt-model-controls').innerHTML,/official-a/);
 assert.equal(f.elements.get('[data-action="ai-test"]').disabled,true);
 await f.ui.actions['chatgpt-signout']();assert.equal(f.state.chatgpt.connected,false);assert.equal(f.elements.get('[data-action="ai-models"]').disabled,true);
});

test('pending authorization is polled without opening duplicate windows or sending inference',async()=>{
 const f=fixture({chatgpt:{connected:false,planEnabled:false,pending:true}});await f.ui.mount();
 assert.equal(f.timers.length,1);assert.equal(f.timers[0].ms,2000);await assert.rejects(f.ui.actions['chatgpt-start'](),/当前官网授权/);
 assert.equal(f.popups.length,0);assert.equal(f.calls.some(call=>call.route==='ai/test'||call.route==='task/start'),false);
});

test('cancel login clears only pending authorization and preserves the existing account and provider settings',async()=>{
 const account={id:'existing',label:'Existing account',connected:true,planEnabled:true};
 const f=fixture({model:'official-a',chatgpt:{connected:true,planEnabled:true,activeId:'existing',accounts:[account],pending:true}});
 await f.ui.mount();
 assert.match(f.ui.fields(f.state.settings),/data-action="chatgpt-cancel"[^>]*>取消登录/);
 const settings=structuredClone(f.state.settings);f.calls.length=0;
 await f.ui.actions['chatgpt-cancel']();
 assert.deepEqual(f.calls,[{route:'chatgpt/cancel',payload:{}},{route:'chatgpt/status',payload:undefined}]);
 assert.equal(f.state.chatgpt.pending,false);assert.equal(f.state.chatgpt.connected,true);assert.equal(f.state.chatgpt.planEnabled,true);
 assert.equal(f.state.chatgpt.activeId,'existing');assert.deepEqual(f.state.chatgpt.accounts,[account]);assert.deepEqual(f.state.settings,settings);
 assert.doesNotMatch(f.ui.fields(f.state.settings),/data-action="chatgpt-cancel"/);assert.equal(f.popups.length,0);
});
