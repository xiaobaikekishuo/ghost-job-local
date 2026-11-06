export function greetingReviewReason(greeting) {
  if (!greeting || greeting.status !== '草稿') return '';
  if (!Array.isArray(greeting.matches) || !greeting.matches.length ||
      greeting.matches.some(match => !match || typeof match.requirement !== 'string' || !match.requirement.trim() || typeof match.evidence !== 'string' || !match.evidence.trim()))
    return '尚未找到岗位要求与简历的直接匹配证据。请补充资料后重新生成，不会凭空生成或发送专属文案。';
  if (!greeting.generatorVersion || greeting.generatorVersion < 4)
    return '这是旧版招呼草稿。请重新生成，并核对岗位要求和简历依据。';
  if (greeting.reviewRequired)
    return greeting.reviewReason === 'edited' ? '正文经过人工修改，需重新生成并核对匹配依据后发送。' : '这条招呼需要确认。请检查岗位详情和简历后重新生成。';
  return '';
}

export function createGreetingUI({getContext, api, btn, esc, confirmAction, toast, closeModal, reload, openJob}) {
  const job = id => getContext().jobs.find(item => item.id === id);
  const attributes = id => `data-id="${esc(id)}"`;
  function decorate(id) {
    const j = job(id), body = document.querySelector('#modal-content .modal-body');
    if (!j || !body) return;
    const {state} = getContext(), greeting = j.greeting;
    const busy = state.task.busy || state.replyTask.busy || state.syncTask.busy;
    const locked = ['已发送', '待核实', '已有开场'].includes(greeting?.status);
    const review = greetingReviewReason(greeting);
    const source = greeting?.generationModel && ['chatgpt-plan', 'api'].includes(greeting.generationProvider)
      ? `${greeting.generationProvider === 'chatgpt-plan' ? 'ChatGPT 订阅' : 'API 服务'} · ${greeting.generationModel}` : '';
    const controls = attributes(id) + (busy || locked ? ' disabled' : '');
    const sendControls = attributes(id) + (busy || locked || review ? ' disabled' : '');
    const manualControls = attributes(id) + (busy || locked || !greeting?.text?.trim() ? ' disabled' : '');
    const section = document.createElement('section');
    section.className = 'job-greeting-panel';
    section.innerHTML = `<div class="section-label">岗位专属招呼 ${greeting ? `<span class="pill ${greeting.status === '已发送' ? 'green' : greeting.status === '待核实' || review ? 'orange' : 'blue'}">${esc(greeting.manualConfirmed ? '已手动发送' : review ? '待确认' : greeting.status)}</span>` : ''}</div>
      <p class="panel-desc">从岗位要求中选择与你简历相关的 1–2 点，不编造经历。${state.settings.personalizedGreeting ? (state.settings.greetingFallback === false ? '通过证据检查后才会发起沟通。' : '自动任务遇到可恢复的专属招呼问题时，可继续发起平台沟通；不保证 BOSS 默认消息送达。') : '可先生成预览；自动使用需在求职配置中开启。'}</p>
      <p class="panel-desc">手动发送专属招呼（包括带专属招呼的沟通）仍严格检查证据及 HR、岗位对应关系；无法核对时不发送专属文案，也不会自动改用平台沟通。</p>
      <p class="panel-desc">同一会话已有本人开场消息时，不再追加招呼。BOSS 自动发出的固定开场也会计入；专属文案保留在本机。</p>
      ${source ? `<p class="panel-desc">生成来源：${esc(source)}${greeting.edited ? ' · 正文已手动修改' : ' · AI 撰写与事实核对'}</p>` : ''}
      ${greeting?.status === '已有开场' ? `<div class="notice">${esc(greeting.skipReason || '已检测到本人开场消息，已跳过追加招呼。')} 下面是保留的文案，不代表已发送。</div>` : ''}
      ${greeting ? `<label class="field"><span>招呼正文</span><textarea id="job-greeting-text" data-job-id="${esc(id)}" rows="4" maxlength="200" ${locked ? 'readonly' : ''}>${esc(greeting.text)}</textarea><small>${locked ? '此条发送记录只读，避免重复发送。' : '修改后请保存，最多 200 个字符。'}</small></label>
        ${Array.isArray(greeting.matches) && greeting.matches.length ? `<details><summary>${greeting.edited ? '查看生成时依据（正文已手动编辑）' : '查看匹配依据'}</summary>${greeting.matches.map(match => `<p><strong>岗位要求：</strong>${esc(match?.requirement)}<br><strong>简历依据：</strong>${esc(match?.evidence)}</p>`).join('')}</details>` : ''}
        ${review ? `<div class="notice"><strong>招呼待确认</strong><br>${esc(review)}</div>` : greeting.error ? `<div class="notice">${esc(greeting.error)}${greeting.status === '待核实' ? ' 请到 BOSS 核对，系统不会重复发送；不要直接补发。' : ' 招呼仍保留为草稿。先核对 HR、岗位和已有消息；已有本人开场时不要再补发。'}</div>` : ''}` : ''}
      <div class="inline-actions">${btn(greeting ? '重新生成招呼' : '生成岗位招呼', 'generate-greeting', 'soft', 'spark', controls)}
      ${greeting?.status === '草稿' ? btn('保存招呼', 'save-greeting', '', 'check', controls) : ''}
      ${greeting?.text ? btn('复制招呼', 'copy-greeting', '', 'copy', attributes(id)) : ''}
      ${j.status === '已沟通' && greeting?.status === '草稿' ? btn('检查发送对象', 'check-greeting-target', '', 'search', controls) + btn('发送这条招呼', 'send-greeting', 'primary', 'send', sendControls) + btn('我已手动发送', 'confirm-manual-greeting', '', 'check', manualControls) : ''}</div>
      <p class="panel-desc" data-greeting-target-result role="status"></p>
      ${j.status === '已沟通' && greeting?.status === '草稿' ? '<p class="panel-desc">若已在 BOSS 手动发送，请点“我已手动发送”记录，避免再次发送。</p>' : ''}`;
    body.querySelector('.detail-description')?.before(section);
    const send = document.querySelector('#modal-content [data-action="send-job"]');
    if (send) {
      if (['已沟通', '待核实'].includes(j.status)) send.disabled = true;
      else if (state.settings.personalizedGreeting) {
        send.innerHTML = review ? '请先重新生成招呼' : '确认沟通（避免重复招呼）';
        send.disabled = busy || Boolean(review);
        if (review) send.title = review;
      }
    }
  }
  async function saveEditor(id) {
    const editor = document.querySelector('#job-greeting-text');
    if (editor?.dataset.jobId === id && !editor.readOnly) await api('jobs/greeting/save', {id, text: editor.value});
  }
  async function requireReady(id, greeting = job(id)?.greeting) {
    const reason = greetingReviewReason(greeting);
    if (!reason) return;
    await reload(); openJob(id);
    throw Error(reason);
  }
  const actions = {
    'check-greeting-target': async element => {
      const id=element.dataset.id;
      const resultNode=document.querySelector('[data-greeting-target-result]');
      const current=()=>resultNode&&document.querySelector('[data-greeting-target-result]')===resultNode;
      const show=(text,error=false)=>{if(current()){resultNode.textContent=text;resultNode.className=error?'notice':'panel-desc';}};
      element.disabled=true;show('正在核对对应的 HR 与岗位，必要时更新会话列表…');
      try{const result=await api('jobs/greeting/check-target',{id});show(result.reason);if(current())toast(result.reason);}
      catch(error){show(error.message,true);if(current())throw error;}
      finally{element.disabled=false;}
    },
    'confirm-manual-greeting': async element => {
      const id = element.dataset.id;
      await saveEditor(id); await reload(); const j = job(id);
      if (!await confirmAction('确认已手动发送', `${j.title} · ${j.company || '公司待核实'}\n\n${j.greeting.text}\n\n请确认你已在 BOSS 向该岗位 HR 发送以上招呼。这里只更新本地记录，之后不会重复发送。`, '我已发送，记录完成')) return;
      await api('jobs/greeting/confirm-manual', {id, expectedGreetingRevision:j.greeting.revision}); closeModal(); await reload(); openJob(id); toast('已记录手动发送');
    },
    'copy-greeting': async element => {
      const id = element.dataset.id, editor = document.querySelector('#job-greeting-text');
      const text = editor?.dataset.jobId === id ? editor.value : job(id)?.greeting?.text;
      if (!text?.trim()) throw Error('暂无可复制的招呼');
      await navigator.clipboard.writeText(text); toast('招呼已复制，请到 BOSS 核对岗位和 HR 后粘贴；已有开场或发送结果不明时不要补发');
    },
    'generate-greeting': async element => {
      const id = element.dataset.id;
      toast('正在撰写招呼并核对简历依据…');
      const greeting = await api('jobs/greeting', {id, force: true}); await reload(); openJob(id);
      const review = greetingReviewReason(greeting); toast(review || '招呼已生成，请核对岗位要求与简历依据', Boolean(review));
    },
    'save-greeting': async element => {
      await saveEditor(element.dataset.id); await reload(); openJob(element.dataset.id); toast('招呼已保存');
    },
    'send-greeting': async element => {
      const id = element.dataset.id;
      await requireReady(id);
      await saveEditor(id); await reload(); const j = job(id);
      await requireReady(id, j.greeting);
      if (!await confirmAction('确认发送岗位专属招呼', `${j.title} · ${j.company || '公司待核实'}\n\n${j.greeting.text}\n\n这条消息将发送给该岗位对应的 HR。`, '确认发送')) return;
      const result = await api('jobs/greeting/send', {id, expectedGreetingRevision:j.greeting.revision}); closeModal(); await reload(); openJob(id); toast(result.reason, !result.verified && !result.alreadyGreeted);
    },
    'send-job': async element => {
      const id = element.dataset.id, personalized = getContext().state.settings.personalizedGreeting;
      let revision;
      let description = '将在 BOSS 直聘打开岗位并点击“立即沟通”。这会产生真实沟通记录。';
      if (personalized) {
        await requireReady(id);
        await saveEditor(id);
        toast('正在准备该岗位的专属招呼…');
        const greeting = await api('jobs/greeting', {id});
        await requireReady(id, greeting);
        revision = greeting.revision;
        description = `${job(id).title} · ${job(id).company || '公司待核实'}\n\n${greeting.text}\n\n点击“立即沟通”可能先发送 BOSS 的固定开场。核对会话后，已有本人开场就跳过追加；没有开场时才发送以上文案。手动操作不会因专属招呼检查失败而自动回退到平台沟通。`;
      }
      if (!await confirmAction(personalized ? '确认沟通并检查专属招呼' : '确认向此岗位发起沟通', description, '确认沟通')) return;
      const result = await api('jobs/send', {id, expectedPersonalizedGreeting:personalized, expectedGreetingRevision:revision}); closeModal(); await reload(); openJob(id);
      toast(result.reason, !result.verified || result.greetingVerified === false && !result.greetingAlreadyPresent);
    }
  };
  return {decorate, actions};
}
