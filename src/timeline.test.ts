import{describe,expect,it}from'vitest';import{toRecreationTime,toSourceTime}from'./timeline';
describe('segment timeline mapping',()=>{
 it('maps global source time to local segment time',()=>expect(toRecreationTime(35,30)).toBe(5));
 it('maps local recreation time to global source time',()=>expect(toSourceTime(5,30)).toBe(35));
});
