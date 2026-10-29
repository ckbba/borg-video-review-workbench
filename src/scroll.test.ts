import{describe,expect,it}from'vitest';import{centeredScrollTop}from'./scroll';
describe('prompt auto-scroll',()=>{it('centers the active prompt inside its own rail',()=>{expect(centeredScrollTop(300,40,120)).toBe(260)});it('never scrolls above zero',()=>{expect(centeredScrollTop(10,40,120)).toBe(0)})});
