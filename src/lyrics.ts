export type LyricRow={id:string;start:number;end:number;text:string};
export function parseTimedPrompt(text:string,offset=0,prefix='p'):LyricRow[]{
 const rows:LyricRow[]=[];let n=0;
 for(const raw of text.split(/\r?\n/)){
  const line=raw.trim();if(!line)continue;
  const matches=[...line.matchAll(/(\d+(?:\.\d+)?)\s*(?:-|–|—|~|至)\s*(\d+(?:\.\d+)?)\s*秒?\s*[：:]?\s*([^\n]+)/g)];
  if(!matches.length)continue;
  const m=matches.at(-1)!;let content=(m[3]||'').trim();
  content=content.replace(/^\s*(?:硬切[。.]?\s*)/,'').trim();
  rows.push({id:`${prefix}-${n++}`,start:offset+Number(m[1]),end:offset+Number(m[2]),text:content});
 }
 return rows;
}
export function passageAtTime(rows:LyricRow[],time:number){return rows.find(x=>time>=x.start&&time<x.end)||rows.filter(x=>x.start<=time).at(-1)||rows[0];}
