const safe=text=>[...String(text)].map(c=>c.codePointAt(0)<=65535?c:'□').join('');
const hex=text=>Buffer.from(safe(text),'utf16le').swap16().toString('hex').toUpperCase();
const literal=text=>text.replace(/[()\\]/g,'\\$&');
export function textPDF(title,paragraphs){
 const pages=[[]];let y=780;
 const line=(text,size=11,url)=>{if(y<55){pages.push([]);y=790;}pages.at(-1).push({text:safe(text),size,y,url});y-=size+9;};
 const wrap=(text,size,url)=>{for(const row of String(text).split('\n')){let chunk='',width=0;for(const ch of row){const w=(ch.charCodeAt(0)>=32&&ch.charCodeAt(0)<127?.6:1)*size;if(width+w>490){line(chunk,size,url);chunk='';width=0;}chunk+=ch;width+=w;}line(chunk,size,url);}};
 wrap(title,19);wrap('Ghost Job Local | '+new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}),9);y-=10;
 for(const item of paragraphs){const p=typeof item==='string'?{text:item}:item;wrap(p.text||'',p.heading?14:11,p.url);y-=7;}
 const objs=[];const add=s=>{objs.push(s);return objs.length;};const catalog=add(''),tree=add('');
 const cmap='/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /GhostUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
 const unicode=add(`<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`);
 const descendant=add('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>');
 const font=add(`<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [${descendant} 0 R] /ToUnicode ${unicode} 0 R >>`),latin=add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>'),pageIDs=[];
 const commands=l=>{let x=48,out='',run='',ascii=null;const flush=()=>{if(!run)return;out+=`BT /${ascii?'F2':'F1'} ${l.size} Tf ${x.toFixed(2)} ${l.y} Td ${ascii?'('+literal(run)+')':'<'+hex(run)+'>'} Tj ET\n`;x+=run.length*l.size*(ascii?.6:1);run='';};for(const ch of l.text){const a=ch.charCodeAt(0)>=32&&ch.charCodeAt(0)<127;if(a!==ascii)flush();ascii=a;run+=ch;}flush();return out;};
 for(const [i,lines]of pages.entries()){const stream=lines.map(commands).join('')+commands({text:`${i+1} / ${pages.length}`,size:9,y:28});const content=add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);const links=lines.filter(l=>/^https?:\/\//.test(l.url||'')).map(l=>add(`<< /Type /Annot /Subtype /Link /Rect [48 ${l.y-2} 548 ${l.y+14}] /Border [0 0 0] /A << /S /URI /URI (${literal(l.url)}) >> >>`));pageIDs.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R /F2 ${latin} 0 R >> >> /Contents ${content} 0 R /Annots [${links.map(n=>n+' 0 R').join(' ')}] >>`));}
 objs[catalog-1]=`<< /Type /Catalog /Pages ${tree} 0 R >>`;objs[tree-1]=`<< /Type /Pages /Count ${pageIDs.length} /Kids [${pageIDs.map(n=>n+' 0 R').join(' ')}] >>`;
 let out='%PDF-1.4\n',offsets=[0];for(let i=0;i<objs.length;i++){offsets.push(Buffer.byteLength(out));out+=`${i+1} 0 obj\n${objs[i]}\nendobj\n`;}const xref=Buffer.byteLength(out);out+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return Buffer.from(out);
}
