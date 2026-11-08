// The swap app's HTTP handlers. Loaded per request by ./server.ts through Vite's module graph, so edits here and
// in the engine hot-reload instead of restarting the dev server (a restart used to kill jobs in flight).
import fs from 'node:fs';
import path from 'node:path';
import { createJob, createTextJob, DATA, dirOf, getJob, listJobs, pickFrame, recoverJobs, retryFrames, TEXT_KINDS, TEXT_TEMPLATE } from './engine/pipeline';
import { providers } from './engine/registry';
import { continueSlots, createReplica, redoSegment, refitFilm, REPLICA, restyle, resumeReplica, reviewCopy, saveCopy, STYLES } from './engine/director';
import { photosForScenes } from './engine/picks';
import { presetBook } from './engine/presets';
import { addNote, createProduct, getProduct, hidePhoto, listProducts, photoFile, PRODUCTS, removeNote, type Product } from './engine/products';
import { toChinese } from './engine/translate';
import { startVoiceover } from './engine/voice';
import { getTemplate, listTemplates, TEMPLATES, withMode } from './engine/templates';
import type { Job, Template } from './engine/types';

const json = (res: any, code: number, x: any) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(x)); };
const body = (req: any, limit = 25 * 1024 * 1024) => new Promise<any>((resolve, reject) => {
  const chunks: Buffer[] = []; let n = 0;
  req.on('data', (c: Buffer) => { n += c.length; if (n > limit) reject(new Error(`文件太大，请小于 ${Math.floor(limit / 1.4 / 1024 / 1024)}MB`)); else chunks.push(c); });
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
});

// Files go to the browser by URL, never by disk path.
const ROOTS: Record<string, string> = { t: TEMPLATES, d: DATA, p: PRODUCTS };
const url = (file?: string) => {
  if (!file) return undefined;
  for (const [k, root] of Object.entries(ROOTS)) {
    const rel = path.relative(root, file);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return `/swap-files/${k}/${rel.split(path.sep).join('/')}`;
  }
};
const publicTemplate = (t: Template) => ({
  id: t.id, title: t.title, desc: t.desc, ratio: t.ratio, seconds: t.seconds, note: t.note,
  video: url(path.join(TEMPLATES, t.id, t.source)), cover: t.cover && url(path.join(TEMPLATES, t.id, t.cover)),
  slot: { label: t.slot.label, hint: t.slot.hint, modes: (t.slot.modes || []).map(m => ({ id: m.id, label: m.label, hint: m.hint })) }, versions: t.versions.map(v => ({ id: v.id, label: v.label })),
  choices: (t.choices || []).map(c => ({ id: c.id, label: c.label, options: c.options.map(o => ({ id: o.id, label: o.label })) }))
});
const publicProduct = (p: Product) => ({ id: p.id, name: p.name, updated: p.updated, jobs: p.jobs.length, notes: p.notes.map(n => n.text),
  photos: p.photos.map(x => ({ file: x.file, angle: x.angle, web: x.origin === 'web', url: url(photoFile(p, x)) })) });
