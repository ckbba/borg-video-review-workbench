import { describe, expect, it } from 'vitest';
import { planSegs, segPrompt, timeline } from './director';
import { simplePrompt } from './route';
import { applyCopy, assText, captions, fitTempo, trustedSpeech } from './voice';
import type { Plan, ReplicaSeg } from './types';

// The shape of a home-wear ad: short shots, one outfit shown in three colours.
const cuts = [0, 0.87, 1.8, 2.9, 3.67, 4.47, 5.1, 6.37, 9.33, 11.07, 12.67, 14.47, 17.43, 19.93, 22.37, 23.57, 24.5, 27.37, 29.03, 29.96];
const colour: Record<number, string> = { 1: 'B', 2: 'C', 5: 'B' }; // shot index (0-based) → scene; the rest is A
const plan: Plan = {
  subject: 'cream pajamas', target: 'the sweater', keep: 'the plush toys', change: 'the outfit becomes the pajamas', summary: '', views: [], by: 'llm',
  variants: [{ id: 'v1', label: '黄', desc: 'cream yellow', main: true, at: 0.4 }, { id: 'v2', label: '蓝', desc: 'grey blue', main: false, at: 1.3 }, { id: 'v3', label: '粉', desc: 'pale pink', main: false, at: 2.3 }],
  scenes: [{ id: 'A', shots: [], keyAt: 0.4, edit: '', variant: 'v1' }, { id: 'B', shots: [], keyAt: 1.3, edit: '', variant: 'v2' }, { id: 'C', shots: [], keyAt: 2.3, edit: '', variant: 'v3' }],
  shots: cuts.slice(0, -1).map((start, i) => ({ index: i + 1, start, end: cuts[i + 1], change: true, scene: colour[i] || 'A', note: '' }))
};

describe('voice', () => {
  it('drops what Whisper made up over music, keeps real speech', () => {
    expect(trustedSpeech({ start: 0, end: 15, text: '请点赞 订阅 转发 打赏 打赏 打赏', no_speech_prob: 0.517 })).toBe(false);
    expect(trustedSpeech({ start: 0, end: 15, text: '请点赞 订阅 转发 打赏 打赏 打赏', no_speech_prob: 0.1 })).toBe(false);
    expect(trustedSpeech({ start: 2, end: 5, text: '又保暖又舒适的家居服', no_speech_prob: 0.02 })).toBe(true);
    expect(trustedSpeech({ start: 0, end: 1, text: '好', no_speech_prob: 0.1 })).toBe(true);
    // 9 Nov, La Mer: loud talk-over film, every clear line scored 0.60 for no speech but with confident words.
    expect(trustedSpeech({ start: 0, end: 2, text: '诶!海南之民过多少水,你知道吗?', no_speech_prob: 0.6, avg_logprob: -0.32 })).toBe(true);
    expect(trustedSpeech({ start: 0, end: 2, text: '嗯', no_speech_prob: 0.9, avg_logprob: -1.4 })).toBe(false);
  });
});

describe('colour versions', () => {
  const segs = planSegs(plan, 30, 5, 15);

  it('covers the film with no gap and fits every piece in the model limits', () => {
    expect(segs[0].start).toBe(0);
    expect(segs[segs.length - 1].end).toBeCloseTo(29.96);
    segs.forEach((s, i) => {
      if (i) expect(s.start).toBeCloseTo(segs[i - 1].end);
      expect(s.end - s.genStart).toBeLessThanOrEqual(15);
      expect(s.end - s.start).toBeGreaterThanOrEqual(5);
      expect(s.scenes.length).toBeLessThanOrEqual(4);
    });
  });

  it('tells the model which picture rules which seconds, so a 1 s pink shot stays pink', () => {
    const s = { ...segs[0], images: [] } as ReplicaSeg;
    const lines = timeline(plan, s, c => s.scenes.indexOf(c) + 1);
    const pink = lines.find(l => l.startsWith('1.80-2.90s'))!;
    expect(pink).toContain('pale pink');
    expect(pink).toContain(`@image${s.scenes.indexOf('C') + 1}`);
  });

  it('leaves untouched shots alone and stays under the prompt limit', () => {
    const p: Plan = { ...plan, shots: plan.shots.map(x => ({ ...x, note: 'n'.repeat(400), change: x.index !== 2 })) };
    const s = { ...planSegs(p, 30, 5, 15)[0], images: [] } as ReplicaSeg;
    expect(timeline(p, { ...s, genStart: 0, end: 3 }, () => 1).join(' ')).toContain('exactly as in @video1');
    expect(segPrompt(p, s, s.scenes, 1, '', '').length).toBeLessThan(2500);
  });
});

