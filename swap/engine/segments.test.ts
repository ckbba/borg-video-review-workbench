import { describe, expect, it } from 'vitest';
import { fitAspect } from './media';
import { planSegments } from './segments';

const lens = (s: { start: number; end: number }[]) => s.map(x => +(x.end - x.start).toFixed(2));

describe('画幅', () => {
  it('crops only what the video model refuses', () => {
    expect(fitAspect(1866, 720)).toEqual({ width: 1800, height: 720 });
    expect(fitAspect(720, 2000)).toEqual({ width: 720, height: 1800 });
    expect(fitAspect(1920, 1080)).toBeUndefined();
    expect(fitAspect(1800, 720)).toBeUndefined();
  });
});

describe('planSegments', () => {
  it('keeps a short clip whole', () => {
    expect(planSegments(10, [4], 4, 15)).toEqual([{ index: 0, start: 0, end: 10, join: 'start' }]);
  });
  it('splits a 30 s clip with one long shot: soft inside the shot, hard at the cut', () => {
    const s = planSegments(30.09, [21.25], 5, 15);
    expect(s.map(x => x.join)).toEqual(['start', 'soft', 'hard']);
    expect(s[2].start).toBe(21.25);
    expect(Math.max(...lens(s))).toBeLessThanOrEqual(15);
  });
  it('merges short shots up to the limit', () => {
    const s = planSegments(24, [3, 6, 9, 12, 18], 4, 12);
    expect(s.length).toBe(2);
    expect(s[1].join).toBe('hard');
  });
  it('never leaves a piece under the minimum', () => {
    const s = planSegments(31, [15, 29], 5, 15);
    expect(Math.min(...lens(s))).toBeGreaterThanOrEqual(5);
    expect(Math.max(...lens(s))).toBeLessThanOrEqual(15);
    expect(s.at(-1)!.end).toBe(31);
  });
});
