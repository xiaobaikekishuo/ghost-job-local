import {assertConversation,assertActive} from './conversation.mjs';
import fs from 'node:fs';
import path from 'node:path';
const clone=x=>structuredClone(x);
// Deterministic fixture evidence, still checked by the same source validator as
// real generation. No invented experience and no special bypass for simulation.
export function simulationGreetingMatches(job,settings){
 const terms=['供应商开发','订单交付','采购询价','成本分析','合同跟踪','询价比价','采购流程','Excel'];
 return terms.filter(term=>String(job.description||'').includes(term)&&String(settings.resume||'').includes(term))
  .slice(0,2).map(term=>({requirement:term,evidence:term}));
}
export function simulationWorld(){
 const companies=['模拟·青禾供应链','模拟·远航制造','模拟·星河贸易','模拟·旧城商贸','模拟·晨光设备','模拟·云桥集团'];
 const jobs=companies.map((company,i)=>({url:`https://www.zhipin.com/job_detail/sim-${i+1}.html`,title:['采购专员','采购主管','电话销售','采购助理','采购工程师','采购经理'][i],company,companyUrl:`https://www.zhipin.com/gongsi/sim-${i+1}.html`,salary:['8-12K','12-18K','10-20K','5-7K','10-15K','20-30K'][i],city:'广州',experience:'1-3年',education:'大专',financing:'不需要融资',companySize:'100-499人',industry:'制造业',jobType:'全职',hrActivity:i===3?'一个月前活跃':'今日活跃',hrName:['林 HR','陈 HR','黄 HR','周 HR','赵 HR','李 HR'][i],description:'【虚构演练岗位】负责供应商开发、采购询价、成本分析、订单交付和合同跟踪，熟悉 Excel、ERP 与采购流程。'+(i===1?'需要丰富的团队管理经验。':''),source:'模拟演练',simulation:true,simulationScore:[92,55,80,80,86,88][i]}));
 const texts=['我想要一份您的附件简历','明天下午三点方便视频面试吗？','感谢关注，目前岗位已招满，暂不匹配。','请介绍一下您的采购经验。','我们的主要采购品类是电子元件，您熟悉吗？','你好，请问您还在看采购机会吗？'];
 return {jobs,conversations:jobs.map((j,i)=>({id:'sim-c'+(i+1),remoteId:'sim-c'+(i+1),contact:j.hrName,company:j.company,jobTitle:j.title,jobUrl:j.url,stage:'未标记',unread:true,messages:[{role:'assistant',text:'您好，我对采购岗位很感兴趣。',remoteId:'sim-'+i+'-greet',time:'2026-11-01T02:00:00Z'},{role:'user',text:texts[i],remoteId:'sim-'+i+'-hr',time:'2026-11-03T01:00:00Z'}]})),sent:[],attachments:[],opened:false};
}
export class SimulationBrowser{
 constructor(dir,role='jobs'){this.file=path.join(dir,'simulation-world.json');this.role=role;this.active='sim-c1';this.keyword='';this.city='广州';if(!fs.existsSync(this.file)){fs.mkdirSync(dir,{recursive:true});this.save(simulationWorld());}}
 world(){return JSON.parse(fs.readFileSync(this.file,'utf8'));}save(w){fs.writeFileSync(this.file,JSON.stringify(w,null,2));}
 async launch(){const w=this.world();w.opened=true;this.save(w);}
 async assertGreetingAvailable({active=()=>true}={}){assertActive(active);return {ready:true,simulation:true};}
 async status(){return {connected:this.world().opened,url:'simulation://boss',title:'虚构 BOSS 页面 · 模拟演练'};}
 async search(keyword,city){this.keyword=keyword;this.city=city;await this.launch();}
 async target(){return {id:'sim-list',url:`https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(this.keyword)}&city=101280100`};}
 async navigate(url){this.jobUrl=url;}
 async readJobs(){return {jobs:clone(this.world().jobs.filter(j=>(!this.keyword||j.title.includes(this.keyword))&&(!this.city||this.city==='全国'||j.city===this.city))),blocked:''};}
 async detail(){const j=this.world().jobs.find(j=>j.url===this.jobUrl);if(!j)throw Error('模拟岗位不存在');return clone(j);}
 async nextPage(){return false;}
 async communicate(j){const w=this.world();if(w.sent.includes(j.url))throw Error('模拟岗位已沟通过');w.sent.push(j.url);const c=w.conversations.find(c=>c.jobUrl===j.url);if(c)c.delivery=true;this.save(w);return {verified:true,reason:'模拟沟通已确认，未联系真实 HR'};}
 async sendJobGreeting(job,text,options={}){
  options.guard?.();const w=this.world();let c=w.conversations.find(c=>c.jobUrl===job.url);
  if(!c){c={id:'sim-greeting-'+job.id,remoteId:'sim-greeting-'+job.id,contact:'模拟 HR',company:job.company,jobTitle:job.title,jobUrl:job.url,messages:[]};w.conversations.push(c);this.save(w);}
  await this.selectConversation(c);await this.sendChat(c,text,options);const conversation=await this.readChat();
  return {verified:true,conversation,receiptId:conversation.messages.at(-1).remoteId,reason:'模拟专属招呼已发送，未联系真实 HR'};
 }
 async openChat(){await this.launch();}
 async listConversations(){return clone(this.world().conversations.map(({messages,...c})=>c));}
 async selectConversation(c){const w=this.world();if(!w.conversations.some(x=>x.id===c.id))throw Error('模拟会话不存在');this.active=c.id;}
 async readChat(){const c=this.world().conversations.find(c=>c.id===this.active);return clone(c);}
 async readHistory(){return this.readChat();}
 async scrollConversations(){return false;}
 async sendChat(conversation,text,options={}){options.guard?.();const w=this.world(),c=w.conversations.find(c=>c.id===this.active);assertConversation(conversation,c);options.guard?.();options.onAttempt?.();c.messages.push({role:'assistant',text,remoteId:'sim-sent-'+c.messages.length,time:new Date().toISOString()});c.unread=false;this.save(w);return true;}
 async sendAttachment(conversation,options={}){options.guard?.();const w=this.world(),c=w.conversations.find(c=>c.id===this.active);assertConversation(conversation,c);options.guard?.();options.onAttempt?.();if(w.attachments.includes(c.id))return {verified:true,reason:'此模拟会话已发送附件'};w.attachments.push(c.id);c.messages.push({role:'assistant',text:'[模拟附件简历已发送]',kind:'attachment',deliveryStatus:'confirmed',remoteId:'sim-attachment-'+c.id,time:new Date().toISOString()});this.save(w);return {verified:true,reason:'模拟附件请求已确认，未上传或发送真实文件'};}
 async companyInfo(job){return {name:job.company,legalName:job.company+'有限公司（虚构）',legalRepresentative:'演练人员',capital:'1000 万元（模拟）',founded:'2018-01-01',status:'存续（模拟）',industry:'制造业',source:job.companyUrl||'https://example.com/simulation',description:'这是模拟演练信息，不对应真实企业。'};}
 async searchCompany(name){return [{title:name+' · 模拟公开资料',url:'https://example.com/simulation/company',snippet:name.includes('星河')?'【虚构样本】模拟一条欠薪争议记录，仅用于测试风险标签。':'【虚构样本】经营资料示例，未提供风险事件。'}];}
 async close(){const w=this.world();w.opened=false;this.save(w);}
}
export function simulationSettings(){return {keywords:'采购',cities:'广州',resume:'【虚构演练简历】三年采购工作经验，熟悉供应商开发、询价比价、Excel、ERP 与订单交付。',aiEnabled:true,resumeMatch:true,scoreFilter:true,minScore:60,activityEnabled:true,minActivity:'本周活跃',autoSend:true,autoAttachment:true,replyStart:0,replyEnd:24,paceMode:'custom',delayMin:0,delayMax:0,pageMin:0,pageMax:0,restEvery:0,replyDelayMin:0,replyDelayMax:0,replyRestEvery:0,direction:'采购类岗位，排除销售、低匹配和长期不活跃岗位。'};}
