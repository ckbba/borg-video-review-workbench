// 一键复刻: the user brings a video they like and pictures of their own thing; the server does the rest.
//
//   review    看懂原片   shots + frames, one model pass over the whole film
//   plan      制定方案   per shot: change or keep the original footage; scenes; the fewest keyframes (one per scene,
//                       the clearest, most frontal frame; side / back shots borrow it)
//   assets    补全素材   only when the film shows views the uploads lack: one multi-view sheet, checked against them;
//                       and one recoloured asset per other colour of the target the film shows
//   keyframes 制作关键画面 one target frame per scene, the first one anchoring the rest; then all checked together
//   generate  生成视频   segments in parallel, every one anchored on its scene's keyframe + the asset (never on the
//                       previous segment's last frame, so errors do not accumulate); soft seams overlap 5 frames
//   repair    检查修复   QA decides: a segment that fails motion / look / seam checks is generated again, best kept
//   compose   合成成片   untouched shots straight from the source, generated pieces crossfaded on their overlaps,
//                       source sound back on
//
// The page only shows the phases; everything below is recorded in job.replica for 链路复盘.
import fs from 'node:fs';
import path from 'node:path';
import { ask, image, parseJson, text } from '../../server/llm';
import { detectShots } from '../../server/shots';
import { compare, cropCentre, finish, fitAspect, frameAt, letterbox, prepare, probe, unbox } from './media';
import { biller, dirOf, fail, getJob, newJobId, save, say, slot, update } from './pipeline';
import { providers } from './registry';
import { buildPrompt } from './presets';
import { cutPiece, conformPiece, planSegments, ssim, stitch } from './segments';
import { addPhotos, getProduct, linkJob, photoFiles, createProduct, webPhotos } from './products';
import { parsePicks, PICK_ASK, photosForScenes } from './picks';
import { OVER_LIMIT, routeOf, simplePrompt } from './route';
import { scout, searchable } from './scout';
import { cutSource, keptSpans, spanSeconds, trimPlan } from './trim';
import { getTemplate, templateFile } from './templates';
import { transcribe, voiceover } from './voice';
import type { CheckReport, CopyItem, Gap, Job, Keyframe, Phase, PhaseId, Plan, Ratio, Replica, ReplicaSeg, Variant, VoiceLine } from './types';

export const REPLICA = 'replica';
const MAX_SECONDS = 60;
const OVERLAP_FRAMES = 5;
const KEYFRAME_TRIES = 3, SEGMENT_TRIES = 2;
/** Most scenes in one video run. Keyframes come first (they already show the design); the asset takes any free picture. */
const MAX_SEG_SCENES = 4;
/** This many real pictures of the thing (uploads + angle photos) and no multi-view sheet is generated. */
const REAL_ANGLES_ENOUGH = 3;
/** Most real photos one job takes: the user's new ones first, then the product library's. */
const MAX_UPLOADS = 8;
/** Without a sheet, this many real photos go to keyframes and their check (2 used to cut off the side photo). */
const KEYFRAME_PHOTOS = 4;
/** Overlap frames of two neighbouring pieces should show the same moment; below this they disagree visibly. */
const SEAM_MIN = 0.55;
/** Below this a crossfade shows two sets of hands (0.67 ghosted on 5 Nov), so the seam is a straight cut instead. */
const SEAM_BLEND = 0.8;
/** Length aimed for per piece: on 5 Nov a 14 s piece with 11 shots came back with cuts up to a second late. */
const SEG_TARGET = 8;

const PHASES: [PhaseId, string][] = [['review', '看懂原片'], ['plan', '制定方案'], ['assets', '补全素材'], ['keyframes', '制作关键画面'],
  ['generate', '生成视频'], ['repair', '检查修复'], ['compose', '合成成片'], ['voice', '配音和字幕']];

/** 'llm' reads the film with the multimodal model; 'basic' (the free demo) changes every shot from one keyframe. */
const planner = () => process.env.SWAP_PLANNER || (process.env.SWAP_PROVIDER === 'borg' || process.env.SWAP_VIDEO ? 'llm' : 'basic');

// ---------- state ----------
const rep = (id: string) => getJob(id).replica!;
const edit = (id: string, fn: (r: Replica) => void) => update(id, j => fn(j.replica!));
function phase(id: string, p: PhaseId, status: Phase['status'], note?: string) {
  edit(id, r => { const x = r.phases.find(y => y.id === p); if (!x) return; x.status = status; if (note !== undefined) x.note = note; }); // jobs made before a phase existed lack it
  if (status === 'running') say(id, PHASES.find(([k]) => k === p)![1] + (note ? `：${note}` : ''));
}
const segEdit = (id: string, i: number, patch: Partial<ReplicaSeg>) => edit(id, r => Object.assign(r.segments[i], patch));

