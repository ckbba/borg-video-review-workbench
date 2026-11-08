// Original-video breakdown: ffmpeg finds the hard cuts, frames are sampled per shot,
// and the model describes each shot in the 「原片镜头」 field vocabulary.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ask, image, LLM, parseJson, text } from './llm';

export const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg', FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';
export const run = (bin: string, args: string[]) => new Promise<string>((res, rej) =>
  execFile(bin, args, { maxBuffer: 64 * 1024 * 1024 }, (e, out, err) => (e ? rej(new Error(String(err || e).slice(-400))) : res(out + err))));

export const OPTIONS = {
  景别: ['大全景', '全景', '中景', '近景', '特写', '大特写'],
  视角: ['第三人称', '主观视角', '无人物'],
  边界类型: ['硬切', '连续运镜', '遮挡转场', '待确认'],
  难度标签: ['快切', '复杂运镜', '商品特写', '手部操作', '文字/UI', '多人互动', '特效'],
  可替换槽位: ['人物', '商品', '道具', '场景']
};
export const TEXT_FIELDS = ['机位与运镜', '构图', '光影', '首帧状态', '主体动作', '动作阶段', '人物眼神', '道具/商品状态', '画面内可见', '与下一镜衔接', '不确定项', '对白/画外音', '原片描述'];

export async function duration(file: string) {
  return Number((await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])).trim());
}

// Hard cuts via scene score; segments shorter than minLen are merged into the previous shot.
export async function detectShots(file: string, threshold = 0.25, minLen = 0.25) {
  const total = await duration(file);
  const log = await run(FFMPEG, ['-nostdin', '-i', file, '-vf', `select='gt(scene,${threshold})',showinfo`, '-an', '-f', 'null', '-']);
  const cuts = [...log.matchAll(/pts_time:([\d.]+)/g)].map(m => Math.round(Number(m[1]) * 100) / 100);
  const edges = [0];
  for (const c of cuts) if (c - edges[edges.length - 1] >= minLen && total - c >= minLen) edges.push(c);
  edges.push(Math.round(total * 100) / 100);
  return { total, cuts: edges.slice(1, -1), shots: edges.slice(0, -1).map((s, i) => ({ start: s, end: edges[i + 1] })) };
}

export async function frameAt(file: string, t: number, out: string, width = 0) {
  await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', ...(width ? ['-vf', `scale=${width}:-2`] : []), '-q:v', width ? '4' : '2', out]);
  return out;
}

async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>) {
  const out: R[] = []; let k = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (k < items.length) { const i = k++; out[i] = await fn(items[i], i); } }));
  return out;
}

// Rules learned the hard way (V3-A): describe what is visible, state viewpoint explicitly, keep limits for the negative side.
const RULES = `写作规则（必须遵守）：
1. 只写画面里看得见的东西，用正面描述。比如纸上有线稿就写"纸面画满铅笔线稿"，不要写"一闪而过、不可读"这类会被理解成"没有"的话。
2. 每个镜头都写清视角：第三人称还是主观视角，摄影机相对人物的位置，哪些身体部位入画、从画面哪一侧进入，脸是否可见。
3. 道具/商品写清状态：完好还是损坏、开合角度、数量、朝向。看不清的不要编，写"看不清"。
4. 不要把后续剧情脑补进当前镜头；只根据这个镜头的帧描述。
5. 主体动作按时间顺序写，带上镜头内的秒数（相对原片的绝对时间）。`;

const SCHEMA = `每个镜头输出一个对象：
{"i":镜头序号,"景别":"大全景|全景|中景|近景|特写|大特写","视角":"第三人称|主观视角|无人物",
"机位与运镜":"...","主体动作":"...","道具/商品状态":"...（没有就写空字符串）",
"画面内可见":"机位位置、入画的身体部位与方向、脸是否可见",
"难度标签":["快切|复杂运镜|商品特写|手部操作|文字/UI|多人互动|特效"中适用的],
"可替换槽位":["人物|商品|道具|场景"中适用的],"原片描述":"一段完整描述，能直接当成复刻时的镜头说明"}`;

