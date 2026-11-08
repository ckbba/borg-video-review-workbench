import { describe, expect, it } from 'vitest';
import { fromBase, parseGenPrompt, rangeFromLabel, shotsAt } from './base';

describe('feishu base mapping', () => {
  it('reads the source range from generation labels', () => {
    expect(rangeFromLabel('第2段 30-60s')).toEqual([30, 60]);
    expect(rangeFromLabel('U05-A｜原片34.2–38.8s｜首次提交')).toEqual([34.2, 38.8]);
    expect(rangeFromLabel('V3-A｜原片32.3–41.1s｜6镜头一次生成')).toEqual([32.3, 41.1]);
  });
  it('parses only shot lines, ignoring times mentioned inside sound/constraint text', () => {
    const p = parseGenPrompt('【参考图职责】\n【镜头1｜0.0–1.8秒｜报废箱近景】固定机位。\n【1.8秒硬切】\n【镜头5｜6.5–7.95秒｜低机位侧面】折纸。\n【镜头6｜7.95–10.0秒｜纸片特写】开合。\n【声音】镜头3咔哒声；镜头5–6纸张沙沙声。\n2.0–4.2秒：街谷大全景\n4.2–5.0秒：后期删除', 32.3, 41.1, 'x');
    expect(p.map(x => [x.start, x.end, x.text])).toEqual([[32.3, 34.1, '镜头1｜报废箱近景｜固定机位。'], [34.3, 36.5, '街谷大全景'], [36.5, 37.3, '后期删除'], [38.8, 40.25, '镜头5｜低机位侧面｜折纸。'], [40.25, 41.1, '镜头6｜纸片特写｜开合。']]);
  });
  it('accepts V1-style lines that start with a hard-cut cue', () => {
    const p = parseGenPrompt('0.0-1.0秒：屋顶大全景\n1.0秒硬切。1.0-1.6秒：极远景仰拍\n1.6秒硬切。1.6-2.6秒：水塔爆裂', 30, 60, 'v1');
    expect(p.map(x => [x.start, x.end, x.text])).toEqual([[30, 31, '屋顶大全景'], [31, 31.6, '极远景仰拍'], [31.6, 32.6, '水塔爆裂']]);
  });
  it('handles cue without 秒, open-ended headers and headers whose text is on the next line', () => {
    const p = parseGenPrompt('0.0-2.0秒：城市\n2.0硬切。2.0-4.2秒：街谷\n26.4-28.4秒高密度夜战蒙太奇：近战', 0, 30, 'a');
    expect(p.map(x => [x.start, x.end, x.text])).toEqual([[0, 2, '城市'], [2, 4.2, '街谷'], [26.4, 28.4, '高密度夜战蒙太奇：近战']]);
    const q = parseGenPrompt('【镜头1｜0.0–1.45秒｜第三人称】\n摄影机在桌面高度。\n【1.45秒硬切】\n【镜头2｜1.45秒起｜斜俯特写】\n双手开合纸卡。\n【声音】沙沙声', 38.8, 41.1, 'b');
    expect(q.map(x => [x.start, x.end, x.text])).toEqual([[38.8, 40.25, '镜头1｜第三人称｜摄影机在桌面高度。'], [40.25, 41.1, '镜头2｜斜俯特写｜双手开合纸卡。']]);
    const u = parseGenPrompt('【动作分拍｜镜头1｜本地时间0.0–3.8秒｜通信】硬切到近特写', 61.8, 66.4, 'c');
    expect(u[0].text).toBe('动作分拍｜镜头1｜通信｜硬切到近特写');
  });
  it('builds a project whose recreations are offset into the source timeline', () => {
    const { project, original } = fromBase({
      cases: [], case: { id: 'c1', name: 'Case', duration: 120, source: { url: '/s.mp4', name: 's.mp4' } },
      shots: [{ id: 's1', code: 'S01', start: 30, end: 32, text: '开场', verified: null }],
      gens: [{ id: 'g1', label: '第2段 30-60s', version: 'V1', adopted: true, shotIds: [], prompt: '0-2秒：开场\n2-4秒：追逐', video: { url: '/g.mp4', name: 'g.mp4' }, score: '', verdict: '' }],
      notes: [{ id: 'n1', localId: '', at: 31, start: 30, end: 32, body: '好', keep: '', change: '', genId: 'g1', target: '', createdAt: '' }]
    });
    expect(project.recreations[0]).toMatchObject({ id: 'g1', group: 'V1', sourceOffset: 30 });
    expect(project.promptVersions[0].passages.map(p => [p.start, p.end])).toEqual([[30, 32], [32, 34]]);
    expect(project.notes[0].recreationId).toBe('g1');
    expect(shotsAt(original, 31)).toEqual(['s1']);
  });
});

import { findPromptLine, splitPromptRefs } from './base';
describe('prompt asset references', () => {
  const assets: any[] = [{ id: 'a', name: '飞狗侠' }, { id: 'b', name: '实验室' }];
  it('maps @图片N to the Nth referenced asset and flags dangling ones', () => {
    const p = splitPromptRefs('@图片1锁定身份，@图片3只约束构图', assets);
    expect(p).toEqual([{ ref: 1, asset: assets[0] }, { text: '锁定身份，' }, { ref: 3, asset: null }, { text: '只约束构图' }]);
  });
  it('finds the line a workbench passage came from', () => {
    const lines = ['【参考图职责】', '【镜头3｜2.7–5.0秒｜双手大特写，最关键】高位斜俯拍双手与桌面', '3.0–3.3秒：双手把两半沿断口对齐、拼合到一起。'];
    expect(findPromptLine(lines, '镜头3｜双手大特写，最关键｜高位斜俯拍双手与桌面')).toBe(1);
    expect(findPromptLine(lines, '双手把两半沿断口对齐、拼合到一起。')).toBe(2);
    expect(findPromptLine(lines, '完全不相关的文字')).toBe(-1);
  });
});

import { markQuotes } from './base';
describe('annotation highlights', () => {
  it('wraps each quoted span and skips overlaps and missing quotes', () => {
    expect(markQuotes('0.43s，一只手从画面右下方伸入，握住相机', [{ id: 'a', quote: '一只手从画面右下方伸入' }, { id: 'b', quote: '右下方伸入，握住' }, { id: 'c', quote: '不存在' }]))
      .toEqual([{ text: '0.43s，' }, { text: '一只手从画面右下方伸入', noteId: 'a' }, { text: '，握住相机' }]);
  });
});