const changed0 = (plan: Plan) => `${plan.shots.filter(s => s.change).length}/${plan.shots.length}`;
const RATIOS: [Ratio, number][] = [['16:9', 16 / 9], ['9:16', 9 / 16], ['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['21:9', 21 / 9]];
const ratioOf = (w: number, h: number) => RATIOS.reduce((a, b) => Math.abs(Math.log(b[1] / (w / h))) < Math.abs(Math.log(a[1] / (w / h))) ? b : a)[0];

// ---------- entry ----------
export async function createReplica(x: { templateId?: string; video?: { data: Buffer; ext: string }; images: { data: Buffer; ext: string }[]; prompt: string;
  shapeImages?: { data: Buffer; ext: string }[]; voice?: boolean; styles?: string[]; productId?: string; productName?: string; scout?: boolean }): Promise<Job> {
  const product = x.productId ? getProduct(x.productId) : x.productName?.trim() ? createProduct(x.productName) : undefined;
  const kept = product ? photoFiles(product).filter(f => fs.existsSync(f)) : [];
  if (!x.images.length && !kept.length) throw new Error('请至少放一张你的图');
  if (x.images.length > MAX_UPLOADS) throw new Error(`最多 ${MAX_UPLOADS} 张图`);
  if (x.prompt.length > 500) throw new Error('提示词请控制在 500 字以内');
  const id = newJobId(), dir = dirOf(id);
  fs.mkdirSync(dir, { recursive: true });
  const fresh = x.images.map((im, i) => { const f = path.join(dir, `upload-${i + 1}${/^\.(png|jpe?g|webp)$/i.test(im.ext) ? im.ext.toLowerCase() : '.png'}`); fs.writeFileSync(f, im.data); return f; });
  // New photos join the product first, so the job and the library hold the same files and nothing is passed in twice.
  const saved = product && fresh.length ? addPhotos(product.id, fresh.map(file => ({ file })), id) : fresh;
  const uploads = [...new Set([...saved, ...kept])].slice(0, MAX_UPLOADS);
  if (product) linkJob(product.id, id);
  if ((x.shapeImages?.length || 0) > 3) throw new Error('补充角度的图最多 3 张');
  const shapeRefs = (x.shapeImages || []).map((im, i) => { const f = path.join(dir, `shape-${i + 1}${/^\.(png|jpe?g|webp)$/i.test(im.ext) ? im.ext.toLowerCase() : '.png'}`); fs.writeFileSync(f, im.data); return f; });
  let source: string, templateId = REPLICA;
  if (x.templateId) { const t = getTemplate(x.templateId); source = templateFile(t, t.source); templateId = t.id; }
  else if (x.video) { source = path.join(dir, 'upload-video' + (/^\.(mp4|mov|webm|m4v)$/i.test(x.video.ext) ? x.video.ext : '.mp4')); fs.writeFileSync(source, x.video.data); }
  else throw new Error('请先选一个视频');
  const job: Job = {
    id, templateId, created: Date.now(), stage: 'rendering', message: '准备中', upload: uploads[0], frames: [], extras: [], log: [],
    versions: [{ id: 'replica', label: '成片', status: 'running' }],
    replica: { source, prompt: x.prompt.trim(), uploads, shapeRefs, productId: product?.id, productNotes: product?.notes.map(n => n.text), productName: product?.name, knownWeb: product ? webPhotos(product) : undefined, scoutOn: !!x.scout, voiceOn: x.voice !== false, styles: (x.styles || []).filter(k => STYLES[k]), phases: PHASES.map(([pid, label]) => ({ id: pid, label, status: 'waiting' })), keyframes: [], segments: [] }
  };
  save(job);
  void run(id, !x.templateId).catch(onFail(id));
  return job;
}

async function run(id: string, own: boolean) {
  const p = await providers(), dir = dirOf(id);
  update(id, j => { j.engine = { image: p.image.name, video: p.video.name, guard: `方案：${planner() === 'llm' ? '多模态模型' : '基础（不调模型）'}`, checker: p.checker.name }; });
  update(id, j => { j.versions[0].startedAt = Date.now(); });

  // 看懂原片
  phase(id, 'review', 'running');
  let source = rep(id).source;
  if (own) {
    const s = await probe(source).catch(() => { throw new Error('读不出这个视频，请换成 MP4 / MOV'); });
    if (s.seconds < p.video.minSeconds) throw new Error(`视频太短，至少 ${p.video.minSeconds} 秒`);
    source = await prepare(source, path.join(dir, 'source.mp4'), { end: Math.min(s.seconds, MAX_SECONDS) });
    edit(id, r => { r.source = source; });
    if (s.seconds > MAX_SECONDS) say(id, `视频超过 ${MAX_SECONDS} 秒，只处理前 ${MAX_SECONDS} 秒`);
    const made = await probe(source), size = fitAspect(made.width, made.height);
    if (size) {
      source = await cropCentre(source, size, path.join(dir, 'source-crop.mp4'));
      edit(id, r => { r.source = source; });
      say(id, `画面太宽或太高，视频模型不接受：裁成 ${size.width}×${size.height}（原来 ${made.width}×${made.height}）`);
    }
  }
  const info = await probe(source), ratio = ratioOf(info.width, info.height);
  // A template's hand-marked cuts beat detection (soft crowd shots slip under the scene threshold).
  const tpl = own ? undefined : getTemplate(getJob(id).templateId);
  const shots = tpl?.cuts?.length ? [0, ...tpl.cuts, info.seconds].slice(0, -1).map((a, i, all) => ({ start: a, end: i + 1 < all.length ? all[i + 1] : info.seconds }))
    : (await detectShots(source, 0.2, Math.max(0.5, 1 / info.fps * 6))).shots;
  const look = path.join(dir, 'review'); fs.mkdirSync(look, { recursive: true });
  const perShot = shots.length > 24 ? 1 : 3;
  const frames = await Promise.all(shots.map(async (s, i) => {
    const d = s.end - s.start, ts = perShot === 1 ? [s.start + d / 2] : [0.15, 0.5, 0.85].map(k => s.start + d * k);
    return { ts, files: await Promise.all(ts.map((t, k) => frameAt(source, t, path.join(look, `s${i + 1}-${k}.jpg`), 480))) };
  }));
  phase(id, 'review', 'done', `${info.seconds.toFixed(1)} 秒，${shots.length} 个镜头`);

  // 制定方案
  phase(id, 'plan', 'running');
  const plan = await makePlan(id, shots, frames, info.seconds);
  // Angle photos were given on purpose: always make the multi-view sheet from them.
  // Real photos beat a generated sheet: with three or more angles, they go to the keyframes as they are (5 Nov, Anta:
  // a generated sheet passed its check yet put blue lines on the inner side, which the real shoe does not have).
  if ((rep(id).uploads.length + (rep(id).shapeRefs?.length || 0)) >= REAL_ANGLES_ENOUGH) { plan.views = []; plan.gaps = (plan.gaps || []).filter(g => g.kind && g.kind !== 'angle'); }
  const route = routeOf(plan, plan.shots.at(-1)!.end, p.video.maxSeconds);
  edit(id, r => { r.plan = plan; r.route = route; });
  say(id, `路线：${route.kind === 'simple' ? '简单路线' : '完整路线'}（${route.reasons.join('；')}）`);
  if (route.kind === 'simple') phase(id, 'plan', 'done', `${changed0(plan)} 个镜头要改，一次生成`);
  const changed = plan.shots.filter(s => s.change);
  if (!changed.length) throw new Error('原片里没找到可以换成你这张图的东西，换个视频或写一句提示词说明要换什么');
  if (route.kind !== 'simple') phase(id, 'plan', 'done', `${changed.length}/${plan.shots.length} 个镜头要改，${plan.scenes.length} 张关键画面`);

  // The missing pictures' frames first: the scout shows them to the model. Then the copy check and the scout run side by side.
  const gaps = plan.gaps || [];
  await Promise.all(gaps.map(async (g, i) => {
    const frame = await frameAt(source, g.at, path.join(look, `gap-${i}.jpg`), 480);
    edit(id, x => { x.plan!.gaps![i].frame = frame; });
  }));
  // The scout works in the background: the confirm page does not wait for it.
  void findMissing(id).catch(e => say(id, `素材员没有完成（${e.message}）`));
  await makeCast(id, true);
  await Promise.all([rep(id).voiceOn !== false ? reviewCopy(id, plan) : undefined, pickPhotos(id, plan, source)]);

  // Every job stops here before anything is paid for (6 Nov: a simple film used to run straight through, so the user never
  // saw the timeline or the route). Everything has a default, so they can just go on.
  if (plan.variants.length > 1) await Promise.all(plan.variants.map(async (v, i) => {
    const frame = await frameAt(source, v.at, path.join(look, `slot-${v.id}.jpg`), 480);
    edit(id, x => { x.plan!.variants[i].frame = frame; });
  }));
  update(id, j => { j.stage = 'slots'; j.message = '开始前确认'; });
}

/** 素材员: looks online for what the uploads lack, while the user is already on the confirm page. Pictures land on the plan
 *  as they are found. Clicking start ends it (continueSlots clears `running`), and from then on it writes no picture:
 *  the plan may have been cut and renumbered, and the user has not seen anything found after that. */
async function findMissing(id: string) {
  const r = rep(id), gaps = r.plan!.gaps || [];
  if (!r.scoutOn || planner() !== 'llm' || process.env.SWAP_SCOUT === 'off' || !gaps.some(searchable)) return;
  const live = () => !!rep(id).scout?.running;
  const note = (m: string) => update(id, j => { j.log.push(`${new Date().toLocaleTimeString()} ${m}`); }); // say() would overwrite the page's status
  edit(id, x => { x.scout = { running: true, rounds: 0, viewed: 0, found: 0, stopped: '进行中' }; });
  note('素材员开始联网找图');
  try {
    const out = await scout({ subject: r.plan!.subject, name: r.productName, prompt: r.prompt, notes: r.productNotes, uploads: r.uploads, gaps, known: r.knownWeb, dir: path.join(dirOf(id), 'scout'), log: note, stop: () => !live(),
      onFound: (i, pic) => edit(id, x => { const g = x.plan!.gaps![i]; if (x.scout?.running && !g.found) g.found = pic; }), // the first one stays: the user may be looking at it
      onStep: steps => edit(id, x => { if (x.scout) x.scout.steps = steps; }) });
    edit(id, x => { x.scout = { running: false, rounds: out.rounds, viewed: out.viewed, found: Object.keys(out.found).length, stopped: out.stopped, steps: out.steps }; });
    note(`素材员结束：找到 ${Object.keys(out.found).length}/${gaps.filter(searchable).length} 项（${out.stopped}）`);
  } catch (e: any) {
    edit(id, x => { if (x.scout) { x.scout.running = false; x.scout.stopped = e.message; } });
    note(`素材员没有完成（${e.message}），缺的素材由你补`);
  }
}

/** 补全素材 onwards: from here on, money is spent. */
async function build(id: string) {
  const r = rep(id), plan = r.plan!, source = r.source, info = await probe(source), ratio = ratioOf(info.width, info.height);
  // Decided again: the choices on 开始前确认 may have cut shots or settled what was missing.
  const route = routeOf(plan, plan.shots.at(-1)!.end, (await providers()).video.maxSeconds);
  edit(id, x => { x.route = route; });
  if (route.kind === 'simple') return buildSimple(id);
  const others = plan.variants.filter(v => !v.main && !r.variantAssets?.some(a => a.id === v.id && a.own));
  if (!plan.views.length && !others.length) phase(id, 'assets', 'skipped', '你的图已经够用');
  else {
    if (plan.views.length) await completeAssets(id, plan);
    if (others.length) await makeVariants(id, others, source);
  }

  await pickPhotos(id, rep(id).plan!, source);
  await makeCast(id, false);

  // 制作关键画面 + 联合验收
  // Wrong captions would stay burned in, so when the copy changes the picture is made without them.
  plan.dropText = !!rep(id).copy?.length || !!plan.noCaptions;
  edit(id, x => { x.plan!.dropText = plan.dropText; });
  await makeKeyframes(id, plan, ratio, source);

  await render(id, plan, ratio, source, info.fps);
}

/** 简单路线: no sheet, no keyframes, no second take. The film and the best pictures go to the video model once. */
async function buildSimple(id: string) {
  const skip = '简单路线不需要';
  phase(id, 'assets', 'skipped', skip);
  phase(id, 'keyframes', 'skipped', skip);
  let plan = rep(id).plan!, source = rep(id).source;
  await pickPhotos(id, plan, source);
  plan.dropText = !!rep(id).copy?.length || !!plan.noCaptions;
  edit(id, x => { x.plan!.dropText = plan.dropText; });
  const p = await providers(), info = await probe(source), max = p.video.maxSeconds;
  // A hair over the model's limit: the last frames go, rather than a second run and a seam.
  if (info.seconds > max && info.seconds <= max + OVER_LIMIT) {
    const out = await cutSource(source, [{ start: 0, end: max }], info.audio, path.join(dirOf(id), 'source-fit.mp4'));
    edit(id, x => { x.fullSource = x.fullSource || x.source; x.source = out; const s = x.plan!.shots; s[s.length - 1].end = max; });
    plan = rep(id).plan!; source = out;
  }
  await render(id, plan, ratioOf(info.width, info.height), source, info.fps);
}

type Picture = { data: Buffer; ext: string };

/** The scenes a gap's shots belong to (only the shots that change). */
function gapScenes(plan: Plan, g: Gap) {
  const shots = g.shots?.length ? plan.shots.filter(s => g.shots!.includes(s.index)) : plan.shots.filter(s => g.at >= s.start && g.at < s.end);
  return [...new Set(shots.filter(s => s.change).map(s => s.scene))];
}

/** 生成人物: a portrait of each new person nobody supplied. `before`: made before the confirm page, for the people the user
 *  said AI should make (they see and can replace it there); otherwise made when the job starts, for those still missing. */
async function makeCast(id: string, before: boolean) {
  const r = rep(id), plan = r.plan!, gaps = plan.gaps || [];
  const todo = gaps.map((g, i) => ({ g, i })).filter(({ g }) => g.kind === 'cast' && (before ? g.generate && !g.found : !(r.castRefs || []).some(c => c.label === g.label)));
  if (!todo.length) return;
  const p = await providers(), dir = path.join(dirOf(id), 'cast'); fs.mkdirSync(dir, { recursive: true });
  say(id, `生成人物：${todo.map(x => x.g.label).join('、')}`);
  await Promise.all(todo.map(async ({ g, i }) => {
    const frame = await frameAt(r.source, g.at, path.join(dir, `cast-${i}-source.jpg`));
    fs.mkdirSync(path.join(dir, `cast-${i}`), { recursive: true });
    const prompt = `Portrait photograph of a new person: ${g.view}. A completely different person from the one in @image1: a new face and identity, not a look-alike. ` +
      `Keep from @image1 only the clothes, accessories, hairstyle, pose and light. Head and shoulders, face clearly visible, sharp, natural skin. No text, no captions, no letters.`;
    try {
      const out = (await p.image.targetFrames({ prompt, refs: [frame], ratio: '3:4', count: 1, outDir: path.join(dir, `cast-${i}`), log: m => say(id, `生成人物 ${g.label}：${m}`), bill: biller(id, `人物 ${g.label}`) }))[0];
      edit(id, x => {
        const gap = x.plan!.gaps![i];
        if (before) gap.found = { file: out, url: out, why: 'AI 生成的新人物' };
        else x.castRefs = [...(x.castRefs || []), { file: out, label: gap.label, scenes: gapScenes(x.plan!, gap), ai: true }];
      });
    } catch (e: any) { say(id, `生成人物 ${g.label} 没有成功（${e.message}）`); }
  }));
}
/** The user's answers on 开始前确认. All optional: `images` by variant id, `angles` by gap index, `answers` by copy index. */
/** mode: 'all' makes every shot; 'fit' cuts the shots that cannot be made first; 'cancel' stops here, nothing spent. */
export function continueSlots(id: string, x: { images?: Record<string, Picture>; angles?: Record<string, Picture>; answers?: Record<string, string>; /** Gaps whose found picture the page showed and the user kept. */ kept?: number[]; mode?: 'all' | 'fit' | 'cancel' }) {
  const j = getJob(id);
  if (j.stage !== 'slots') throw new Error('现在不能调整素材');
  if (j.replica?.scout?.running) edit(id, r => { r.scout!.running = false; });
  if (x.mode === 'cancel') {
    update(id, o => { o.stage = 'failed'; o.message = '已取消'; o.error = '你选了不复刻。没有生成，也没有花钱。'; o.versions[0].status = 'failed'; o.versions[0].error = o.error; });
    return getJob(id);
  }
  const scenesOf = gapScenes;
  const dir = path.join(dirOf(id), 'slots'); fs.mkdirSync(dir, { recursive: true });
  const save = (name: string, im: Picture) => { const file = path.join(dir, name + im.ext); fs.writeFileSync(file, im.data); return file; };
  update(id, o => {
    o.stage = 'rendering'; o.message = '开始制作';
    const r = o.replica!, plan = r.plan!;
    r.variantAssets = plan.variants.filter(v => x.images?.[v.id]).map(v => {
      v.desc = ''; // the picture decides the colour now
      return { id: v.id, label: v.label, file: save(v.id, x.images![v.id]), ok: true, own: true };
    });
    // A picture of a missing angle is a real photo of the thing: it joins the uploads and that view needs no generating.
    (plan.gaps || []).forEach((g, i) => {
      const im = x.angles?.[i];
      if (!im) return;
      const file = save(`angle-${i}`, im);
      // The user's photo of the new person: it rules that person's scenes, and it is not a photo of the product.
      if (g.kind === 'cast') { r.castRefs = [...(r.castRefs || []), { file, label: g.label, scenes: scenesOf(plan, g), ai: false }]; return; }
      // A photo of a part (a cabin) is no photo of the whole thing: it rules that part in its own scenes only.
      if (g.kind === 'part') {
        r.partRefs = [...(r.partRefs || []), { file, label: g.label, scenes: scenesOf(plan, g), web: false }];
        if (r.productId) addPhotos(r.productId, [{ file, angle: g.label, part: true }], id);
        return;
      }
      r.uploads.push(r.productId ? addPhotos(r.productId, [{ file, angle: g.label }], id)[0] : file);
      plan.views = plan.views.filter(v => v !== g.view);
    });
    // A picture the scout found counts once the user lets it stand. Of a part, it rules that part (the user has no other
    // picture of it); of an angle, it gives shape only.
    (plan.gaps || []).forEach((g, i) => {
      if (!g.found || x.angles?.[i] || !x.kept?.includes(i)) { g.found = undefined; return; }
      if (g.kind === 'cast') { r.castRefs = [...(r.castRefs || []), { file: g.found.file, label: g.label, scenes: scenesOf(plan, g), ai: true }]; return; }
      if (g.kind === 'part') r.partRefs = [...(r.partRefs || []), { file: g.found.file, label: g.label, scenes: scenesOf(plan, g), web: true }];
      else r.shapeRefs = [...new Set([...(r.shapeRefs || []), g.found.file])];
      if (r.productId) addPhotos(r.productId, [{ file: g.found.file, angle: g.label, url: g.found.url, page: g.found.page }], id);
    });
    for (const [i, text] of Object.entries(x.answers || {})) {
      const c = r.copy?.[Number(i)];
      if (c && text.trim()) { c.to = text.trim().slice(0, 200); c.sure = true; c.why = undefined; }
    }
  });
  void (async () => { if (x.mode === 'fit') await cutUnfit(id); await build(id); })().catch(onFail(id));
  return getJob(id);
}

/** Cuts the shots marked fit=no out of the source; the rest of the job then runs on the shorter film. */
async function cutUnfit(id: string) {
  const r = rep(id), plan = r.plan!;
  if (!plan.shots.some(s => s.fit === 'no')) return;
  const spans = keptSpans(plan), keep = spanSeconds(spans);
  const p = await providers();
  if (!spans.length || !plan.shots.some(s => s.fit !== 'no' && s.change)) throw new Error('去掉做不了的片段后，没有要换的镜头了');
  if (keep < p.video.minSeconds) throw new Error(`去掉做不了的片段后只剩 ${keep.toFixed(1)} 秒，太短了`);
  say(id, `剪掉做不了的片段：${(plan.shots.at(-1)!.end - keep).toFixed(1)} 秒，剩 ${keep.toFixed(1)} 秒`);
  const out = await cutSource(r.source, spans, (await probe(r.source)).audio, path.join(dirOf(id), 'source-cut.mp4'));
  const t = trimPlan(plan, r.copy, spans);
  edit(id, x => { x.fullSource = x.fullSource || x.source; x.source = out; x.plan = t.plan; x.copy = t.copy; });
}

export function saveCopy(id: string, items: CopyItem[]) {
  edit(id, r => { r.copy = items.map(x => ({ at: Number(x.at), from: String(x.from), to: String(x.to).slice(0, 200), sure: !!x.sure, why: x.why, src: x.src, price: x.price || undefined })); });
  return getJob(id);
}

const COPY_ASK = (plan: Plan, heard: VoiceLine[]) => `下面先是用户的商品图，然后是原片逐镜头的帧，画面里可能有字幕和花字。
${heard.length ? `原片的口播（语音转写，可能有错别字；如果其实是歌词或背景音乐，就不算口播，忽略）：
${heard.map(l => `${l.start.toFixed(1)}s ${l.from}`).join('\n')}
` : '原片里没有听到口播。\n'}
这条视频的 ${plan.target} 已经换成用户图里的东西（${plan.subject}）。找出口播和字幕里所有因此和画面矛盾的话，给出改写。
规则：
0. 口播和字幕说的是同一句时只列一次，from 用口播转写的原话（转写有错别字就按字幕修正），src="both"；只在口播里的 src="voice"；只在画面上的 src="caption"。
1. 不矛盾的不要列，比如"又保暖又舒适"这类通用的话。
2. 看图能确定的（颜色、图案、款式）直接改写，sure=true。
3. 看图不能确定的（品牌、型号、材质、工艺、功效）绝不编造，改成通用说法，sure=false，why 用中文一句话说明要用户确认什么。
   to 是会被念出来、烧进画面的话：不要写"待确认""以页面为准"这类说明，用自然的说法。用户图里看得出品牌的（瓶身、包装上的字），直接用这个品牌。
3.5 价格和规格（如 1195、359、5195、100ml*3、8瓶）只有用户知道：每个不同的数字单独列一项，price=true，sure=false，from 和 to 都写原片的这个数字本身（只写数字和单位，如"1195"、"100ml*3"），why 写这个数字是什么（如"大瓶精华水的单价"）。
   其他句子里出现这些数字时，数字保持原样不改，不要改成"另一个价""这个价"这种模糊说法。
4. 改写后的字数尽量和原文一样，保持原来的语气，读起来要和原来的节奏对得上。
5. 同一句连续出现多帧只列一次，at 取它第一次出现的秒数。
6. 只列字幕和花字。画面角落的 Logo、品牌水印、衣服上的字不是文案，不要列。to 只写改写后的文字本身，不要写"改成"这类说明。
只输出 JSON：{"items":[{"at":秒,"from":"原文","to":"改写","sure":true,"why":"","src":"voice","price":false}]}`;

/** Listens to the voiceover and reads the captions off the review frames, and lists what no longer fits. Never blocks the job.
 *  7 Nov: captions alone missed films that only speak; a line saying the old car's colour went out unchanged. */
export async function reviewCopy(id: string, plan: Plan) {
  if (planner() !== 'llm') return;
  const r = rep(id), look = path.join(dirOf(id), 'review');
  // Its own folder: voice/ caches the transcript of the film as finally cut, which may differ from this one.
  const heard = await transcribe(r.source, path.join(look, 'voice')).catch(e => { say(id, `听写口播没有完成（${e.message}），只看字幕`); return [] as VoiceLine[]; });
  edit(id, x => { x.copyCheck = { heard: heard.length, done: false }; });
  try {
    const parts = plan.shots.flatMap((s, i) => [0, 1, 2].flatMap(k => {
      const f = path.join(look, `s${i + 1}-${k}.jpg`);
      if (!fs.existsSync(f)) return [];
      return [text(`${(s.start + (s.end - s.start) * [0.15, 0.5, 0.85][k]).toFixed(1)}s`), image(f)];
    }));
    const j = parseJson(await ask([text(COPY_ASK(plan, heard)), ...r.uploads.map(image), ...parts], '你是严谨的电商文案编辑，只输出 JSON。', 2));
    const seen = new Set<string>();
    const items: CopyItem[] = (j.items || []).filter((x: any) => x.from && !seen.has(x.from) && seen.add(x.from))
      .map((x: any) => ({ at: Number(x.at) || 0, from: String(x.from), to: String(x.to || ''), sure: x.sure !== false, why: x.why ? String(x.why) : undefined,
        src: ['voice', 'caption', 'both'].includes(x.src) ? x.src : undefined, price: x.price === true || undefined }))
      .map((x: CopyItem) => x.price ? { ...x, to: x.from, sure: false } : x);
    edit(id, x => { x.copy = items.sort((a, b) => a.at - b.at); x.copyCheck = { heard: heard.length, done: true }; });
  } catch (e: any) {
    say(id, `文案检查没有完成（${e.message}），不影响视频`);
    edit(id, x => { x.copyCheck = { heard: heard.length, done: false, error: e.message }; });
  }
}

/** 生成视频 onwards. Separate from run() so a job whose keyframes passed can continue without paying for them again. */
async function render(id: string, plan: Plan, ratio: Ratio, source: string, fps: number) {
  const p = await providers(), dir = dirOf(id), info = { fps };
  const simple = rep(id).route?.kind === 'simple', end = plan.shots.at(-1)!.end;
  const segs: ReplicaSeg[] = simple ? [{ index: 0, start: 0, end, genStart: 0, join: 'start', scenes: plan.scenes.map(c => c.id), images: [], tries: 0, status: 'waiting' }]
    : planSegs(plan, info.fps, p.video.minSeconds, p.video.maxSeconds).map((s, index) => ({ ...s, index }));
  edit(id, r => { r.segments = segs; });
  if (simple) await generateSimple(id, plan, ratio, source);
  else await generate(id, plan, ratio, source, info.fps);
  await finishFilm(id, plan, source, info.fps, true);
}

async function finishFilm(id: string, plan: Plan, source: string, fps: number, styles: boolean) {
  const dir = dirOf(id), info = { fps };
  // 合成成片
  phase(id, 'compose', 'running');
  const picture = await compose(id, plan, source, info.fps);
  phase(id, 'compose', 'done');
  // Sound and subtitles never fail the job: the picture with the source sound is still a result.
  let out = picture;
  if (rep(id).copy?.length) {
    phase(id, 'voice', 'running');
    edit(id, r => { r.picture = picture; r.voice = { status: 'running' }; });
    try { out = await voiceover(id, picture); edit(id, r => { r.voice!.status = 'done'; }); phase(id, 'voice', 'done'); }
    catch (e: any) {
      const quiet = /没有听到口播/.test(e.message); // nobody speaks in this film: nothing went wrong, and nothing is added
      edit(id, r => { r.voice = quiet ? undefined : { ...r.voice, status: 'failed', error: e.message }; });
      phase(id, 'voice', quiet ? 'skipped' : 'failed', quiet ? '原片没有口播，保留原声' : '没配成，成片还是原声');
    }
  } else phase(id, 'voice', 'skipped', rep(id).voiceOn === false ? '这次保留原声' : rep(id).copyCheck?.done && !rep(id).copyCheck!.heard ? '原片没有口播，字幕也不用改' : '口播和字幕都不用改');
  const cmp = await compare(source, out, path.join(dir, 'compare.mp4'));
  const bad = rep(id).segments.filter(s => s.qa?.lookBad);
  const simple2 = rep(id).route?.kind === 'simple';
  update(id, j => {
    Object.assign(j.versions[0], { status: 'done', final: out, compare: cmp, endedAt: Date.now(),
      check: { pass: !bad.length, trimTail: 0, summary: !bad.length ? '自动检查通过' : simple2 ? `自动检查提示：${bad[0].qa!.summary.replace(/。$/, '')}。没有自动重做，你看过再决定要不要重新生成` : `有 ${bad.length} 段修复后仍有小问题，详情在完整链路里` } });
    j.stage = 'done'; j.message = '完成';
  });
  if (styles) for (const k of rep(id).styles || []) await restyle(id, k).catch(e => say(id, `风格版没开始：${e.message}`));
}

/** 按镜头挑图: before 开始前确认, so the timeline shows real picks; again if a photo was added there. If it fails, upload order. */
async function pickPhotos(id: string, plan: Plan, source: string) {
  const r = rep(id);
  if (planner() !== 'llm' || r.uploads.length < 2 || !plan.scenes.length || r.photoPicks?.of === r.uploads.length) return;
  say(id, `给每个场景挑图（${r.uploads.length} 张）`);
  try {
    const dir = path.join(dirOf(id), 'picks'); fs.mkdirSync(dir, { recursive: true });
    const frames = await Promise.all(plan.scenes.map(c => frameAt(source, c.keyAt, path.join(dir, `${c.id}.jpg`), 640)));
    const j = parseJson(await ask([text(PICK_ASK(plan, r.uploads.length)),
      ...r.uploads.flatMap((f, i) => [text(`照片 ${i + 1}`), image(f)]),
      ...plan.scenes.flatMap((c, i) => [text(`场景 ${c.id}。${plan.shots.filter(s => c.shots.includes(s.index) && s.note).map(s => s.note).slice(0, 3).join(' ')}`), image(frames[i])])
    ], '你是严谨的广告复刻美术，只输出 JSON。', 2));
    const picks = { ...parsePicks(j, r.uploads, plan.scenes.map(c => c.id)), of: r.uploads.length };
    edit(id, x => { x.photoPicks = picks; });
    if (picks.issue) say(id, `素材提醒：${picks.issue}`);
  } catch (e: any) { say(id, `挑图没有完成（${e.message}），按上传顺序用`); }
}

const onFail = (id: string) => (e: any) => {
  update(id, j => { j.versions[0].status = 'failed'; j.versions[0].error = String(e.message || e); j.replica!.phases.forEach(p => { if (p.status === 'running') p.status = 'failed'; }); });
  fail(id, e);
};

/** Fits every finished piece to the film again from its raw output, then joins them. Local work: nothing is generated. */
async function refitPieces(id: string) {
  for (const s of rep(id).segments) {
    const raw = s.fit?.replace(/-fit\.mp4$/, '.mp4');
    if (s.fit && s.source && raw && raw !== s.fit && fs.existsSync(raw)) await conformPiece(s.source, raw, s.fit);
  }
}
const busyFinished = (id: string, message: string) => update(id, j => { j.stage = 'rendering'; j.message = message; j.versions[0].status = 'running'; j.replica!.redoError = undefined; });
const restored = (id: string, was: Job['versions'][number], e: any) => {
  say(id, `没有成功（${e.message}），成片没变`);
  update(id, j => {
    j.stage = 'done'; j.message = '完成'; j.error = undefined; j.replica!.redoError = String(e.message);
    Object.assign(j.versions[0], { status: 'done', final: was.final, compare: was.compare, check: was.check });
    j.replica!.segments.forEach(s => { if (s.fit) { s.status = 'done'; s.error = undefined; } });
    j.replica!.phases.forEach(p => { if (p.status === 'running' || p.status === 'failed') p.status = 'done'; });
  });
};
/** 去黑边 on a finished film: free, it only re-fits what was already generated. */
export function refitFilm(id: string) {
  const j = getJob(id), r = j.replica, was = { ...j.versions[0] };
  if (!r?.plan || j.stage !== 'done') throw new Error('成片做好后才能处理');
  busyFinished(id, '重新合成');
  void (async () => { await refitPieces(id); await finishFilm(id, rep(id).plan!, r.source, (await probe(r.source)).fps, false); })().catch(e => restored(id, was, e));
  return getJob(id);
}
/** 重做这段: one piece of a finished film, with any keyframe its scenes lack. This costs money, so only the user starts it. */
export function redoSegment(id: string, index: number) {
  const j = getJob(id), r = j.replica, s = r?.segments[index], was = { ...j.versions[0] };
  if (!r?.plan || !s) throw new Error('没有这一段');
  if (j.stage !== 'done') throw new Error('成片做好后才能重做');
  if (r.route?.kind === 'simple') throw new Error('简单路线只有一段，请重新提交');
  busyFinished(id, `重做 ${index + 1}/${r.segments.length} 段`);
  void (async () => {
    const plan = rep(id).plan!, source = r.source, info = await probe(source), ratio = ratioOf(info.width, info.height);
    if (plan.scenes.some(c => !rep(id).keyframes.some(k => k.scene === c.id && k.out))) await makeKeyframes(id, plan, ratio, source);
    await generate(id, plan, ratio, source, info.fps, index);
    await refitPieces(id);
    await finishFilm(id, plan, source, info.fps, false);
  })().catch(e => restored(id, was, e));
  return getJob(id);
}

/** Runs a failed job again from its finished keyframes, on whichever video model the server is using now. */
export async function resumeReplica(id: string) {
  const j = getJob(id), r = j.replica, p = await providers();
  if (!r?.plan || (r.route?.kind !== 'simple' && (!r.keyframes.length || r.keyframes.some(k => !k.out)))) throw new Error('这个任务还没有做完关键画面，不能继续');
  if (j.stage !== 'failed') throw new Error('只有失败的任务可以继续');
  update(id, x => {
    x.stage = 'rendering'; x.error = undefined; x.message = '从关键画面继续';
    x.engine = { ...x.engine!, video: p.video.name, checker: p.checker.name };
    Object.assign(x.versions[0], { status: 'running', error: undefined, startedAt: Date.now() });
    x.replica!.segments = [];
    x.replica!.keyframeStop = undefined;
    x.replica!.phases.forEach(f => { if (['generate', 'repair', 'compose'].includes(f.id)) { f.status = 'waiting'; f.note = undefined; } if (f.id === 'keyframes' && f.status === 'failed') { f.status = 'done'; f.note = '没通过验收，你选择继续'; } });
  });
  const info = await probe(r.source);
  void render(id, r.plan, ratioOf(info.width, info.height), r.source, info.fps).catch(onFail(id));
  return getJob(id);
}

// ---------- 风格版本 ----------
/** Restyles offered on a finished job: ALTER presets that need no picture. */
export const STYLES: Record<string, { label: string; preset: string }> = {
  anime: { label: '动画风', preset: 'anime' }, '3d': { label: '3D 动画', preset: '3d-feature' }, comic: { label: '漫画风', preset: 'comic-ink' }
};

/** One more version of a finished job in another style, made from its picture (before sound and subtitles). */
export async function restyle(id: string, style: string) {
  const st = STYLES[style];
  if (!st) throw new Error('没有这个风格');
  const j = getJob(id), r = j.replica;
  if (!r?.plan || j.versions[0].status !== 'done') throw new Error('成片做好后才能出风格版');
  if (j.versions.some(v => v.id === style && v.status === 'running')) throw new Error('这个风格正在做');
  update(id, x => {
    x.versions = x.versions.filter(v => v.id !== style);
    x.versions.push({ id: style, label: st.label, status: 'running', step: '准备中', preset: st.preset, startedAt: Date.now() });
  });
  void makeStyle(id, style, st.preset).catch(e => update(id, x => Object.assign(x.versions.find(v => v.id === style)!, { status: 'failed', error: String(e.message || e), step: undefined, endedAt: Date.now() })));
  return getJob(id);
}

async function makeStyle(id: string, style: string, presetName: string) {
  const p = await providers(), r = rep(id), plan = r.plan!, dir = path.join(dirOf(id), `style-${style}`);
  fs.mkdirSync(dir, { recursive: true });
  const base = r.picture || getJob(id).versions[0].final!, info = await probe(base), ratio = ratioOf(info.width, info.height);
  const set = (patch: object) => update(id, x => Object.assign(x.versions.find(v => v.id === style)!, patch));
  const cuts = plan.shots.slice(1).map(s => s.start);
  const segs = planSegments(info.seconds, cuts, p.video.minSeconds, Math.min(SEG_TARGET, p.video.maxSeconds), p.video.maxSeconds);
  const { prompt } = buildPrompt(presetName, plan.subject ? `the person and ${plan.subject}` : 'the person', { place: 'the place as seen' }, false);
  const outs = await Promise.all(segs.map(async s => {
    const piece = segs.length > 1 ? await cutPiece(base, s, path.join(dir, `seg${s.index}-src.mp4`)) : base;
    set({ step: segs.length > 1 ? `第 ${s.index + 1}/${segs.length} 段：生成视频` : '生成视频' });
    const raw = await slot(() => p.video.edit({ prompt: p.video.bindRefs ? p.video.bindRefs(prompt) : prompt, source: piece, images: [], ratio,
      duration: Math.min(p.video.maxSeconds, Math.max(p.video.minSeconds, Math.ceil(s.end - s.start))), outFile: path.join(dir, `seg${s.index}.mp4`),
      log: m => say(id, `${STYLES[style].label}：${m}`), bill: biller(id, `${STYLES[style].label}${segs.length > 1 ? ` · 第 ${s.index + 1} 段` : ''}`) }));
    return conformPiece(piece, raw, path.join(dir, `seg${s.index}-fit.mp4`));
  }));
  const joined = outs.length > 1 ? await stitch(outs.map(file => ({ file, overlap: 0 })), info.fps, path.join(dir, 'joined.mp4')) : outs[0];
  const final = await finish(r.source, joined, path.join(dir, 'final.mp4'));
  set({ status: 'done', step: undefined, final, compare: await compare(r.source, final, path.join(dir, 'compare.mp4')), endedAt: Date.now() });
}

// ---------- 制定方案 ----------
const PLAN_ASK = (n: number, prompt: string, seconds: number) => `你是广告视频复刻导演。用户要把原片里的某样视觉资产（人物 / 商品 / 道具 / 场景）换成用户图里的东西，其余（镜头、剪辑、构图、动作、运镜、节奏、叙事）全部保留。
最先给出的 ${n} 张是用户的图（同一个东西的不同照片）。用户的说明：${prompt || '（没写，按图自己判断要替换原片里的哪个对应物）'}
接下来是原片（共 ${seconds.toFixed(1)} 秒）逐镜头的帧。

只输出 JSON：
{"subject":"英文，用户图里的东西，写清外观要点",
 "target":"英文，原片里要被替换的对应物，写它在原片里的样子",
 "keep":"英文一句，必须保持不变的东西",
 "change":"英文一句，要变的东西（把用户说明融进去）",
 "summary":"中文一句话，给用户看的方案",
 "recast":false,
 "speech":"",
 "noCaptions":false,
 "views":[{"view":"英文短语，只能是 side view / back view / sole / folded 这类","label":"中文，如 侧面","at":秒}],
 "needs":[{"kind":"part / screen / cast","view":"英文短语，如 driver cockpit view","label":"中文，如 主驾内饰","at":秒,"need":"中文，具体要用户提供什么、怎么拍","fallback":"中文，用户不提供时这段怎么处理","shots":[用到它的镜头编号],"generate":false}],
 "variants":[{"id":"v1","label":"中文，如 奶黄企鹅款","desc":"英文，只写这一版的颜色，12 个词以内，如 pale grey-blue with ivory collar；不写图案、款式和替换动作","main":true,"at":秒}],
 "scenes":[{"id":"A","variant":"v1","shots":[镜头编号],"keyAt":秒,"edit":"英文，这个场景的关键画面怎么改"}],
 "shots":[{"index":镜头编号,"change":true,"scene":"A","note":"英文，这个镜头里 target 的状态：角度、动作、形态、和手/人/其他物体的关系","fit":"good","why":""}]}

规则：
0. recast：用户的说明要求换掉画面里的人（换演员、换人种、换长相）时为 true，此时出现这些人的镜头都 change=true；否则 false。
   speech：用户要求视频里的人改说另一种语言时，写这种语言的英文名（如 "Russian"、"English"、"Spanish"、"Chinese"），否则空字符串。
   noCaptions：用户要求去掉原片字幕时为 true。
1. 画面里出现 target 的镜头 change=true；完全没出现的镜头 change=false，直接用原片，不重新生成。
2. 场景 = 同一地点、光线、人物组合，且 target 看起来差不多的一组镜头。target 在画面里的样子差到一张图说明不了时（比如汽车的正面、俯视、背面、车内），要分成不同场景：视频模型只能照着看得到的关键画面做，没有对应画面的镜头会照原片画。每个场景只出一张关键画面，这张图要同时表达该场景所有需要约束的信息（身份、外观、动作形态、构图），一张能说清的绝不出两张。
3. keyAt 选该场景里 target 最大、最清楚、最接近正面、遮挡最少的一帧（时间必须落在该场景一个 change=true 的镜头内）。同一场景里只是角度略有变化的镜头共用这张。
4. 每个 change=true 的镜头都必须属于一个场景；样子相近的镜头共用一张，不要多出。
4.5 views 只列原片里 target 清楚出现、而用户图里看不到的物体角度或形态，最多 3 个；人物的姿势和动作（坐着、拉衣角）不算；用户图已覆盖就空数组。at 选原片里这个角度最清楚的一帧的秒数。
4.6 needs 列 AI 从用户图推测不出来的东西，最多 4 个；用户图已覆盖、或 views 已列的不要重复，没有就空数组。
  - part：原片拍到了 target 的另一个部位，用户图完全没有，且结构无法从外观推断（例如只有汽车外观图，原片却拍内饰）。
  - cast：用户要求把画面里的某个人换成另一个人（换演员、换人种、换长相），但用户的图里没有这个新人物。每个要换的人列一条：label 写新人物（如"俄罗斯男演员"），
    view 用英文描述新人物的样子（性别、年龄、人种、脸型、发色；衣服、发型、配饰默认照原片，写明 same clothes and accessories as in the footage），at 选原片里这个人脸最清楚的一帧，shots 列出这个人出现的全部镜头（这些镜头都 change=true），
    need 写"上传一张这个人的正脸照"，fallback 写"不上传就由 AI 生成一个新人物"；用户明确说了让 AI 生成、随便生成、不用上传时 generate=true，否则 false。用户图里已经有这个人的，不要列。
  - screen：原片在演示屏幕上的真实操作或功能步骤（手指点设置、菜单路径）。这是事实，不是外观：换了商品，菜单和功能都可能不同。同一段连续操作合并成一条，need 按原片顺序列出每一步，要求用户从第一步开始连续拍一条视频，并说明路径不同就按实际操作拍。fallback 写去掉具体操作、文案怎么跟着改；绝不写让 AI 画界面。
5. 先精准判断要换的到底是什么：只有用户图对应的那一类东西才是 target（比如用户图是一套家居服，就只换主角身上这套家居服）。其他人的衣服、配角、玩偶、毛毯、鞋、家具都不是 target，写进 keep，不换。屏幕文字和字幕不要写进 keep，它们另有处理。一个人穿着的非同类衣物也不换。
6. 原片里 target 可能有多个版本（同款不同颜色、不同胸口图案）。每个版本一个 variant：出现时长最多的版本 main=true，其余 main=false；只有一个版本就只输出一个。用户图是这些版本全部的替换来源：所有版本都换成用户图里的这件东西，保留用户图的款式、版型、胸口图案，只有 main=false 的版本把颜色改成原片这一版的颜色。desc 只写主色和辅色，绝不提原片的图案（苹果、企鹅等），否则原图案会被带回来。at 选这一版最清楚的一帧的秒数。
8. 每个镜头判断换成用户的东西后能不能做好。fit=good：和原片差不多（外形接近，或这个镜头不用改）。fit=rough：能做，但细节可能和实物不完全一样（结构差别大、用户图里没有这个部位）。fit=no：做不出来，只限画面本身在演示真实的屏幕界面、菜单操作、按键步骤，换了商品画面就是错的。fit 只看画面能不能做出来：字幕和口播里说的功能、效果、宣传话术不算，它们由文案检查另外处理；车在路上开、外观和内饰展示这类画面，换了商品照样能拍，最多算 rough。why 写给普通用户看，一句大白话、不用术语，good 可以留空。
7. 同一个场景只能有一个 variant，版本不同就分成不同场景；每个 change=true 的镜头的 scene 都要指向正确版本的场景，逐镜头看清颜色，不要漏掉很短的镜头。`;

async function makePlan(id: string, shots: { start: number; end: number }[], frames: { ts: number[]; files: string[] }[], seconds: number): Promise<Plan> {
  const r = rep(id);
  const basic = (why?: string): Plan => {
    const t = (() => { try { return getTemplate(getJob(id).templateId); } catch { return undefined; } })();
    const at = t ? Math.min(t.frameAt, seconds - 0.1) : Math.min(0.5, seconds / 2);
    return { by: 'basic', subject: 'the thing in @image2', target: 'the matching main subject', keep: 'everything else',
      change: 'the main subject becomes the one in the reference pictures' + (r.prompt ? `; ${r.prompt}` : ''),
      summary: why ? `基础方案（${why}）：所有镜头都按你的图替换主体` : '基础方案：所有镜头都按你的图替换主体', views: [], variants: [],
      scenes: [{ id: 'A', shots: shots.map((_, i) => i + 1), keyAt: at, edit: 'replace the main subject with the one from the reference pictures' }],
      shots: shots.map((s, i) => ({ index: i + 1, start: s.start, end: s.end, change: true, scene: 'A', note: '' })) };
  };
  if (planner() !== 'llm') return basic();
  try {
    const j = parseJson(await ask([
      text(PLAN_ASK(r.uploads.length, r.prompt, seconds) + (r.productNotes?.length ? `\n\n关于用户这件商品已知的事实（来自以前的任务）：\n${r.productNotes.map(n => '- ' + n).join('\n')}` : '')), ...r.uploads.map(image),
      ...shots.flatMap((s, i) => [text(`镜头${i + 1}（${s.start.toFixed(2)}–${s.end.toFixed(2)}s，帧时间 ${frames[i].ts.map(t => t.toFixed(2)).join('、')}s）`), ...frames[i].files.map(image)])
    ], '你是严谨的广告复刻导演，只输出 JSON。', 2));
    const views: Gap[] = (j.views || []).slice(0, 3).map((v: any) => typeof v === 'string' ? { view: v, label: v, at: seconds / 2 }
      : { view: String(v.view), label: String(v.label || v.view), at: Math.min(Number(v.at) || 0, seconds - 0.1) });
    const needs: Gap[] = (Array.isArray(j.needs) ? j.needs : []).filter((n: any) => n?.label && ['part', 'screen', 'cast'].includes(n.kind)).slice(0, 6)
      .map((n: any) => ({ kind: n.kind, view: String(n.view || n.label), label: String(n.label), at: Math.min(Number(n.at) || 0, seconds - 0.1), need: String(n.need || ''), fallback: String(n.fallback || ''), ...(n.kind === 'cast' ? { generate: n.generate === true } : {}), shots: (Array.isArray(n.shots) ? n.shots : []).map(Number).filter((k: number) => k > 0) }));
    const byIdx = new Map<number, any>((j.shots || []).map((s: any) => [Number(s.index), s]));
    const planShots = shots.map((s, i) => { const x = byIdx.get(i + 1) || {}; return { index: i + 1, start: s.start, end: s.end, change: x.change !== false, scene: String(x.scene || 'A'), note: String(x.note || ''),
      fit: (['good', 'rough', 'no'].includes(x.fit) ? x.fit : 'good') as 'good' | 'rough' | 'no', why: String(x.why || '') }; });
    let variants: Variant[] = (j.variants || []).map((v: any) => ({ id: String(v.id), label: String(v.label || v.id), desc: String(v.desc || '').slice(0, 80), main: !!v.main, at: Number(v.at) }));
    if (variants.length && variants.filter(v => v.main).length !== 1) variants = variants.map((v, i) => ({ ...v, main: i === 0 }));
    let scenes: Plan['scenes'] = (j.scenes || []).map((s: any) => ({ id: String(s.id), shots: (s.shots || []).map(Number), keyAt: Number(s.keyAt), edit: String(s.edit || ''),
      variant: variants.some(v => v.id === String(s.variant)) ? String(s.variant) : variants.find(v => v.main)?.id }));
    // Every changed shot needs a scene with a keyframe; a scene with a bad keyAt takes its first changed shot's middle.
    for (const s of planShots.filter(x => x.change)) if (!scenes.some(c => c.id === s.scene)) scenes.push({ id: s.scene, shots: [s.index], keyAt: (s.start + s.end) / 2, edit: String(j.change || ''), variant: variants.find(v => v.main)?.id });
    scenes = scenes.filter(c => planShots.some(s => s.change && s.scene === c.id)).map(c => {
      const own = planShots.filter(s => s.change && s.scene === c.id);
      return own.some(s => c.keyAt >= s.start && c.keyAt < s.end) ? c : { ...c, keyAt: (own[0].start + own[0].end) / 2 };
    });
    return { by: 'llm', recast: j.recast === true, speech: typeof j.speech === 'string' ? j.speech.trim().slice(0, 30) : '', noCaptions: j.noCaptions === true,
      subject: String(j.subject || ''), target: String(j.target || ''), keep: String(j.keep || ''), change: String(j.change || ''),
      summary: String(j.summary || ''), views: views.map(g => g.view), gaps: [...views, ...needs], variants, scenes, shots: planShots };
  } catch (e: any) {
    say(id, `方案模型没有回应（${e.message}），改用基础方案`);
    return basic('模型没回应');
  }
}

// ---------- 补全素材 ----------
export async function completeAssets(id: string, plan: Plan) {
  const p = await providers(), r = rep(id), dir = path.join(dirOf(id), 'assets');
  fs.mkdirSync(dir, { recursive: true });
  phase(id, 'assets', 'running', `补 ${plan.views.join('、')}`);
  edit(id, x => { x.sheet = { views: plan.views }; });
  const refs = r.uploads.map((_, i) => `@image${i + 1}`).join(', ');
  const shape = r.shapeRefs || [], shapeTags = shape.map((_, i) => `@image${r.uploads.length + i + 1}`).join(', ');
  const shapeLine = shape.length ? ` ${shapeTags} show the same model, possibly in another colourway: use them only to know its shape from other angles (sole, heel, side, top). Every colour, material, pattern and marking comes from ${refs} only.` : '';
  let fix = '';
  for (let k = 0; k < 2; k++) {
    const prompt = `Reference sheet of ${plan.subject || 'the subject'} from ${refs}. One image, several views side by side on a plain light grey studio background: ` +
      `the front view as in the pictures, plus ${plan.views.join(', ')}. Exactly the same design, shape, proportions, colours, materials, markings and logos as in ${refs}; ` +
      `invent nothing that contradicts them. A side no picture shows stays plain: its base material only, with no lines, prints, logos or texture details copied or mirrored from the visible side; the two sides of a product are often different.${shapeLine} Even soft light, sharp. No text, no labels, no letters.${fix}`;
    const tryDir = path.join(dir, `sheet-t${k + 1}`); fs.mkdirSync(tryDir, { recursive: true }); // every attempt kept for 链路复盘
    const out = (await p.image.targetFrames({ prompt, refs: [...r.uploads, ...shape], ratio: '16:9', count: 1, outDir: tryDir, log: m => say(id, `补全素材：${m}`), bill: biller(id, '补全素材') }))[0];
    const v = await judge(id, [text(`下面先是用户的原图${shape.length ? '和同款实拍的其他角度（可能是别的配色，只看形状和图案位置）' : ''}，最后一张是根据它们补全的多视图设定图（应包含：${plan.views.join('、')}）。这张设定图是为了补全用户图里缺的角度，补得合理就够，不要求和真品分毫不差。
只有出现下面的大错才判 ok=false：配色错（包括把同款其他配色的颜色串进来）；实拍图看得到的主要图案、logo 画错或画到了别的位置；把一侧的醒目图案照搬到另一侧；编造了醒目的图案、logo 或大字；畸形；要求的视角没补齐。
线条数量、小字、纹理疏密、细小结构这类细节偏差不算不通过，写在 issue 里即可。只输出 JSON：{"ok":true,"issue":"中文，问题","fix":"英文，重做时追加的修改要求"}${notesFor(r)}`),
      ...[...r.uploads, ...shape].map(image), image(out)]);
    edit(id, x => { x.sheet = { views: plan.views, file: out, ok: v.ok, issue: v.issue }; });
    if (v.ok) return phase(id, 'assets', 'done', `已补 ${plan.views.join('、')}`);
    fix = v.fix ? ` Fix: ${v.fix}` : '';
  }
  edit(id, x => { x.sheet!.file = undefined; });
  phase(id, 'assets', 'done', '补出来的图和原图不够一致，没用它，只用你的原图');
}

/** The user's thing in the film's other colours: same design, recoloured from a frame of that version. */
async function makeVariants(id: string, others: Variant[], source: string) {
  const p = await providers(), r = rep(id), dir = path.join(dirOf(id), 'assets');
  fs.mkdirSync(dir, { recursive: true });
  phase(id, 'assets', 'running', `做 ${others.map(v => v.label).join('、')} 的颜色`);
  edit(id, x => { x.variantAssets = [...(x.variantAssets || []), ...others.map(v => ({ id: v.id, label: v.label }))]; });
  const base = r.sheet?.file ? [r.sheet.file] : r.uploads.slice(0, 2);
  await Promise.all(others.map(async v => {
    const d = path.join(dir, v.id); fs.mkdirSync(d, { recursive: true });
    const frame = await frameAt(source, v.at, path.join(d, 'source.jpg'));
    const set = (patch: object) => edit(id, x => Object.assign(x.variantAssets!.find(a => a.id === v.id)!, patch));
    const refs = [...base, frame], own = base.map((_, k) => `@image${k + 1}`).join(' and '), colour = `@image${refs.length}`;
    let fix = '';
    for (let k = 0; k < 2; k++) {
      const prompt = `Product recolour. Keep ${own} exactly as ${base.length > 1 ? 'they are' : 'it is'}: same garment, cut, proportions, pockets, buttons, knit texture, chest graphic, layout, pose and background. ` +
        `Change only its colours to ${v.desc || 'the colours of the garment'} as worn in ${colour}. ${colour} is only a colour reference: take nothing else from it, not its print, shape or person. ` +
        `The chest graphic stays the design from ${own}. No new text, no letters.${fix}`;
      const out = (await p.image.targetFrames({ prompt, refs, ratio: '1:1', count: 1, outDir: d, log: m => say(id, `补全素材 ${v.label}：${m}`), bill: biller(id, `素材 ${v.label}`) }))[0];
      const c = await judge(id, [text(`先是用户原图，然后是原片里这一版衣服的颜色参考，最后一张是改色结果。检查结果是否：和原图同款同图案（版型、口袋、胸口图案都没变），颜色接近参考（${v.desc}）。只输出 JSON：{"ok":true,"issue":"中文，问题","fix":"英文，重做时追加的修改要求"}`),
        ...refs.map(image), image(out)]);
      set({ file: out, ok: c.ok, issue: c.issue });
      if (c.ok) return;
      fix = c.fix ? ` Fix: ${c.fix}` : '';
    }
  }));
  const bad = rep(id).variantAssets!.filter(a => !a.ok).length;
  phase(id, 'assets', 'done', `做好 ${others.map(v => v.label).join('、')}${bad ? `，${bad} 款颜色有小问题` : ''}`);
}

/** One model verdict. In basic mode (no model) everything passes. */
async function judge(id: string, parts: Parameters<typeof ask>[0]): Promise<{ ok: boolean; issue: string; fix: string }> {
  if (planner() !== 'llm') return { ok: true, issue: '', fix: '' };
  try { const j = parseJson(await ask(parts, '你是严格的画面验收员，只输出 JSON。', 2)); return { ok: j.ok !== false, issue: String(j.issue || ''), fix: String(j.fix || '') }; }
  catch (e: any) { say(id, `验收模型没有回应（${e.message}），按通过处理`); return { ok: true, issue: '', fix: '' }; }
}

/** The new people for these scenes, at most two (a run takes few pictures). */
const castFor = (r: Replica, scenes: string[]) => (r.castRefs || []).filter(x => x.scenes.some(c => scenes.includes(c))).slice(0, 2);

/** The pictures that define the user's thing: the completed sheet when there is one, else their uploads. */
const baseRefs = (r: Replica, scene?: string) => {
  const real = scene ? photosForScenes(r.photoPicks, [scene], r.uploads) : r.uploads;
  // Real photos first, so a slot that is short drops the generated sheet and not them: only the first upload used to
  // get through next to a sheet, which lost an angle the user had just added on 开始前确认.
  return r.sheet?.file ? [...real.slice(0, scene ? 2 : KEYFRAME_PHOTOS), r.sheet.file] : real.slice(0, KEYFRAME_PHOTOS);
};
/** The same for one colour version: its recoloured asset first, when it has one. */
const assetRefs = (r: Replica, variant?: string, scene?: string) => {
  const own = r.variantAssets?.find(a => a.id === variant)?.file;
  return own ? [own] : baseRefs(r, scene);
};
const variantOf = (plan: Plan, scene?: string) => plan.variants.find(v => v.id === plan.scenes.find(c => c.id === scene)?.variant);
/** The product's known pitfalls, for the checks: each one broke an earlier job, so breaking it fails the picture. */
const notesFor = (r: Replica) => r.productNotes?.length ? `\n这个商品的已知要点（以前出过错，逐条核对，违反任何一条就不通过）：\n${r.productNotes.map(n => '- ' + n).join('\n')}` : '';

// ---------- 制作关键画面 ----------
/** Makes the keyframes a scene does not have yet: all of them on a new job, only the added ones on a redo. */
async function makeKeyframes(id: string, plan: Plan, ratio: Ratio, source: string) {
  const p = await providers(), dir = path.join(dirOf(id), 'keyframes');
  fs.mkdirSync(dir, { recursive: true });
  phase(id, 'keyframes', 'running', `${plan.scenes.length} 张`);
  const film = await probe(source), wide = ratio === '21:9', aspect = film.width / film.height; // the image model refuses 21:9
  const had = rep(id).keyframes;
  const kfs: Keyframe[] = await Promise.all(plan.scenes.map(async c => had.find(k => k.scene === c.id && k.out) || ({ scene: c.id, at: c.keyAt, tries: 0, source: await frameAt(source, c.keyAt, path.join(dir, `${c.id}-source.jpg`)) })));
  const todo = plan.scenes.map((c, i) => i).filter(i => !kfs[i].out);
  edit(id, r => { r.keyframes = kfs; });
  const kfEdit = (i: number, patch: Partial<Keyframe>) => edit(id, r => Object.assign(r.keyframes[i], patch));
  const partsOf = (i: number) => (rep(id).partRefs || []).filter(x => x.scenes.includes(plan.scenes[i].id)).slice(0, 2);
  const castOf = (i: number) => castFor(rep(id), [plan.scenes[i].id]);
  const make = async (i: number, fix: string, anchor?: string) => {
    const c = plan.scenes[i], v = variantOf(plan, c.id), parts = partsOf(i), cast = castOf(i);
    // A scene of new people is about those people: their portraits are the references, not the product's photos, and the
    // prompt names the people that change instead of keeping "the same people" (10 Nov: both keyframes came back unchanged).
    if (cast.length) {
      const src = wide ? await letterbox(kfs[i].source, path.join(dir, `${c.id}-box.jpg`)) : kfs[i].source, refs = [src, ...cast.map(x => x.file)];
      const prompt = `Photo edit. Keep the photograph @image1 as it is: the same framing, composition, poses, hands, clothes, accessories, background, light, focus and grain. ` +
        cast.map((x, k) => `The person in @image1 to be recast as "${x.label}" (the one of the matching sex) becomes the person in @image${k + 2}: their face, skin and facial features in this exact pose, angle and expression; a different person from the one in @image1. `).join('') +
        `Change: ${c.edit || plan.change}.` +
        (wide ? ' @image1 has black bars above and below the picture: keep them exactly as they are, pure black, with nothing in them.' : '') +
        (plan.dropText ? ' Remove all captions, subtitles and decorative titles from the picture, restoring what is behind them.' : '') +
        ` It must look photographed in this light, not pasted on. No text, no letters, no logos added.${fix}`;
      kfEdit(i, { prompt, tries: rep(id).keyframes[i].tries + 1 });
      const tmp = path.join(dir, `${c.id}-t${rep(id).keyframes[i].tries}`); fs.mkdirSync(tmp, { recursive: true });
      const got = (await p.image.targetFrames({ prompt, refs, ratio: wide ? '16:9' : ratio, count: 1, outDir: tmp, log: m => say(id, `制作关键画面 ${c.id}：${m}`), bill: biller(id, `关键画面 ${c.id}`) }))[0];
      const out = wide ? await unbox(got, aspect, path.join(tmp, 'frame-film.jpg')) : got;
      kfEdit(i, { out });
      return out;
    }
    // A scene with a part picture is about that part: two pictures of the whole thing are enough, and no anchor from a
    // scene that shows the outside (6 Nov, Firefly: a cabin picture went to every scene and lost to the exterior's colours).
    const assets = parts.length ? assetRefs(rep(id), c.variant, c.id).slice(0, 2) : assetRefs(rep(id), c.variant, c.id).slice(0, 4);
    if (parts.length) anchor = undefined;
    // Shape photos go in directly: a rejected multi-view sheet used to cut them off before this step (5 Nov, Anta).
    const shape = parts.length ? [] : (rep(id).shapeRefs || []).slice(0, 3), refs = [wide ? await letterbox(kfs[i].source, path.join(dir, `${c.id}-box.jpg`)) : kfs[i].source, ...assets, ...shape, ...parts.map(x => x.file), ...(anchor ? [anchor] : [])];
    const partLine = parts.map((x, k) => { const tag = `@image${1 + assets.length + k + 1}`;
      return ` ${tag} is ${x.web ? 'a photo found online of' : 'the user\'s photo of'} the real ${x.label} of this product: in @image1 the ${x.label} must be rebuilt exactly like ${tag}, its layout, shape, screens, colours and materials, seen from the camera position and framing of @image1. Nothing of the original ${x.label} stays. The colours of the ${x.label} come from ${tag}, not from the other pictures.`; }).join('');
    const shapeTags = shape.map((_, k) => `@image${assets.length + k + 2}`).join(', ');
    const a = assets.map((_, k) => `@image${k + 2}`).join(' and ');
    const prompt = `Photo retouch. Keep the photograph @image1 exactly as it is: the same framing, composition, people, poses, hands, background, light, focus and grain. ` +
      `Change only this: ${c.edit || plan.change}. ${plan.subject ? `The new ${plan.subject} must look exactly like ${a}` : `The new subject must look exactly like ${a}`}: same shape, proportions, colours, materials and markings, ` +
      `at the same size, position, angle and state as ${plan.target || 'the original'} in @image1.` + (v?.desc && !v.main ? ` In this scene its colours are: ${v.desc}.` : '') +
      (shape.length ? ` ${shapeTags} show the same model from other angles, possibly in another colourway: take only its shape from them (sole, heel, side panels, silhouette) and use it for the angle seen in @image1. Every colour, material and marking comes from ${a} only, never from ${shapeTags}.` : '') +
      partLine + ` ${plan.recast ? 'Only the people this change names are replaced; the reference pictures\' own models and props are never copied.' : NO_PHOTO_PEOPLE}` +
      (wide ? ' @image1 has black bars above and below the picture: keep them exactly as they are, pure black, with nothing in them.' : '') +
      (anchor ? ` @image${refs.length} shows the same thing already placed in another shot of this film: match it exactly.` : '') +
      (plan.dropText ? ' Remove all captions, subtitles and decorative titles from the picture, restoring what is behind them.' : '') +
      (rep(id).productNotes?.length ? ` Known facts about this product, each from an earlier mistake: ${rep(id).productNotes!.join('; ')}.` : '') +
      ` It must look photographed in this light, not pasted on. No text, no letters, no logos added.${fix}`;
    kfEdit(i, { prompt, tries: rep(id).keyframes[i].tries + 1 });
    const tmp = path.join(dir, `${c.id}-t${rep(id).keyframes[i].tries}`); fs.mkdirSync(tmp, { recursive: true });
    const got = (await p.image.targetFrames({ prompt, refs, ratio: wide ? '16:9' : ratio, count: 1, outDir: tmp, log: m => say(id, `制作关键画面 ${c.id}：${m}`), bill: biller(id, `关键画面 ${c.id}`) }))[0];
    const out = wide ? await unbox(got, aspect, path.join(tmp, 'frame-film.jpg')) : got;
    kfEdit(i, { out });
    return out;
  };
  // The first keyframe sets the look; the others get it as an anchor, so the thing is the same in every scene.
  // Anchors stay inside one colour version: a keyframe of another colour would pull this one towards it.
  // Scenes ruled by a part picture neither take nor give an anchor.
  const plain = plan.scenes.map((c, i) => i).filter(i => !partsOf(i).length && !castOf(i).length);
  const lead = new Map<string | undefined, string>();
  for (const i of plain) if (kfs[i].out && kfs[i].ok !== false && !lead.has(plan.scenes[i].variant)) lead.set(plan.scenes[i].variant, kfs[i].out!);
  const open = plain.filter(i => todo.includes(i) && !lead.has(plan.scenes[i].variant));
  const leads = open.filter(i => open.find(k => plan.scenes[k].variant === plan.scenes[i].variant) === i);
  await Promise.all(leads.map(async i => { lead.set(plan.scenes[i].variant, await make(i, '')); }));
  await Promise.all(todo.map(i => leads.includes(i) ? undefined : make(i, '', lead.get(plan.scenes[i].variant))));

  // 联合验收: all keyframes at once, against the asset and each other; only the failed ones are made again.
  for (let round = 1; round <= KEYFRAME_TRIES; round++) {
    phase(id, 'keyframes', 'running', round === 1 ? '一起验收' : `第 ${round} 次验收`);
    const r = rep(id);
    const verdict = await judgeKeyframes(id, r, plan);
    verdict.forEach((v, i) => { if (todo.includes(i)) kfEdit(i, { ok: v.ok, issue: v.issue }); });
    const bad = verdict.map((v, i) => ({ v, i })).filter(x => !x.v.ok && todo.includes(x.i));
    if (!bad.length || round === KEYFRAME_TRIES) break; // the last take is judged too, and not made again
    const anchorOf = (i: number) => verdict.findIndex((v, k) => v.ok && k !== i && plain.includes(k) && plan.scenes[k].variant === plan.scenes[i].variant);
    await Promise.all(bad.map(({ v, i }) => { const a = anchorOf(i); return make(i, v.fix ? ` Fix: ${v.fix}` : '', a >= 0 ? rep(id).keyframes[a].out : undefined); }));
  }
  const left = todo.filter(i => rep(id).keyframes[i].ok === false).length;
  // Not one keyframe is right: video made from them would be wrong too, and it is the expensive part.
  if (left && left === todo.length) {
    edit(id, r => { r.keyframeStop = true; });
    throw new Error(`${left} 张关键画面都没通过验收，已停下，还没有生成视频。比如：${rep(id).keyframes[todo[0]].issue || '和你的图不一致'}`);
  }
  phase(id, 'keyframes', 'done', `${todo.length} 张${left ? `，${left} 张没通过验收` : '，验收通过'}`);
}

async function judgeKeyframes(id: string, r: Replica, plan: Plan) {
  if (planner() !== 'llm') return r.keyframes.map(() => ({ ok: true, issue: '', fix: '' }));
  try {
    const j = parseJson(await ask([
      text(`验收关键画面。先是用户的参考图${r.sheet?.file ? '和补全的多视图设定图' : ''}${r.shapeRefs?.length ? '、同款其他角度的实拍图（可能是别的配色）' : ''}，然后每个场景给两张：原片帧、改好的关键画面。要替换的：${plan.target} → ${plan.subject}；要保留：${plan.keep}。
逐张检查：0）商品已知要点（见下）全部满足；有部位图的场景，这个部位的布局、结构、屏幕和颜色要和部位图一致，原片的样子不能残留，颜色不以外观图为准；1）替换后的东西和参考图是否是同一个（配色、材质、logo 以用户的图为准；同款其他角度的实拍图决定形状和图案位置；参考图都看不到的部位，出现了参考图里没有的线条、图案或纹理就不通过）；2）构图、姿态、手、背景、光线是否和原片帧一致；3）同款是否一致（颜色按各场景标注的版本，版本不同颜色就该不同）；4）只换了该换的东西，原片的人物不能变，参考图里的人和物品（模特、杂志、水杯等）不能出现，其他人的衣服、玩偶、毛毯、鞋没被改；5）有无贴图感、多余文字、畸形。
只输出 JSON：{"results":[{"id":"场景id","ok":true,"issue":"中文，问题","fix":"英文，重做时追加的修改要求"}]}${notesFor(r)}`),
      ...baseRefs(r).map(image), ...(r.shapeRefs || []).map(image),
      ...(r.partRefs || []).flatMap(x => [text(`部位图「${x.label}」，只用于场景 ${x.scenes.join('、')}：`), image(x.file)]),
      ...(r.castRefs || []).flatMap(x => [text(`新人物「${x.label}」，场景 ${x.scenes.join('、')} 里对应的人必须换成这张图里的人：脸、五官和原片不同才算换了，人还是原片那张脸就不通过；姿势、衣服照原片：`), image(x.file)]),
      ...r.keyframes.flatMap(k => { const v = variantOf(plan, k.scene); return [text(`场景 ${k.scene}${v ? `（${v.label}：${v.desc}）` : ''}：原片帧 / 关键画面`), image(k.source), image(k.out!)]; })
    ], '你是严格的画面验收员，只输出 JSON。', 2));
    return r.keyframes.map(k => { const x = (j.results || []).find((y: any) => String(y.id) === k.scene) || {}; return { ok: x.ok !== false, issue: String(x.issue || ''), fix: String(x.fix || '') }; });
  } catch (e: any) {
    say(id, `验收模型没有回应（${e.message}），按通过处理`);
    return r.keyframes.map(() => ({ ok: true, issue: '', fix: '' }));
  }
}

// ---------- 分段 ----------
/** Segments over runs of changed shots only; cuts inside a run are hard, splits inside a shot soft (with overlap). */
export function planSegs(plan: Plan, fps: number, minS: number, maxS: number): ReplicaSeg[] {
  const ov = OVERLAP_FRAMES / fps, runs: Plan['shots'][] = [];
  for (const s of plan.shots) {
    if (!s.change) continue;
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1].index === s.index - 1) last.push(s); else runs.push([s]);
  }
  const total = plan.shots[plan.shots.length - 1].end;
  const out: ReplicaSeg[] = [];
  const scenesIn = (start: number, end: number) => [...new Set(plan.shots.filter(x => x.change && x.end > start + 0.01 && x.start < end - 0.01).map(x => x.scene))];
  // A run takes a limited number of pictures, so a piece with too many scenes is split at the cut nearest its middle.
  const fit = (s: { start: number; end: number; join: ReplicaSeg['join'] }): typeof s[] => {
    if (scenesIn(s.start, s.end).length <= MAX_SEG_SCENES) return [s];
    const mid = (s.start + s.end) / 2;
    const cut = plan.shots.map(x => x.start).filter(t => t - s.start >= minS && s.end - t >= minS).sort((x, y) => Math.abs(x - mid) - Math.abs(y - mid))[0];
    return cut == null ? [s] : [...fit({ start: s.start, end: cut, join: s.join }), ...fit({ start: cut, end: s.end, join: 'hard' })];
  };
  for (const run of runs) {
    let a = run[0].start, b = run[run.length - 1].end;
    // A run shorter than the model's minimum borrows untouched footage around it.
    if (b - a < minS) { const need = minS - (b - a); a = Math.max(0, a - need / 2); b = Math.min(total, a + minS); a = Math.max(0, b - minS); }
    const cuts = run.slice(1).map(s => s.start - a);
    for (const s of planSegments(b - a, cuts, minS, Math.min(SEG_TARGET, maxS - ov), maxS - ov).flatMap(x => fit({ start: a + x.start, end: a + x.end, join: x.index === 0 ? 'start' : x.join }))) {
      const scenes = scenesIn(s.start, s.end);
      out.push({ index: out.length, start: s.start, end: s.end, genStart: s.join === 'soft' ? Math.max(0, s.start - ov) : s.start, join: s.join, scenes: scenes.length ? scenes : [plan.scenes[0].id], images: [], tries: 0, status: 'waiting' });
    }
  }
  return out;
}