export type Analysed = { start: number; end: number; fields: Record<string, any>; keyframe: string; sampling?: string };

// One version of the breakdown prompt (a row of 「拆解提示词」). The defaults below are version P1.
export type PromptCfg = { id?: string; version: string; model: string; frames: number; system: string; overview: string; rules: string; schema: string;
  strategy?: '固定' | '两轮动态' | '全片定频'; scout?: string; denseFps?: number;
  coarseFps?: number; sceneThreshold?: number; cutReview?: boolean; aFps?: number; sheetWidth?: number; frameWidth?: number }; // 全片定频, see fullRate.ts
export const DEFAULT_SCOUT = `这是全片每个镜头的粗看帧（每镜头 {帧数} 张），以及 ffmpeg 测得的每个镜头的画面变化量（越大说明画面动得越多）。
请找出需要回看细节的复杂时间段：人物神态或眼睛开合变化、头部/身体转动、手部操作、道具或布料的运动轨迹与速度、摄影机推拉摇移跟随、首帧到尾帧状态明显不同的地方。
静止或只有轻微晃动的镜头不要列。时间段要尽量窄，精确到 0.1 秒。
只输出 JSON：{"segments":[{"start":秒,"end":秒,"why":"一句话说明要看清什么"}]}`;
export const DEFAULT_PROMPT: PromptCfg = {
  version: 'P1', model: LLM.model, frames: 3, system: '你是严谨的视频拆解分析师，为广告复刻写逐镜头分析。',
  overview: '下面是一条 {时长} 秒视频按时间顺序的代表帧。请用 6–10 句话概括：讲了什么事、主要人物与外观、反复出现的商品/道具及其状态变化、场景。只写看得到的。',
  rules: RULES, schema: SCHEMA, strategy: '固定', scout: DEFAULT_SCOUT, denseFps: 4
};

// Mean frame-to-frame luma change per shot (ffmpeg signalstats YDIF at 6 fps): a cheap "how much moves" signal for round one.
export async function motionPerShot(file: string, shots: { start: number; end: number }[]) {
  const out = await run(FFMPEG, ['-nostdin', '-v', 'error', '-i', file, '-vf', 'fps=6,scale=160:-2,signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=-', '-f', 'null', '-']);
  const pts: [number, number][] = []; let t = 0;
  for (const line of out.split(/\r?\n/)) { const a = line.match(/pts_time:([\d.]+)/); if (a) t = Number(a[1]); const b = line.match(/YDIF=([\d.]+)/); if (b) pts.push([t, Number(b[1])]); }
  return shots.map(s => { const v = pts.filter(([x]) => x > s.start + 0.05 && x < s.end).map(p => p[1]); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10 : 0; });
}
// Round two: inside each complex segment that overlaps a shot, one frame every 1/fps seconds (capped), merged with the coarse frames.
export function denseTimes(s: number, e: number, segs: { start: number; end: number }[], fps: number, coarse: number[], cap = 16) {
  const extra: number[] = [];
  for (const g of segs) { const a = Math.max(s + 0.04, g.start), b = Math.min(e - 0.04, g.end); if (b <= a) continue; for (let t = a; t <= b + 1e-6; t += 1 / fps) extra.push(t); }
  if (!extra.length) return coarse;
  let all = [...new Set([...coarse, ...extra].map(t => Math.round(t * 100) / 100))].sort((x, y) => x - y);
  if (all.length > cap) { const step = (all.length - 1) / (cap - 1); all = Array.from({ length: cap }, (_, k) => all[Math.round(k * step)]); }
  return all;
}
// n evenly spaced frame times inside a shot, keeping a small margin from the cuts
const frameTimes = (s: number, e: number, n: number) => { const d = e - s; if (d < 0.6 || n <= 1) return [s + d / 2]; return Array.from({ length: n }, (_, k) => s + d * (0.12 + 0.76 * k / (n - 1))); };

