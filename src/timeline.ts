export const toRecreationTime=(sourceTime:number,offset:number)=>Math.max(0,sourceTime-offset);
export const toSourceTime=(recreationTime:number,offset:number)=>recreationTime+offset;