// ---------- 生成视频 + 检查修复 ----------
/** A product photo may have a model in it (7 Nov: a woman reading in the 900L cabin). She and her things are not the product. */
const NO_PHOTO_PEOPLE = 'People in the reference pictures, and what they hold or wear, are not part of the product: never copy them. The people on screen stay exactly those of the original footage.';
const MOUTHS = 'Mouths stay exactly as in @video1: nobody sings, speaks or mouths words unless they do in @video1.';
/** The fixed rules, minus the ones the user's own request overrides. 10 Nov: "recast them as Russian actors speaking Russian"
 *  went out with "the people on screen stay exactly those of the original" and "mouths stay as in @video1" at the end of every
 *  prompt, and the model obeyed those: nobody was recast. */
export const peopleRule = (plan: Plan) => plan.recast
  ? 'The people on screen become the people shown in the pictures for their shots: their faces in every frame; clothes, hair, poses and actions stay as in @video1.'
  : NO_PHOTO_PEOPLE;
export const mouthRule = (plan: Plan) => plan.speech
  ? `The people speak ${plan.speech}: their lips move naturally with ${plan.speech} speech wherever they speak in @video1.`
  : MOUTHS;

/** Which picture rules which seconds of the piece: this is what makes a 1 s pink shot come out pink. */
export function timeline(plan: Plan, s: ReplicaSeg, refOf: (scene: string) => number | undefined) {
  const f = (t: number) => Math.max(0, t - s.genStart).toFixed(2);
  return plan.shots.filter(x => x.end > s.genStart + 0.01 && x.start < s.end - 0.01).map(x => {
    const span = `${f(Math.max(x.start, s.genStart))}-${f(Math.min(x.end, s.end))}s`;
    if (!x.change) return `${span}: leave this shot exactly as in @video1.`;
    const v = variantOf(plan, x.scene), ref = refOf(x.scene);
    // A colour only for the other colour versions: the main one is what the pictures already show (10 Nov: "colours blue-silver" on a woman's close-up).
    // The note is the planner's English description of the shot: kept short and cut at a word, never mid-word.
    const note = x.note ? ' ' + (x.note.length > 110 ? x.note.slice(0, 110).replace(/[,;]?\s+\S*$/, '') + '.' : x.note) : '';
    return `${span}: ${ref ? `match @image${ref}` : 'apply the change'}${v?.desc && !v.main ? `, colours ${v.desc}` : ''}.${note}`;
  });
}

