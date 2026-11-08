// 商品库: real photos and known pitfalls of one product, kept across jobs so the next film starts from them.
//
// Only real photos go in (the user's uploads and the angles they add on 开始前确认); generated sheets and recolours
// do not: a sheet that passed its check still invented blue lines on the Anta shoe (5 Nov).
// Lives outside swap/data on purpose, and nothing here ever deletes a file: removing a photo only drops it from the
// list. An empty variable once wiped swap/data/jobs (6 Nov).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PRODUCTS = path.resolve(process.env.SWAP_PRODUCTS || 'swap/products');

/** origin 'web' = found online; 'part' = the user's own photo of a part (a car's cabin). Neither is a photo of the whole thing. */
export type ProductPhoto = { file: string; angle?: string; from?: string; added: number; origin?: 'web' | 'part'; url?: string; page?: string };
export type ProductNote = { text: string; from?: string; added: number };
export type Product = { id: string; name: string; created: number; updated: number; photos: ProductPhoto[]; notes: ProductNote[]; jobs: string[] };

const ID = /^p-\d{8}-[0-9a-f]{6}$/;
const dirOf = (id: string) => {
  if (!ID.test(id)) throw new Error('商品编号不对');
  return path.join(PRODUCTS, id);
};
const fileOf = (id: string) => path.join(dirOf(id), 'product.json');

export function getProduct(id: string): Product {
  const f = fileOf(id);
  if (!fs.existsSync(f)) throw new Error('找不到这个商品');
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function save(p: Product) {
  p.updated = Date.now();
  const f = fileOf(p.id), tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(p, null, 1));
  fs.renameSync(tmp, f);
  return p;
}
const edit = (id: string, fn: (p: Product) => void) => { const p = getProduct(id); fn(p); return save(p); };

export function listProducts(): Product[] {
  if (!fs.existsSync(PRODUCTS)) return [];
  return fs.readdirSync(PRODUCTS).filter(d => ID.test(d) && fs.existsSync(fileOf(d))).map(getProduct).sort((a, b) => b.updated - a.updated);
}

export function createProduct(name: string): Product {
  const n = name.trim().slice(0, 60);
  if (!n) throw new Error('请给商品起个名字');
  const d = new Date(), day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const id = `p-${day}-${crypto.randomBytes(3).toString('hex')}`;
  fs.mkdirSync(dirOf(id), { recursive: true });
  return save({ id, name: n, created: Date.now(), updated: Date.now(), photos: [], notes: [], jobs: [] });
}

export const photoFile = (p: Product, x: ProductPhoto) => path.join(dirOf(p.id), x.file);
/** Absolute paths of the product's real photos, in the order they were added. */
export const photoFiles = (p: Product) => p.photos.filter(x => !x.origin).map(x => photoFile(p, x));
/** Pictures of parts kept by earlier jobs (found online or the user's own), offered to the scout for reuse. */
export const webPhotos = (p: Product) => p.photos.filter(x => x.origin).map(x => ({ file: photoFile(p, x), url: x.url || '', page: x.page, label: x.angle }));

/** Copies photos in; the same picture twice is kept once (named by its content). Returns the paths inside the library. */
export function addPhotos(id: string, files: { file: string; angle?: string; url?: string; page?: string; part?: boolean }[], from?: string) {
  const out: string[] = [];
  edit(id, p => {
    for (const x of files) {
      const data = fs.readFileSync(x.file);
      const name = crypto.createHash('sha1').update(data).digest('hex').slice(0, 16) + (path.extname(x.file).toLowerCase() || '.png');
      const dest = path.join(dirOf(id), name);
      if (!fs.existsSync(dest)) fs.writeFileSync(dest, data);
      const had = p.photos.find(y => y.file === name);
      if (had) { if (x.angle && !had.angle) had.angle = x.angle; }
      else p.photos.push({ file: name, angle: x.angle, from, added: Date.now(), ...(x.url ? { origin: 'web' as const, url: x.url, page: x.page } : x.part ? { origin: 'part' as const } : {}) });
      out.push(dest);
    }
  });
  return out;
}

/** Drops a photo from the list. The file stays on disk. */
export const hidePhoto = (id: string, file: string) => edit(id, p => { p.photos = p.photos.filter(x => x.file !== path.basename(file)); });

export function addNote(id: string, text: string, from?: string) {
  const t = text.trim().slice(0, 200);
  if (!t) throw new Error('要点不能是空的');
  return edit(id, p => { if (!p.notes.some(n => n.text === t)) p.notes.push({ text: t, from, added: Date.now() }); });
}
export const removeNote = (id: string, index: number) => edit(id, p => { p.notes.splice(index, 1); });
export const linkJob = (id: string, job: string) => edit(id, p => { if (!p.jobs.includes(job)) p.jobs.push(job); });
