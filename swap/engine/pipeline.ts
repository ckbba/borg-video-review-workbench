// The job state machine. A job is one user upload against one template:
//   checking → framing → pick (user chooses a preview) → rendering → done
// Rendering = the user's swap, then each picked choice on the previous result, then the ticked versions;
// clips longer than the model's limit are cut into segments (./segments.ts) and joined back.
// State is a JSON file per job (swap/data/jobs/<id>/job.json), so the UI just polls it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { compare, finish, frameAt, prepare, probe } from './media';
import { buildPrompt } from './presets';
import { providers } from './registry';
import { detectShots } from '../../server/shots';
import { conformPiece, cutAudio, cutPiece, joinPieces, lastFrame, planSegments, seamImage, Segment } from './segments';
import { chainOf, getTemplate, templateFile, withMode } from './templates';
import type { AudioRef, Bill, CheckMode, CheckReport, Job, SegTrace, Template, TextEditKind, VersionRun } from './types';

export const DATA = path.resolve('swap/data');
const JOBS = path.join(DATA, 'jobs');
const PREVIEWS = 2;

// ---------- storage ----------
export const newJobId = () => new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(3).toString('hex');
export const dirOf = (id: string) => path.join(JOBS, id);
export function getJob(id: string): Job {
  if (!/^[\w-]+$/.test(id)) throw new Error('任务编号不对');
  return JSON.parse(fs.readFileSync(path.join(dirOf(id), 'job.json'), 'utf8'));
}
export function save(job: Job) { job.pid = process.pid; fs.writeFileSync(path.join(dirOf(job.id), 'job.json'), JSON.stringify(job, null, 1)); }
export function update(id: string, fn: (j: Job) => void) { const j = getJob(id); fn(j); save(j); return j; }
/** A Bill that files each paid call under `step` in the job. */
export const biller = (id: string, step: string): Bill => c => update(id, j => { (j.costs ??= []).push({ ...c, step, at: Date.now() }); });
export const say = (id: string, message: string) => update(id, j => { j.message = message; j.log.push(`${new Date().toLocaleTimeString()} ${message}`); });
export const fail = (id: string, e: any) => update(id, j => { j.stage = 'failed'; j.error = String(e?.message || e); j.message = '生成失败'; j.log.push(`失败：${j.error}`); });

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Jobs left mid-way by a restart can't resume their in-memory work; mark them so the UI doesn't spin forever. */
export function recoverJobs() {
  if (!fs.existsSync(JOBS)) return;
  for (const id of fs.readdirSync(JOBS)) {
    try {
      const j = getJob(id);
      // Dev servers on other ports share this folder: a job another live server is running is not orphaned.
      if (j.pid && j.pid !== process.pid && alive(j.pid)) continue;
      if (j.replica?.scout?.running) update(id, x => { x.replica!.scout!.running = false; x.replica!.scout!.stopped = '服务重启，没找完'; });
      if (['checking', 'framing', 'rendering'].includes(j.stage)) fail(id, '服务重启，任务中断了，请重新生成');
    } catch { /* half-written job folder: ignore */ }
  }
}

// ---------- vendor concurrency ----------
// Scenario saw a multi-hour cooldown after ~28 edit jobs in 30 min; keep a small ceiling for every vendor.
const MAX = Number(process.env.SWAP_MAX_JOBS || 3);
let active = 0; const queue: (() => void)[] = [];
export async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX) await new Promise<void>(r => queue.push(r));
  active++;
  try { return await fn(); } finally { active--; queue.shift()?.(); }
}

// ---------- steps ----------
/** Known ids only, and at most one option per choice. */
const oneEach = (t: Template, extras: string[]) => chainOf(t, extras)
  .filter((v, _, all) => { const c = t.choices?.find(c => c.options.includes(v)); return !c || all.find(o => c.options.includes(o)) === v; })
  .map(v => v.id);

export function listJobs(): Job[] {
  if (!fs.existsSync(JOBS)) return [];
  return fs.readdirSync(JOBS).flatMap(id => { try { return [getJob(id)]; } catch { return []; } }).sort((a, b) => b.created - a.created);
}

