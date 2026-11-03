// Runs in the page. Read identity from the live selected row/header on every
// operation, including in the same synchronous evaluation as a send click.
export function chatDOM({expected, action, text} = {}) {
  const visible = e => e && e.getBoundingClientRect().height > 0;
  const nameOf = e => e?.querySelector('.name,.user-name,.nickname')?.innerText?.trim() || '';
  const idOf = e => e && (e.getAttribute('data-conversation-id') || e.getAttribute('data-uid') || e.getAttribute('data-id') || e.getAttribute('data-geekid')) || '';
  const header = document.querySelector('.chat-info,.chat-header,.conversation-header');
  const list = document.querySelector('.user-list,.chat-user-list,.conversation-list,.chat-list');
  const selected = [...(list?.querySelectorAll('.user-item,.chat-user,.conversation-item,.friend-item,li') || [])]
    .filter(e => visible(e) && (e.classList.contains('active') || e.classList.contains('selected') || e.getAttribute('aria-selected') === 'true'));
  const row = selected.length === 1 ? selected[0] : null;
  const headerId = idOf(header), rowId = idOf(row);
  const contact = nameOf(header) || header?.innerText?.trim().split('\n').filter(Boolean)[0] || '';
  const company = header?.querySelector('.company,.company-name')?.innerText?.trim() || '';
  const rowCompany = row?.querySelector('.company,.company-name')?.innerText?.trim() || '';
  const remoteId = headerId || rowId;
  const root = document.querySelector('.chat-record,.chat-message-list,.message-list,.chat-conversation');
  const fail = error => ({error, contact, messages: []});
  if (!root || !contact) return fail('请在求职浏览器消息页选择一个会话');
  if (!remoteId || (headerId && rowId && headerId !== rowId) ||
      (row && nameOf(row) && nameOf(row) !== contact) || (company && rowCompany && company !== rowCompany))
    return fail('无法确认当前会话身份或页面正在切换，请等待后重新同步；未执行发送');
  const a = document.querySelector('.chat-job a[href*="/job_detail/"],.job-card a[href*="/job_detail/"],.chat-info a[href*="/job_detail/"]');
  const context = {id: remoteId, remoteId, contact, company: company || rowCompany,
    jobUrl: a?.href?.split('?')[0] || '',
    jobTitle: header?.querySelector('.job-name,.job-title')?.innerText?.trim() || row?.querySelector('.job-name,.job-title')?.innerText?.trim() || a?.innerText?.trim() || ''};
  if (expected) {
    if (String(expected.remoteId || expected.id || '') !== remoteId ||
        ['contact','company','jobTitle','jobUrl'].some(k => expected[k] && expected[k] !== context[k]))
      return fail('当前会话已切换或岗位信息不一致，未执行发送');
  }
  let nodes = [...root.querySelectorAll('.message-item')];
  if (!nodes.length) nodes = [...root.querySelectorAll('.chat-item,.message')];
  const counts = {};
  context.messages = nodes.map(e => {
    const role = /(?:^|[\s_-])(myself|self|right|mine)(?:$|[\s_-])/.test(String(e.className)) ? 'assistant' : 'user';
    const content = (e.querySelector('.text,.text-content,.message-text') || e).innerText.trim();
    const key = role + '|' + content; counts[key] = (counts[key] || 0) + 1;
    const time = e.getAttribute('data-time') || e.querySelector('time')?.getAttribute('datetime') || '';
    const card = e.querySelector('.resume-card,.attachment-card,.file-card,[data-type="resume"],[data-type="attachment"],[data-type="file"]');
    const receipt = e.getAttribute('data-status') || e.querySelector('.message-status,.send-status')?.innerText?.trim() || '';
    const failed = /失败|未发送|发送中|pending|failed|sending/i.test(receipt + ' ' + content);
    const confirmed = !failed && /^(sent|delivered|success)$|已发送|发送成功|已送达|等待对方确认|对方已同意|已同意发送/.test(receipt || card?.innerText || '');
    return {role, text: content, remoteId: e.getAttribute('data-mid') || e.getAttribute('data-id') || e.id || key + '|' + (time || counts[key]),
      sourceTime: time, kind: card ? 'attachment' : 'text', deliveryStatus: confirmed ? 'confirmed' : failed ? 'failed' : 'unknown',
      attachmentRequest: !!card && /等待对方|请求/.test(content)};
  }).filter(m => m.text);
  if (!action) return context;
  const input = () => document.querySelector('.chat-input[contenteditable],.chat-input textarea,textarea.input-area,[contenteditable="true"].input-area');
  if (action === 'fill') {
    const el = input(); if (!el) return fail('无法定位消息输入框，请手动复制草稿发送');
    el.focus();
    if ('value' in el) Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, text);
    else el.textContent = text;
    el.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:text}));
    return {ok:true};
  }
  if (action === 'send') {
    const el = input();
    if (!el || ('value' in el ? el.value : el.textContent) !== text) return fail('输入内容已变化，未发送');
    const button = [...document.querySelectorAll('button,.btn-send')].find(e => visible(e) && e.innerText.trim() === '发送' && !e.disabled);
    if (!button) return fail('未找到可用的发送按钮');
    button.click(); return {ok:true};
  }
  if (action === 'attachment') {
    const requested = [...nodes].reverse().find(e => /我想要一份您的附件简历/.test(e.innerText));
    let button = requested && [...requested.querySelectorAll('button,a,span')].find(e => visible(e) && e.innerText.trim() === '同意' && !e.disabled);
    if (button) { button.click(); return {ok:true, type:'accept'}; }
    button = [...document.querySelectorAll('button,a')].find(e => visible(e) && e.innerText.trim() === '发简历' && !e.disabled);
    if (!button) return fail('附件按钮不可用，请在 BOSS 检查已上传的附件简历');
    button.click(); return {ok:true, type:'request'};
  }
  if (action === 'confirm-attachment') {
    const dialog = [...document.querySelectorAll('[role="dialog"],.dialog-container,.dialog-wrap')].find(e => visible(e) && /简历/.test(e.innerText));
    const button = dialog && [...dialog.querySelectorAll('button')].find(e => /^(发送|确定|确认发送)$/.test(e.innerText.trim()) && !e.disabled);
    if (button) { button.click(); return {ok:true, confirmed:true}; }
    return {ok:true, confirmed:false};
  }
  return fail('未知会话操作');
}
