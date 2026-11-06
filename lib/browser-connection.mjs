import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {BrowserSession} from './cdp-session.mjs';

export function chromePortFile(){
 const profile=process.env.USERPROFILE||os.homedir();
 return path.join(profile,'AppData','Local','Google','Chrome','User Data','DevToolsActivePort');
}

export function readBrowserEndpoint(file){
 let raw;
 try{raw=fs.readFileSync(file,'utf8');}catch{throw Error('请在已登录的 Chrome 打开 chrome://inspect/#remote-debugging，开启允许此浏览器的远程调试，再点击连接。');}
 const [port,endpoint]=raw.trim().split(/\r?\n/);
 if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535||!/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(endpoint||''))throw Error('Chrome 的连接信息无效，请重新开启浏览器远程调试后重试。');
 return `ws://127.0.0.1:${port}${endpoint}`;
}

// All app roles share one approved connection. No login data is copied or read.
export class BrowserConnection{
 constructor({mode='dedicated',portFile=chromePortFile(),session=new BrowserSession()}={}){
  this.mode=mode==='existing'?'existing':'dedicated';this.portFile=portFile;this.session=session;
  this.generation=0;this.preferredTargetId=null;this.createdTargets=new Set();this.pending=null;this.error='';
 }
 async connect(){
  if(this.session.connected)return;
  if(this.pending)return this.pending;
  this.error='';
  const generation=this.generation;
  this.pending=Promise.resolve().then(async()=>{
   if(generation!==this.generation)throw Error('连接已取消');
   const endpoint=readBrowserEndpoint(this.portFile);
   try{await this.session.connect(endpoint,{timeoutMs:60000});if(generation!==this.generation)throw Error('连接已取消');this.generation++;}
   catch(e){this.error='未连接到已登录的 Chrome。请确认已开启远程调试，并在 Chrome 弹窗中点击允许。';throw Error(this.error,{cause:e});}
  }).finally(()=>{this.pending=null;});
  return this.pending;
 }
 disconnect(){this.session.disconnect();this.generation++;this.preferredTargetId=null;this.createdTargets.clear();}
 setMode(mode){if(!['existing','dedicated'].includes(mode))throw Error('请选择有效的浏览器连接方式');this.disconnect();this.mode=mode;this.error='';}
}