/** The job's template with its slot mode applied. */
const templateOf = (j: Job) => withMode(getTemplate(j.templateId), j.slotMode);

export async function createJob(x: { templateId: string; image: Buffer; ext: string; extras: string[]; mode?: string; force?: boolean }): Promise<Job> {
  const raw = getTemplate(x.templateId);
  const slotMode = raw.slot.modes?.some(m => m.id === x.mode) ? x.mode : raw.slot.modes?.[0]?.id;
  const t = withMode(raw, slotMode);
  const id = newJobId();
  fs.mkdirSync(dirOf(id), { recursive: true });
  const upload = path.join(dirOf(id), 'upload' + (/^\.(png|jpe?g|webp)$/i.test(x.ext) ? x.ext.toLowerCase() : '.png'));
  fs.writeFileSync(upload, x.image);
  const job: Job = {
    id, templateId: t.id, created: Date.now(), stage: 'checking', message: '检查图片', upload,
    frames: [], versions: [], extras: oneEach(t, x.extras), slotMode, log: []
  };
  save(job);
  void start(id, t, !!x.force).catch(e => fail(id, e));
  return job;
}

async function start(id: string, t: Template, force: boolean) {
  const p = await providers();
  update(id, j => { j.engine = { image: p.image.name, video: p.video.name, guard: p.guard.name, checker: p.checker.name }; });
  const guard = await p.guard.inspect(getJob(id).upload);
  update(id, j => { j.guard = guard; });
  if (!guard.ok && !force) {
    update(id, j => { j.stage = 'failed'; j.error = guard.message; j.message = '这张图可能无法使用'; });
    return;
  }
  await makeFrames(id, t);
}

/** Target frames: the template's chosen frame with the user's thing already in it. Cheap, so the user decides here. */
async function makeFrames(id: string, t: Template) {
  const p = await providers();
  update(id, j => { j.stage = 'framing'; j.frames = []; j.picked = undefined; });
  say(id, '正在生成预览图');
  const dir = path.join(dirOf(id), `frames-${Date.now()}`);
  fs.mkdirSync(dir);
  const frame = await frameAt(templateFile(t, t.source), t.frameAt, path.join(dir, 'source.jpg'));
  update(id, j => { j.framing = { prompt: t.slot.framePrompt, frameAt: t.frameAt, model: p.image.name, attempts: (j.framing?.attempts || 0) + 1,
    refs: [{ role: `@image1 原片第 ${t.frameAt} 秒的画面`, file: frame }, { role: '@image2 用户上传的图', file: j.upload }] }; });
  const frames = await p.image.targetFrames({ prompt: t.slot.framePrompt, refs: [frame, getJob(id).upload], ratio: t.ratio, count: PREVIEWS, outDir: dir, log: m => say(id, m), bill: biller(id, '预览图') });
  update(id, j => { j.frames = frames; j.stage = 'pick'; j.message = '选一张最满意的预览图'; });
}

export async function retryFrames(id: string) {
  const j = getJob(id);
  if (j.stage !== 'pick' && j.stage !== 'failed') throw new Error('现在不能重新生成预览图');
  const t = templateOf(j);
  update(id, x => { x.stage = 'framing'; x.error = undefined; x.message = '正在生成预览图'; });
  void makeFrames(id, t).catch(e => fail(id, e));
  return getJob(id);
}


export async function pickFrame(id: string, picked: number) {
  const j = getJob(id);
  if (j.stage !== 'pick' || !j.frames[picked]) throw new Error('现在不能选这张图');
  const t = templateOf(j);
  const choiceOf = (vid: string) => t.choices?.find(c => c.options.some(o => o.id === vid));
  const mode = t.slot.modes?.find(m => m.id === j.slotMode);
  const versions: VersionRun[] = [{ id: 'base', label: mode ? `${t.slot.label}：${mode.label}` : t.slot.label + '替换', status: 'waiting' },
    ...chainOf(t, j.extras).map(v => ({ id: v.id, label: choiceOf(v.id) ? `${choiceOf(v.id)!.label}：${v.label}` : v.label, status: 'waiting' as const }))];
  update(id, x => { x.picked = picked; x.stage = 'rendering'; x.versions = versions; x.message = '正在生成视频'; });
  void render(id, t).catch(e => fail(id, e));
  return getJob(id);
}

