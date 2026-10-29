import type { Passage, Project } from './model';
import { parseTimedPrompt } from './lyrics';

const SESSION='local-caf1e85fc186c7f35fbb3080e028da383f4873e84857827897efa14361fb1ff1';
const DOC='https://jcnbwn76mhrv.feishu.cn/wiki/Nh4Nw7tVeiZqVtkD2Wbcu4tHnFf';

function firstTimedLine(text:string, offset:number, index:number):Passage {
  const lines=text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const timed=lines.find(x=>/\d+(?:\.\d+)?\s*(?:-|–|—|~|至)\s*\d/.test(x)) || lines[0] || `第${index+1}段提示词`;
  return {id:`fold8-passage-${index+1}`,start:offset,end:offset+30,text:`第${index+1}段完整提示词｜${text}`};
}

export function timedPassagesForPrompt(text:string,offset:number,prefix:string):Passage[]{return parseTimedPrompt(text,offset,prefix)}

export function createSeedProject(prompts:string[]):Project {
  const recreationId='fold8-recreation-full-v1';
  const passages=prompts.flatMap((p,i)=>timedPassagesForPrompt(p,i*30,`seg${i+1}`));
  return {
    id:'fold8-aero-hound-seed-project',
    name:'蜘蛛侠 Fold8 广告复刻｜飞狗侠替换 × Seedance 2.5',
    source:{name:'三星手机蜘蛛侠.mp4',url:'/media/spiderman-fold8-original-h264.mp4',duration:116.588798},
    recreations:[
      {id:recreationId,name:'飞狗侠_Galaxy广告复刻_四段完整版.mp4',url:'/media/aero-hound-full.mp4',duration:120.32,attemptNo:1,label:'四段完整复刻 V1',promptVersion:1,sourceOffset:0,sourceEnd:120},
      ...[1,2,3,4].map((n,i)=>({id:`fold8-recreation-segment-${n}`,name:`飞狗侠_第${n}段_Seedance2.5.mp4`,url:`/media/aero-hound-segment-${n}.mp4`,duration:30.08,attemptNo:n+1,label:`第${n}段独立复刻`,promptVersion:1,sourceOffset:i*30,sourceEnd:(i+1)*30}))
    ],
    selectedRecreationId:recreationId,
    promptVersions:[{version:1,text:prompts.map((p,i)=>`【第${i+1}段｜${i*30}-${(i+1)*30}秒】\n${p}`).join('\n\n'),passages}],
    notes:[], sessionId:SESSION, createdAt:new Date().toISOString(),
    sourceDocUrl:DOC
  } as Project & {sourceDocUrl:string};
}
