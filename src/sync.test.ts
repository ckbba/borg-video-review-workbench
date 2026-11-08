import { describe, expect, it, vi } from 'vitest';
import { follow, recreationTarget } from './sync';

const video = (o: Partial<HTMLVideoElement>) => ({ currentTime: 0, duration: 10, paused: true, seeking: false, readyState: 4, playbackRate: 1, play: vi.fn(function (this: any) { this.paused = false; return Promise.resolve(); }), pause: vi.fn(function (this: any) { this.paused = true; }), ...o }) as any as HTMLVideoElement;

describe('recreation follows the source clock', () => {
  it('maps source time into the clip and flags out-of-range', () => {
    expect(recreationTarget(35, 32.3, 10)).toEqual({ t: 2.7000000000000028, inside: true });
    expect(recreationTarget(45, 32.3, 10)).toMatchObject({ t: 10, inside: false });
    expect(recreationTarget(20, 32.3, 10)).toMatchObject({ t: 0, inside: false });
  });
  it('starts the clip at the offset position instead of the raw source time', () => {
    const src = video({ currentTime: 33.3, paused: false }), rec = video({});
    follow(src, rec, 32.3, 1, true);
    expect(rec.currentTime).toBeCloseTo(1);
    expect(rec.play).toHaveBeenCalled();
  });
  it('restarts a clip that had ended once the source is back in range', () => {
    const src = video({ currentTime: 34, paused: false }), rec = video({ currentTime: 10, paused: true });
    follow(src, rec, 32.3, 1, true);
    expect(rec.currentTime).toBeCloseTo(1.7);
    expect(rec.paused).toBe(false);
  });
  it('absorbs small drift with playbackRate instead of seeking', () => {
    const src = video({ currentTime: 35, paused: false }), rec = video({ currentTime: 2.4, paused: false });
    follow(src, rec, 32.3, 1, true);
    expect(rec.currentTime).toBe(2.4);
    expect(rec.playbackRate).toBeGreaterThan(1);
  });
  it('holds the source while the clip is buffering', () => {
    const src = video({ currentTime: 35, paused: false }), rec = video({ currentTime: 2.7, readyState: 2 });
    follow(src, rec, 32.3, 1, true);
    expect(src.paused).toBe(true);
    (rec as any).readyState = 4;
    follow(src, rec, 32.3, 1, true);
    expect(src.play).toHaveBeenCalled();
  });
  it('rests the clip when the source is outside its range', () => {
    const src = video({ currentTime: 50, paused: false }), rec = video({ currentTime: 9.9, paused: false });
    follow(src, rec, 32.3, 1, true);
    expect(rec.paused).toBe(true);
    expect(rec.currentTime).toBe(10);
  });
});