const publicJob = (j: Job) => ({
  id: j.id, templateId: j.templateId, slotMode: j.slotMode, mock: /模拟/.test(j.engine?.video || ''), stage: j.stage, message: j.message, error: j.error, guard: j.guard,
  upload: url(j.upload), frames: j.frames.map(url), picked: j.picked, log: j.log.slice(-8),
  versions: j.versions.map(v => ({ id: v.id, label: v.label, status: v.status, step: v.step, error: v.error, final: url(v.final), compare: url(v.compare), check: v.check && { pass: v.check.pass, summary: v.check.summary } })),
  replica: j.replica && {
    phases: j.replica.phases, summary: j.replica.plan?.summary, route: j.replica.route, photoIssue: j.replica.photoPicks?.issue, keyframeStop: j.replica.keyframeStop, scouting: !!j.replica.scout?.running,
    fit: (j.replica.plan?.shots || []).map((s, i) => ({ start: s.start, end: s.end, fit: s.fit || 'good', why: s.why || '', change: s.change, variant: j.replica!.plan!.scenes.find(c => c.id === s.scene)?.variant, pics: j.replica!.photoPicks ? photosForScenes(j.replica!.photoPicks, [s.scene], j.replica!.uploads).map(url) : undefined,
      thumb: url([1, 0].map(k => path.join(dirOf(j.id), 'review', `s${i + 1}-${k}.jpg`)).find(f => fs.existsSync(f))) })), uploads: j.replica.uploads.map(url), source: url(j.replica.source),
    styles: Object.entries(STYLES).map(([id, x]) => ({ id, label: x.label })),
    copy: j.replica.copy || [], copyCheck: j.replica.copyCheck, voice: j.replica.voice && { status: j.replica.voice.status, error: j.replica.voice.error, lines: j.replica.voice.lines?.length },
    gaps: (j.replica.plan?.gaps || []).map(g => ({ label: g.label, at: g.at, frame: url(g.frame), kind: g.kind || 'angle', shots: g.shots, need: g.need, fallback: g.fallback,
      found: g.found && { url: url(g.found.file), page: g.found.page, why: g.found.why } })),
    slots: (j.replica.plan?.variants || []).map(v => {
      const a = j.replica!.variantAssets?.find(x => x.id === v.id);
      return { id: v.id, label: v.label, main: v.main, at: v.at, frame: url(v.frame), image: url(a?.own ? a.file : j.replica!.uploads[0]), own: !!a?.own };
    }),
    sheet: url(j.replica.sheet?.file), variants: (j.replica.variantAssets || []).filter(a => a.file).map(a => ({ label: a.label, url: url(a.file) })), keyframes: j.replica.keyframes.filter(k => k.out).map(k => ({ scene: k.scene, url: url(k.out), ok: k.ok })),
    redoError: j.replica.redoError,
    segments: j.replica.segments.map((s, i) => ({ status: s.status, repaired: s.repaired, pass: s.qa?.pass, start: s.start, end: s.end, lookBad: !!s.qa?.lookBad,
      yuan: (j.costs || []).find(c => c.step?.startsWith(`第 ${i + 1}/${j.replica!.segments.length} 段`) && c.yuan)?.yuan }))
  }
});
const dataUrl = (s: string, kind: 'image' | 'video') => {
  const m = (kind === 'image' ? /^data:image\/(png|jpe?g|webp);base64,(.+)$/ : /^data:video\/(mp4|quicktime|webm|x-m4v);base64,(.+)$/).exec(s || '');
  if (!m) throw new Error(kind === 'image' ? '请上传 PNG / JPG / WEBP 图片' : '请上传 MP4 / MOV / WEBM 视频');
  const ext = kind === 'image' ? '.' + m[1] : ({ mp4: '.mp4', quicktime: '.mov', webm: '.webm', 'x-m4v': '.m4v' } as any)[m[1]];
  return { data: Buffer.from(m[2], 'base64'), ext };
};

/** The whole job for 链路复盘, every file path turned into a URL; plus the template and the preset text used. */
const deepUrls = (x: any): any => typeof x === 'string' ? (path.isAbsolute(x) && url(x)) || x
  : Array.isArray(x) ? x.map(deepUrls) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, deepUrls(v)])) : x;
function traceOf(j: Job) {
  let t: Template | undefined; try { t = withMode(getTemplate(j.templateId), j.slotMode); } catch { /* template removed */ }
  const presets = Object.fromEntries(j.versions.filter(v => v.preset).map(v => [v.preset!, presetBook().presets.find(p => p.name === v.preset)]));
  if (j.templateId === TEXT_TEMPLATE) return deepUrls({ job: j, presets });
  return deepUrls({ job: j, template: t && { ...t, source: path.join(TEMPLATES, t.id, t.source) }, presets });
}

