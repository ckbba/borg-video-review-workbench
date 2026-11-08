import { describe, expect, it } from 'vitest';
import { parsePicks, photosForScenes } from './picks';

const up = ['full.png', 'back.png', 'flat.png', 'half.png'];

describe('按镜头挑图', () => {
  it('turns numbers into files and drops what makes no sense', () => {
    const p = parsePicks({
      photos: [{ n: 3, view: '平铺' }, { n: 9, view: '不存在' }],
      scenes: [{ id: 'A', order: [4, 4, 9, 3, 1, 2], why: '特写' }, { id: 'Z', order: [1] }, { id: 'B', order: [] }],
      issue: '第 3 张偏色'
    }, up, ['A', 'B']);
    expect(p.scenes.A).toEqual({ files: ['half.png', 'flat.png', 'full.png'], why: '特写' });
    expect(p.scenes.B).toBeUndefined();
    expect(p.scenes.Z).toBeUndefined();
    expect(p.photos).toEqual([{ file: 'flat.png', view: '平铺', note: '' }]);
    expect(p.issue).toBe('第 3 张偏色');
  });

  it('survives a reply with nothing usable', () => {
    expect(parsePicks({}, up, ['A'])).toEqual({ photos: [], scenes: {}, issue: undefined });
    expect(parsePicks(null, up, ['A']).scenes).toEqual({});
  });

  it('gives a piece each scene\'s best photo before anyone\'s second best', () => {
    const picks = { photos: [], scenes: { A: { files: ['half.png', 'flat.png'], why: '' }, B: { files: ['back.png', 'half.png'], why: '' } } };
    expect(photosForScenes(picks, ['A', 'B'], up)).toEqual(['half.png', 'back.png', 'flat.png']);
  });

  it('falls back to upload order without picks', () => {
    expect(photosForScenes(undefined, ['A'], up)).toEqual(up);
    expect(photosForScenes({ photos: [], scenes: {} }, ['A'], up)).toEqual(up);
  });
});