/** Only what this piece needs (10 Nov: a 5 s close-up of the woman got 2,273 characters about the whole film, the tower included,
 *  and a picture of the tower). The keyframes already show the change; the words say which picture rules which seconds.
 *  `cast`: labels of the new people's portraits, which come right after the keyframes; `assetCount` 0 = no product here. */
export function segPrompt(plan: Plan, s: ReplicaSeg, kfScenes: string[], assetCount: number, userPrompt: string, fix: string, cast: string[] = []) {
  const kfCount = kfScenes.length;
  const as = Array.from({ length: assetCount }, (_, k) => `@image${kfCount + cast.length + k + 1}`).join(' and ');
  const ref = (scene: string) => { const i = kfScenes.indexOf(scene); return i < 0 ? undefined : i + 1; };
  const line = (lines: string[]) => [
    '@video1 is the original footage: keep its shots, cuts, camera, timing, actions and light.',
    kfCount ? 'The pictures show it with the change made:' : `Change: ${plan.change || 'the main subject becomes the one in the reference pictures'}.`,
    ...lines,
    ...cast.map((label, k) => `Replace the person in @video1 who is ${label} with the person in @image${kfCount + k + 1}.`),
    as ? `${as} ${assetCount > 1 ? 'show' : 'shows'} the ${plan.subject.split(/[:,.]/)[0] || 'new subject'}: the same design in every frame.` : '',
    userPrompt && plan.by === 'basic' ? `Also: ${userPrompt}.` : '',
    fix ? `Fix: ${fix.slice(0, 300)}` : '',
    plan.dropText ? 'Remove all captions and subtitles.' : '',
    plan.speech ? `They speak ${plan.speech}.` : MOUTHS,
    // Product photos may have a model in them; without product pictures the warning has nothing to warn about.
    as && !plan.recast ? NO_PHOTO_PEOPLE : '',
    'No new text or logos.'
  ].filter(Boolean).join(' ');
  const lines = timeline(plan, s, ref);
  const full = line(lines);
  return full.length <= 2400 ? full : line(lines.map(l => l.replace(/(\.) .*$/, '$1')));
}

