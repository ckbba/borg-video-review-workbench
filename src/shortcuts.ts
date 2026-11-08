export type ShortcutAction={type:'toggle'}|{type:'seek';time:number}|{type:'rate';rate:number}|{type:'none'};
export function resolveReviewKey(key:string,time:number,lastPressAt:number,stamps:number[],now=Date.now(),currentRate=1):ShortcutAction{
 if(key===' '||key==='Spacebar')return{type:'toggle'};
 if(key!=='ArrowLeft'&&key!=='ArrowRight')return{type:'none'};
 const double=lastPressAt>0&&now-lastPressAt<=300;
 if(double){const target=key==='ArrowLeft'?.5:1.5;return{type:'rate',rate:currentRate===target?1:target}};
 if(key==='ArrowLeft'){const previous=stamps.filter(x=>x<time-.05).at(-1);return{type:'seek',time:previous??0}}
 const next=stamps.find(x=>x>time+.05);return{type:'seek',time:next??time};
}
// ↑/↓: previous/next record in the same list; stays put at either end
export function adjacentId(ids:string[],current:string,key:string):string|null{
 if(key!=='ArrowUp'&&key!=='ArrowDown')return null;
 const i=ids.indexOf(current),j=i+(key==='ArrowUp'?-1:1);
 return i<0||j<0||j>=ids.length?null:ids[j];
}
