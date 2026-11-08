import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { privateIp, scout, SCOUT } from './scout';
import type { Gap } from './types';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-'));
const pic = path.join(dir, 'user.jpg'); fs.writeFileSync(pic, 'x');
const fetchImage = async (_u: string, file: string) => { fs.writeFileSync(file, 'x'); return file; };
const fn = (name: string, args: object, id = name) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
const base = { subject: 'a car', uploads: [pic], dir, log: () => {}, fetchImage };
const gaps: Gap[] = [{ view: 'cabin', label: '内饰', at: 1, kind: 'part' }, { view: 'settings', label: '设置操作', at: 2, kind: 'screen' }, { view: 'front', label: '正面', at: 3 }];

describe('素材员', () => {
  it('searches, looks, then accepts only what it has seen', async () => {
    const turns = [[fn('accept_image', { gap: 0, id: 'web1', why: '没看过' })],
      [fn('view_images', { images: [{ url: 'https://a.cn/1.jpg', page: 'https://a.cn' }] })],
      [fn('accept_image', { gap: 0, id: 'web1', why: '同款方向盘' }), fn('finish', { note: '完成' }, 'f')]];
    const r = await scout({ ...base, gaps, call: async () => turns.shift()! });
    expect(r.found[0]).toMatchObject({ url: 'https://a.cn/1.jpg', page: 'https://a.cn', why: '同款方向盘', label: '内饰' });
    expect(r.rounds).toBe(3);
    expect(r.stopped).toBe('完成');
    expect(r.steps.map(s => s.picks.length)).toEqual([1, 0, 1]);
    expect(r.steps[0].picks[0].refused).toBeTruthy();
    expect(r.steps[1].pics[0]).toMatchObject({ id: 'web1', url: 'https://a.cn/1.jpg' });
  });

  it('never takes a screen operation or a plain angle, and does not run when only those are missing', async () => {
    let called = 0;
    const r = await scout({ ...base, gaps: [gaps[1], gaps[2]], call: async () => { called++; return []; } });
    expect(called).toBe(0);
    expect(r.found).toEqual({});
    const turns = [[fn('view_images', { images: [{ url: 'https://a.cn/2.jpg' }] })], [fn('accept_image', { gap: 1, id: 'web1', why: '屏幕图' })], []];
    expect((await scout({ ...base, gaps, call: async () => turns.shift()! })).found).toEqual({});
  });

  it('reports a picture as soon as it is chosen, and stops when told to', async () => {
    const seen: number[] = [];
    const turns = [[fn('view_images', { images: [{ url: 'https://a.cn/1.jpg' }] })], [fn('accept_image', { gap: 0, id: 'web1', why: '同款' })], [fn('view_images', { images: [] })]];
    let rounds = 0, stopped = false;
    const r = await scout({ ...base, gaps, onFound: g => { seen.push(g); stopped = true; }, stop: () => stopped, call: async () => { rounds++; return turns.shift()!; } });
    expect(seen).toEqual([0]);
    expect(rounds).toBe(2);
    expect(r.stopped).toContain('不再找');
  });

  it('stops at the round limit even if the model never does', async () => {
    let n = 0;
    const r = await scout({ ...base, gaps, call: async () => { n++; return [fn('view_images', { images: [] })]; } });
    expect(n).toBe(SCOUT.rounds);
    expect(r.stopped).toContain('上限');
  });

  it('stops looking when the picture budget runs out', async () => {
    let got = 0;
    await scout({ ...base, gaps, fetchImage: async (u, f) => { got++; return fetchImage(u, f); },
      call: async () => [fn('view_images', { images: [1, 2, 3, 4].map(i => ({ url: `https://a.cn/${i}.jpg` })) })] });
    expect(got).toBe(SCOUT.views);
  });

  it('can reuse a picture already in the library without searching', async () => {
    const known = [{ file: pic, url: 'https://a.cn/old.jpg', label: '内饰' }];
    const turns = [[fn('accept_image', { gap: 0, id: 'lib1', why: '之前找到的' }), fn('finish', { note: '完成' }, 'f')]];
    expect((await scout({ ...base, gaps, known, call: async () => turns.shift()! })).found[0].url).toBe('https://a.cn/old.jpg');
  });

  it('refuses addresses inside the network', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) expect(privateIp(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1']) expect(privateIp(ip)).toBe(false);
  });
});
