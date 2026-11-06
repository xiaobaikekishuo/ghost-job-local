// Page-serialized, visible-DOM-only proof. No frame document, framework state,
// storage, network or message body reads. Actual BOSS markup still needs live
// validation before this adapter can be considered supported.
export function modernJobProofDOM({action='read',expectedJobUrl}={}) {
  const fail=(error,code='GREETING_TARGET_UNAVAILABLE')=>({ok:false,error,code,notSent:true});
  const allowedHost=host=>['www.zhipin.com','zhipin.com'].includes(host);
  let here;try{here=new URL(location.href);}catch{return fail('当前消息页地址不可核对');}
  const safe=url=>url.protocol==='https:'&&allowedHost(url.hostname)&&!url.username&&!url.password&&!url.port;
  if(!safe(here))return fail('当前页面不是可核对的 BOSS 消息页');
  if(here.pathname==='/web/passport/zp/security.html')return fail('BOSS 正在要求安全验证','VERIFICATION_REQUIRED');
  if(/\/(?:login|passport)(?:\/|$)/.test(here.pathname))return fail('BOSS 正在要求登录','AUTH_REQUIRED');
  if(!/^\/web\/geek\/chat\/?$/.test(here.pathname))return fail('请在 BOSS 消息页核对当前岗位');
  if(!['read','close','closed'].includes(action))return fail('不支持的岗位弹窗操作');
  const publicJob=value=>{
    try{
      const url=new URL(value,here.origin),match=/^\/job_detail\/([A-Za-z0-9_-]+)\.html$/.exec(url.pathname);
      return safe(url)&&match?{url,stem:match[1],jobUrl:'https://www.zhipin.com'+url.pathname}:null;
    }catch{return null;}
  };
  const expected=expectedJobUrl?publicJob(expectedJobUrl):null;
  if(expectedJobUrl&&!expected)return fail('目标岗位公开链接无效');
  if(action==='closed'&&!expected)return fail('检查弹窗关闭状态需要完整目标岗位链接');
  const all=(root,selector)=>[...root.querySelectorAll(selector)];
  const visible=element=>{
    if(!element)return false;
    const rect=element.getBoundingClientRect();if(!(rect.width>0&&rect.height>0))return false;
    for(let current=element;current;current=current.parentElement){
      if(current.hidden||current.hasAttribute('hidden')||current.getAttribute('aria-hidden')==='true')return false;
      if(typeof getComputedStyle==='function'){
        const style=getComputedStyle(current);
        if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.opacity==='0')return false;
      }
    }
    return true;
  };
  const excluded='.chat-record,.chat-message-list,.message-list,.message-item,.chat-item,.message,.message-text,.resume,.resume-content,.resume-card,[contenteditable],textarea,input,[class*="recommend"],[class*="related-job"]';
  const eligible=element=>visible(element)&&!element.closest(excluded);
  const dialogSelector='[role="dialog"],[aria-modal="true"],.dialog-container,.dialog-wrap,.dialog-layer,.dialog-content,.boss-dialog,.boss-dialog__wrapper,.el-dialog,.el-dialog__wrapper';
  const dialogCandidates=all(document,dialogSelector).filter(eligible);
  if(typeof getComputedStyle==='function')for(const element of all(document,'*')){
    if(!eligible(element)||element.closest('header,nav,aside,[role="banner"],[role="navigation"],[role="complementary"]')||
       element.matches('.chat-conversation,.user-list,.user-list-content,.chat-list')||element.querySelector('.chat-record,.chat-message-list,.message-list,.message-item'))continue;
    const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
    if(style.position==='fixed'&&Number(style.zIndex)>10&&rect.width>300&&rect.height>200)dialogCandidates.push(element);
  }
  const dialogSet=new Set(dialogCandidates);
  const dialogs=[...dialogSet].filter(element=>{
    for(let parent=element.parentElement;parent;parent=parent.parentElement)if(dialogSet.has(parent))return false;
    return true;
  });
  const titles=dialogs.flatMap(dialog=>all(dialog,'.dialog-title,.title,h1,h2,h3,[role="heading"]')).filter(eligible)
    .map(element=>String(element.textContent||'').trim().replace(/\s+/g,' ').slice(0,80));
  if(titles.some(title=>/^(?:安全验证|请完成验证|拖动滑块|请完成安全验证)$/.test(title)))return fail('BOSS 正在要求安全验证','VERIFICATION_REQUIRED');
  if(titles.some(title=>/^(?:扫码登录|请先登录|登录已失效|登录已过期)$/.test(title)))return fail('BOSS 正在要求登录','AUTH_REQUIRED');
  if(titles.some(title=>/^(?:访问过于频繁|今日沟通次数已达上限|沟通次数已达上限)$/.test(title)))return fail('BOSS 提示访问频繁或沟通上限','RATE_LIMITED');
  const ownerOf=element=>dialogs.find(dialog=>dialog===element||dialog.contains(element));
  const frames=all(document,'iframe').filter(eligible),evidence=[];
  if(action==='closed'){
    // A different/unsupported visible popup is still a blocker, never evidence
    // that the intended dialog has closed. No close click is repeated here.
    const closed=dialogs.length===0&&frames.length===0;
    return {ok:true,closed,...closed?{jobUrl:expected.jobUrl}:{}};
  }
  if(frames.length>1)return fail('存在多个可见岗位框架，无法唯一核对当前岗位');
  if(frames.length===1){
    const element=frames[0];let url;
    try{url=new URL(element.getAttribute('src')||'',here.origin);}catch{return fail('岗位框架地址不可核对');}
    if(!safe(url)||url.origin!==here.origin)return fail('岗位框架不是当前 BOSS 同源公开页面');
    const direct=publicJob(url.href);
    if(direct)evidence.push({element,owner:ownerOf(element),jobUrl:direct.jobUrl,info:{kind:'iframe',srcPath:url.pathname}});
    else{
      if(!/^\/(?:web\/frame\/job|web\/geek\/(?:job|job-detail|jobDetail|job-detail-dialog))\/?$/.test(url.pathname))return fail('岗位框架地址不是支持的公开岗位入口');
      if(!expected)return fail('此岗位框架需要先提供完整目标岗位链接，不能从标题猜测');
      const entries=[...url.searchParams.entries()].filter(([key])=>['encryptJobId','encryptedJobId','jobId'].includes(key));
      if(entries.length!==1||entries[0][1]!==expected.stem)return fail('岗位框架中的完整岗位编号与目标岗位不一致或不唯一');
      evidence.push({element,owner:ownerOf(element),jobUrl:expected.jobUrl,info:{kind:'iframe',srcPath:url.pathname,queryKey:entries[0][0]}});
    }
  }
  const links=[];
  for(const dialog of dialogs)for(const element of all(dialog,'a[href]').filter(eligible)){
    let url;try{url=new URL(element.getAttribute('href'),here.origin);}catch{continue;}
    if(!url.pathname.startsWith('/job_detail/'))continue;
    const direct=publicJob(url.href);
    if(!direct)return fail('弹窗包含不可核对的岗位链接');
    links.push({element,owner:dialog,jobUrl:direct.jobUrl,info:{kind:'link',href:direct.jobUrl}});
  }
  if(links.length>1)return fail('弹窗内有多个可见岗位链接，无法唯一核对');
  evidence.push(...links);
  if(!evidence.length)return fail('未找到可见弹窗中的公开岗位链接或可核对框架');
  if(new Set(evidence.map(item=>item.jobUrl)).size!==1||new Set(evidence.map(item=>item.owner)).size!==1)
    return fail('当前弹窗的岗位链接或所属弹窗证据冲突');
  const selected=evidence[0];
  if(expected&&selected.jobUrl!==expected.jobUrl)return fail('当前职位弹窗不是目标岗位，未继续操作');
  const result={ok:true,jobUrl:selected.jobUrl,evidence:selected.info};
  if(action==='read')return result;
  // Reached only after re-parsing the SAME live DOM proof in this evaluation.
  if(dialogs.length!==1||!selected.owner||selected.owner!==dialogs[0])return fail('未确认岗位证据所属的唯一弹窗，未点击关闭');
  const controls=all(selected.owner,'button,[role="button"],a,span,i,div').filter(element=>{
    if(!eligible(element)||element.disabled||element.hasAttribute('disabled')||element.getAttribute('aria-disabled')==='true')return false;
    if(element.getAttribute('aria-label')==='关闭'||element.getAttribute('title')==='关闭')return true;
    const className=element.getAttribute('class')||'',text=String(element.textContent||'').trim();
    return /(?:^|[\s_-])close(?:$|[\s_-])/.test(className)&&/^[×xX\uE000-\uF8FF]?$/.test(text);
  });
  const controlSet=new Set(controls),buttons=controls.filter(element=>{
    for(let parent=element.parentElement;parent&&parent!==selected.owner;parent=parent.parentElement)if(controlSet.has(parent))return false;
    return true;
  });
  if(buttons.length!==1)return fail('岗位弹窗的关闭按钮不唯一或不可确认，未点击');
  buttons[0].click();
  return {...result,closeClicked:true,closed:!visible(selected.owner)};
}
