import { describe, expect, it } from 'vitest';
import { fitAspect, stackFor } from './media';
import { matchShots, planSegments } from './segments';

const lens = (s: { start: number; end: number }[]) => s.map(x => +(x.end - x.start).toFixed(2));

// 11 Nov, 936637 segment 2: source shots train / crowd runway (0.75 s) / lake / night runway; the output had no crowd runway.
describe('matchShots', () => {
  it('finds the swallowed shot by picture, not by time', () => {
    // rows: output train, lake, night runway; columns: source train, crowd runway, lake, night runway
    const sim = [[0.8, 0.3, 0.2, 0.1], [0.2, 0.35, 0.75, 0.2], [0.1, 0.3, 0.2, 0.7]];
    const r = matchShots(sim, [1.96, 4.3, 6.3], [1.96, 4.3, 5.1, 6.4]);
    expect(r.map).toEqual([0, 2, 3]);
    expect(r.lost).toEqual([1]);
  });
  it('lets a false cut map two output shots to one source shot', () => {
    const r = matchShots([[0.8, 0.1], [0.7, 0.2], [0.1, 0.9]], [1, 2, 4], [1.5, 4]);
    expect(r.map).toEqual([0, 0, 1]);
    expect(r.lost).toEqual([]);
  });
});

describe('画幅', () => {
  it('crops only what the video model refuses', () => {
    expect(fitAspect(1866, 720)).toEqual({ width: 1800, height: 720 });
    expect(fitAspect(720, 2000)).toEqual({ width: 720, height: 1800 });
    expect(fitAspect(1920, 1080)).toBeUndefined();
    expect(fitAspect(1800, 720)).toBeUndefined();
  });
  it('keeps a landscape film landscape in the before/after pair', () => {
    expect(stackFor(true)).toBe('hstack');
    expect(stackFor(false)).toBe('vstack');
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
