import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('商品库', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'products-'));
  vi.stubEnv('SWAP_PRODUCTS', root);
  const m = await import('./products');

  it('keeps one copy of the same photo, remembers its angle, and never deletes files', () => {
    const p = m.createProduct('安踏 C202');
    const a = path.join(root, 'a.png'); fs.writeFileSync(a, 'front');
    const b = path.join(root, 'b.jpg'); fs.writeFileSync(b, 'side');
    m.addPhotos(p.id, [{ file: a }, { file: b }], 'job-1');
    m.addPhotos(p.id, [{ file: a }, { file: b, angle: '侧面' }], 'job-2');
    const q = m.getProduct(p.id);
    expect(q.photos.map(x => x.angle)).toEqual([undefined, '侧面']);
    expect(m.photoFiles(q).map(f => fs.readFileSync(f, 'utf8'))).toEqual(['front', 'side']);
    m.hidePhoto(p.id, q.photos[0].file);
    expect(m.getProduct(p.id).photos).toHaveLength(1);
    expect(fs.existsSync(m.photoFiles(q)[0])).toBe(true);
  });

  it('keeps pictures found online apart from real photos', () => {
    const p = m.createProduct('理想 i8');
    const a = path.join(root, 'real.png'); fs.writeFileSync(a, 'real');
    const b = path.join(root, 'web.jpg'); fs.writeFileSync(b, 'web');
    m.addPhotos(p.id, [{ file: a }]);
    m.addPhotos(p.id, [{ file: b, angle: '内饰', url: 'https://a.cn/1.jpg' }]);
    const q = m.getProduct(p.id);
    expect(m.photoFiles(q).map(f => fs.readFileSync(f, 'utf8'))).toEqual(['real']);
    expect(m.webPhotos(q)).toMatchObject([{ url: 'https://a.cn/1.jpg', label: '内饰' }]);
  });

  it('dedupes notes and rejects bad ids', () => {
    const p = m.createProduct('Nike Uptempo');
    m.addNote(p.id, 'AIR 字母顺序是 A-I-R');
    m.addNote(p.id, 'AIR 字母顺序是 A-I-R');
    expect(m.getProduct(p.id).notes).toHaveLength(1);
    expect(() => m.getProduct('../jobs')).toThrow();
    expect(m.listProducts().map(x => x.name).sort()).toEqual(['Nike Uptempo', '安踏 C202', '理想 i8'].sort());
  });
});