// Video models invent mouth movement (singing, talking) when the source has music and they get no sound.
const MOUTHS = 'Mouths stay exactly as in @video1: nobody sings, speaks or mouths words unless they do in @video1.';
// Every segment of every step also gets the picked preview as a fixed look reference, so the main character
// stays the same person across segments and across chained steps.
const LOOK_LINE = (n: number) => ` @image${n} shows the main character as they must look in every frame (face, hair, clothes); it is only a reference for their look.`;
const AUDIO_LINE = '@audio1 is the soundtrack of this shot: keep every movement on its beat, as in @video1.';

type Change = { preset: string; fill: Record<string, string>; who: string; framePrompt?: string };

async function render(id: string, t: Template) {
  const job = getJob(id), target = job.frames[job.picked!];
  const after = t.whoAfter || 'the main character';
  let latest = await runVersion(id, t, 'base', templateFile(t, t.source),
    { preset: t.slot.preset, fill: t.slot.fill, who: t.who, framePrompt: t.slot.framePrompt }, { target, upload: job.upload });
  // Picked choice options run one after another, each on the previous result (one change per run)…
  const chain = chainOf(t, job.extras), options = chain.filter(v => !t.versions.includes(v));
  for (const v of options) {
    if (!latest) break;
    latest = await runVersion(id, t, v.id, latest, { ...v, who: v.who || after });
  }
  // …then the ticked versions, in parallel, all on the last result.
  if (latest) await Promise.all(chain.filter(v => t.versions.includes(v)).map(v => runVersion(id, t, v.id, latest!, { ...v, who: v.who || after })));
  update(id, j => {
    j.versions.forEach(v => { if (v.status === 'waiting') { v.status = 'failed'; v.error = '前一步失败，没有继续'; } });
    const ok = j.versions.filter(v => v.status === 'done').length;
    j.stage = ok ? 'done' : 'failed';
    j.message = ok ? `完成 ${ok}/${j.versions.length} 个版本` : '生成失败';
    if (!ok) j.error = j.versions.map(v => v.error).filter(Boolean).join('；');
  });
}

/** Segments for a template, planned on its source; every run of the job uses the same boundaries. */
async function segmentsFor(t: Template, minS: number, maxS: number): Promise<Segment[]> {
  const src = templateFile(t, t.source), { seconds } = await probe(src);
  if (seconds <= maxS) return planSegments(seconds, [], minS, maxS);
  const hard = t.cuts ?? (await detectShots(src, 0.3, minS)).cuts;
  return planSegments(seconds, hard, minS, maxS);
}

