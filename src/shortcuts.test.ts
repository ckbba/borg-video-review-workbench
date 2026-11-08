import {describe,expect,it}from'vitest';import{adjacentId,resolveReviewKey}from'./shortcuts';
const stamps=[0,2,4.2,8.2,9,13];
describe('review shortcuts',()=>{
 it('toggles playback with space',()=>expect(resolveReviewKey(' ',10,0,stamps,0,1)).toEqual({type:'toggle'}));
 it('single arrows jump to adjacent prompt timestamps',()=>{expect(resolveReviewKey('ArrowLeft',10,0,stamps,0,1)).toEqual({type:'seek',time:9});expect(resolveReviewKey('ArrowRight',10,0,stamps,0,1)).toEqual({type:'seek',time:13})});
 it('double arrows set review speed',()=>{expect(resolveReviewKey('ArrowLeft',10,100,stamps,250,1)).toEqual({type:'rate',rate:.5});expect(resolveReviewKey('ArrowRight',10,100,stamps,250,1)).toEqual({type:'rate',rate:1.5})});
 it('repeating the same double-speed gesture restores 1x',()=>{expect(resolveReviewKey('ArrowLeft',10,100,stamps,250,.5)).toEqual({type:'rate',rate:1});expect(resolveReviewKey('ArrowRight',10,100,stamps,250,1.5)).toEqual({type:'rate',rate:1})});
});
describe('record shortcuts',()=>{
 it('up/down move to the previous/next record',()=>{expect(adjacentId(['a','b','c'],'b','ArrowUp')).toBe('a');expect(adjacentId(['a','b','c'],'b','ArrowDown')).toBe('c')});
 it('stays put at either end and ignores other keys',()=>{expect(adjacentId(['a','b'],'a','ArrowUp')).toBeNull();expect(adjacentId(['a','b'],'b','ArrowDown')).toBeNull();expect(adjacentId(['a','b'],'a','ArrowLeft')).toBeNull()});
});
