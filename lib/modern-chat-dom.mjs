// Runs only against the visible modern chat DOM. This module does not establish
// job ownership: the caller must first verify the public job URL/detail proof.
// expected is a continuity guard for that verified context, never authorization
// on its own. A send click is not a receipt; the caller must verify a fresh one.
export function modernChatDOM({action, expected, text} = {}) {
  const value = text => typeof text === 'string' ? text.trim() : '';
  const visible = element => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    if (!rect.height || !rect.width) return false;
    for (let current = element; current; current = current.parentElement) {
      if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false;
      if (typeof getComputedStyle === 'function') {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      }
    }
    return true;
  };
  const all = (root, selector) => [...root.querySelectorAll(selector)].filter(visible);
  const unique = (root, selector) => { const elements = all(root, selector); return elements.length === 1 ? elements[0] : null; };
  const companyLabels = (root, afterName = false) => {
    if (!root) return [];
    let children = [...root.children];
    if (afterName) {
      const index = children.findIndex(element => element.classList.contains('name-text'));
      if (index < 0) return [];
      children = children.slice(index + 1);
    }
    const divider = children.findIndex(element => element.classList.contains('vline'));
    if (divider >= 0) children = children.slice(0, divider);
    return children.filter(element => element.tagName === 'SPAN' && visible(element) &&
      !element.classList.contains('name-text') && !element.classList.contains('base-title'))
      .map(element => value(element.innerText)).filter(Boolean);
  };
  const fail = (error, code = 'MODERN_CHAT_IDENTITY_UNAVAILABLE') => ({modern: true, error, code, messages: [], anchorIds: [],
    ...['fill', 'send', 'openJob', 'locateJobEntry'].includes(action) ? {notSent: true} : {}});
  // A visible challenge can cover a still-mounted conversation. Check it in
  // this same evaluation before any focus, edit or click, using page chrome
  // only: HR message text and resumes must never act as account restrictions.
  const route = typeof location === 'undefined' ? '' : location.pathname;
  if (/^\/(?:web\/passport\/(?:[^/]+\/)?|web\/|)(?:security|verify|captcha)(?:[/.]|$)/i.test(route))
    return fail('BOSS 要求安全验证，请手动完成后继续', 'VERIFICATION_REQUIRED');
  if (/^\/(?:web\/)?(?:passport|login)(?:[/.]|$)/i.test(route))
    return fail('BOSS 登录已失效，请登录后继续', 'AUTH_REQUIRED');
  const userContent = new Set(['chat-record', 'chat-message-list', 'message-list', 'message-item', 'chat-item',
    'message', 'message-text', 'text-content', 'resume', 'resume-content', 'resume-card']);
  const pageChrome = element => {
    for (let current = element; current; current = current.parentElement) {
      if (['INPUT', 'TEXTAREA'].includes(current.tagName) || current.getAttribute('contenteditable') !== null ||
          String(current.className || '').split(/\s+/).some(name => userContent.has(name))) return false;
    }
    return true;
  };
  if (all(document, '.verify-dialog,.captcha-dialog,.geetest_panel,.geetest_panel_box').some(pageChrome))
    return fail('BOSS 要求安全验证，请手动完成后继续', 'VERIFICATION_REQUIRED');
  if (all(document, '.login-dialog,.login-page,.login-wrap').some(pageChrome))
    return fail('BOSS 登录已失效，请登录后继续', 'AUTH_REQUIRED');
  const dialogs = all(document, '[role="dialog"],[aria-modal="true"],.dialog-wrap,.dialog-container,.dialog-content,.boss-dialog,.boss-dialog__wrapper,.el-dialog');
  const titles = dialogs.filter(pageChrome).flatMap(dialog => all(dialog, '.dialog-title,.title,h1,h2,h3,[role="heading"]'))
    .filter(pageChrome).map(element => value(element.innerText).replace(/\s+/g, '').replace(/[。！!：:]+$/, ''));
  if (titles.some(title => /^(?:安全验证|请完成(?:安全|人机)?验证|请完成安全检查|拖动滑块(?:完成验证)?|滑动验证|点击验证|人机验证)$/.test(title)))
    return fail('BOSS 要求安全验证，请手动完成后继续', 'VERIFICATION_REQUIRED');
  if (titles.some(title => /^(?:请先登录|扫码登录|账号登录|密码登录|验证码登录|登录已失效|登录已过期|登录后查看)$/.test(title)))
    return fail('BOSS 登录已失效，请登录后继续', 'AUTH_REQUIRED');
  if (titles.some(title => /^(?:(?:访问|操作|请求)过于频繁(?:[，,]请稍后(?:再试|重试))?|(?:今日)?(?:沟通|打招呼)(?:次数)?已(?:达|达到)上限)$/.test(title)))
    return fail('BOSS 提示访问频繁或沟通次数上限，请稍后继续', 'RATE_LIMITED');
  const header = unique(document, '.top-info-content');
  const position = unique(document, '.chat-position-content');
  const record = unique(document, '.chat-record');
  const list = unique(document, '.user-list-content');
  if (!header || !position || !record || !list) return fail('现代消息页结构不完整或有多个可见会话，未执行操作');
  const name = unique(header, '.name-content .name-text');
  const base = unique(header, '.base-info');
  const companies = companyLabels(base);
  const jobName = unique(position, '.position-name');
  const contact = value(name?.innerText), company = companies.length === 1 ? companies[0] : '', jobTitle = value(jobName?.innerText);
  if (!contact || !company || !jobTitle) return fail('当前 HR、公司或岗位名称为空或不唯一，未执行操作');

  const rowIdentity = row => {
    const box = unique(row, '.name-box'), name = box && unique(box, '.name-text');
    const companies = companyLabels(box, true);
    return {contact: value(name?.innerText), company: companies.length === 1 ? companies[0] : ''};
  };
  const rows = all(list, 'li[role="listitem"]');
  const marked = element => element.getAttribute('aria-selected') === 'true' ||
    ['active', 'selected', 'is-active'].some(name => element.classList.contains(name));
  const selected = rows.filter(row => marked(row) || all(row, '.friend-content').some(marked));
  if (selected.length !== 1) return fail('未确认唯一选中的 HR 会话，未执行操作');
  const row = rowIdentity(selected[0]);
  if (row.contact !== contact || row.company !== company) return fail('选中行与当前 HR 或公司不一致，页面可能正在切换');
  if (rows.filter(row => { const identity = rowIdentity(row); return identity.contact === contact && identity.company === company; }).length !== 1)
    return fail('可见列表中存在同名同公司的 HR，无法唯一确认会话');

  const messages = [], anchorIds = [], seen = new Map();let ownTextUnknownCount=0;
  for (const element of all(record, '.message-item')) {
    const remoteId = value(element.getAttribute('data-mid'));
    const contents=all(element,'.text-content'),content=contents.length===1?contents[0]:null;
    const body = value(content?.innerText);
    const role = element.classList.contains('item-myself') ? 'assistant' : 'user';
    // Unnumbered or ambiguous own text cannot prove delivery, but its presence
    // must still block another automatic first greeting. Expose only a count.
    if(role==='assistant'&&contents.some(content=>value(content.innerText))&&(!remoteId||!content))ownTextUnknownCount++;
    if (!remoteId) continue;
    const statuses = all(element, '.message-status');
    const statusText = statuses.map(status => value(status.innerText)).join(' ');
    const statusClasses = statuses.map(status => String(status.className)).join(' ');
    const failed = /发送失败|发送错误|未发送|\bfailed\b|\berror\b/i.test(statusText) || /(?:^|[\s_-])(?:failed|error)(?:$|[\s_-])/i.test(statusClasses);
    const pending = /发送中|正在发送|\bpending\b|\bsending\b/i.test(statusText) || /(?:^|[\s_-])(?:pending|sending|loading)(?:$|[\s_-])/i.test(statusClasses);
    const delivered = statuses.some(status => status.classList.contains('status-delivery') || status.classList.contains('status-read')) || /^(?:已读|送达|已送达|发送成功)$/.test(statusText);
    const deliveryStatus = failed ? 'failed' : pending ? 'pending' : role === 'assistant' && delivered ? 'confirmed' : 'unknown';
    const signature = JSON.stringify([role, body, deliveryStatus]);
    if (seen.has(remoteId)) {
      if (seen.get(remoteId) !== signature) return fail('同一消息编号对应不同内容，当前会话回执不可靠');
      continue;
    }
    seen.set(remoteId, signature); anchorIds.push(remoteId);
    if (body) messages.push({remoteId, platformMessageId: true, text: body, role, deliveryStatus});
  }
  // Reading an unseen MID does not prove that it was just sent. A virtualized
  // history view must first prove that its current rendered tail is the latest.
  const chain=[];
  for(let current=record;current;current=current.parentElement)chain.push(current);
  const layout=element=>typeof getComputedStyle==='function'?getComputedStyle(element):{};
  const dimensions=element=>[element.scrollHeight,element.clientHeight,element.scrollTop].every(Number.isFinite)&&
    element.scrollHeight>=element.clientHeight&&element.clientHeight>0&&element.scrollTop>=0;
  const scrollers=chain.filter(element=>/^(?:auto|scroll)$/.test(layout(element).overflowY)&&dimensions(element)&&element.scrollHeight>element.clientHeight);
  const container=scrollers.length===1?scrollers[0]:record;
  const messageContent=element=>{
    for(let current=element;current&&current!==container;current=current.parentElement)
      if(current.getAttribute('contenteditable')!==null||String(current.className||'').split(/\s+/)
        .some(name=>['message-item','chat-item','message-text','text-content','resume','resume-card','resume-content'].includes(name)))return true;
    return false;
  };
  const loading=chain.some(element=>element.getAttribute('aria-busy')==='true')||
    all(container,'.loading,.list-loading,.loading-more,[aria-busy="true"]').some(element=>!messageContent(element));
  let proven=false;
  if(scrollers.length===1){
    proven=!chain.some(element=>/^(?:auto|scroll)$/.test(layout(element).overflowY)&&!dimensions(element))&&
      !chain.slice(chain.indexOf(container)+1).some(element=>/^(?:hidden|clip)$/.test(layout(element).overflowY)&&
        (!dimensions(element)||element.scrollHeight>element.clientHeight));
  }else if(scrollers.length===0&&dimensions(record)&&record.scrollHeight<=record.clientHeight){
    const rect=record.getBoundingClientRect(),viewport=typeof innerHeight==='number'?innerHeight:document.documentElement?.clientHeight;
    // An unscrollable content box alone is not enough if a parent or viewport
    // clips its bottom. Unknown measurements deliberately remain unproven.
    proven=Number.isFinite(viewport)&&viewport>0&&Number.isFinite(rect.top)&&Number.isFinite(rect.bottom)&&rect.top>=0&&rect.bottom<=viewport+2&&
      !chain.some(element=>/^(?:auto|scroll|hidden|clip)$/.test(layout(element).overflowY)&&
        (!dimensions(element)||element.scrollHeight>element.clientHeight));
  }
  const atBottom=proven&&Math.abs(container.scrollHeight-container.clientHeight-container.scrollTop)<=2;
  const signature=proven?JSON.stringify([container.scrollHeight,container.clientHeight,container.scrollTop,anchorIds.at(-1)||'']):'';
  const latestTail={atBottom,loading,signature};
  const context = {modern: true, contact, company, jobTitle, messages, anchorIds, latestTail,...(ownTextUnknownCount?{ownTextUnknownCount}:{})};
  if (!action || action === 'read') return context;
  if (!['fill', 'send', 'openJob', 'locateJobEntry'].includes(action)) return fail('未知现代消息页操作', 'MODERN_CHAT_ACTION_UNAVAILABLE');
  if (!expected || ['contact', 'company', 'jobTitle'].some(key => !value(expected[key]) || expected[key] !== context[key]))
    return fail('当前 HR、公司或岗位与已核对上下文不一致，未执行操作');
  if (!Array.isArray(expected.anchorIds) || !expected.anchorIds.some(id => typeof id === 'string' && value(id) && anchorIds.includes(id)))
    return fail('已核对会话的消息锚点已失效，未执行操作');

  if(['fill','send'].includes(action)&&expected.noExistingOpening===true){
    const own=messages.filter(message=>message.role==='assistant'&&value(message.text));
    const confirmed=own.find(message=>message.platformMessageId===true&&anchorIds.includes(message.remoteId)&&message.deliveryStatus==='confirmed');
    if(confirmed)return {...fail('目标会话已有本人开场，本次未追加发送','GREETING_ALREADY_PRESENT'),alreadyGreeted:true,receiptId:confirmed.remoteId};
    if(own.length||ownTextUnknownCount)return {...fail('目标会话已有本人文本但状态未确认，本次未追加发送','GREETING_PRESENCE_UNCERTAIN'),presenceUnknown:true};
  }

  if(['fill','send'].includes(action)&&expected.requireLatestTail===true){
    if(!latestTail.atBottom||latestTail.loading||!latestTail.signature)
      return fail('尚未确认已到最新消息且加载完成，请先在目标会话查看最新消息；未执行发送','GREETING_TARGET_UNAVAILABLE');
    if(expected.tailSignature!==undefined&&expected.tailSignature!==latestTail.signature)
      return fail('最新消息区域在核对后发生变化，未执行发送','GREETING_TARGET_UNAVAILABLE');
    if(action==='send'&&(!value(expected.tailSignature)||expected.anchorIds.at(-1)!==anchorIds.at(-1)))
      return fail('发送前的最新消息边界不一致或缺少稳定证明，未执行发送','GREETING_TARGET_UNAVAILABLE');
  }

  if (action === 'openJob' || action === 'locateJobEntry') {
    const entry = unique(position, '.position-content[ka="geek_chat_job_detail"]');
    if (!entry) return fail('未找到唯一可见的当前岗位详情入口', 'MODERN_CHAT_ACTION_UNAVAILABLE');
    const labelText = text => value(text).replace(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu, '').trim();
    const controls=all(entry,'.right-content > span').filter(element=>{
      const children=[...element.children];
      // The observed label has one decorative arrow icon. Do not accept nested
      // controls or borrow their text to turn another action into this label.
      if(children.length>1||children.some(child=>child.tagName!=='I'||child.className.trim()!=='iboss-left'||
        child.children.length!==0||labelText(child.textContent)!==''||
        ['role','tabindex','contenteditable','href','onclick'].some(name=>child.getAttribute(name)!==null)))return false;
      const ownText=[...element.childNodes].filter(node=>node.nodeType===3).map(node=>node.textContent).join('');
      return value(ownText)==='查看职位';
    });
    if(controls.length!==1)return fail('当前岗位卡片中没有唯一可见的“查看职位”入口', 'MODERN_CHAT_ACTION_UNAVAILABLE');
    if(action==='locateJobEntry'){
      if(document.visibilityState!=='visible')return {...fail('消息页不在前台，未定位职位入口', 'MODERN_CHAT_ACTION_UNAVAILABLE'),
        ...(document.visibilityState==='hidden'?{reason:'CHAT_NOT_FOREGROUND'}:{})};
      const control=controls[0],rect=control.getBoundingClientRect();
      if(!['left','top','right','bottom','width','height'].every(key=>Number.isFinite(rect[key]))||
        rect.width<=0||rect.height<=0||rect.right<=rect.left||rect.bottom<=rect.top||
        typeof innerWidth!=='number'||typeof innerHeight!=='number'||!Number.isFinite(innerWidth)||!Number.isFinite(innerHeight)||innerWidth<=0||innerHeight<=0)
        return fail('职位入口没有可靠的可见位置，未执行点击', 'MODERN_CHAT_ACTION_UNAVAILABLE');
      const x=rect.left+rect.width/2,y=rect.top+rect.height/2;
      if(x<0||y<0||x>=innerWidth||y>=innerHeight||typeof document.elementFromPoint!=='function')
        return fail('职位入口中心不在可核对的视口内，未执行点击', 'MODERN_CHAT_ACTION_UNAVAILABLE');
      const hit=document.elementFromPoint(x,y);
      if(hit!==control&&![...control.children].some(child=>child===hit&&visible(child)))
        return fail('职位入口被其他元素遮挡，未执行点击', 'MODERN_CHAT_ACTION_UNAVAILABLE');
      return {modern:true,ok:true,x,y,viewport:{width:innerWidth,height:innerHeight}};
    }
    controls[0].click(); return {modern: true, ok: true, openedJob: true};
  }
  const enabled = element => element && !element.disabled && element.getAttribute('disabled') === null &&
    element.getAttribute('aria-disabled') !== 'true' && !element.classList.contains('disabled');
  const input = unique(document, '#chat-input[contenteditable]');
  if (!enabled(input) || input.getAttribute('contenteditable') === 'false') return fail('未找到唯一可编辑的消息输入框', 'MODERN_CHAT_ACTION_UNAVAILABLE');
  if (typeof text !== 'string' || !text.trim()) return fail('招呼内容为空，未执行操作', 'MODERN_CHAT_ACTION_UNAVAILABLE');
  if (action === 'fill') {
    if (String(input.textContent || '').trim() && input.textContent !== text)
      return fail('消息输入框已有其他草稿，请先保存或清空后再发送专属招呼', 'GREETING_TARGET_UNAVAILABLE');
    input.focus(); input.textContent = text;
    input.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: text}));
    return {modern: true, ok: true, filled: true};
  }
  if (input.textContent !== text) return fail('消息输入内容已变化，未执行发送', 'MODERN_CHAT_ACTION_UNAVAILABLE');
  const button = unique(document, 'button[type="send"].btn-send');
  if (!enabled(button)) return fail('未找到唯一可用的发送按钮', 'MODERN_CHAT_ACTION_UNAVAILABLE');
  button.click();
  return {modern: true, ok: true, clicked: true};
}