export async function analyseVideo(file: string, workDir: string, log: (s: string) => void, batchSize = 6, cfg: PromptCfg = DEFAULT_PROMPT) {
  fs.mkdirSync(workDir, { recursive: true });
  if (cfg.strategy === '全片定频') return (await import('./fullRate')).analyseFullRate(file, workDir, log, cfg);
  log('ffmpeg 检测硬切…');
  const { total, cuts, shots } = await detectShots(file, cfg.sceneThreshold || 0.25);
  log(`原片 ${total.toFixed(1)} 秒，检测到 ${shots.length} 个镜头`);

  log('抽帧（每个镜头首/中/尾 3 帧 + 1 张全分辨率关键帧）…');
  const frames = await pool(shots, 6, async (s, i) => {
    const d = s.end - s.start, ts = frameTimes(s.start, s.end, cfg.frames);
    const small = await Promise.all(ts.map((t, k) => frameAt(file, t, path.join(workDir, `s${i}_${k}.jpg`), 640)));
    // dense frames are smaller: there can be up to 16 of them per shot
    const key = await frameAt(file, s.start + d / 2, path.join(workDir, `S${String(i + 1).padStart(2, '0')}_关键帧_${(s.start + d / 2).toFixed(2)}s.jpg`));
    return { small, key, ts };
  });

  log('GPT 先看全片梗概…');
  const overviewIdx = shots.map((_, i) => i).filter((_, i, a) => a.length <= 24 || i % Math.ceil(a.length / 24) === 0);
  const overview = await ask([
    text(cfg.overview.replace('{时长}', total.toFixed(1))),
    ...overviewIdx.flatMap(i => [text(`${shots[i].start.toFixed(1)}s`), image(frames[i].small[Math.floor(frames[i].small.length / 2)])])
  ], '你是严谨的视频拆解分析师。', 2, cfg.model);
  log('梗概完成');

  // ---- two-pass sampling: round one finds the complex time ranges, round two looks at them frame by frame ----
  const notes: string[] = shots.map(() => `固定 ${cfg.frames} 帧`);
  let segments: { start: number; end: number; why: string }[] = [];
  if (cfg.strategy === '两轮动态') {
    log('第一轮：粗看全片，找复杂时间段…');
    const motion = await motionPerShot(file, shots).catch(() => shots.map(() => 0));
    const scout = (cfg.scout || DEFAULT_SCOUT).replace('{帧数}', String(cfg.frames));
    const r1 = parseJson(await ask([
      text(`${scout}\n\n全片梗概：\n${overview}`),
      ...shots.flatMap((s, i) => [text(`镜头${i + 1}（${s.start.toFixed(2)}–${s.end.toFixed(2)}s，画面变化量 ${motion[i]}），帧时间 ${frames[i].ts.map(t => t.toFixed(2)).join('、')}s`), ...frames[i].small.map(image)])
    ], cfg.system, 2, cfg.model));
    segments = (r1.segments || []).map((g: any) => ({ start: Number(g.start), end: Number(g.end), why: String(g.why || '') })).filter((g: any) => g.end > g.start);
    log(`第一轮找到 ${segments.length} 个复杂时间段，第二轮加密抽帧（每秒 ${cfg.denseFps || 4} 帧）…`);
    await pool(shots, 6, async (s, i) => {
      const segs = segments.filter(g => g.end > s.start && g.start < s.end);
      if (!segs.length) { notes[i] = `两轮动态：未加密，${frames[i].ts.length} 帧（画面变化量 ${motion[i]}）`; return; }
      const ts = denseTimes(s.start, s.end, segs, cfg.denseFps || 4, frames[i].ts);
      frames[i].small = await Promise.all(ts.map((t, k) => frameAt(file, t, path.join(workDir, `d${i}_${k}.jpg`), 640)));
      frames[i].ts = ts;
      notes[i] = `两轮动态：加密到 ${ts.length} 帧（画面变化量 ${motion[i]}）。原因：${segs.map(g => `${g.start.toFixed(1)}–${g.end.toFixed(1)}s ${g.why}`).join('；')}`;
    });
  }

  const batches: number[][] = [];
  for (let i = 0; i < shots.length; i += batchSize) batches.push(shots.slice(i, i + batchSize).map((_, k) => i + k));
  const timeline = shots.map((s, i) => `镜头${i + 1}: ${s.start.toFixed(2)}–${s.end.toFixed(2)}s`).join('\n');
  let done = 0;
  const results = await pool(batches, 3, async batch => {
    const parts = [text(`全片梗概：\n${overview}\n\n全片镜头时间表（硬切由 ffmpeg 检测，可能有极少误切）：\n${timeline}\n\n请分析下面这些镜头：`)];
    for (const i of batch) {
      const focus = segments.filter(g => g.end > shots[i].start && g.start < shots[i].end);
      parts.push(text(`—— 镜头${i + 1}（${shots[i].start.toFixed(2)}–${shots[i].end.toFixed(2)}s，时长 ${(shots[i].end - shots[i].start).toFixed(2)}s），帧时间：${frames[i].ts.map(t => t.toFixed(2) + 's').join('、')}${focus.length ? `。这个镜头已加密抽帧，请逐帧看清并写出过程：${focus.map(g => g.why).join('；')}` : ''}`));
      frames[i].small.forEach(f => parts.push(image(f)));
    }
    parts.push(text(`${cfg.rules}\n\n${cfg.schema}\n\n只输出 JSON：{"shots":[...]}，覆盖镜头 ${batch.map(i => i + 1).join('、')}。`));
    const out = parseJson(await ask(parts, cfg.system, 2, cfg.model));
    log(`已分析 ${(done += batch.length)}/${shots.length} 个镜头`);
    return out.shots as any[];
  });
  const byI = new Map(results.flat().map((r: any) => [Number(r.i), r]));
  const analysed: Analysed[] = shots.map((s, i) => ({ ...s, fields: byI.get(i + 1) || {}, keyframe: frames[i].key, sampling: notes[i] }));
  return { total, cuts, overview, analysed, segments };
}