function serveFile(req: any, res: any, file: string) {
  const st = fs.statSync(file), type = ({ '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp3': 'audio/mpeg' } as any)[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  res.setHeader('Content-Type', type); res.setHeader('Accept-Ranges', 'bytes');
  if (!m) { res.setHeader('Content-Length', st.size); return fs.createReadStream(file).pipe(res); }
  const a = m[1] ? Number(m[1]) : st.size - Number(m[2]), b = m[1] && m[2] ? Number(m[2]) : st.size - 1;
  res.statusCode = 206; res.setHeader('Content-Range', `bytes ${a}-${b}/${st.size}`); res.setHeader('Content-Length', b - a + 1);
  fs.createReadStream(file, { start: a, end: b }).pipe(res);
}

export { recoverJobs };

export function handleFiles(req: any, res: any) {
  const [, k, ...rest] = decodeURIComponent(req.url.split('?')[0]).split('/');
  const root = ROOTS[k], file = root && path.resolve(root, ...rest);
  if (!file || !file.startsWith(root + path.sep) || !fs.existsSync(file)) return json(res, 404, { error: '找不到文件' });
  serveFile(req, res, file);
}

export async function handleApi(req: any, res: any) {
  try {
    const u = req.url.split('?')[0], parts = u.split('/').filter(Boolean);
    if (req.method === 'GET' && u === '/config') {
      const p = await providers();
      return json(res, 200, { image: p.image.name, video: p.video.name, guard: p.guard.name, checker: p.checker.name, minSeconds: p.video.minSeconds, maxSeconds: p.video.maxSeconds,
        styles: Object.entries(STYLES).map(([id, x]) => ({ id, label: x.label })) });
    }
    if (req.method === 'GET' && u === '/cases') {
      const file = path.resolve('docs/replica-cases.md');
      return json(res, 200, { text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' });
    }
    if (req.method === 'GET' && u === '/templates') return json(res, 200, listTemplates().map(publicTemplate));
    if (req.method === 'POST' && u === '/jobs') {
      const b = await body(req);
      const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(b.image || '');
      if (!m) return json(res, 400, { error: '请上传 PNG / JPG / WEBP 图片' });
      const job = await createJob({ templateId: b.templateId, image: Buffer.from(m[2], 'base64'), ext: '.' + m[1], extras: b.extras || [], mode: b.mode, force: !!b.force });
      return json(res, 200, publicJob(job));
    }
    if (req.method === 'POST' && u === '/text-jobs') {
      const b = await body(req, 140 * 1024 * 1024);
      const m = /^data:video\/(mp4|quicktime|webm|x-m4v);base64,(.+)$/.exec(b.video || '');
      if (!m) return json(res, 400, { error: '请上传 MP4 / MOV / WEBM 视频' });
      const ext = { mp4: '.mp4', quicktime: '.mov', webm: '.webm', 'x-m4v': '.m4v' }[m[1]]!;
      return json(res, 200, publicJob(await createTextJob({ video: Buffer.from(m[2], 'base64'), ext, kind: b.kind, text: String(b.text || '') })));
    }
    if (req.method === 'POST' && u === '/replica') {
      const b = await body(req, 160 * 1024 * 1024);
      const job = await createReplica({ templateId: b.templateId || undefined, video: b.video ? dataUrl(b.video, 'video') : undefined,
        images: (b.images || []).map((x: string) => dataUrl(x, 'image')), prompt: String(b.prompt || ''),
        shapeImages: (b.shapeImages || []).map((x: string) => dataUrl(x, 'image')), voice: b.voice !== false, styles: b.styles || [],
        productId: b.productId || undefined, productName: b.productName ? String(b.productName) : undefined, scout: !!b.scout });
      return json(res, 200, publicJob(job));
    }
    // 商品库
    if (req.method === 'GET' && u === '/products') return json(res, 200, listProducts().map(publicProduct));
    if (req.method === 'POST' && u === '/products') return json(res, 200, publicProduct(createProduct(String((await body(req)).name || ''))));
    if (parts[0] === 'products' && parts[1] && req.method === 'POST') {
      const b = await body(req);
      if (parts[2] === 'notes' && parts[3] === 'remove') return json(res, 200, publicProduct(removeNote(parts[1], Number(b.index))));
      if (parts[2] === 'notes') return json(res, 200, publicProduct(addNote(parts[1], String(b.text || ''))));
      if (parts[2] === 'photos' && parts[3] === 'hide') return json(res, 200, publicProduct(hidePhoto(parts[1], String(b.file || ''))));
    }
    if (req.method === 'GET' && parts[0] === 'products' && parts[1]) return json(res, 200, publicProduct(getProduct(parts[1])));
    if (req.method === 'POST' && u === '/translate') return json(res, 200, { zh: await toChinese(String((await body(req)).text || '').slice(0, 6000)) });
    if (req.method === 'GET' && u === '/jobs') return json(res, 200, listJobs().map(j => {
      let t: Template | undefined; try { t = getTemplate(j.templateId); } catch { /* removed */ }
      const done = j.versions.filter(v => v.status === 'done' && v.final);
      const known = (j.costs || []).filter(c => c.yuan != null);
      return {
        id: j.id, templateId: j.templateId, title: (j.replica ? '一键复刻 · ' : '') + (t?.title || (j.templateId === REPLICA ? '我的视频' : '')) || (j.textEdit ? `文字改视频 · ${TEXT_KINDS[j.textEdit.kind].label}` : j.templateId), created: j.created, stage: j.stage, message: j.message,
        upload: url(j.upload), versions: j.versions.map(v => v.label),
        mode: t?.slot.modes?.find(m => m.id === j.slotMode)?.label,
        // The last finished step is the full chain's result; earlier ones are kept as alternatives.
        results: done.map(v => ({ label: v.label, final: url(v.final), compare: url(v.compare), pass: v.check?.pass })).reverse(),
        engine: j.engine, cost: known.length ? Math.round(known.reduce((a, c) => a + c.yuan!, 0) * 100) / 100 : undefined,
        costUnknown: (j.costs || []).length - known.length,
        seconds: j.versions.map(v => [v.startedAt, v.endedAt]).flat().filter(Boolean) as number[]
      };
    }));
    if (parts[0] === 'jobs' && parts[1]) {
      if (req.method === 'GET' && parts.length === 2) return json(res, 200, publicJob(getJob(parts[1])));
      if (req.method === 'GET' && parts[2] === 'trace') return json(res, 200, traceOf(getJob(parts[1])));
      if (req.method === 'POST' && parts[2] === 'pick') return json(res, 200, publicJob(await pickFrame(parts[1], Number((await body(req)).index))));
      if (req.method === 'POST' && parts[2] === 'slots') {
        const b = await body(req, 60 * 1024 * 1024);
        const pics = (m: any) => Object.fromEntries(Object.entries(m || {}).map(([k, v]) => [k, dataUrl(String(v), 'image')]));
        return json(res, 200, publicJob(continueSlots(parts[1], { images: pics(b.images), angles: pics(b.angles), answers: b.answers || {}, kept: (b.kept || []).map(Number), mode: ['all', 'fit', 'cancel'].includes(b.mode) ? b.mode : 'all' })));
      }
      if (req.method === 'POST' && parts[2] === 'copy' && parts[3] === 'review') {
        const j = getJob(parts[1]);
        if (!j.replica?.plan) throw new Error('这个任务还没有方案');
        await reviewCopy(j.id, j.replica.plan);
        return json(res, 200, publicJob(getJob(j.id)));
      }
      if (req.method === 'POST' && parts[2] === 'restyle') return json(res, 200, publicJob(await restyle(parts[1], String((await body(req)).style || ''))));
      if (req.method === 'POST' && parts[2] === 'voiceover') return json(res, 200, publicJob(startVoiceover(parts[1])));
      if (req.method === 'POST' && parts[2] === 'copy') return json(res, 200, publicJob(saveCopy(parts[1], (await body(req)).items || [])));
      if (req.method === 'POST' && parts[2] === 'redo') return json(res, 200, publicJob(redoSegment(parts[1], Number((await body(req)).index))));
      if (req.method === 'POST' && parts[2] === 'refit') return json(res, 200, publicJob(refitFilm(parts[1])));
      if (req.method === 'POST' && parts[2] === 'resume') return json(res, 200, publicJob(await resumeReplica(parts[1])));
      if (req.method === 'POST' && parts[2] === 'retry') return json(res, 200, publicJob(await retryFrames(parts[1])));
    }
    json(res, 404, { error: '没有这个接口' });
  } catch (e: any) { json(res, 400, { error: e.message }); }
}