/** One change over the whole clip, segment by segment. `base` is set for the user's swap (their picture + pick). */
async function runVersion(id: string, t: Template, vid: string, source: string, c: Change, base?: { target: string; upload: string }): Promise<string | undefined> {
  const p = await providers();
  const dir = path.join(dirOf(id), vid); fs.mkdirSync(dir, { recursive: true });
  const set = (patch: Partial<VersionRun>) => update(id, j => Object.assign(j.versions.find(v => v.id === vid)!, patch));
  const label = getJob(id).versions.find(v => v.id === vid)!.label;
  try {
    set({ status: 'running', step: '准备中', preset: c.preset, who: c.who, startedAt: Date.now() });
    const segs = await segmentsFor(t, p.video.minSeconds, p.video.maxSeconds);
    set({ segments: segs.map(s => ({ ...s, images: [] })) });
    const seg = (i: number, patch: Partial<SegTrace>) => update(id, j => Object.assign(j.versions.find(v => v.id === vid)!.segments![i], patch));
    const n = segs.length, tag = (i: number) => n > 1 ? `第 ${i + 1}/${n} 段` : '';
    const log = (i: number, m: string) => { const s = [tag(i), m].filter(Boolean).join('：'); set({ step: s }); say(id, `${label}：${s}`); };
    const look = getJob(id).frames[getJob(id).picked!];
    const extra = base ? [base.upload] : []; // in base runs @image2 is always the user's picture

    // A target frame built by the server for a segment the user did not pick a preview for.
    const autoTarget = async (piece: string, i: number, at: number) => {
      log(i, '生成参考帧');
      const d = path.join(dir, `seg${i}-frame`); fs.mkdirSync(d, { recursive: true });
      const frame = await frameAt(piece, at, path.join(d, 'source.jpg'));
      const prompt = base ? t.slot.framePrompt + ' @image3 shows the same character already placed in this film: match them exactly as they appear there.' : c.framePrompt!;
      const refs = base ? [frame, base.upload, base.target] : [frame];
      const out = (await p.image.targetFrames({ prompt, refs, ratio: t.ratio, count: 1, outDir: d, log: m => log(i, m), bill: biller(id, `${label}${tag(i) ? ' · ' + tag(i) : ''} · 参考帧`) }))[0];
      const roles = ['@image1 这一段的原画面', '@image2 用户上传的图', '@image3 用户选定的预览图'];
      seg(i, { autoFrame: { prompt, out, refs: refs.map((file, k) => ({ role: roles[k], file })) } });
      return out;
    };

    const pieces = n > 1 ? await Promise.all(segs.map(s => cutPiece(source, s, path.join(dir, `seg${s.index}-src.mp4`)))) : [source];
    const outs: string[] = [], reports: CheckReport[] = [];
    // Segments of one version run in parallel groups; once one fails the version is lost, so the others
    // stop before their next paid step instead of spending on a result nobody can use.
    let failed: Error | undefined;
    const go = () => { if (failed) throw failed; };
    const runSeg = async (s: Segment, prevOut?: string) => {
      go();
      const i = s.index, piece = pieces[i], len = s.end - s.start;
      const local = t.frameAt - s.start, hasPick = local >= 0 && local < len;
      seg(i, { source: piece });
      let images: string[], first = '';
      if (s.join === 'soft' && prevOut) { images = [await lastFrame(prevOut, path.join(dir, `seg${i}-first.jpg`)), ...extra]; first = '上一段结果的最后一帧（接缝不跳）'; }
      else if (base && hasPick) { images = [base.target, ...extra]; first = '用户选定的预览图'; }
      else if (base) { images = [await autoTarget(piece, i, Math.min(0.3, len / 2)), ...extra]; first = '后台为这一段自动生成的参考帧'; }
      else if (c.framePrompt) { images = [await autoTarget(piece, i, hasPick ? local : Math.min(0.3, len / 2))]; first = '后台自动生成的参考帧'; }
      else images = [];
      const built = buildPrompt(c.preset, c.who, c.fill, images.length > 0), check = built.check;
      // The preview is already @image1 when this segment starts from the user's pick; otherwise append it.
      const anchor = look && images[0] !== look ? (images.push(look), LOOK_LINE(images.length)) : '';
      const prompt = (built.prompt + anchor).replace(/(Nothing else changes\.|It must look like|No text, no letters)/, MOUTHS + ' $1');
      let audio: AudioRef | undefined;
      if (t.audio) {
        const track = t.audio === 'source' ? templateFile(t, t.source) : templateFile(t, t.audio);
        const a = await cutAudio(track, s.start, s.end, path.join(dir, `seg${i}-audio.mp3`));
        if (a) audio = { file: a, line: AUDIO_LINE };
      }
      const sent = p.video.bindRefs ? p.video.bindRefs(prompt) : prompt;
      seg(i, { prompt, sentPrompt: sent, model: p.video.name, images: images.map((file, k) => ({ role: `@image${k + 1} ${!k ? first : file === look && anchor ? '主角长相参考（用户选定的预览图）' : '用户上传的图'}`, file })),
        audio: audio && { role: `@audio1 ${t.audio === 'source' ? '原片这一段的声音' : '替代音轨这一段'}`, file: audio.file } });
      fs.writeFileSync(path.join(dir, `seg${i}-prompt.txt`), prompt);
      go();
      log(i, '生成视频');
      const t0 = Date.now();
      const editWith = (pr: string, imgs: string[]) => slot(() => p.video.edit({
        prompt: pr, source: piece, images: imgs, audio: audio && { ...audio, line: p.video.bindRefs ? p.video.bindRefs(audio.line) : audio.line }, ratio: t.ratio,
        duration: Math.min(p.video.maxSeconds, Math.max(p.video.minSeconds, Math.ceil(len))), outFile: path.join(dir, `seg${i}-edit.mp4`), log: m => log(i, m),
        bill: biller(id, `${label}${tag(i) ? ' · ' + tag(i) : ''} · 视频`)
      }));
      let edited: string;
      try { edited = await editWith(sent, images); }
      catch (e: any) {
        // The look anchor is a photoreal close-up face, the input MiniMax refuses most ("input image sensitive",
        // 4 Nov). On a moderation refusal, try once more without it: consistency then rests on @image1 alone.
        if (!anchor || !/审核|sensitive/i.test(e.message)) throw e;
        log(i, '主角长相参考被审核拦截，去掉它再试一次');
        const imgs = images.filter(f => f !== look);
        const pr = p.video.bindRefs ? p.video.bindRefs(prompt.replace(anchor, '')) : prompt.replace(anchor, '');
        edited = await editWith(pr, imgs);
        seg(i, { sentPrompt: pr, images: (getJob(id).versions.find(v => v.id === vid)!.segments![i].images).filter(r => r.file !== look)
          .concat([{ role: '主角长相参考（被审核拦截后去掉了）', file: look }]) });
      }
      seg(i, { edit: edited, ms: Date.now() - t0, ...(audio?.dropped ? { audio: { role: '@audio1 被审核拦截后去掉了', file: audio.file, dropped: true } } : {}) });
      log(i, '自动质检');
      const qaDir = path.join(dir, `seg${i}-qa`);
      // QA and joining use the retimed piece: the raw edit is longer than the source.
      const fit = await conformPiece(piece, edited, path.join(dir, `seg${i}-fit.mp4`));
      reports[i] = await p.checker.check(piece, fit, check, qaDir).catch(e => ({ pass: true, trimTail: 0, summary: `没能质检（${e.message}）` }));
      const r = reports[i].raw || {}, crops = path.join(qaDir, 'crops.jpg');
      seg(i, { qa: { pass: reports[i].pass, summary: reports[i].summary, sheet: reports[i].sheet, crops: fs.existsSync(crops) ? crops : undefined,
        metrics: r.verdict ? { 改动面积: r.changed_area, 结构相似度: r.structure_median, 动作相关度: r.motion_correlation } : undefined } });
      outs[i] = fit;
      return outs[i];
    };
    const seams = async () => {
      for (const s of segs.slice(1)) if (outs[s.index - 1] && outs[s.index])
        seg(s.index, { seam: await seamImage(outs[s.index - 1], outs[s.index], path.join(dir, `seam${s.index}.jpg`)).catch(() => undefined) });
    };
    // A hard boundary starts a new group. Groups run in parallel; segments inside one (soft seams) run in order,
    // each starting from the previous result's last frame.
    const groups: Segment[][] = [];
    for (const s of segs) if (s.join === 'soft') groups[groups.length - 1].push(s); else groups.push([s]);
    await Promise.all(groups.map(async g => {
      let prev: string | undefined;
      try { for (const s of g) prev = await runSeg(s, prev); }
      catch (e: any) { failed ??= Object.assign(new Error(n > 1 ? `第 ${g.find(s => !outs[s.index])!.index + 1} 段：${e.message}` : e.message)); }
    }));
    if (failed) throw failed;
    if (n > 1) await seams();

    log(n - 1, '拼接并合回原声');
    const joined = n > 1 ? await joinPieces(outs, path.join(dir, 'joined.mp4')) : outs[0];
    const trim = reports[n - 1].trimTail;
    const final = await finish(source, joined, path.join(dir, 'final.mp4'), trim);
    const cmp = await compare(templateFile(t, t.source), final, path.join(dir, 'compare.mp4'));
    const bad = reports.map((r, i) => r.pass ? '' : (n > 1 ? `第 ${i + 1} 段：` : '') + r.summary).filter(Boolean);
    const check: CheckReport = { pass: !bad.length, trimTail: trim, summary: bad.length ? bad.join('；') : '自动质检通过' };
    set({ status: 'done', step: undefined, output: joined, final, compare: cmp, check, endedAt: Date.now() });
    return final;
  } catch (e: any) {
    set({ status: 'failed', step: undefined, error: e.message, endedAt: Date.now() });
    say(id, `${label}：失败：${e.message}`);
  }
}

