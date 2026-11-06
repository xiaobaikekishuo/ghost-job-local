// Presentation layer. Existing API actions and settings field names stay in app.js.
import {browserDiagnosticsInstructions} from './browser-diagnostics-ui.mjs';
import {aiServiceReady} from './ai-provider-ui.mjs';
export function createWorkspaceUI({getContext, icon, btn, pill, color, esc, heading, empty}) {
  let logFilter = '全部', showAllLogs = false;
  const template = html => {
    const element = document.createElement('template');
    element.innerHTML = html;
    return element;
  };
  // Site-specific salary glyphs have no readable value outside the original page font.
  const readableTitle = value => String(value || '').replace(/\s*[\uE000-\uF8FF][\uE000-\uF8FF\dKkWw\-~薪 ]*/g, '').trim();

  function dashboard() {
    const {state} = getContext(), {settings: s, task: task, stats, browser} = state;
    const connected = browser.connected;
    const foregroundRecovery = task.running && task.personalizedPaused &&
      task.personalizedRecoveryReason === 'CHAT_NOT_FOREGROUND' &&
      ['waiting', 'checking'].includes(task.foregroundRecoveryStatus);
    const checkingForeground = foregroundRecovery && task.foregroundRecoveryStatus === 'checking';
    const recoveryJobsLeft = Math.max(0, Number(task.foregroundRecoveryJobsLeft) || 0);
    const recoveryAttempts = Math.max(0, Math.min(2, Number(task.foregroundRecoveryAttempts) || 0));
    const recoveryDescription = checkingForeground
      ? `正在进行第 ${recoveryAttempts} / 2 次只读前台检查，本次检查不会发送消息。通过后仅恢复后续新岗位的专属流程，仍须核对发送对象；不会补发旧岗位。`
      : `专属招呼暂因消息页未在前台而暂停；再遇到 ${recoveryJobsLeft} 个新合适岗位时，只读检查能否恢复（本轮已检查 ${recoveryAttempts} / 2 次）。等待期间仅发起平台沟通，不保证默认消息送达；不会补发旧岗位。`;
    const mainStats = [
      ['briefcase', stats.jobs, '收集岗位', '已整理到本地岗位库'],
      ['send', stats.sent, '累计投递', '已确认沟通的岗位'],
      ['reply', stats.suitable, '合适岗位', '已通过当前筛选条件'],
      ['inbox', stats.received, '收到消息', '已同步的对话消息']
    ];
    const isScreening = log => /岗位|筛选|匹配|合适|投递/.test(log.text);
    const logs = state.logs.filter(log => logFilter === '全部' || (logFilter === '筛选记录' ? isScreening(log) : !isScreening(log)));
    const visibleLogs = showAllLogs ? logs : logs.slice(0, 5);
    const connectAction = state.simulation || browser.mode !== 'existing' ? 'open-browser' : 'connect-existing';
    const aiConfigured = aiServiceReady(s, state.chatgpt);
    const hasResume = Boolean(String(s.resume || '').trim());
    const reminder = !hasResume ? '补充简历，让匹配更准确' : !aiConfigured && (s.aiEnabled || s.resumeMatch || s.personalizedGreeting) ? '配置 AI 服务，开启岗位分析' : '';
    const readiness = [
      [connected, connected ? '浏览器已连接' : '连接浏览器', connectAction],
      [aiConfigured, aiConfigured ? 'AI 已配置' : '配置 AI 服务', 'go-ai-settings'],
      [hasResume, hasResume ? '简历已填写' : '填写简历', 'go-resume']
    ];
    return heading('工作台', '把重复的工作交给工具，把时间留给更好的机会。') + `
      <div class="stats">${mainStats.map(([name, value, title, description]) => `<div class="stat"><div class="stat-icon">${icon(name)}</div><b>${title}</b><strong>${value ?? 0}</strong><small>${description}</small></div>`).join('')}</div>
      <div class="secondary-stats">${[['本次投递', task.sent], ['本次重复', task.duplicates], ['本次跳过', task.skipped], ['自动回复', stats.replied]].map(([label, value]) => `<div class="secondary-stat"><span>${label}</span><strong>${value ?? 0}</strong></div>`).join('')}</div>
      <div class="dashboard-grid">
        <section class="panel assistant-panel"><div class="panel-body">
          <div class="assistant-heading"><h2>求职助手</h2>${pill(task.communicationDeferred ? '本轮仅筛选' : foregroundRecovery ? (checkingForeground ? '正在检查前台状态' : '等待恢复专属招呼') : task.personalizedPaused ? '本轮仅平台沟通' : s.autoSend ? '自动沟通模式' : '筛选与确认模式', task.communicationDeferred || task.personalizedPaused || s.autoSend ? 'orange' : 'blue')}</div>
          <p class="panel-desc">${task.communicationDeferred ? (task.running ? '岗位筛选继续进行，招呼草稿会保存；本轮暂不发起新的沟通。' : '本轮已停止新的沟通；筛选结果和招呼草稿已保存在岗位管理。') : foregroundRecovery ? recoveryDescription : task.personalizedPaused ? (task.running ? '本轮已暂停专属招呼；后续合适岗位仅发起平台沟通，不保证 BOSS 默认消息送达。' : '本轮专属招呼已暂停，任务已结束。请在岗位管理核对沟通记录与保留文案。') : s.autoSend ? '自动沟通已开启：任务会对筛选合适的岗位发起沟通。发起沟通不代表专属招呼已送达。' : '自动沟通未开启：合适岗位仅保存，需在岗位详情确认沟通。'}</p>
          <div class="preferences">
            <div>${icon('search')}<label>岗位关键词</label><strong>${esc(s.keywords || '尚未设置')}</strong><button class="text-btn" data-action="go-settings">编辑条件</button></div>
            <div>${icon('pin')}<label>目标城市</label><strong>${esc(s.cities || '尚未设置')}</strong></div>
          </div>
          <div class="task-summary"><div><span>岗位任务</span>${pill(task.phase, task.running ? 'green' : '')}</div><div><span>自动回复</span>${pill(state.replyTask.phase || '未开启', state.autoReply ? 'green' : '')}</div></div>
          ${stats.greetingPending ? `<div class="attention-note">${icon('message')}<span><strong>${stats.greetingPending} 个岗位专属招呼待核对</strong><br>已发起沟通，专属文案仍保留。先核对已有消息；已有开场时不追加，结果不明时不补发。</span><button class="text-btn" data-action="go-pending-greetings">查看草稿 →</button></div>` : ''}
          ${task.message && (task.communicationDeferred || task.personalizedPaused || task.foregroundRecoveryStatus === 'recovered' || !task.running) ? `<div class="attention-note">${icon('info')}<span>${esc(task.message)}</span></div>` : ''}
          ${task.error && !task.running ? `<div class="attention-note">${icon('warn')}<span>任务已暂停：${esc(task.error)}</span></div>` : ''}
          <div class="assistant-actions">
            ${btn(task.running ? '停止任务' : s.autoSend ? '开始筛选与沟通' : '开始自动筛选', task.running ? 'stop-task' : 'start-task', task.running ? 'danger' : 'primary', task.running ? 'stop' : 'play', !task.running && task.busy ? 'disabled' : '')}
            ${btn(state.replyTask.busy && !state.autoReply ? '正在停止…' : state.autoReply ? '停止自动回复' : '开启自动回复', state.autoReply ? 'stop-reply' : 'start-reply', state.autoReply ? 'danger' : 'outline', 'reply', state.replyTask.busy && !state.autoReply ? 'disabled' : '')}
          </div>
          <div class="readiness-inline" aria-label="准备状态">${readiness.map(([ready, label, action]) => `<button class="ready-item ${ready ? 'is-ready' : 'is-missing'}" data-action="${action}" title="${label}">${icon(ready ? 'check' : 'plus')}<span>${label}</span></button>`).join('')}</div>
          ${reminder ? `<div class="attention-note">${icon('info')}<span>${reminder}</span><button class="text-btn" data-action="${hasResume ? 'go-ai-settings' : 'go-resume'}">前往配置 →</button></div>` : ''}
          <div class="browser-tools">${btn('读取当前页岗位', 'collect', '', 'download', task.busy ? 'disabled' : '')}${btn(connected ? '管理浏览器连接' : '连接浏览器', connected && browser.mode === 'existing' ? 'connect-existing' : connectAction, '', 'globe')}${!state.simulation ? btn('生成页面诊断', 'browser-diagnostics', '', 'file', !connected || task.busy || state.syncTask.busy || state.replyTask.busy ? 'disabled' : '') : ''}</div>
          ${!state.simulation ? `<p class="panel-desc">${esc(browserDiagnosticsInstructions)}诊断仅保存本机，不发送 HR 消息，不启动任务。</p>` : ''}
          <div class="connection-line ${connected ? 'connected' : ''}"><i class="dot"></i><span>${connected ? '浏览器已连接，可读取当前页面或开始筛选。' : '先连接已登录的 BOSS 页面，再开始筛选。'}</span>${connected ? `<button class="text-btn" data-action="close-browser">${browser.mode === 'existing' ? '断开' : '关闭'}</button>` : ''}</div>
        </div></section>
        <section class="panel logs-panel">
          <div class="panel-title"><h2>运行日志</h2><small>共 ${state.logs.length} 条</small><button class="text-btn right" data-action="clear-logs">${icon('trash')}清空</button></div>
          <div class="logs-filters" aria-label="日志分类">${['全部', '筛选记录', '系统消息'].map(filter => `<button class="${logFilter === filter ? 'active' : ''}" data-action="log-filter" data-filter="${filter}" aria-pressed="${logFilter === filter}">${filter}</button>`).join('')}</div>
          <div class="logs">${visibleLogs.length ? visibleLogs.map(log => `<div class="log ${esc(log.level)}"><time>${new Date(log.time).toLocaleTimeString('zh-CN', {hour12: false})}</time>${icon(log.level === 'success' ? 'check' : ['warn', 'error'].includes(log.level) ? 'warn' : 'info')}<span>${esc(readableTitle(log.text))}</span></div>`).join('') : empty('等待新的进展', '任务运行后，相关记录会显示在这里。', 'clock')}</div>
          <div class="logs-footer"><span>${showAllLogs ? `共 ${logs.length} 条记录` : `显示最近 ${Math.min(5, logs.length)} 条记录`}</span>${logs.length > 5 ? `<button class="text-btn" data-action="all-logs">${showAllLogs ? '收起记录 ↑' : '查看全部 →'}</button>` : ''}</div>
        </section>
      </div>
      <div class="setup-note">${icon('message')}<span>历史会话同步 · ${esc(state.syncTask.phase)}${state.syncTask.processed ? ` · 已处理 ${state.syncTask.processed} 个会话` : ''}</span><button data-action="${state.syncTask.running ? 'stop-history' : 'sync-history'}">${state.syncTask.running ? '停止同步' : '同步历史会话'} →</button></div>`;
  }

  function settingsPage(html) {
    const {settingsTab} = getContext(), view = template(html), root = view.content;
    const firstGrid = root.querySelector('#settings-form > .form-grid');
    if (settingsTab === 'search' && firstGrid) {
      root.querySelector('.settings-panel > h2')?.remove();
      root.querySelector('.settings-panel > p')?.remove();
      const fields = [...firstGrid.children], sections = document.createElement('div');
      sections.className = 'settings-sections';
      for (const [title, indices] of [['求职目标', [0, 1]], ['薪资范围', [2, 3]], ['排除规则', [4, 5]], ['补充求职方向', [6]]]) {
        const section = document.createElement('section');
        section.className = 'form-section';
        section.innerHTML = `<h3>${title}</h3><div class="form-grid"></div>`;
        indices.forEach(index => { if (fields[index]) section.lastElementChild.append(fields[index]); });
        sections.append(section);
      }
      firstGrid.replaceWith(sections);
      for (const name of ['excludedWords', 'excludedCompanies']) {
        const textarea = root.querySelector(`[name="${name}"]`);
        if (textarea?.tagName === 'TEXTAREA' && !/[\r\n]/.test(textarea.value)) {
          const input = document.createElement('input');
          input.type = 'text'; input.name = name; input.setAttribute('value', textarea.value);
          input.placeholder = name === 'excludedWords' ? '例如：销售,保险,贷款' : '输入要排除的公司名称';
          textarea.replaceWith(input);
        }
      }
      const keywordHint = root.querySelector('[name="keywords"]')?.closest('.field')?.querySelector('small');
      if (keywordHint) keywordHint.textContent = '多个关键词用逗号分隔。';
      const cityHint = root.querySelector('[name="cities"]')?.closest('.field')?.querySelector('small');
      if (cityHint) cityHint.textContent = '可填写多个城市，用逗号分隔。';
      const directionField = root.querySelector('[name="direction"]');
      if (directionField) {
        directionField.setAttribute('rows', '3');
        directionField.setAttribute('placeholder', '补充你偏好的行业、工作内容与求职要求…');
        const directionHint = directionField.closest('.field').querySelector('small');
        if (directionHint) directionHint.textContent = '写清你的工作偏好，有助于 AI 判断岗位方向。';
      }
      const advancedStart = [...root.querySelectorAll('.section-label')].find(el => el.textContent === '完整筛选条件');
      if (advancedStart) {
        const details = document.createElement('details');
        details.className = 'advanced-settings';
        details.innerHTML = '<summary>更多筛选条件与投递节奏<span>经验、学历、HR 活跃度、任务间隔</span></summary><div class="advanced-content"></div>';
        advancedStart.before(details);
        let current = advancedStart;
        while (current && !current.classList.contains('form-actions')) {
          const next = current.nextElementSibling;
          details.lastElementChild.append(current);
          current = next;
        }
      }
    }
    const save = root.querySelector('.form-actions');
    if (save) {
      const note = save.querySelector('.save-note');
      if (note) { note.textContent = settingsTab === 'search' ? '保存后，下次任务开始时生效' : '配置保存在本机'; save.prepend(note); }
    }
    root.querySelector('.today')?.remove();
    return view.innerHTML;
  }

  function messagesPage(html) {
    const {state} = getContext(), view = template(html), root = view.content;
    const layout = root.querySelector('.messages-layout'), toolbar = root.querySelector('.toolbar');
    const list = root.querySelector('#conversation-list');
    if (!layout || !toolbar || !list) return html;
    const sidebar = document.createElement('aside');
    sidebar.className = 'contacts-pane';
    sidebar.innerHTML = `<div class="contacts-title"><h2>会话</h2>${pill(state.conversations.length)}</div><div class="conversation-filters"></div>`;
    const filtersElement = sidebar.querySelector('.conversation-filters');
    ['conversation-search', 'conversation-filter'].forEach(id => {
      const control = root.querySelector('#' + id);
      control.setAttribute('aria-label', id === 'conversation-search' ? '搜索 HR、公司或岗位' : '筛选会话');
      filtersElement.append(control);
    });
    layout.prepend(sidebar);
    sidebar.append(list);
    const headingActions = root.querySelector('.page-heading .inline-actions');
    const more = document.createElement('details');
    more.className = 'more-menu';
    more.innerHTML = '<summary>更多 ···</summary><div class="more-menu-items"></div>';
    toolbar.querySelectorAll('button').forEach(button => {
      if (button.dataset.action === 'sync-chat') headingActions.append(button);
      else more.lastElementChild.append(button);
    });
    headingActions.append(more);
    toolbar.remove();
    const chat = root.querySelector('.chat-main');
    if (!state.conversations.length) {
      headingActions.querySelector('[data-action="add-message"]')?.remove();
      headingActions.querySelector('[data-action="sync-history"]')?.remove();
      more.querySelectorAll('button').forEach(button => { button.disabled = true; });
      chat.innerHTML = `<div class="chat-header"><strong>历史记录</strong><span class="count-label">你的每次沟通，都有迹可循</span></div><div class="conversation-empty">${empty('导入你的第一段会话', '同步历史会话，或粘贴已有对话。', 'message', `<div class="inline-actions">${btn(state.syncTask.running ? '停止同步' : '同步全部历史', state.syncTask.running ? 'stop-history' : 'sync-history', 'primary', 'refresh')}${btn('粘贴对话', 'add-message', 'outline', 'plus')}</div>`)}</div><div class="conversation-note">${icon('file')}<div><strong>会话保存在本机</strong><p>历史同步逐个读取，停止后可以继续。</p></div></div>`;
    }
    return view.innerHTML;
  }

  function analyticsPage(html) {
    if (getContext().reports.length) return html;
    return heading('求职分析', '保存统计快照，发现下一步的方向。', '<span></span>') + `
      <section class="panel analytics-empty"><div class="panel-title"><div><h2>统计快照</h2><p class="panel-desc">把每一段求职进展，变成下一次行动的依据。</p></div>${pill('暂无快照')}</div>
        ${empty('创建第一份统计快照', '保存当前的统计结果，之后可按需生成 AI 解读。', 'chart', btn('创建统计快照', 'report', 'primary', 'plus'))}
        <div class="snapshot-features">${[['chart', '统计无需 AI Key', '随时记录当前求职进展'], ['file', '创建后数据固定', '保留这一刻的统计结果'], ['spark', 'AI 解读按需生成', '创建快照后，再选择是否解读']].map(([name, title, description]) => `<div class="feature"><span class="feature-icon">${icon(name)}</span><div><h3>${title}</h3><p>${description}</p></div></div>`).join('')}</div>
      </section><div class="setup-note">${icon('info')}<span>小样本的可信区间可能较宽，请结合样本量理解结果。</span><button data-action="show-help">使用指南 →</button></div>`;
  }

  return {dashboard, settingsPage, messagesPage, analyticsPage,
    setLogFilter(filter) { logFilter = filter; showAllLogs = false; },
    toggleAllLogs() { showAllLogs = !showAllLogs; }
  };
}