/** One run of the whole film. The look is checked once and reported; a redo costs money, so that is the user's call. */
async function generateSimple(id: string, plan: Plan, ratio: Ratio, source: string) {
  const p = await providers(), dir = path.join(dirOf(id), 'segments'), s = rep(id).segments[0], r = rep(id);
  fs.mkdirSync(dir, { recursive: true });
  phase(id, 'generate', 'running', '一次生成');
  phase(id, 'repair', 'waiting');
  const piece = await cutPiece(source, { index: 0, start: s.start, end: s.end, join: 'hard' }, path.join(dir, 'seg0-src.mp4'));
  const images = [...photosForScenes(r.photoPicks, s.scenes, r.uploads), ...(r.shapeRefs || [])].slice(0, p.video.maxRefs ?? 5);
  const prompt = simplePrompt(plan, images.length, r.prompt, plan.dropText);
  segEdit(id, 0, { status: 'running', tries: 1, prompt, images, source: piece });
  const raw = await slot(() => p.video.edit({ prompt: p.video.bindRefs ? p.video.bindRefs(prompt) : prompt, source: piece, images, ratio,
    duration: Math.min(p.video.maxSeconds, Math.max(p.video.minSeconds, Math.ceil(s.end - s.start))), outFile: path.join(dir, 'seg0-t1.mp4'),
    log: m => say(id, `视频：${m}`), bill: biller(id, '视频') }));
  const fit = await conformPiece(piece, raw, path.join(dir, 'seg0-t1-fit.mp4'));
  phase(id, 'generate', 'done', '一次生成');
  phase(id, 'repair', 'running', '检查外观');
  const len = s.end - s.start;
  const frames = await Promise.all([0.2, 0.5, 0.8].map((k, i) => frameAt(fit, len * k, path.join(dir, `seg0-look${i}.jpg`), 640)));
  const v = await judge(id, [text(`先是商品照片，后面 3 张是生成视频里的帧。检查换上去的东西（${plan.subject}）：颜色款式是否一致，Logo 和文字是否清楚、有没有乱码，有无畸形。只有明显问题才算不通过。只输出 JSON：{"ok":true,"issue":"中文，问题","fix":"英文"}${notesFor(r)}`),
    ...images.map(image), ...frames.map(image)]);
  segEdit(id, 0, { status: 'done', fit, qa: { pass: v.ok, lookBad: !v.ok, summary: v.ok ? '外观检查通过' : v.issue } });
  phase(id, 'repair', 'done', v.ok ? '外观通过' : '外观有问题，没有自动重做');
}

