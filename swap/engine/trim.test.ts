import { describe, expect, it } from 'vitest';
import { keptSpans, remap, spanSeconds, trimPlan } from './trim';
import type { Plan } from './types';

const shot = (index: number, start: number, end: number, scene: string, fit?: 'good' | 'rough' | 'no') => ({ index, start, end, change: true, scene, note: '', fit });
const plan: Plan = {
  by: 'llm', subject: '', target: '', keep: '', change: '', summary: '', views: [],
  variants: [{ id: 'v1', label: '主款', desc: '', main: true, at: 3.5 }],
  scenes: [{ id: 'A', shots: [1, 3], keyAt: 0.5, edit: '', variant: 'v1' }, { id: 'B', shots: [2], keyAt: 2.5, edit: '', variant: 'v1' }, { id: 'C', shots: [4], keyAt: 6.5, edit: '', variant: 'v1' }],
  shots: [shot(1, 0, 2, 'A'), shot(2, 2, 3, 'B', 'no'), shot(3, 3, 5, 'A', 'rough'), shot(4, 5, 8, 'C', 'no')],
  gaps: [{ view: 'cabin', label: '内饰', at: 4, kind: 'part', shots: [3] }, { view: 'ui', label: '设置', at: 2.2, kind: 'screen', shots: [2] }]
};

describe('只复刻能做的部分', () => {
  it('keeps every shot that is not "no", joined where they touch', () => {
    expect(keptSpans(plan)).toEqual([{ start: 0, end: 2 }, { start: 3, end: 5 }]);
    expect(spanSeconds(keptSpans(plan))).toBe(4);
  });

  it('moves times onto the cut film', () => {
    const s = keptSpans(plan);
    expect(remap(0.5, s)).toBe(0.5);
    expect(remap(3.5, s)).toBe(2.5);
    expect(remap(2.5, s)).toBeUndefined();
    expect(remap(6, s)).toBeUndefined();
  });

  it('renumbers shots, drops empty scenes, and moves keyframes, colours, gaps and captions', () => {
    const t = trimPlan(plan, [{ at: 1, from: 'a', to: 'b', sure: true }, { at: 2.5, from: 'c', to: 'd', sure: true }, { at: 4.2, from: 'e', to: 'f', sure: true }], keptSpans(plan));
    expect(t.plan.shots.map(s => [s.index, s.start, s.end])).toEqual([[1, 0, 2], [2, 2, 4]]);
    expect(t.plan.scenes.map(c => [c.id, c.shots, c.keyAt])).toEqual([['A', [1, 2], 0.5]]);
    expect(t.plan.variants[0].at).toBe(2.5);
    expect(t.plan.gaps!.map(g => [g.label, g.at, g.shots])).toEqual([['内饰', 3, [2]]]);
    expect(t.copy.map(c => [c.from, c.at])).toEqual([['a', 1], ['e', 3.2]]);
  });
});