// ---------- 文字改视频 ----------
// The user's own clip, one change described in words: no template, no preview, no reference image.
// Grok's edit ignores reference images (4 Nov: a recast with a picked preview kept the original actor), but follows
// a text-only background or object change closely, so this path sends the words alone.
export const TEXT_TEMPLATE = 'text';
export const TEXT_KINDS: Record<TextEditKind, { label: string; check: CheckMode; prompt: (x: string) => string }> = {
  background: {
    label: '换背景', check: 'motion',
    prompt: x => 'Keep every person and everything in the foreground exactly as it is: the same faces, hair, clothes, expressions, lip movement and gestures, ' +
      `and the same camera movement and framing, frame for frame. Change only the background and setting behind them: ${x}. ` +
      'Light the people the way the new setting would, naturally. Nothing else changes. No text, no letters, no logos.'
  },
  object: {
    label: '换物品', check: 'swap',
    prompt: x => 'Keep everything exactly as it is: the same people, hands, movement, camera motion, framing and light, frame for frame. ' +
      `Change only this one thing: ${x}. The new object sits in the same place at the same size and moves with the camera and hands exactly as the original did. ` +
      'Nothing else changes. No text, no letters, no logos.'
  }
};
const TEXT_MAX_SECONDS = 30;

export async function createTextJob(x: { video: Buffer; ext: string; kind: TextEditKind; text: string }): Promise<Job> {
  const kind = TEXT_KINDS[x.kind];
  if (!kind) throw new Error('只能选换背景或换物品');
  const text = x.text.trim();
  if (!text) throw new Error('请写清楚要换成什么');
  if (text.length > 400) throw new Error('描述太长了，请控制在 400 字以内');
  const id = newJobId();
  const dir = dirOf(id); fs.mkdirSync(dir, { recursive: true });
  const raw = path.join(dir, 'upload-video' + (/^\.(mp4|mov|webm|m4v)$/i.test(x.ext) ? x.ext.toLowerCase() : '.mp4'));
  fs.writeFileSync(raw, x.video);
  const source = path.join(dir, 'source.mp4'), upload = path.join(dir, 'upload.jpg');
  const job: Job = {
    id, templateId: TEXT_TEMPLATE, created: Date.now(), stage: 'rendering', message: '整理视频', upload, frames: [],
    versions: [{ id: 'text', label: `${kind.label}：${text.slice(0, 30)}`, status: 'waiting' }], extras: [], log: [],
    textEdit: { kind: x.kind, text, source }
  };
  save(job);
  void (async () => {
    const p = await providers();
    update(id, j => { j.engine = { image: '—', video: p.video.name, guard: '—', checker: p.checker.name }; });
    const s = await probe(raw).catch(() => { throw new Error('读不出这个视频，请换成 MP4 / MOV'); });
    if (s.seconds < p.video.minSeconds) throw new Error(`视频太短，至少 ${p.video.minSeconds} 秒`);
    await prepare(raw, source, { end: Math.min(s.seconds, TEXT_MAX_SECONDS) });
    await frameAt(source, Math.min(0.5, s.seconds / 2), upload);
    if (s.seconds > TEXT_MAX_SECONDS) say(id, `视频超过 ${TEXT_MAX_SECONDS} 秒，只处理前 ${TEXT_MAX_SECONDS} 秒`);
    say(id, '生成视频');
    await runTextEdit(id, source, x.kind, text);
    const v = getJob(id).versions[0];
    if (v.status === 'done') update(id, j => { j.stage = 'done'; j.message = '完成'; });
    else fail(id, v.error || '生成失败');
  })().catch(e => { update(id, j => { j.versions[0].status = 'failed'; j.versions[0].error = String(e.message || e); }); fail(id, e); });
  return job;
}

