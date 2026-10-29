import { describe, expect, it } from 'vitest';
import { createSeedProject, timedPassagesForPrompt } from './seed';

describe('seed project', () => {
  it('keeps only timestamped shot lines in passages', () => {
    const prompt='角色资产前缀，不应显示\n0-2秒：开场\n声音：也不应显示';
    const rows=timedPassagesForPrompt(prompt,0,'seg1');
    expect(rows.map(x=>x.text)).toEqual(['开场']);
  });
  it('builds one full-length project from four segment prompts', () => {
    const p = createSeedProject(['0-2 first','0-3 second','0-4 third','0-5 fourth']);
    expect(p.name).toContain('蜘蛛侠 Fold8');
    expect(p.source.url).toBe('/media/spiderman-fold8-original-h264.mp4');
    expect(p.recreations[0].url).toBe('/media/aero-hound-full.mp4');
    expect(p.promptVersions[0].passages.map(x=>x.start)).toEqual([0,30,60,90]);
    expect(p.sessionId).toContain('local-caf1e85');
  });
});
