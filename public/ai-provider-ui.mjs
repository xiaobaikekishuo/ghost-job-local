export const chatgptUsageUrl = 'https://chatgpt.com/settings/usage';
const welcomeKey = 'a-border-job.chatgpt-plan-welcome.v1';

export function aiServiceReady(settings = {}, chatgpt = {}) {
  if (settings.aiProvider === 'chatgpt-plan') return chatgpt.connected === true && chatgpt.planEnabled === true && Boolean(String(settings.chatgptModel || '').trim());
  if (settings.aiProvider && settings.aiProvider !== 'api') return false;
  try {
    const url = new URL(String(settings.aiBase || '').trim());
    return ['http:', 'https:'].includes(url.protocol) && Boolean(String(settings.aiModel || '').trim()) &&
      Boolean(settings.hasApiKey || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch { return false; }
}

export function officialChatgptAuthUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'auth.openai.com' && !url.username && !url.password && !url.port) return url.href;
  } catch { /* Never navigate a login window to an unverified destination. */ }
  throw Error('未取得有效的 OpenAI 官方授权地址，请重试。');
}

export function createAIProviderUI({getContext, api, esc, btn, field, toast,
  getFormValues, setSummary, showWelcome, closeWelcome, flushSettings = async () => {}, document: doc = globalThis.document,
  openAuthWindow = () => { const popup = window.open('about:blank', '_blank'); if (popup) popup.opener = null; return popup; },
  storage = () => globalThis.localStorage, schedule = setTimeout, cancel = clearTimeout}) {
  let status = null, statusRequest = null, modelRequest = null, models = null, modelsAccount = '', timer = null, welcomed = false;
  const $ = selector => doc.querySelector(selector);
  const context = () => getContext();
  const summary = () => status || context().state?.chatgpt || {};
  const provider = () => $('[name="aiProvider"]')?.value || context().state?.settings?.aiProvider || 'api';
  const modelValue = () => $('[name="chatgptModel"]')?.value ?? context().state?.settings?.chatgptModel ?? '';
  const inSettings = () => context().page === 'settings' && context().settingsTab === 'ai';
  const allowed = () => summary().connected === true && summary().planEnabled === true;
  const usage = `<a class="text-btn" href="${chatgptUsageUrl}" target="_blank" rel="noopener noreferrer">Manage usage ↗</a>`;
  const payload = () => {
    const values = getFormValues();
    return provider() === 'chatgpt-plan' ? {aiProvider:'chatgpt-plan',chatgptModel:values.chatgptModel || ''} : {...values,aiProvider:'api'};
  };
  function accountMarkup() {
    const s = summary(), accounts = Array.isArray(s.accounts) ? s.accounts : [];
    const stateLabel = s.pending ? '等待官网授权完成' : allowed() ? '已授权使用 ChatGPT 订阅额度' : s.connected ? '已登录，尚未授权订阅额度' : '尚未连接 ChatGPT';
    return `<div class="chatgpt-status" role="status"><strong>${esc(stateLabel)}</strong>${s.error ? `<p class="notice">${esc(s.error)}</p>` : ''}</div>
      ${accounts.length ? `<label class="field"><span>当前账号</span><select id="chatgpt-account" ${s.pending ? 'disabled' : ''}><option value="">选择账号</option>${accounts.map(account => `<option value="${esc(account.id)}" ${account.id === s.activeId ? 'selected' : ''}>${esc(account.label || account.email || 'ChatGPT 账号')}${account.label && account.email ? ' · ' + esc(account.email) : ''}${account.planEnabled ? ' · 已授权额度' : account.connected ? ' · 仅登录' : ' · 需重新登录'}</option>`).join('')}</select></label>` : ''}
      <div class="inline-actions">${btn('Continue with ChatGPT','chatgpt-start','primary','','type="button" '+(s.pending ? 'disabled' : ''))}${s.pending ? btn('取消登录','chatgpt-cancel','','','type="button"') : ''}${accounts.length ? btn('连接其他账号','chatgpt-add-account','','','type="button" '+(s.pending ? 'disabled' : '')) : ''}${btn('刷新授权状态','chatgpt-status','','refresh','type="button"')}${s.connected || accounts.length ? btn('退出当前账号','chatgpt-signout','','','type="button"') : ''}${usage}</div>
      <p class="panel-desc">在 OpenAI 官网登录，并明确允许本应用使用订阅额度。仅登录不代表已授权额度；可用性以官方返回为准。</p>`;
  }
  function modelMarkup(value = modelValue()) {
    const known = modelsAccount === (summary().activeId || '') && Array.isArray(models) ? models : [];
    const missing = value && !known.includes(value);
    return `<label class="field"><span>ChatGPT 模型</span><select name="chatgptModel" ${!allowed() || !known.length ? 'disabled' : ''}><option value="">${allowed() ? '从官方可用模型中选择' : '授权后获取可用模型'}</option>${missing ? `<option value="${esc(value)}" selected disabled>${esc(value)}（待刷新核实）</option>` : ''}${known.map(name => `<option value="${esc(name)}" ${name === value ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select><small>使用官方返回的模型列表；与 API 模型配置分别保存。</small></label>
      ${allowed() ? `<p class="panel-desc">Using ChatGPT plan · ${usage}</p>` : ''}`;
  }
  function fields(settings) {
    const selected = settings.aiProvider === 'chatgpt-plan' ? 'chatgpt-plan' : 'api';
    return `<label class="field"><span>AI 服务提供方式</span><select name="aiProvider" id="ai-provider"><option value="api" ${selected === 'api' ? 'selected' : ''}>API 服务</option><option value="chatgpt-plan" ${selected === 'chatgpt-plan' ? 'selected' : ''}>ChatGPT 订阅额度</option></select><small>两种方式分别保存配置，使用所选服务处理 AI 请求。</small></label>
      <section id="api-provider-panel" ${selected !== 'api' ? 'hidden' : ''}><div class="form-grid">${field('接口基础地址','aiBase',settings.aiBase,'text','支持兼容 Chat Completions 的接口；本地 Ollama 可留空 API Key。',true)}${field('API Key','apiKey','','password',settings.hasApiKey ? '已保存密钥；留空可保持原值。密钥在本地加密保存。' : '填写服务商提供的 API Key；不会回显到页面。',true)}${field('模型名称','aiModel',settings.aiModel,'text','填写服务商模型名称，或获取模型列表选择。',true)}</div><div class="notice">分析时会将选用的岗位描述和简历发送到此处配置的模型服务。</div><div id="model-list"></div>${settings.hasApiKey ? btn('清除密钥','clear-key','small','','type="button"') : ''}</section>
      <section id="chatgpt-provider-panel" ${selected !== 'chatgpt-plan' ? 'hidden' : ''}><div class="notice">授权用途：分析岗位、依据简历事实生成岗位专属招呼，以及你主动使用的其他 AI 功能。相关内容将发给 OpenAI，并计入你的 ChatGPT 订阅额度。可用额度和模型受账号资格及官方限制影响。</div><div id="chatgpt-account-panel">${accountMarkup()}</div><div id="chatgpt-model-controls">${modelMarkup(settings.chatgptModel || '')}</div></section>
      <div class="inline-actions ai-provider-actions">${btn('获取模型列表','ai-models','','refresh','type="button"')}${btn('测试连接','ai-test','soft','check','type="button"')}</div>`;
  }
  function updateButtons() {
    const isPlan = provider() === 'chatgpt-plan';
    const list = $('[data-action="ai-models"]'), test = $('[data-action="ai-test"]');
    if (list) list.disabled = isPlan && !allowed();
    if (test) test.disabled = isPlan && (!allowed() || !models?.includes(modelValue()));
  }
  function renderStatus() {
    const value = modelValue();
    if ($('#chatgpt-account-panel')) $('#chatgpt-account-panel').innerHTML = accountMarkup();
    if ($('#chatgpt-model-controls')) $('#chatgpt-model-controls').innerHTML = modelMarkup(value);
    updateButtons();
  }
  function welcome() {
    if (!allowed() || welcomed) return;
    try { if (storage()?.getItem(welcomeKey) === '1') { welcomed = true; return; } } catch { /* Storage can be disabled. */ }
    if (showWelcome() === false) return;
    welcomed = true;
    try { storage()?.setItem(welcomeKey, '1'); } catch { /* Only this UI flag is stored. */ }
  }
  function observeState(next) {
    if (!next || typeof next !== 'object') return;
    const previousId = summary().activeId;
    status = {...status,...next,...(!Array.isArray(next.accounts) && status?.accounts ? {accounts:status.accounts} : {})};
    if (status.activeId !== previousId) { models = null; modelsAccount = ''; }
    welcome();
    if (inSettings()) renderStatus();
  }
  async function loadModels({quiet = false} = {}) {
    if (modelRequest) return modelRequest;
    if (provider() === 'chatgpt-plan' && !allowed()) throw Error('请先在官网授权使用 ChatGPT 订阅额度。');
    const body = payload(), account = summary().activeId || '';
    modelRequest = (async () => {
      const result = await api('ai/models',body);
      if (!Array.isArray(result) || result.some(name => typeof name !== 'string')) throw Error('模型列表格式无效，请重试。');
      const list = [...new Set(result.filter(Boolean))];
      if (body.aiProvider === 'chatgpt-plan') {
        if (account !== (summary().activeId || '')) return;
        models = list; modelsAccount = account; renderStatus();
      } else if ($('#model-list')) $('#model-list').innerHTML = `<label class="field"><span>可用模型</span><select id="model-choice"><option value="">选择模型</option>${list.map(name => `<option>${esc(name)}</option>`).join('')}</select></label>`;
      if (!quiet) toast('已获取 '+list.length+' 个模型');
      return list;
    })();
    try { return await modelRequest; } finally { modelRequest = null; }
  }
  async function loadStatus() {
    if (statusRequest) return statusRequest;
    statusRequest = (async () => {
      const next = await api('chatgpt/status');observeState(next);setSummary(next);
      if (timer) { cancel(timer);timer = null; }
      if (next.pending) timer = schedule(() => { timer = null;loadStatus().catch(error => toast(error.message,true)); },2000);
      if (inSettings() && provider() === 'chatgpt-plan' && allowed() && models === null) await loadModels({quiet:true});
      return next;
    })();
    try { return await statusRequest; } finally { statusRequest = null; }
  }
  async function mount() {
    if (!inSettings()) return;
    updateButtons();
    if (provider() === 'chatgpt-plan' && !statusRequest) await loadStatus();
  }
  async function change(element) {
    if (element.name === 'aiProvider') {
      const plan = element.value === 'chatgpt-plan';
      if ($('#api-provider-panel')) $('#api-provider-panel').hidden = plan;
      if ($('#chatgpt-provider-panel')) $('#chatgpt-provider-panel').hidden = !plan;
      updateButtons();if (plan) await loadStatus();
    } else if (element.name === 'chatgptModel') updateButtons();
    else if (element.id === 'chatgpt-account' && element.value) {
      await flushSettings();
      await api('chatgpt/select',{id:element.value});
      models = null;modelsAccount = '';
      await api('settings',{chatgptModel:''});context().state.settings.chatgptModel = '';
      if ($('[name="chatgptModel"]')) $('[name="chatgptModel"]').value = '';
      await loadStatus();toast('已切换账号，请选择该账号可用的模型');
    }
  }
  async function start(existing) {
    if (summary().pending) throw Error('请先完成当前官网授权，或刷新授权状态。');
    const popup = openAuthWindow();if (!popup) throw Error('请允许本地应用打开新窗口，再继续官网授权。');
    try {
      const activeId = existing && summary().activeId;
      const result = await api('chatgpt/start',activeId ? {accountId:activeId} : {});
      popup.location.href = officialChatgptAuthUrl(result.url);
    } catch (error) { popup.close();throw error; }
    toast('请在 OpenAI 官网完成登录，并确认是否允许本应用使用订阅额度。');
    await loadStatus();
  }
  const actions = {
    'ai-models':() => loadModels(),
    'ai-test':async () => {
      if (provider() === 'chatgpt-plan' && (!allowed() || !models?.includes(modelValue()))) throw Error('请完成官网额度授权，并从可用列表选择模型。');
      const result = await api('ai/test',payload());toast('模型响应：'+result.message);
    },
    'chatgpt-status':() => loadStatus(),
    'chatgpt-start':() => start(true),
    'chatgpt-add-account':() => start(false),
    'chatgpt-cancel':async () => { await api('chatgpt/cancel',{});await loadStatus();toast('已取消本次登录'); },
    'chatgpt-signout':async () => { await api('chatgpt/signout',{});models = null;modelsAccount = '';await loadStatus();toast('已退出当前 ChatGPT 账号'); },
    'chatgpt-welcome-dismiss':() => closeWelcome()
  };
  return {fields,actions,change,mount,observeState};
}
