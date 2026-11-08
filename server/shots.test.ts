import { describe, expect, it } from 'vitest';
import { denseTimes } from './shots';

describe('two-pass dense sampling', () => {
  it('keeps the coarse frames when no complex segment overlaps the shot', () => {
    expect(denseTimes(10, 13, [{ start: 20, end: 22 }], 4, [10.4, 11.5, 12.6])).toEqual([10.4, 11.5, 12.6]);
  });
  it('adds frames every 1/fps inside the overlapping part only', () => {
    expect(denseTimes(10, 13, [{ start: 11, end: 12 }], 4, [10.4, 11.5, 12.6])).toEqual([10.4, 11, 11.25, 11.5, 11.75, 12, 12.6]);
  });
  it('caps the number of frames, keeping first and last', () => {
    const ts = denseTimes(0, 10, [{ start: 0, end: 10 }], 4, [1, 5, 9], 12);
    expect(ts).toHaveLength(12); expect(ts[0]).toBe(0.04); expect(ts.at(-1)!).toBeGreaterThan(9.7);
  });
});