export async function reviseShot(input: { frames: string[]; times: number[]; current: Record<string, any>; notes: string[]; issues: string[]; overview?: string; marks?: { file: string; t: number; body: string }[] }) {
  // Each frame mark is sent as its own labelled image right after the plain frames, so the model can't mix it up with them.
  const marks = (input.marks || []).flatMap((m, k) => [text(`审核人画面标记 ${k + 1}（${m.t.toFixed(2)}s，红框是审核人圈出的位置，红框本身不是画面内容）：${m.body}`), image(m.file)]);
  const parts = [
    text(`这是一个原片镜头的现有分析：\n${JSON.stringify(input.current, null, 1)}\n\n审核人的问题标签：${input.issues.join('、') || '无'}\n审核人的备注：\n${input.notes.map(n => '- ' + n).join('\n') || '无'}\n\n下面是这个镜头的帧（${input.times.map(t => t.toFixed(2) + 's').join('、')}）：`),
    ...input.frames.map(image),
    ...marks,
    text(`${RULES}\n\n请对照画面和审核意见修改分析。审核意见与画面冲突时以画面为准，并在 reason 里说明。\n只输出 JSON：{"fields":{"景别":...,"视角":...,"机位与运镜":...,"主体动作":...,"道具/商品状态":...,"画面内可见":...,"原片描述":...},"reason":"改了什么、为什么（2–4 句）"}`)
  ];
  return parseJson(await ask(parts, '你是严谨的视频拆解分析师。')) as { fields: Record<string, string>; reason: string };
}

export const pick = (v: any, allowed: string[]) => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter(x => allowed.includes(x));