async function generate(id: string, plan: Plan, ratio: Ratio, source: string, fps: number, only?: number) {
  const p = await providers(), dir = path.join(dirOf(id), 'segments');
  fs.mkdirSync(dir, { recursive: true });
  const segs = rep(id).segments, n = segs.length;
  phase(id, 'generate', 'running', `${n} 段同时生成`);
  phase(id, 'repair', 'waiting');
  const pieces = await Promise.all(segs.map(s => cutPiece(source, { index: s.index, start: s.genStart, end: s.end, join: s.join }, path.join(dir, `seg${s.index}-src.mp4`))));
  const reports: (CheckReport & { look?: string; lookBad?: boolean })[] = [];
  // ALTER's structure and motion scores are kept for comparing takes but do not cause a redo: a white top turned navy
  // changes 46% of the picture and "fails" every time (6 Nov, Kelme: 12.86 yuan for two takes no better than the first).
  const qaOf = (q: CheckReport & { look?: string; lookBad?: boolean }) => ({ pass: q.pass, summary: q.summary, lookBad: q.lookBad, motion: q.raw?.motion_correlation });

  const once = async (s: ReplicaSeg, fix: string) => {
    const r = rep(id), tryNo = r.segments[s.index].tries + 1, tag = n > 1 ? `第 ${s.index + 1}/${n} 段` : '视频';
    const made = r.keyframes.filter(k => k.out && s.scenes.includes(k.scene));
    const kfs = s.scenes.map(c => made.find(k => k.scene === c)).filter(Boolean).slice(0, MAX_SEG_SCENES) as Keyframe[];
    const main = plan.scenes.find(c => c.id === s.scenes[0])?.variant;
    // The free slots go to the photos this piece's scenes need most.
    const own = r.variantAssets?.find(a => a.id === main)?.file;
    const best = own ? [own] : [...photosForScenes(r.photoPicks, s.scenes, r.uploads), ...(r.sheet?.file ? [r.sheet.file] : [])];
    const cast = castFor(r, s.scenes).slice(0, Math.max(0, (p.video.maxRefs ?? 5) - kfs.length));
    // A piece of only new people (no product in its scenes) gets no product pictures.
    const people = s.scenes.every(c => castFor(r, [c]).length);
    const assets = people ? [] : best.slice(0, Math.max(0, (p.video.maxRefs ?? 5) - kfs.length - cast.length));
    const images = [...kfs.map(k => k.out!), ...cast.map(x => x.file), ...assets];
    const prompt = segPrompt(plan, s, kfs.map(k => k.scene), assets.length, r.prompt, fix, cast.map(x => x.label));
    const sent = p.video.bindRefs ? p.video.bindRefs(prompt) : prompt;
    segEdit(id, s.index, { status: 'running', tries: tryNo, prompt, images, source: pieces[s.index] });
    const len = s.end - s.genStart;
    const raw = await slot(() => p.video.edit({ prompt: sent, source: pieces[s.index], images, ratio,
      duration: Math.min(p.video.maxSeconds, Math.max(p.video.minSeconds, Math.ceil(len))), outFile: path.join(dir, `seg${s.index}-t${tryNo}.mp4`),
      log: m => say(id, `${tag}：${m}`), bill: biller(id, `${tag}${only != null ? ' · 重做这段' : tryNo > 1 ? ' · 修复' : ''}`) }));
    const fit = await conformPiece(pieces[s.index], raw, path.join(dir, `seg${s.index}-t${tryNo}-fit.mp4`));
    const qa: CheckReport & { look?: string; lookBad?: boolean } = await p.checker.check(pieces[s.index], fit, 'swap', path.join(dir, `seg${s.index}-t${tryNo}-qa`))
      .catch(e => ({ pass: true, trimTail: 0, summary: `没能质检（${e.message}）` }));
    // The look of the new thing, judged on every changed shot: one frame per scene missed an overhead shot left unchanged
    // (7 Nov, 900L). Only an obvious fault counts: small differences are reported, but a redo costs as much as the first run.
    const shots = plan.shots.filter(x => x.change && x.end > s.start + 0.01 && x.start < s.end - 0.01).slice(0, 8);
    const pairs = await Promise.all(shots.map(async (x, n) => {
      const k = kfs.find(y => y.scene === x.scene), c = variantOf(plan, x.scene);
      const at = (Math.max(x.start, s.genStart) + Math.min(x.end, s.end)) / 2 - s.genStart;
      return [text(`镜头 ${x.index}（场景 ${x.scene}${c ? `，应为 ${c.label}：${c.desc}` : ''}）：${k ? '关键画面 / ' : ''}生成结果`), ...(k ? [image(k.out!)] : []), image(await frameAt(fit, at, path.join(dir, `seg${s.index}-t${tryNo}-look${n}.jpg`), 640))];
    }));
    const v = await judge(id, [text(`每组是一个要改的镜头：先是这个场景的关键画面（目标效果，角度可能和这个镜头不同），后面是生成视频里这个镜头的一帧。检查换上去的东西（${plan.subject}）。
只有明显错误才 ok=false：还是原来的东西没换、款式或型号不对、颜色不对、畸形、不该换的东西被改了、多出参考图里的人。纹理粗细、格栅和轮毂细节、打孔这类细节不一致不算，写进 issue，ok 仍为 true。
只输出 JSON：{"ok":true,"issue":"中文，问题","fix":"英文，重做时的修改要求"}${notesFor(rep(id))}`),
      ...pairs.flat()]);
    if (!v.ok) { qa.pass = false; qa.summary = [qa.summary.replace(/^自动质检通过.*/, ''), `外观：${v.issue}`].filter(Boolean).join('；'); qa.look = v.fix; qa.lookBad = true; }
    else if (v.issue) qa.summary = `${qa.summary}；外观小问题：${v.issue}`;
    return { fit, qa };
  };

  // Every segment runs on its own (anchored on keyframes, not on its neighbour), so all start at once.
  let firstError: Error | undefined;
  await Promise.all(segs.filter(s => only == null || s.index === only).map(async s => {
    try {
      const { fit, qa } = await once(s, '');
      reports[s.index] = qa;
      segEdit(id, s.index, { status: 'done', fit, qa: qaOf(qa) });
    } catch (e: any) { firstError ??= new Error(n > 1 ? `第 ${s.index + 1} 段：${e.message}` : e.message); segEdit(id, s.index, { status: 'failed', error: e.message }); }
  }));
  if (firstError) throw firstError;
  phase(id, 'generate', 'done', only != null ? `重做了第 ${only + 1} 段` : `${n} 段`);
  if (only != null) return phase(id, 'repair', 'done', '这次只重做一段');

  // 检查修复: motion / look from the checks above, plus every soft seam: the overlap frames of two neighbours show the
  // same source moment, so they must agree. A failing segment is generated once more; the better take is kept.
  phase(id, 'repair', 'running', '检查动作、外观和接缝');
  const seamScore = async (s: ReplicaSeg) => {
    const r = rep(id), prev = r.segments[s.index - 1];
    if (s.join !== 'soft' || !prev?.fit || !s.fit) return undefined;
    const at = s.genStart - prev.genStart + 0.5 / fps;
    const a = await frameAt(prev.fit, at, path.join(dir, `seam${s.index}-a.jpg`)), b = await frameAt(s.fit, 0.5 / fps, path.join(dir, `seam${s.index}-b.jpg`));
    return ssim(a, b).catch(() => undefined);
  };
  for (const s of segs) {
    const seam = await seamScore(rep(id).segments[s.index]);
    if (seam != null) segEdit(id, s.index, { qa: { ...rep(id).segments[s.index].qa!, seam: Math.round(seam * 100) / 100 } });
  }
  const needs = rep(id).segments.filter(s => s.qa?.lookBad || (s.qa?.seam != null && s.qa.seam < SEAM_MIN));
  if (!needs.length) return phase(id, 'repair', 'done', '外观和接缝没问题，不用重做');
  phase(id, 'repair', 'running', `重做 ${needs.length} 段`);
  let fixed = 0;
  await Promise.all(needs.map(async s => {
    if (s.tries >= SEGMENT_TRIES) return;
    const seamBad = s.qa?.seam != null && s.qa.seam < SEAM_MIN;
    const fix = [reports[s.index]?.look, seamBad ? 'The first frames must continue seamlessly from the previous shot: same positions, same look.' : ''].filter(Boolean).join(' ');
    try {
      const again = await once(s, fix);
      const old = rep(id).segments[s.index];
      segEdit(id, s.index, { fit: again.fit, qa: qaOf(again.qa), status: 'done', repaired: true });
      const seam = await seamScore(rep(id).segments[s.index]);
      const score = (lookBad?: boolean, sm?: number) => (lookBad ? 0 : 2) + ((sm ?? 1) >= SEAM_MIN ? 1 : 0);
      const a = score(again.qa.lookBad, seam), b = score(old.qa?.lookBad, old.qa?.seam), m = again.qa.raw?.motion_correlation;
      // A tie used to go to the new take, which on 6 Nov kept motion 0.07 over 0.28.
      const better = a > b || (a === b && m != null && old.qa?.motion != null && m > old.qa.motion);
      if (better) { fixed++; segEdit(id, s.index, { qa: { ...qaOf(again.qa), seam: seam != null ? Math.round(seam * 100) / 100 : undefined } }); }
      else segEdit(id, s.index, { fit: old.fit, qa: old.qa, repaired: false }); // the first take was better: keep it
    } catch (e: any) { say(id, `第 ${s.index + 1} 段修复失败（${e.message}），保留第一次的结果`); segEdit(id, s.index, { status: 'done' }); }
  }));
  phase(id, 'repair', 'done', `修了 ${fixed}/${needs.length} 段`);
}