describe('repair prompts', () => {
  it('stays under the limit with a long fix on a busy piece', () => {
    const p: Plan = { ...plan, shots: plan.shots.map(x => ({ ...x, note: 'n'.repeat(400) })) };
    const s = { ...planSegs(p, 30, 5, 15)[0], images: [] } as ReplicaSeg;
    expect(segPrompt(p, s, s.scenes, 0, '', 'x'.repeat(3000)).length).toBeLessThan(2500);
  });
});

describe('segment length', () => {
  it('aims for short pieces and cuts only on real shot changes', () => {
    const segs = planSegs(plan, 30, 5, 15);
    expect(segs.every(s => s.join !== 'soft')).toBe(true);
    expect(Math.max(...segs.map(s => s.end - s.start))).toBeLessThanOrEqual(11);
  });
});

describe('voice and subtitles', () => {
  it('applies the change list to a line', () => {
    expect(applyCopy('超可爱的小企鹅', [{ at: 0, from: '小企鹅', to: '小熊脸', sure: true }])).toBe('超可爱的小熊脸');
  });
  it('speeds a long line up to a limit and never slows one down', () => {
    expect(fitTempo(2, 4)).toBe(1);
    expect(fitTempo(3, 2)).toBe(1.5);
    expect(fitTempo(10, 2)).toBe(1.6);
  });
  it('splits a long line into short captions that fill its time', () => {
    const c = captions([{ start: 2, end: 6, from: '', to: '这是一段非常非常长的前半句话而且完全没有停顿的地方，后半句短。' }]);
    expect(c.length).toBeGreaterThan(1);
    expect(c.every(x => x.to.length <= 16)).toBe(true);
    expect(c[0].start).toBe(2);
    expect(c[c.length - 1].end).toBeCloseTo(6);
  });
  it('writes timed subtitles that end before the next line starts', () => {
    const ass = assText([{ start: 1, end: 3.5, from: '', to: '第一句' }, { start: 3, end: 4, from: '', to: '第二{句}' }], 720, 1280, 'X');
    expect(ass).toContain('Dialogue: 0,0:00:01.00,0:00:03.00,Default,第一句');
    expect(ass).toContain('Default,第二句');
    expect(ass).toContain('PlayResY: 1280');
  });
});

// 10 Nov: "recast them as Russian actors speaking Russian" ended every prompt with "people stay as in the footage" and
// "mouths stay as in @video1"; the model obeyed those and nobody changed.
describe('the user own request beats the fixed rules', () => {
  const seg = planSegs(plan, 30, 5, 15)[0];
  it('keeps people and mouths by default', () => {
    const p = segPrompt(plan, seg, [], 1, '', '');
    expect(p).toContain('The people on screen stay exactly those of the original footage');
    expect(p).toContain('Mouths stay exactly as in @video1');
  });
  it('drops them when the plan recasts and changes the language', () => {
    const p = segPrompt({ ...plan, recast: true, speech: 'Russian' }, seg, [], 1, '', '');
    expect(p).not.toContain('stay exactly those of the original footage');
    expect(p).not.toContain('Mouths stay exactly');
    expect(p).toContain('speak Russian');
    const s = simplePrompt({ ...plan, recast: true, speech: 'Russian' }, 1, '');
    expect(s).not.toContain('people, faces');
    expect(s).toContain('speak Russian');
  });
});

describe('new people', () => {
  it('names each portrait after the keyframes and before the product pictures', () => {
    const seg = planSegs(plan, 30, 5, 15)[0];
    const p = segPrompt({ ...plan, recast: true }, seg, ['A'], 1, '', '', ['俄罗斯男演员']);
    expect(p).toContain('who is 俄罗斯男演员 with the person in @image2');
    expect(p).toContain('@image3 shows');
  });
});
