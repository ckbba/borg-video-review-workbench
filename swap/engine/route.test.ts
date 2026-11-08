import { describe, expect, it } from 'vitest';
import { routeOf, simplePrompt } from './route';
import type { Plan } from './types';

const shot = (index: number, change = true) => ({ index, start: index - 1, end: index, change, scene: 'A', note: '', fit: 'good' as const });
const easy: Plan = { by: 'llm', subject: 's', target: 'the top', keep: '', change: '', summary: '', views: [], variants: [{ id: 'v1', label: '款', desc: '', main: true, at: 0 }],
  scenes: [{ id: 'A', shots: [1, 2], keyAt: 0, edit: '' }], shots: [shot(1), shot(2)] };

describe('路线', () => {
  const route = (p: Partial<Plan>, s = 15, force = '') => routeOf({ ...easy, ...p }, s, 15, force);

  it('sends a one-product, one-scene film the short way, even a touch over the limit', () => {
    expect(route({}).kind).toBe('simple');
    expect(route({}, 15.09).kind).toBe('simple');
    expect(route({ gaps: [{ view: 'side', label: '侧面', at: 1 }] }).kind).toBe('simple');
  });

  it('names every reason a film needs the full route', () => {
    const r = route({ variants: [...easy.variants, { id: 'v2', label: '蓝', desc: '', main: false, at: 1 }],
      scenes: [...easy.scenes, { id: 'B', shots: [], keyAt: 1, edit: '' }], shots: [shot(1), { ...shot(2, false), fit: 'no' }],
      gaps: [{ view: 'cabin', label: '内饰', at: 1, kind: 'part' }] }, 40);
    expect(r.kind).toBe('full');
    expect(r.reasons).toHaveLength(6);
    expect(r.reasons.join()).toContain('内饰');
  });

  it('does not guess when the planning model gave no answer', () => {
    expect(route({ by: 'basic' }).kind).toBe('full');
  });

  it('can be forced', () => {
    expect(route({ by: 'basic' }, 15, 'simple').kind).toBe('simple');
    expect(route({}, 15, 'full').kind).toBe('full');
  });
});

describe('简单路线的提示词', () => {
  it('says which picture is for what, and stays short', () => {
    const p = simplePrompt(easy, 3, '');
    expect(p).toContain('with the one in @image1');
    expect(p).toContain('@image2 and @image3');
    expect(p.length).toBeLessThan(300);
  });
  it('has no detail line for one picture', () => {
    expect(simplePrompt(easy, 1, '')).not.toContain('@image2');
  });
});
