import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import {filterAdvanced,stages} from './rules.mjs';

export const defaults = { keywords:'', cities:'广州', minSalary:0, maxSalary:0, excludedCompanies:'', excludedWords:'销售,保险,贷款', direction:'', minScore:60, aiEnabled:false, delaySeconds:30, dailyLimit:20, greeting:'您好，我对这个岗位很感兴趣，希望进一步沟通。', autoSend:false, resume:'', aiBase:'https://api.deepseek.com', aiModel:'deepseek-chat', replyPrompt:'礼貌、简短地回复，只根据简历中的事实，不编造经历。涉及薪资和面试安排时请先让我确认。', replyStart:9, replyEnd:18 };
Object.assign(defaults,{jobType:'不限',experiences:'',educations:'',financingStages:'',companySizes:'',industries:'',titleIncludes:'',titleExcludes:'',includedCompanies:'',activityEnabled:false,minActivity:'本周活跃',resumeMatch:true,scoreFilter:true,paceMode:'normal',delayMin:3,delayMax:8,pageMin:2,pageMax:5,restEvery:15,restMin:30,restMax:60,replyPace:'normal',replyDelayMin:3,replyDelayMax:8,replyRestEvery:10,replyRestMin:15,replyRestMax:30,autoAttachment:false,replyScope:'all',updateRepository:'',referenceVersion:'1.5.0'});
Object.assign(defaults,{personalizedGreeting:false});
// When a personalized greeting cannot be used (no evidence, chat page cannot verify
// the HR, unconfirmed send), keep contacting with BOSS's own greeting instead of
// stopping new contacts for the rest of the run. Drafts stay saved either way.
Object.assign(defaults,{greetingFallback:true});
Object.assign(defaults,{aiProvider:'api',chatgptModel:''});
export const identity=value=>createHash('sha256').update(String(value)).digest('hex').slice(0,24);
export const dailyLimitError=(n,limit)=>Object.assign(Error(`已达到今日投递上限（本地计数 ${n}/${limit}，含待核实）。可在 配置中心 → 求职配置 → 每日沟通上限 调高（最大 150），或明天再继续`),{code:'DAILY_LIMIT',notSent:true});
export function dayKey(){ return new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}); }
export function createStore(dir){
 fs.mkdirSync(dir,{recursive:true});
 const db=new DatabaseSync(path.join(dir,'ghost-job.sqlite'));
 db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT, level TEXT, text TEXT);
 CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, day TEXT, status TEXT);
 CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS companies(id TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS metadata(id TEXT PRIMARY KEY,value TEXT NOT NULL);`);
 const keyPath=path.join(dir,'local.key'); if(!fs.existsSync(keyPath))fs.writeFileSync(keyPath,randomBytes(32),{mode:0o600});
 const key=fs.readFileSync(keyPath);
 const encrypt=text=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);const body=Buffer.concat([c.update(text,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]).toString('base64');};
 const decrypt=text=>{try{ const b=Buffer.from(text,'base64'),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString();}catch{return '';}};
 function settings(secret=false){const raw=JSON.parse(db.prepare('SELECT value FROM settings WHERE id=1').get()?.value||'{}');const result={...defaults,...raw};delete result.apiKeyEncrypted;if(secret)result.apiKey=raw.apiKeyEncrypted?decrypt(raw.apiKeyEncrypted):'';else result.hasApiKey=!!raw.apiKeyEncrypted;return result;}
 function saveSettings(input){const old=JSON.parse(db.prepare('SELECT value FROM settings WHERE id=1').get()?.value||'{}');const n={...old};for(const k of Object.keys(defaults))if(k in input)n[k]=input[k];
 for(const [k,min,max] of [['delaySeconds',1,600],['dailyLimit',1,150],['minScore',0,100],['minSalary',0,100000],['maxSalary',0,100000],['replyStart',0,23],['replyEnd',1,24],...['delayMin','delayMax','pageMin','pageMax','restMin','restMax','replyDelayMin','replyDelayMax','replyRestMin','replyRestMax'].map(k=>[k,0,3600]),['restEvery',0,1000],['replyRestEvery',0,1000]]){const v=Number(n[k]??defaults[k]);if(!Number.isFinite(v))throw Error('数字配置无效：'+k);n[k]=Math.min(max,Math.max(min,v));}
 if(n.minSalary&&n.maxSalary&&n.minSalary>n.maxSalary)throw Error('最低薪资不能大于最高薪资');
 if((n.replyStart??defaults.replyStart)>=(n.replyEnd??defaults.replyEnd))throw Error('回复结束时间应晚于开始时间');
 for(const k of ['aiEnabled','autoSend','activityEnabled','resumeMatch','scoreFilter','autoAttachment','personalizedGreeting','greetingFallback'])n[k]=Boolean(n[k]??defaults[k]);
 for(const [a,b]of [['delayMin','delayMax'],['pageMin','pageMax'],['restMin','restMax'],['replyDelayMin','replyDelayMax'],['replyRestMin','replyRestMax']])if(n[a]>n[b])throw Error('停顿下限不能大于上限');
 for(const k of Object.keys(defaults))if(typeof defaults[k]==='string'&&k in n){if(typeof n[k]!=='string')throw Error('文本配置无效：'+k);n[k]=n[k].slice(0,k==='resume'?100000:24000);}
 if(!['api','chatgpt-plan'].includes(n.aiProvider??'api'))throw Error('无效的 AI 服务提供方式');
 if(input.apiKey==='')delete n.apiKeyEncrypted;else if(typeof input.apiKey==='string')n.apiKeyEncrypted=encrypt(input.apiKey.trim());
 db.prepare('INSERT OR REPLACE INTO settings VALUES(1,?)').run(JSON.stringify(n));return settings();}
 function jobs(){return db.prepare('SELECT value FROM jobs ORDER BY rowid DESC').all().map(x=>JSON.parse(x.value));}
 function upsertJob(j){if(!j.title?.trim())throw Error('岗位名称不能为空');const id=j.id||createHash('sha256').update(j.url||[j.title,j.company,j.city].join('|')).digest('hex').slice(0,24);const old=getJob(id);const value={status:'待分析',score:null,reason:'',createdAt:new Date().toISOString(),...old,...j,id,updatedAt:new Date().toISOString()};db.prepare('INSERT OR REPLACE INTO jobs VALUES(?,?)').run(id,JSON.stringify(value));return value;}
 function getJob(id){const r=db.prepare('SELECT value FROM jobs WHERE id=?').get(String(id));return r?JSON.parse(r.value):null;}
 function log(text,level='info'){db.prepare('INSERT INTO logs(time,level,text) VALUES(?,?,?)').run(new Date().toISOString(),level,String(text).slice(0,1000));db.exec('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 500)');}
 function messages(){return db.prepare('SELECT id,value FROM messages ORDER BY id').all().map(r=>({...JSON.parse(r.value),id:r.id}));}
 function addMessage(m){const conversationId=m.conversationId||identity(m.contact||'本地会话');const conv=getConversation(conversationId);upsertConversation({id:conversationId,contact:m.contact||conv?.contact||'HR',...conv,lastTime:m.time||new Date().toISOString(),lastText:m.text});if(m.remoteId){const duplicate=messages().find(x=>x.conversationId===conversationId&&x.remoteId===m.remoteId);if(duplicate)return duplicate;}const order=Math.max(-1,...messages().filter(x=>x.conversationId===conversationId).map(x=>x.order??x.id??0))+1;const value={time:new Date().toISOString(),status:'草稿',...m,conversationId,order};const id=db.prepare('INSERT INTO messages(value) VALUES(?)').run(JSON.stringify(value)).lastInsertRowid;return {...value,id:Number(id)};}
 function updateMessage(id,patch){const old=db.prepare('SELECT value FROM messages WHERE id=?').get(Number(id));if(!old)throw Error('消息不存在');db.prepare('UPDATE messages SET value=? WHERE id=?').run(JSON.stringify({...JSON.parse(old.value),...patch}),Number(id));}
 function reserveDelivery(id,limit){db.exec('BEGIN IMMEDIATE');try{if(db.prepare('SELECT 1 FROM deliveries WHERE id=?').get(id))throw Object.assign(Error('该岗位已有投递或待核实记录，请勿重复发送'),{code:'DELIVERY_EXISTS',notSent:true});const n=db.prepare('SELECT count(*) n FROM deliveries WHERE day=?').get(dayKey()).n;if(n>=limit)throw dailyLimitError(n,limit);db.prepare('INSERT INTO deliveries VALUES(?,?,?)').run(id,dayKey(),'pending');db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
 function getConversation(id){const row=db.prepare('SELECT value FROM conversations WHERE id=?').get(String(id));return row?JSON.parse(row.value):null;}
 function upsertConversation(c){const id=c.id||identity(c.remoteId||[c.contact,c.company,c.jobUrl].join('|')),old=getConversation(id);if(c.stage&&!stages.includes(c.stage))throw Error('无效的沟通状态');const value={stage:'未标记',createdAt:new Date().toISOString(),...old,...c,id};db.prepare('INSERT OR REPLACE INTO conversations VALUES(?,?)').run(id,JSON.stringify(value));return value;}
 function conversations(){const list=db.prepare('SELECT value FROM conversations').all().map(r=>JSON.parse(r.value));for(const m of messages())if(!m.conversationId&&!list.some(c=>c.contact===m.contact))list.push(upsertConversation({id:identity(m.contact),contact:m.contact,lastTime:m.time,lastText:m.text}));return list.sort((a,b)=>String(b.lastTime||'').localeCompare(String(a.lastTime||'')));}
 function deleteConversation(id){const c=getConversation(id);db.exec('BEGIN');try{for(const m of messages())if(m.conversationId===id||(!m.conversationId&&m.contact===c?.contact))db.prepare('DELETE FROM messages WHERE id=?').run(m.id);db.prepare('DELETE FROM conversations WHERE id=?').run(id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
 function companies(){return db.prepare('SELECT value FROM companies').all().map(r=>JSON.parse(r.value));}
 function saveCompany(c){const id=identity(c.name);const value={...companies().find(x=>x.id===id),...c,id,updatedAt:new Date().toISOString()};db.prepare('INSERT OR REPLACE INTO companies VALUES(?,?)').run(id,JSON.stringify(value));return value;}
 const reports=()=>db.prepare('SELECT id,value FROM reports ORDER BY id DESC').all().map(r=>({...JSON.parse(r.value),id:r.id}));
 return {db,settings,saveSettings,jobs,getJob,upsertJob,log,messages,addMessage,updateMessage,reserveDelivery,conversations,getConversation,upsertConversation,deleteConversation,companies,saveCompany,
  meta:(id,value)=>{if(value===undefined){const row=db.prepare('SELECT value FROM metadata WHERE id=?').get(id);return row?JSON.parse(row.value):null;}db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run(id,JSON.stringify(value));return value;},
  finishDelivery:(id,status)=>db.prepare('UPDATE deliveries SET status=? WHERE id=?').run(status,id),
  // Only for a reservation whose browser step provably never clicked: give the
  // quota back. Sent/uncertain rows are never removed.
  releaseDelivery:id=>db.prepare("DELETE FROM deliveries WHERE id=? AND status='pending'").run(id).changes>0,
  deliveryCount:()=>db.prepare('SELECT count(*) n FROM deliveries WHERE day=?').get(dayKey()).n,
  logs:()=>db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 100').all(),
  clearLogs:()=>db.exec('DELETE FROM logs'),
  deleteJob:id=>db.prepare('DELETE FROM jobs WHERE id=?').run(String(id)),
  report:r=>{const value={...r,time:new Date().toISOString()};const id=db.prepare('INSERT INTO reports(value) VALUES(?)').run(JSON.stringify(value)).lastInsertRowid;return {...value,id:Number(id)};},reports,
  updateReportText:(id,text)=>{const r=reports().find(x=>x.id===Number(id));if(!r)throw Error('报告不存在');db.prepare('UPDATE reports SET value=? WHERE id=?').run(JSON.stringify({...r,text,interpretedAt:new Date().toISOString()}),Number(id));},
  deleteReport:id=>db.prepare('DELETE FROM reports WHERE id=?').run(Number(id)),
  close:()=>db.close()};
}
export function filterJob(job,s){
 const advanced=filterAdvanced(job,s);if(advanced)return advanced;
 const tokens=v=>String(v||'').split(/[,，\n]/).map(x=>x.trim()).filter(Boolean);
 const badCompany=tokens(s.excludedCompanies).find(x=>(job.company||'').toLowerCase().includes(x.toLowerCase()));if(badCompany)return {status:'不合适',reason:'屏蔽公司：'+badCompany,score:null};
 const bad=tokens(s.excludedWords).find(x=>[job.title,job.description].join(' ').toLowerCase().includes(x.toLowerCase()));if(bad)return {status:'不合适',reason:'包含排除词：'+bad,score:null};
 const match=String(job.salary||'').match(/(\d+(?:\.\d+)?)\s*[-~–]\s*(\d+(?:\.\d+)?)\s*[kK]/);if(match){const lo=Number(match[1])*1000,hi=Number(match[2])*1000;if((s.minSalary&&hi<s.minSalary)||(s.maxSalary&&lo>s.maxSalary))return {status:'不合适',reason:'薪资范围不匹配',score:null};}
 return null;
}
