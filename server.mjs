import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createStore} from './lib/store.mjs';
import {chat,models} from './lib/ai.mjs';
import {Browser,cities,openApp} from './lib/browser.mjs';
import {SimulationBrowser,simulationSettings} from './lib/simulation.mjs';
import {createWorkflows} from './lib/workflows.mjs';
import {textPDF} from './lib/pdf.mjs';
import {stages} from './lib/rules.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const simulation=process.argv.includes('--simulate');
const data=process.env.GHOST_DATA_DIR||path.join(root,simulation?'data-simulation':'data');
// Simulation cannot reuse the production directory, including through environment overrides.
if(simulation&&path.resolve(data)===path.resolve(root,'data'))throw Error('模拟演练必须使用独立数据目录');
const port=Number(process.env.PORT||(simulation?17842:17839)),origin=`http://127.0.0.1:${port}`;
const store=createStore(data),Adapter=simulation?SimulationBrowser:Browser;
if(simulation&&!store.meta('simulation-initialized')){store.saveSettings(simulationSettings());store.meta('simulation-initialized',true);}
const browser=new Adapter(data,'jobs'),chatBrowser=new Adapter(data,'chat'),companyBrowser=new Adapter(data,'company');
const flow=createWorkflows(store,browser,chatBrowser,companyBrowser,simulation);
const log=(t,l)=>store.log(t,l);
const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const pdfResponse=(res,name,title,lines)=>{const b=textPDF(title,lines);res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${name}.pdf"`,'Content-Length':b.length});res.end(b);};
async function body(req){let s='';for await(const chunk of req){s+=chunk;if(s.length>8_000_000)throw Error('请求过大，最多 8 MB');}try{return s?JSON.parse(s):{};}catch{throw Error('无效的 JSON 数据');}}
function backup(){return {format:'ghost-job-local',version:2,simulation,exportedAt:new Date().toISOString(),jobs:store.jobs(),messages:store.messages(),conversations:store.conversations(),companies:store.companies(),reports:store.reports()};}
const timer=setInterval(()=>void flow.replyTick(),30000);timer.unref();
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.mjs':'text/javascript; charset=utf-8'};
const server=http.createServer(async(req,res)=>{try{if(!['127.0.0.1:'+port,'localhost:'+port].includes(req.headers.host))return json(res,{error:'Invalid Host'},403);const u=new URL(req.url,origin),p=u.pathname;
 if(p.startsWith('/api/')){
  if(req.headers.origin&&req.headers.origin!==origin&&req.headers.origin!==`http://localhost:${port}`)return json(res,{error:'不允许跨站请求'},403);
  if(req.method!=='GET'&&req.headers['x-local-app']!=='ghost-job')return json(res,{error:'缺少本地请求标识'},403);
  const b=req.method==='GET'?{}:await body(req);
  if(req.method==='GET'){
   if(p==='/api/state')return json(res,{settings:store.settings(),stats:flow.stats(),task:flow.task,syncTask:flow.sync,replyTask:flow.reply,autoReply:flow.reply.running,simulation,audit:flow.audit.steps.length?flow.audit:store.meta('simulation-audit'),browser:await browser.status(),logs:store.logs(),cities:Object.keys(cities),conversations:store.conversations(),companies:store.companies(),stages,version:'1.1.2'});
   if(p==='/api/jobs')return json(res,store.jobs());
   if(p==='/api/messages')return json(res,store.messages());
   if(p==='/api/conversations')return json(res,store.conversations());
   if(p==='/api/companies')return json(res,store.companies());
   if(p==='/api/reports')return json(res,store.reports());
   if(p==='/api/export')return json(res,backup());
   if(p==='/api/report/pdf'){const r=store.reports().find(r=>r.id===Number(u.searchParams.get('id')));if(!r)throw Error('报告不存在');const metric=(label,v)=>v?`${label}：${v.success}/${v.n}；后验均值 ${(v.mean*100).toFixed(1)}%；95% 可信区间 ${(v.low*100).toFixed(1)}%-${(v.high*100).toFixed(1)}%`:'旧版报告';return pdfResponse(res,'job-report-'+r.id,r.title||'求职分析报告',[r.time,'策略：'+(r.strategy||'未填写'),r.analysis?.method||'',{text:'求职进展',heading:true},...Object.entries(r.analysis?.funnel||{}).map(([k,v])=>({sent:'已投递（含历史沟通）',observable:'可观测投递',replied:'HR 已回应',resume:'HR 提及简历',interview:'面试状态',unobservable:'未观察到聊天记录'})[k]+'：'+v),metric('投递后回应',r.analysis?.delivery),metric('自动回复后再次回应',r.analysis?.reply),...Object.entries(r.analysis?.groups||{}).flatMap(([key,groups])=>[{text:({score:'匹配度分组',activity:'活跃度分组',risk:'企业风险分组'})[key],heading:true},...groups.flatMap(g=>[metric(g.name+' / 投递回应',g.delivery),metric(g.name+' / 回复回应',g.reply)])]),{text:'AI 解读',heading:true},r.text||'尚未生成']);}
   if(p==='/api/company/pdf'){const c=store.companies().find(c=>c.id===u.searchParams.get('id'));if(!c)throw Error('企业报告不存在');return pdfResponse(res,'company-'+c.id,c.name+' · 企业查询报告',[c.updatedAt,...Object.entries({legalName:'企业全称',legalRepresentative:'法定代表人',capital:'注册资本',founded:'成立日期',status:'经营状态',industry:'行业',risk:'风险等级',assessment:'分析与限制'}).map(([k,label])=>label+'：'+(c[k]||'未获取')),{text:c.source||'',url:c.source},...(c.sources||[]).flatMap((s,i)=>[{text:`[${i+1}] ${s.title}`,url:s.url},s.snippet,{text:s.url,url:s.url}]),...(c.errors||[])]);}
   return json(res,{error:'未找到接口'},404);
  }
  if(req.method!=='POST')return json(res,{error:'未找到接口'},404);
  if(p==='/api/shutdown'){if(flow.busy)throw Error('请先停止任务，等待当前操作完成');flow.stop();json(res,{ok:true});setTimeout(()=>{server.close();store.close();process.exit(0);},250);return;}
  if(p==='/api/settings'){if(flow.busy)throw Error('请先停止任务再修改配置');return json(res,store.saveSettings(b));}
  if(p==='/api/resume/pdf'){if(typeof b.base64!=='string')throw Error('请上传 PDF 文件');const result=await new Promise((resolve,reject)=>{const py=spawn(process.env.GHOST_PYTHON||(fs.existsSync(path.join(root,'runtime','python','python.exe'))?path.join(root,'runtime','python','python.exe'):'python'),[path.join(root,'lib','extract_pdf.py')],{windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>{py.kill();reject(Error('PDF 解析超时'));},20000);py.on('error',()=>{clearTimeout(timer);reject(Error('PDF 导入需要 Python，请安装 Python 或直接粘贴简历文字'));});py.stdout.on('data',c=>out+=c);py.stderr.on('data',c=>err+=c);py.on('close',code=>{clearTimeout(timer);try{const r=JSON.parse(out);if(r.error)reject(Error(r.error));else resolve(r);}catch{reject(Error('PDF 解析失败，请检查文件或直接粘贴简历文字'));}});py.stdin.on('error',()=>{});py.stdin.end(JSON.stringify({base64:b.base64}));});return json(res,result);}
  if(p==='/api/ai/test')return json(res,{message:simulation?'模拟连接成功（未调用外部模型）':await chat({...store.settings(true),...b},[{role:'user',content:'请只回复：连接成功'}])});
  if(p==='/api/ai/models')return json(res,simulation?['simulation-model']:await models({...store.settings(true),...b}));
  if(p==='/api/jobs/save'){if(flow.busy)throw Error('任务运行期间请勿修改岗位');return json(res,store.upsertJob(b));}
  if(p==='/api/jobs/delete'){if(flow.busy)throw Error('任务运行期间请勿删除岗位');for(const id of b.ids||[])store.deleteJob(id);return json(res,{ok:true});}
  if(p==='/api/jobs/analyze')return json(res,await flow.exclusive(async()=>{const results=[];for(const id of (b.ids||[]).slice(0,100)){const j=store.getJob(id);if(!j)continue;try{const result=await flow.checkJob(j,true);if(['已沟通','待核实'].includes(j.status))store.upsertJob({...result,status:j.status});results.push(result);}catch(e){results.push({id,error:e.message});log(e.message,'warn');}}return results;}));
  if(p==='/api/jobs/send')return json(res,await flow.exclusive(()=>flow.sendJob(b.id)));
  if(p==='/api/import'){if(flow.busy)throw Error('请在任务停止后导入');const items=Array.isArray(b)?b:b.jobs;if(!Array.isArray(items)||items.length>5000)throw Error('请导入包含 jobs 数组的 JSON，最多 5000 条');if(!simulation&&(b.simulation||items.some(j=>j.simulation)))throw Error('模拟数据不能导入真实工作区');let count=0;for(const j of items)if(j.title||j.jobName||j.job_name){store.upsertJob({...j,title:j.title||j.jobName||j.job_name,company:j.company||j.brandName||'',source:j.source||'导入'});count++;}for(const c of (b.conversations||[]).slice(0,10000))store.upsertConversation(c);for(const m of (b.messages||[]).slice(0,50000)){const {id,...rest}=m;store.addMessage({...rest,remoteId:m.remoteId||'import-'+id+'-'+m.time});}for(const c of b.companies||[])store.saveCompany(c);for(const r of b.reports||[])if(!store.reports().some(x=>x.time===r.time&&x.title===r.title))store.report(r);return json(res,{count});}
  if(p==='/api/demo'){for(const j of [{title:'AI 应用开发工程师',company:'示例 · 星河科技',salary:'18-28K',city:'广州',description:'使用 Python、FastAPI 开发 AI 应用，熟悉 RAG、向量数据库、LLM 接口和后端工程。'},{title:'前端开发工程师',company:'示例 · 云帆工作室',salary:'15-25K',city:'深圳',description:'负责 React、TypeScript 应用开发，重视交互体验、性能与工程质量。'},{title:'软件测试工程师',company:'示例 · 青禾软件',salary:'12-18K',city:'杭州',description:'负责接口测试、自动化测试和质量保障，熟悉 Python、SQL。'}])store.upsertJob({...j,demo:true,source:'示例'});return json(res,{ok:true});}
  if(p==='/api/demo/clear'){for(const j of store.jobs().filter(j=>j.demo))store.deleteJob(j.id);return json(res,{ok:true});}
  if(p==='/api/browser/open'){await browser.launch();return json(res,{ok:true});}
  if(p==='/api/browser/search')return json(res,await flow.exclusive(async()=>{await browser.launch();const s=store.settings();await browser.search(b.keyword||s.keywords.split(/[,，\n]/)[0],b.city||s.cities.split(/[,，\n]/)[0]);return {ok:true};}));
  if(p==='/api/browser/collect')return json(res,await flow.exclusive(()=>flow.collect()));
  if(p==='/api/browser/detail')return json(res,await flow.exclusive(()=>{const j=store.getJob(b.id);if(!j?.url)throw Error('没有岗位链接');return flow.detail(j);}));
  if(p==='/api/browser/close'){if(flow.busy)throw Error('请先停止任务，等待当前操作完成');flow.stop();await browser.close();return json(res,{ok:true});}
  if(p==='/api/task/start'){if(flow.task.busy||flow.sync.busy||flow.audit.running)throw Error('任务正在进行');const s=store.settings();if(!s.keywords.trim()||!s.cities.trim())throw Error('请先填写关键词和城市');void flow.scan().catch(e=>log(e.message,'error'));return json(res,{ok:true});}
  if(p==='/api/task/stop'){flow.task.running=false;flow.task.phase='正在停止';return json(res,{ok:true});}
  if(p==='/api/logs/clear'){store.clearLogs();return json(res,{ok:true});}
  if(p==='/api/messages/add'){if(!b.contact?.trim()||!b.text?.trim())throw Error('请填写联系人和消息');if(b.conversationId){const c=store.getConversation(b.conversationId);if(!c||c.contact!==b.contact.trim())throw Error('会话与联系人不一致，请重新选择');}return json(res,store.addMessage({conversationId:b.conversationId,contact:b.contact,text:b.text,role:'user',status:'收到'}));}
  if(p==='/api/messages/sync')return json(res,await flow.exclusive(()=>flow.syncCurrent()));
  if(p==='/api/history/start'){if(flow.sync.busy||flow.task.busy||flow.reply.running||flow.reply.busy)throw Error('请先停止投递与自动回复');void flow.history(Boolean(b.reset)).catch(e=>log(e.message,'error'));return json(res,{ok:true});}
  if(p==='/api/history/stop'){flow.sync.running=false;return json(res,{ok:true});}
  if(p==='/api/conversations/update'){if(!stages.includes(b.stage))throw Error('请选择有效会话状态');const c=store.getConversation(b.id);if(!c)throw Error('会话不存在');store.upsertConversation({...c,stage:b.stage});if(c.jobId&&store.getJob(c.jobId))store.upsertJob({...store.getJob(c.jobId),stage:b.stage});return json(res,{ok:true});}
  if(p==='/api/conversations/delete'){if(flow.busy)throw Error('请在任务停止后删除');for(const id of b.ids||[])store.deleteConversation(id);return json(res,{ok:true});}
  if(p==='/api/messages/draft')return json(res,await flow.draft(b.conversationId,b.contact));
  if(p==='/api/messages/save'){const m=store.messages().find(x=>x.id===Number(b.id));if(!m||m.role!=='assistant'||m.status!=='草稿')throw Error('只能编辑尚未发送的草稿');store.updateMessage(b.id,{text:String(b.text).slice(0,5000)});return json(res,{ok:true});}
  if(p==='/api/messages/send')return json(res,await flow.exclusive(()=>flow.sendMessage(b.id)));
  if(p==='/api/messages/attachment')return json(res,await flow.exclusive(()=>flow.attachment(b.conversationId)));
  if(p==='/api/reply/start'){if(flow.sync.busy)throw Error('请先停止历史同步');const s=store.settings(true);if(!s.resume.trim()||!simulation&&!s.apiKey&&!/localhost|127\.0\.0\.1/.test(s.aiBase))throw Error('请先配置简历和 AI 服务');flow.startReply();void flow.replyTick();return json(res,{ok:true});}
  if(p==='/api/reply/stop'){flow.stopReply();return json(res,{ok:true});}
  if(p==='/api/company/query')return json(res,await flow.exclusive(()=>flow.company(b.id,Boolean(b.force))));
  if(p==='/api/report')return json(res,await flow.report(b.strategy));
  if(p==='/api/report/interpret')return json(res,await flow.interpret(b.id));
  if(p==='/api/report/delete'){store.deleteReport(b.id);return json(res,{ok:true});}
  if(p==='/api/simulation/run'){if(!simulation)throw Error('请打开独立模拟演练入口');if(flow.busy)throw Error('请等待当前操作完成');void flow.simulate();return json(res,{ok:true});}
  if(p==='/api/version/check'){if(simulation)return json(res,{version:'1.1.2',reference:'模拟检查，未访问 GitHub',release:null});const repository=store.settings().updateRepository||'InfernalAzazel/ghost-job';if(!/^[\w.-]+\/[\w.-]+$/.test(repository))throw Error('仓库格式：所有者/仓库名');const r=await fetch('https://api.github.com/repos/'+repository+'/releases/latest',{headers:{Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('版本检查失败：HTTP '+r.status);const release=await r.json();return json(res,{version:'1.1.2',reference:repository,release:{version:release.tag_name,url:release.html_url,published:release.published_at},note:repository==='InfernalAzazel/ghost-job'?'此为原版更新，不能直接覆盖本地复刻版。':'请确认发布者后手动更新。'});}
  return json(res,{error:'未找到接口'},404);
 }
 const pathname=p==='/'?'index.html':decodeURIComponent(p).slice(1),file=path.resolve(root,'public',pathname);if(!file.startsWith(path.join(root,'public')+path.sep)||!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.writeHead(404);return res.end('Not found');}
 res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});fs.createReadStream(file).pipe(res);
 }catch(e){json(res,{error:e.message},400);}});
server.on('error',e=>{if(e.code==='EADDRINUSE'&&process.argv.includes('--open')){fetch(origin+'/api/state').then(r=>r.json()).then(s=>{if(s.version)openApp(origin,data);process.exit(0);}).catch(()=>process.exit(1));}else{console.error(e.message);process.exit(1);}});
server.listen(port,'127.0.0.1',()=>{log(simulation?'独立模拟环境已就绪，所有岗位、HR 和模型结果均为虚构':'本地服务已就绪，数据保存在应用 data 目录');console.log(origin);if(process.argv.includes('--open'))openApp(origin,data);});
process.on('SIGINT',()=>{flow.stop();server.close(()=>{store.close();process.exit(0);});});
