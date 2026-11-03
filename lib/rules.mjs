export const tokens=v=>String(v||'').split(/[,，\n]/).map(x=>x.trim()).filter(Boolean);
export const stages=['未标记','有面试','已面试','面试通过','面试不通过','HR 已拒绝','AI 已婉拒'];
export const manualStages=['已面试','面试通过','面试不通过'];
export function activityRank(text=''){
 if(/刚刚|在线|正在活跃/.test(text))return 0;
 if(/今日|今天/.test(text))return 1;
 if(/3日|三日|3天|三天/.test(text))return 2;
 if(/本周|7日|7天|一周/.test(text))return 3;
 if(/2周|两周|14天/.test(text))return 4;
 if(/本月|30天|一月|1月/.test(text))return 5;
 if(/近期|半年|很久|月前|年前|天前/.test(text))return 6;
 return null;
}
export function filterAdvanced(job,s){
 const fail=reason=>({status:'不合适',reason,score:null});
 const has=(a,b)=>String(a||'').toLowerCase().includes(b.toLowerCase());
 const required=tokens(s.titleIncludes);if(required.length&&!required.some(v=>has(job.title,v)))return fail('职位名不包含所需关键词');
 const excluded=tokens(s.titleExcludes).find(v=>has(job.title,v));if(excluded)return fail('职位名排除：'+excluded);
 const companies=tokens(s.includedCompanies);if(companies.length&&job.company&&!companies.some(v=>has(job.company,v)))return fail('不在指定公司范围');
 for(const [setting,key,label] of [['experiences','experience','工作经验'],['educations','education','学历'],['financingStages','financing','融资阶段'],['companySizes','companySize','企业规模'],['industries','industry','行业']]){
  const allowed=tokens(s[setting]);if(allowed.length&&job[key]&&!allowed.some(v=>has(job[key],v)))return fail(label+'不符合筛选条件');
 }
 if(s.jobType&&s.jobType!=='不限'&&job.jobType&&job.jobType!==s.jobType)return fail('求职类型不匹配');
 if(s.activityEnabled){const rank=activityRank(job.hrActivity),minimum=activityRank(s.minActivity);if(rank!==null&&minimum!==null&&rank>minimum)return fail('招聘者活跃度低于'+s.minActivity);}
 return null;
}
export const pacePresets={slow:{delayMin:8,delayMax:15,pageMin:4,pageMax:8,restEvery:10,restMin:60,restMax:120},normal:{delayMin:3,delayMax:8,pageMin:2,pageMax:5,restEvery:15,restMin:30,restMax:60},fast:{delayMin:2,delayMax:4,pageMin:1,pageMax:3,restEvery:20,restMin:20,restMax:40}};
export function pace(s,kind='job',random=Math.random){const p=s.paceMode==='custom'?s:(pacePresets[s.paceMode]||pacePresets.normal);const [lo,hi]=kind==='page'?[p.pageMin,p.pageMax]:kind==='rest'?[p.restMin,p.restMax]:[p.delayMin??s.delaySeconds,p.delayMax??s.delaySeconds];return Math.max(0,Number(lo)+(Number(hi)-Number(lo))*random());}
export function replyHourAllowed(s,date=new Date()){const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',hour:'numeric',hour12:false}).format(date))%24;return s.replyStart<s.replyEnd?hour>=s.replyStart&&hour<s.replyEnd:hour>=s.replyStart||hour<s.replyEnd;}
export function classifyIncoming(text,oldStage='未标记'){
 let stage='未标记';
 if(/暂不匹配|不太合适|不符合|岗位已招满|已招到|暂不考虑|感谢.*关注.*后续/.test(text))stage='HR 已拒绝';
 else if(/面试/.test(text)&&/邀请|安排|方便|明天|后天|周[一二三四五六日天]|几点|时间|地址|链接|视频/.test(text))stage='有面试';
 const rejected=stage==='HR 已拒绝';if(manualStages.includes(oldStage))stage=oldStage;
 return {stage,shouldReply:!rejected,attachmentRequested:/附件简历|一份.*简历|发送.*简历|发.*简历|简历.*发/.test(text),needsReview:/薪资|工资|到岗|身份证|银行卡|验证码|签约|合同|offer|面试|地址/.test(text)};
}
