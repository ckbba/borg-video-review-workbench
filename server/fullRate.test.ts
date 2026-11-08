import { describe, expect, it } from 'vitest';
import { planFrames, Segment } from './fullRate';

const coarse = Array.from({ length: 150 }, (_, k) => Math.round(k / 5 * 100) / 100); // 30s at 5fps
const seg = (start: number, end: number, level: 'A' | 'B'): Segment => ({ start, end, level, why: '', questions: [] });
const rate = { A: 10, B: 25 };

describe('全片定频 frame plan', () => {
  it('a 0.2s B-level close gets native-rate frames, not just the 1–2 coarse ones', () => {
    const p = planFrames({ start: 18.84, end: 20.72 }, coarse, [seg(19.0, 19.2, 'B')], rate, false);
    expect(p.ts.filter(t => t >= 19 && t <= 19.2).length).toBeGreaterThanOrEqual(5);
    expect(p.coarse).toBe(9);
  });
  it('A-level segments use the lower rate', () => {
    const p = planFrames({ start: 6.68, end: 9.08 }, coarse, [seg(7, 8, 'A')], rate, false);
    expect(p.dense).toBe(11);
  });
  it('cut review adds the first and last frame of the shot', () => {
    const p = planFrames({ start: 2.84, end: 4 }, coarse, [], rate, true);
    expect(p.ts[0]).toBeCloseTo(2.86, 2);
    expect(p.ts[p.ts.length - 1]).toBeCloseTo(3.98, 2);
  });
  it('has no per-shot cap: a 2.4s B segment keeps all ~60 frames', () => {
    const p = planFrames({ start: 6.68, end: 9.08 }, coarse, [seg(6.68, 9.08, 'B')], rate, true);
    expect(p.ts.length).toBeGreaterThan(55);
  });
});
