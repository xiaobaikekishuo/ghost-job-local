// Serialized into an existing chat page. No interaction, HTML serialization,
// message text, input values, account storage, or arbitrary URL parameters.
export function browserDiagnosticsDOM() {
  const allowedHost = host => host === 'www.zhipin.com' || host === 'zhipin.com';
  const here = new URL(location.href);
  if (here.protocol !== 'https:' || !allowedHost(here.hostname) || here.username || here.password || here.port)
    return {error:'请选择已打开的 BOSS 消息页后再采集诊断',code:'DIAGNOSTIC_CHAT_REQUIRED'};
  if (/^\/web\/passport\/zp\/security\.html$/.test(here.pathname))
    return {usable:false,state:'verification',error:'BOSS 正在显示安全验证页面，请完成验证后回到消息页',code:'VERIFICATION_REQUIRED'};
  if (/\/(?:login|passport)(?:\/|$)/.test(here.pathname))
    return {usable:false,state:'login',error:'BOSS 正在显示登录页面，请登录后回到消息页',code:'AUTH_REQUIRED'};
  if (!/^\/web\/geek\/chat\/?$/.test(here.pathname))
    return {error:'请选择已打开的 BOSS 消息页后再采集诊断',code:'DIAGNOSTIC_CHAT_REQUIRED'};
  const publicUrl = (value, iframe = false) => {
    try {
      const url = new URL(value, here.origin);
      if (url.protocol !== 'https:' || !allowedHost(url.hostname) || url.username || url.password || url.port) return '';
      const publicPath = /^\/(?:job_detail|gongsi)\/[A-Za-z0-9_-]+\.html\/?$/.test(url.pathname);
      const jobFrame = iframe && /^\/web\/geek\/(?:job|job-detail|jobDetail|job-detail-dialog)\/?$/.test(url.pathname);
      return publicPath || jobFrame ? url.origin + url.pathname : '';
    } catch { return ''; }
  };
  const frameSource = element => {
    const value = element.getAttribute('src');
    const result = {hasSrc:!!value};
    try {
      const url = new URL(value,here.origin);
      if (value && url.origin === here.origin && !url.username && !url.password && /^[A-Za-z0-9/_.%-]{1,240}$/.test(url.pathname)) {
        result.srcPath = url.pathname;
        const queryKeys = [...new Set([...url.searchParams.keys()].filter(key=>['jobId','encryptJobId','encryptedJobId','positionId'].includes(key)))];
        if (queryKeys.length) result.queryKeys = queryKeys;
      }
    } catch {}
    const src = value ? publicUrl(value,true) : '';
    if (src) result.src = src;
    return result;
  };
  const visible = element => {
    if (!element || element.closest?.('[hidden],[aria-hidden="true"]')) return false;
    const box = element.getBoundingClientRect();
    if (!(box.height > 0 && box.width > 0)) return false;
    if (typeof getComputedStyle === 'function') {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    return true;
  };
  const all = (root, selector) => [...root.querySelectorAll(selector)];
  const dialogSelector = '[role="dialog"],.dialog-container,.dialog-wrap,.dialog-layer,.dialog-content,.boss-dialog,.boss-dialog__wrapper,.el-dialog,.el-dialog__wrapper';
  const visibleDialogs = all(document,dialogSelector).filter(visible);
  const dialogTitles = visibleDialogs.flatMap(dialog => all(dialog,'.dialog-title,.title,h1,h2,h3,[role="heading"]'))
    .filter(element=>visible(element)&&!element.closest('.chat-record,.chat-message-list,.message-list,.message-item,.chat-item,.resume,.resume-content'))
    .map(element=>String(element.textContent||'').trim().replace(/\s+/g,' ').slice(0,80));
  // Explicit UI signals only. Never classify from the body or chat messages.
  if (all(document,'.verify-dialog,.security-check,.verify-wrap,.geetest_panel').some(visible) || dialogTitles.some(title=>/^(?:安全验证|请完成验证|拖动滑块|请完成安全验证)$/.test(title)))
    return {usable:false,state:'verification',error:'BOSS 正在显示安全验证，请完成后重新采集',code:'VERIFICATION_REQUIRED'};
  if (dialogTitles.some(title=>/^(?:访问过于频繁|今日沟通次数已达上限|沟通次数已达上限)$/.test(title)))
    return {usable:false,state:'rateLimited',error:'BOSS 提示访问频繁或沟通上限，请稍后重新采集',code:'RATE_LIMITED'};
  if (all(document,'.login-dialog,.login-box,.login-panel,.sign-dialog,.sign-form').some(visible) || dialogTitles.some(title=>/^(?:扫码登录|请先登录|登录已失效|登录已过期)$/.test(title)))
    return {usable:false,state:'login',error:'BOSS 正在显示登录界面，请登录后重新采集',code:'AUTH_REQUIRED'};
  const classes = element => String(element.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0,12).map(value => value.slice(0,60)).join(' ');
  const privateSelector = 'input,textarea,[contenteditable],script,style,.resume,.resume-content,.resume-card,.attachment-card,.file-card,[data-type="resume"],[data-type="attachment"],[data-type="file"],.last-msg,.message,.msg,.message-item,.chat-item,.message-text,.text-content,.chat-record,.chat-message-list,.message-list';
  const controls = /^(?:查看职位|关闭|返回|确定|取消|知道了|发送|继续沟通|立即沟通|[×xX])$/;
  const modalNodes = all(document,'[aria-modal="true"]').filter(visible);
  const overlays = typeof getComputedStyle === 'function' ? all(document,'*').filter(element=>{
    if (!visible(element) || element.closest(privateSelector) || element.closest('header,nav,aside,[role="banner"],[role="navigation"],[role="complementary"]') ||
        element.matches('.chat-conversation,.user-list,.user-list-content,.chat-list') ||
        element.querySelector('.chat-record,.chat-message-list,.message-list,.message-item,.chat-item')) return false;
    const box=element.getBoundingClientRect(),style=getComputedStyle(element);
    return style.position==='fixed' && Number(style.zIndex)>10 && box.width>300 && box.height>200;
  }) : [];
  const extraDialogs = [...new Set([...modalNodes,...overlays])].filter(element=>!visibleDialogs.includes(element));
  const structureOnlyDialogs = new Set(extraDialogs);
  const diagnosticDialogs = [...new Set([...visibleDialogs,...extraDialogs])];
  let remaining = 320;
  const node = (element, depth = 0, section = '', structureOnly = false) => {
    if (!element || remaining-- <= 0 || !visible(element) || element.matches(privateSelector)) return null;
    const tag = element.tagName.toLowerCase();
    const item = {tag,class:classes(element)};
    const attributes = {};
    const role = element.getAttribute('role');
    if (role && /^[a-z-]{1,30}$/.test(role)) item.role = role;
    for (const name of ['aria-selected','aria-expanded','aria-hidden','aria-modal']) {
      const value = element.getAttribute(name);
      if (value === 'true' || value === 'false') attributes[name] = value;
    }
    if (element.hasAttribute('disabled')) attributes.disabled = true;
    const jobId = element.getAttribute('data-job-id');
    if (jobId && /^[A-Za-z0-9_-]{1,128}$/.test(jobId)) attributes['data-job-id'] = jobId;
    const href = tag === 'a' ? publicUrl(element.getAttribute('href')) : '';
    if (href) attributes.href = href;
    if (tag === 'iframe') Object.assign(attributes,frameSource(element));
    if (Object.keys(attributes).length) item.attributes = attributes;
    // Only fixed UI labels and current job-card titles. Link text, generic
    // headings and recruiter names can contain user content and are omitted.
    const isControl = ['button','a'].includes(tag) || role === 'button' || /(?:^|[\s_-])(?:close|btn)(?:[\s_-]|$)/.test(item.class);
    const isJobTitle = section === 'jobCards' && element.matches('.position-name,.job-name,.job-title') && !element.children.length;
    if (!structureOnly && (isControl || isJobTitle)) {
      const label = String(element.textContent || '').trim().replace(/\s+/g,' ');
      if (isJobTitle || controls.test(label)) item.text = label.slice(0,60);
    }
    if (depth < 6 && tag !== 'iframe') {
      const children = [...element.children].slice(0,40).map(child => node(child,depth+1,section,structureOnly)).filter(Boolean);
      if (children.length) item.children = children;
    }
    return item;
  };
  const roots = {
    header: all(document,'.top-info-content,.chat-info,.chat-header,.conversation-header').filter(visible).slice(0,3),
    selectedRows: [],
    jobCards: all(document,'.chat-position-content,.chat-job,.job-card').filter(element => visible(element) && !element.closest('.chat-record,.chat-message-list,.message-list,.message-item,.chat-item')).slice(0,4),
    jobDetails: all(document,'.job-detail,.job-detail-box,.job-detail-container,.job-sec-text').filter(element => visible(element) && !element.closest(privateSelector)).slice(0,4),
    dialogs: diagnosticDialogs.slice(0,8)
  };
  const list = document.querySelector('.user-list,.chat-user-list,.conversation-list,.chat-list');
  const rows = list ? all(list,'.user-item,.chat-user,.conversation-item,.friend-item,li').filter(visible) : [];
  roots.selectedRows = rows.filter(element => element.matches('.active,.selected,[aria-selected="true"]') || element.querySelector('.active,.selected,[aria-selected="true"]')).slice(0,3);
  const scopes = [...new Set(Object.values(roots).flat())];
  const links = new Map(), frames = new Map();
  for (const scope of scopes) {
    for (const element of all(scope,'a[href],iframe[src]')) {
      if (!visible(element) || element.closest(privateSelector)) continue;
      const frame = element.tagName.toLowerCase() === 'iframe';
      const url = publicUrl(element.getAttribute(frame ? 'src' : 'href'),frame);
      if (frame) frames.set(element,{tag:'iframe',class:classes(element),...frameSource(element)});
      else if (url) links.set(url,{tag:'a',class:classes(element),href:url});
    }
  }
  // A site-specific modal may not have a dialog role or a known class yet.
  // Iframe metadata still reveals its same-origin path, never its parameters.
  for (const element of all(document,'iframe[src]')) if (visible(element) && !element.closest(privateSelector))
    frames.set(element,{tag:'iframe',class:classes(element),...frameSource(element)});
  for (const element of all(document,'a[href]')) if (visible(element) && !element.closest(privateSelector)) {
    const href = publicUrl(element.getAttribute('href'));
    if (href) links.set(href,{tag:'a',class:classes(element),href});
  }
  const messageRoots = all(document,'.chat-record,.chat-message-list,.message-list,.chat-conversation');
  const messageRoot = messageRoots.find(visible);
  const messageNodes = messageRoot ? all(messageRoot,'[data-mid],.message-item,.chat-item').filter(visible) : [];
  const messageClasses = new Map(), receiptClasses = new Set();
  for (const element of messageNodes.slice(0,500)) {
    const value = classes(element); messageClasses.set(value,(messageClasses.get(value)||0)+1);
    for (const receipt of all(element,'.message-status,.send-status')) if (visible(receipt)) receiptClasses.add(classes(receipt));
  }
  const selectors = {header:'.top-info-content,.chat-info,.chat-header,.conversation-header',jobCards:'.chat-position-content,.chat-job,.job-card',jobDetails:'.job-detail,.job-detail-box,.job-detail-container,.job-sec-text',dialogs:dialogSelector,frames:'iframe',rows:'.user-list li,.chat-user-list li,.conversation-list li,.chat-list li'};
  const matched = {}, visibleCounts = {};
  for (const [name,selector] of Object.entries(selectors)) {
    const elements = name === 'rows' ? (list ? all(list,'.user-item,.chat-user,.conversation-item,.friend-item,li') : []) :
      name === 'dialogs' ? [...new Set([...all(document,dialogSelector),...all(document,'[aria-modal="true"]'),...overlays])] : all(document,selector);
    matched[name] = elements.length; visibleCounts[name] = elements.filter(visible).length;
  }
  matched.messageRoots = messageRoots.length; visibleCounts.messageRoots = messageRoots.filter(visible).length;
  const loading = document.readyState !== 'complete' || all(document,'[aria-busy="true"],.loading,.loading-wrap,.loading-container').some(visible);
  const title = String(document.title||'').trim();
  const publicFrame = [...frames.values()].some(frame=>frame.src || /^\/web\/frame\/job\/?$/.test(frame.srcPath||''));
  const usable = !!(roots.header.length || roots.jobCards.length || messageNodes.length || roots.jobDetails.length || publicFrame);
  const bodyChildren = document.body?.children?.length || 0;
  const result = {version:2,usable,state:usable?'ready':loading?'loading':bodyChildren===0?'empty':'unrecognized',route:here.pathname,readyState:document.readyState,
    structure:{bodyChildren,bodyElements:document.body?all(document.body,'*').length:0,matched,visible:visibleCounts,loading,
      ...(typeof document.visibilityState==='string'?{visibility:document.visibilityState}:{}),
      ...(['BOSS直聘','BOSS直聘官网','消息 - BOSS直聘','消息-BOSS直聘','BOSS直聘-消息'].includes(title)?{title}:{})},
    counts:{renderedRows:rows.length,selectedRows:roots.selectedRows.length},
    links:[...links.values()].slice(0,40),iframes:[...frames.values()].slice(0,20),
    messages:{count:messageNodes.length,withDataMid:messageNodes.filter(element=>element.hasAttribute('data-mid')).length,
      classes:[...messageClasses].slice(0,30).map(([className,count])=>({class:className,count})),receiptClasses:[...receiptClasses].slice(0,20)}};
  for (const [section,elements] of Object.entries(roots)) result[section] = elements.map(element=>node(element,0,section,section==='dialogs'&&structureOnlyDialogs.has(element))).filter(Boolean);
  result.truncated = remaining <= 0;
  return result;
}
