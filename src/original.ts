import type{Passage}from'./model';
const seconds=(s:string)=>{const p=s.split(':').map(Number);return p.length===2?p[0]*60+p[1]:p[0]};
export function parseOriginalAnalysis(md:string):Passage[]{const hits=[...md.matchAll(/^### 镜头\s+\d+｜(\d{2}:\d{2}(?:\.\d+)?)–(\d{2}:\d{2}(?:\.\d+)?)([\s\S]*?)(?=^### 镜头|^## |$(?![\s\S]))/gm)];return hits.map((m,i)=>{const lines=m[3].split(/\r?\n/).map(x=>x.replace(/^- \*\*[^*]+\*\*[：:]?/,'').trim()).filter(Boolean);return{id:`source-shot-${i+1}`,start:seconds(m[1]),end:seconds(m[2]),text:lines.join(' ')}})}