// ---------- 合成 ----------
async function compose(id: string, plan: Plan, source: string, fps: number) {
  const dir = path.join(dirOf(id), 'compose'), segs = rep(id).segments;
  fs.mkdirSync(dir, { recursive: true });
  const total = (await probe(source)).seconds, items: { file: string; overlap: number }[] = [];
  let t = 0, k = 0;
  const keep = async (a: number, b: number) => { if (b - a > 0.5 / fps) items.push({ file: await cutPiece(source, { index: k, start: a, end: b, join: 'hard' }, path.join(dir, `keep${k++}.mp4`)), overlap: 0 }); };
  for (const s of segs) {
    if (s.start > t + 0.5 / fps) await keep(t, s.start);
    const head = s.start - s.genStart, blend = head > 0 && (s.qa?.seam ?? 1) >= SEAM_BLEND;
    // A straight cut drops the overlap frames, so the piece still starts exactly where the previous one ends.
    const file = head > 0 && !blend ? await cutPiece(s.fit!, { index: s.index, start: head, end: s.end - s.genStart, join: 'hard' }, path.join(dir, `seg${s.index}-cut.mp4`)) : s.fit!;
    items.push({ file, overlap: blend ? head : 0 });
    t = s.end;
  }
  await keep(t, total);
  const joined = await stitch(items, fps, path.join(dir, 'joined.mp4'));
  return finish(source, joined, path.join(dirOf(id), 'final.mp4'));
}
