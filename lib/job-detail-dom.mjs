// Runs in a BOSS job detail page. Only visible dedicated JD nodes contribute to
// description; page text, recommendation cards and company introductions do not.
export function jobDetailDOM() {
  const visible = element => {
    if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    const rect = element.getBoundingClientRect();
    if (!rect.height || !rect.width) return false;
    if (typeof getComputedStyle === 'function') {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  };
  const text = element => String(element?.innerText || '').trim();
  const firstLine = value => String(value || '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
  const all = selector => [...document.querySelectorAll(selector)].filter(visible);
  const fail = (message, code) => { throw Object.assign(Error(message), {code}); };
  let page;
  try { page = new URL(location.href); } catch {}
  const route = page?.pathname || '';
  if (/^\/(?:web\/passport\/(?:[^/]+\/)?|web\/|)(?:security|verify|captcha)(?:[/.]|$)/i.test(route)) fail('岗位页面要求安全验证，请手动完成后继续', 'VERIFICATION_REQUIRED');
  if (/^\/(?:web\/)?(?:passport|login)(?:[/.]|$)/i.test(route)) fail('岗位页面要求登录，请登录后继续', 'AUTH_REQUIRED');
  const barriers = all('[role="dialog"],.dialog-wrap,.dialog-container,.login-dialog,.login-page,.login-wrap,.verify-dialog,.captcha-dialog,.geetest_panel');
  for (const element of barriers) {
    const body = text(element);
    if (/安全验证|请完成验证|拖动滑块|滑动验证|点击验证|人机验证/.test(body) ||
        ['verify-dialog', 'captcha-dialog', 'geetest_panel'].some(name => element.classList.contains(name)))
      fail('岗位页面要求安全验证，请手动完成后继续', 'VERIFICATION_REQUIRED');
    if (/访问过于频繁|操作过于频繁|请求过于频繁/.test(body)) fail('岗位页面提示访问频繁，请稍后重试', 'RATE_LIMITED');
    if (/扫码登录|密码登录|验证码登录|账号登录|登录后查看|请先登录/.test(body) || element.classList.contains('login-page'))
      fail('岗位页面要求登录，请登录后继续', 'AUTH_REQUIRED');
  }
  const canonical = (value, kind) => {
    try {
      const url = new URL(value, page?.href);
      const path = kind === 'job' ? /^\/job_detail\/[^/]+\.html$/ : /^\/gongsi(?:_detail)?\/[^/]+\.html$/;
      if (url.protocol !== 'https:' || !['www.zhipin.com', 'zhipin.com'].includes(url.hostname) ||
          url.username || url.password || url.port || !path.test(url.pathname)) return '';
      url.search = ''; url.hash = ''; return url.href;
    } catch { return ''; }
  };
  const detailUrl = page ? canonical(page.href, 'job') : '';
  const result = {description: '', title: '', hrName: '', company: '', companyUrl: '', hrActivity: '',
    detailSource: 'job-detail-dom', detailUrl};
  if (!detailUrl) return result;

  const unrelatedClasses = new Set(['recommend-job','recommend-jobs','job-recommend','job-recommendation','recommend-list','recommend-wrap','recommend-box',
    'similar-jobs','related-jobs','job-list','job-list-box','job-card','job-card-wrap','job-card-wrapper',
    'welfare','job-welfare','benefits','benefit-list','salary-benefits']);
  const companyClasses = new Set(['job-company','company-info','company-profile','company-intro','company-introduction','company-description','company-business',
    'company-detail','business-info','business-detail','brand-intro','brand-info','gongsi-info']);
  const hasExcludedClass = (element, includeCompany = true) => String(element.className || '').split(/\s+/)
    .some(name => unrelatedClasses.has(name) || includeCompany && companyClasses.has(name));
  const excludedAncestor = (element, includeCompany = true) => {
    for (let node = element; node && node !== document.body; node = node.parentElement)
      if (hasExcludedClass(node, includeCompany)) return true;
    return false;
  };
  const headingLike = element => /^(?:H[1-6])$/.test(element.tagName) ||
    ['section-title','job-sec-title','job-detail-title','title'].some(name => element.classList.contains(name));
  const excludedHeading = value => /^(?:公司(?:简介|介绍|概况|信息|福利)|关于(?:我们|公司)|企业(?:简介|介绍|概况)|工商信息|基本信息|福利待遇|薪资福利|职位福利|岗位福利|福利|推荐(?:岗位|职位)|相似(?:岗位|职位)|猜你喜欢|热门(?:岗位|职位)|其他(?:岗位|职位))/.test(value.trim());
  const nearbyHeading = element => {
    for (let current = element; current && current !== document.body; current = current.parentElement) {
      if (current !== element && (/^(?:SECTION|ARTICLE|MAIN)$/.test(current.tagName) ||
          ['job-detail', 'job-detail-section', 'job-sec'].some(name => current.classList.contains(name)))) break;
      for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (!visible(sibling)) continue;
        if (headingLike(sibling)) return firstLine(text(sibling));
        const headings = [...sibling.querySelectorAll('h2,h3,h4,.section-title,.job-sec-title,.job-detail-title')].filter(visible);
        if (headings.length) return firstLine(text(headings.at(-1)));
      }
    }
    return '';
  };
  const block = /^(?:DIV|P|LI|UL|OL|SECTION|ARTICLE|H[1-6])$/;
  const jdText = element => {
    const walk = node => {
      if (node.nodeType === 3) return node.nodeValue || '';
      if (node.nodeType !== 1 || hasExcludedClass(node)) return '';
      if (node.tagName === 'BR') return node.hidden ? '' : '\n';
      if (!visible(node)) return '';
      let blocked = false, body = '';
      for (const child of node.childNodes) {
        if (child.nodeType === 1 && visible(child) && headingLike(child)) blocked = excludedHeading(firstLine(text(child)));
        if (!blocked) body += walk(child);
      }
      return block.test(node.tagName) ? '\n' + body + '\n' : body;
    };
    return walk(element).split(/\r?\n/).map(line => line.replace(/[\t \u00a0]+/g, ' ').trim()).filter(Boolean).join('\n');
  };
  const chunks = [], accepted = [];
  for (const element of all('.job-sec-text,.job-detail-section .text,.job-detail .text')) {
    if (excludedAncestor(element) || excludedHeading(nearbyHeading(element)) || accepted.some(parent => parent.contains(element))) continue;
    const content = jdText(element);
    if (!content) continue;
    const normalized = content.replace(/\s+/g, '');
    if (!chunks.some(chunk => chunk.replace(/\s+/g, '') === normalized)) chunks.push(content);
    accepted.push(element);
  }
  result.description = chunks.join('\n\n');
  const first = (selector, includeCompany = true) => all(selector).find(element => !excludedAncestor(element, includeCompany) && text(element));
  result.title = firstLine(text(first('.job-name h1,.name h1')))
    .replace(/\s+\d+(?:\.\d+)?\s*[-–~]\s*\d+(?:\.\d+)?\s*(?:[Kk]|万)(?:[·・]\d+薪)?\s*$/, '');
  const activity = /(?:刚刚|今日|今天|3日内|三日内|本周|2周内|本月|近期|很久未)活跃|当前在线|在线/;
  const recruiter = first('.boss-info,.job-boss-info');
  result.hrActivity = text(recruiter).match(activity)?.[0] || '';
  result.hrName = firstLine(text(first('.boss-info .name,.job-boss-info .name')))
    .replace(/(?:\s|[·•|])*(?:(?:刚刚|今日|今天|3日内|三日内|本周|2周内|本月|近期|很久未)活跃|当前在线|在线)\s*$/, '').trim();
  // Chat identity uses the recruiting brand, not a registration label or the
  // legal entity in 工商信息. Never search a bare global .company-name.
  const companyScopes = new Set(['job-company', 'company-info', 'boss-info', 'job-boss-info']);
  const businessClasses = new Set(['business-info', 'business-detail', 'business-info-box', 'company-business',
    'company-register', 'registration-info', 'register-info', 'legal-info', 'gongsi-info', 'company-intro',
    'company-introduction', 'company-description', 'company-profile', 'company-detail']);
  const fieldLabel = /^(?:公司名称|企业名称|企业全称|公司全称|注册名称|工商名称|法定代表人|注册资本|成立日期|成立时间|经营状态|统一社会信用代码)[：:]?$/;
  const brandName = element => {
    let raw = text(element);
    if (element.classList.contains('boss-info-attr')) {
      const parts=[];let divider=false;
      for(const child of element.childNodes){
        if(child.nodeType===1&&(child.classList.contains('vdot')||child.classList.contains('vline'))){divider=true;break;}
        if(child.nodeType===3)parts.push(child.nodeValue||'');
        else if(child.nodeType===1&&visible(child))parts.push(text(child));
      }
      if(!divider)return '';
      raw=parts.join('');
    }
    const name = firstLine(raw).replace(/\s+/g, ' ');
    return !name || fieldLabel.test(name) || /^(?:公司名称|企业名称|公司全称|企业全称|注册名称|工商名称)[：:]/.test(name) ||
      /^(?:公司|企业|公司信息|公司主页|企业主页|查看公司|公司详情|查看详情|了解更多|工商信息|注册信息|招聘者|招聘负责人|人事|HR)$/i.test(name) ? '' : name;
  };
  const companyScope = element => {
    for (let current = element; current; current = current.parentElement)
      if (String(current.className || '').split(/\s+/).some(name => companyScopes.has(name))) return current;
    return null;
  };
  const brandEligible = element => {
    if (!visible(element) || excludedAncestor(element, false) || element.querySelector('.job-title,.badge')) return false;
    const scope = companyScope(element);
    if (!scope) return false;
    for (let current = element; current && current !== document.body; current = current.parentElement) {
      if (String(current.className || '').split(/\s+/).some(name => businessClasses.has(name) || ['job-name','job-sec-text','job-title','badge'].includes(name))) return false;
      if ((current === scope || /^(?:SECTION|ARTICLE)$/.test(current.tagName) || current.classList.contains('job-sec') || current.classList.contains('job-detail-section')) &&
          [...current.children].some(child => visible(child) && headingLike(child) && /^(?:工商信息|注册信息|企业注册|登记信息|工商资料)/.test(firstLine(text(child))))) return false;
    }
    // A value beside a registration field label is still a legal-name field,
    // even when the site calls that value .name or omits the business class.
    for (let current = element.parentElement; current; current = current.parentElement) {
      if ([...current.children].some(sibling => sibling !== element && visible(sibling) && fieldLabel.test(text(sibling).replace(/\s+/g,'')))) return false;
      if (current === scope) break;
    }
    return !!scope;
  };
  const companyLink = '.job-company a[href*="/gongsi/"],.job-company a[href*="/gongsi_detail/"]';
  const recruiterLink = '.boss-info a[href*="/gongsi/"],.job-boss-info a[href*="/gongsi/"],.boss-info a[href*="/gongsi_detail/"],.job-boss-info a[href*="/gongsi_detail/"]';
  const groups = [
    all('.company-info > a[ka="job-detail-company_custompage"][href*="/gongsi/"]').filter(anchor => canonical(anchor.href, 'company')),
    all(companyLink).filter(anchor => canonical(anchor.href, 'company')),
    all(recruiterLink).filter(anchor => canonical(anchor.href, 'company')),
    all('.boss-info .company-name,.job-boss-info .company-name,.boss-info .boss-company,.job-boss-info .boss-company,.boss-info .brand-name,.job-boss-info .brand-name,.boss-info .boss-info-attr,.job-boss-info .boss-info-attr'),
    all('.job-company .brand-name,.job-company .company-name,.job-company .name'),
    all('.company-info .brand-name,.company-info .company-name,.company-info .name')
  ];
  let selectedCompany;
  for (const group of groups) {
    const candidates = group.filter(brandEligible).map(element => ({element, name: brandName(element)})).filter(item => item.name);
    const names = new Set(candidates.map(item => item.name));
    if (!names.size) continue;
    if (names.size === 1) selectedCompany = candidates[0];
    break; // Conflicting brands at one priority cannot be resolved by DOM order.
  }
  if (selectedCompany) {
    result.company = selectedCompany.name;
    const scope = companyScope(selectedCompany.element);
    const links = [selectedCompany.element, ...scope.querySelectorAll('a[href*="/gongsi/"],a[href*="/gongsi_detail/"]')];
    const urls = new Set(links.filter(brandEligible).map(anchor => canonical(anchor.href, 'company')).filter(Boolean));
    if (urls.size === 1) result.companyUrl = [...urls][0];
  }
  return result;
}