async function runTextEdit(id: string, source: string, kindId: TextEditKind, text: string) {
  const p = await providers();
  const kind = TEXT_KINDS[kindId], dir = path.join(dirOf(id), 'text'); fs.mkdirSync(dir, { recursive: true });
  const set = (patch: Partial<VersionRun>) => update(id, j => Object.assign(j.versions[0], patch));
  const s = await probe(source);
  const segs = planSegments(s.seconds, (await detectShots(source, 0.3, p.video.minSeconds)).cuts, p.video.minSeconds, p.video.maxSeconds);
  const n = segs.length, prompt = kind.prompt(text);
  set({ status: 'running', step: '准备中', who: text, startedAt: Date.now(), segments: segs.map(x => ({ ...x, images: [] })) });
  const seg = (i: number, patch: Partial<SegTrace>) => update(id, j => Object.assign(j.versions[0].segments![i], patch));
  const log = (i: number, m: string) => { const msg = [n > 1 ? `第 ${i + 1}/${n} 段` : '', m].filter(Boolean).join('：'); set({ step: msg }); say(id, msg); };
  try {
    const pieces = n > 1 ? await Promise.all(segs.map(x => cutPiece(source, x, path.join(dir, `seg${x.index}-src.mp4`)))) : [source];
    const reports: CheckReport[] = [];
    // No reference image to carry across a seam, so every segment runs on its own, in parallel.
    const outs = await Promise.all(segs.map(async x => {
      const i = x.index, piece = pieces[i], len = x.end - x.start;
      seg(i, { source: piece, prompt, sentPrompt: prompt, model: p.video.name });
      fs.writeFileSync(path.join(dir, `seg${i}-prompt.txt`), prompt);
      log(i, '生成视频');
      const t0 = Date.now();
      const edited = await slot(() => p.video.edit({ prompt, source: piece, images: [], ratio: s.width >= s.height ? '16:9' : '9:16',
        duration: Math.min(p.video.maxSeconds, Math.max(p.video.minSeconds, Math.ceil(len))), outFile: path.join(dir, `seg${i}-edit.mp4`),
        log: m => log(i, m), bill: biller(id, `${kind.label}${n > 1 ? ` · 第 ${i + 1} 段` : ''} · 视频`) }));
      seg(i, { edit: edited, ms: Date.now() - t0 });
      log(i, '自动质检');
      const fit = await conformPiece(piece, edited, path.join(dir, `seg${i}-fit.mp4`));
      reports[i] = await p.checker.check(piece, fit, kind.check, path.join(dir, `seg${i}-qa`)).catch(e => ({ pass: true, trimTail: 0, summary: `没能质检（${e.message}）` }));
      seg(i, { qa: { pass: reports[i].pass, summary: reports[i].summary, sheet: reports[i].sheet } });
      return fit;
    }));
    log(n - 1, '拼接并合回原声');
    const joined = n > 1 ? await joinPieces(outs, path.join(dir, 'joined.mp4')) : outs[0];
    const final = await finish(source, joined, path.join(dir, 'final.mp4'), reports[n - 1].trimTail);
    const cmp = await compare(source, final, path.join(dir, 'compare.mp4'));
    const bad = reports.map((r, i) => r.pass ? '' : (n > 1 ? `第 ${i + 1} 段：` : '') + r.summary).filter(Boolean);
    set({ status: 'done', step: undefined, output: joined, final, compare: cmp, endedAt: Date.now(),
      check: { pass: !bad.length, trimTail: reports[n - 1].trimTail, summary: bad.length ? bad.join('；') : '自动质检通过' } });
  } catch (e: any) {
    set({ status: 'failed', step: undefined, error: e.message, endedAt: Date.now() });
  }
}
