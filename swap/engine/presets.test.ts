import { describe, expect, it } from 'vitest';
import { buildPrompt, needsImage } from './presets';
import { listTemplates } from './templates';

describe('buildPrompt', () => {
  it('a swap keeps everything and binds the target frame', () => {
    const { prompt, check } = buildPrompt('product-swap', 'the man', { object: 'cup', product: 'can' }, true);
    expect(prompt).toMatch(/^Edit @video1\. Keep absolutely everything/);
    expect(prompt).toContain('the cup in the hand: it becomes the can from @image1');
    expect(check).toBe('swap');
  });
  it('a restyle never says "keep the light"', () => {
    const { prompt } = buildPrompt('anime', 'the man', { place: 'the street' }, false);
    expect(prompt).toMatch(/^Restyle @video1 completely/);
    expect(prompt).not.toMatch(/keep absolutely everything|the light and the timing/i);
    expect(prompt).not.toContain('first frame of the result');
  });
  it('refuses a missing placeholder', () => {
    expect(() => buildPrompt('recast', 'the man', {}, true)).toThrow(/new_person/);
  });
  it('knows which presets need a picture', () => {
    expect(needsImage('recast')).toBe(true);
    expect(needsImage('time-of-day')).toBe(false);
  });
});

describe('templates', () => {
  it('every template loads and builds its prompts', () => {
    for (const t of listTemplates()) {
      expect(() => buildPrompt(t.slot.preset, t.who, t.slot.fill, true)).not.toThrow();
      for (const v of t.versions) expect(() => buildPrompt(v.preset, t.whoAfter || 'x', v.fill, false)).not.toThrow();
      for (const m of t.slot.modes || []) expect(() => buildPrompt(m.preset || t.slot.preset, t.who, m.fill, true)).not.toThrow();
      for (const o of (t.choices || []).flatMap(c => c.options)) expect(() => buildPrompt(o.preset, o.who || 'x', o.fill, true)).not.toThrow();
    }
  });
});
