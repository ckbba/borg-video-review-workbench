// 全片定频 — the sampling GPT-6.1 SOL used in its web "Work" mode on the Galaxy Z Fold8 × Gemini ad (version line G):
// ① the whole video at a fixed fps (5) as timecoded contact sheets → overview + the model lists tricky segments, level A or B;
// ② A segments at aFps (8–12), B segments (fast open/close, occlusion swaps, suspected cuts) at the native frame rate,
//    plus the first/last frame of every shot (cut review);
// ③ per-shot analysis. No per-shot frame cap: a shot with more frames than one request holds is read in consecutive
//    chunks first, then analysed from those chunk notes plus an even subset of frames.
import fs from 'node:fs';
import path from 'node:path';
import { ask, image, parseJson, text } from './llm';
import { Analysed, detectShots, FFMPEG, FFPROBE, frameAt, PromptCfg, run } from './shots';

export const DEFAULT_SCOUT_FULL = `你已看到全片按每秒 {帧率} 帧抽出的联系表（每格左上角是原片秒数），以及 ffmpeg 测得的候选切点。
请定位稀疏采样不足以判断动作和转场的时间段：开合/旋转/翻面/变形、手部遮挡后替换物体、快速推拉、甩镜、屏幕滚动与运镜叠加、极短镜头、疑似隐藏切点、首尾状态不同但中间过程不清楚。
每个区间覆盖完整动作的开始、过程和结束；相邻重叠区间合并。
加密级别：A＝一般复杂运动（约 8–12 帧/秒）；B＝快速开合、遮挡替换、疑似切点（连续原始帧）。
只输出 JSON：{"segments":[{"start":秒,"end":秒,"level":"A或B","why":"为什么需要加密","questions":["加密后要确认的问题"]}]}`;

export async function nativeFps(file: string) {
  const r = (await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', file])).trim();
  const [a, b] = r.split('/').map(Number);
  return b ? a / b : a || 25;
}

const FONT = ['C:/Windows/Fonts/arial.ttf', '/System/Library/Fonts/Helvetica.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find(p => fs.existsSync(p));
// Contact sheets with the source timecode burned into each cell.
async function contactSheets(file: string, fps: number, width: number, dir: string) {
  const label = FONT
    ? `,drawtext=fontfile='${FONT.replace(':', '\\:')}':text='%{eif\\:t\\:d}.%{eif\\:mod(t*100\\,100)\\:d\\:2}s':x=4:y=4:fontsize=18:fontcolor=yellow:box=1:boxcolor=black@0.6`
    : '';
  await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-i', file, '-vf', `fps=${fps},scale=${width}:-2${label},tile=5x4`, path.join(dir, 'sheet_%02d.jpg')]);
  return fs.readdirSync(dir).filter(x => /^sheet_\d+\.jpg$/.test(x)).sort().map(x => path.join(dir, x));
}

async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>) {
  const out: R[] = []; let k = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (k < items.length) { const i = k++; out[i] = await fn(items[i], i); } }));
  return out;
}
const evenly = <T,>(a: T[], n: number) => (a.length <= n ? a : Array.from({ length: n }, (_, k) => a[Math.round(k * (a.length - 1) / (n - 1))]));
const r2 = (t: number) => Math.round(t * 100) / 100;
export type Segment = { start: number; end: number; level: 'A' | 'B'; why: string; questions: string[] };

// All frames a shot gets: coarse frames, segment frames at their level's rate, and the shot's first/last frame. No cap.
export function planFrames(shot: { start: number; end: number }, coarseTs: number[], segs: Segment[], rate: { A: number; B: number }, cutReview: boolean) {
  const c = coarseTs.filter(t => t > shot.start + 0.02 && t < shot.end - 0.02);
  const d: number[] = [];
  for (const g of segs) {
    const a = Math.max(shot.start + 0.02, g.start), b = Math.min(shot.end - 0.02, g.end), step = 1 / rate[g.level];
    for (let t = a; t <= b + 1e-6; t += step) d.push(r2(t));
  }
  const edgeStep = 1 / rate.B;
  const edge = cutReview ? [r2(shot.start + edgeStep / 2), r2(shot.end - edgeStep / 2)] : [];
  const fine = [...d, ...edge];
  const ts = [...new Set([...fine, ...c.filter(t => !fine.some(m => Math.abs(m - t) < edgeStep / 2))])].sort((x, y) => x - y);
  return { ts: ts.length ? ts : [r2((shot.start + shot.end) / 2)], coarse: c.length, dense: d.length, edge: edge.length };
}

const fmtStages = (v: any) => Array.isArray(v) ? v.map((x: any) => `${x.start ?? ''}–${x.end ?? ''}s：${[x['起始状态'], x['过程变化'], x['结束状态']].filter(Boolean).join(' → ')}${x['同期运镜'] ? `（运镜：${x['同期运镜']}）` : ''}`).join('\n') : String(v || '');
const fmtList = (v: any) => Array.isArray(v) ? v.join('\n') : String(v || '');

export async function analyseFullRate(file: string, workDir: string, log: (s: string) => void, cfg: PromptCfg) {
  const coarse = cfg.coarseFps || 5, thr = cfg.sceneThreshold || 0.16, BUDGET = 48;
  const sheetW = cfg.sheetWidth || 384, frameW = cfg.frameWidth || 640;
  log(`ffmpeg 检测硬切（阈值 ${thr}）…`);
  const { total, cuts, shots } = await detectShots(file, thr);
  const fpsNative = await nativeFps(file);
  const rate = { A: Math.min(cfg.aFps || 10, fpsNative), B: fpsNative };
  log(`原片 ${total.toFixed(1)} 秒、${fpsNative.toFixed(0)}fps，${shots.length} 个镜头。第一轮：全片每秒 ${coarse} 帧（约 ${Math.round(total * coarse)} 帧，联系表每格 ${sheetW}px）…`);
  const sheets = await contactSheets(file, coarse, sheetW, workDir);
  const coarseTs = Array.from({ length: Math.floor(total * coarse) }, (_, k) => r2(k / coarse));
  const key = await pool(shots, 6, (s, i) => frameAt(file, (s.start + s.end) / 2, path.join(workDir, `S${String(i + 1).padStart(2, '0')}_关键帧_${((s.start + s.end) / 2).toFixed(2)}s.jpg`)));
  const fill = (t: string) => t.replace('{时长}', total.toFixed(1)).replace('{开始时间}', '0').replace('{结束时间}', total.toFixed(2)).replace(/\{帧率\}/g, String(coarse));
  const overview = await ask([text(fill(cfg.overview)), ...sheets.map(image)], cfg.system || '你是严谨的视频拆解分析师。', 2, cfg.model);
  log('梗概完成，找需要加密复查的时间段…');
  const scout = fill(cfg.scout && /\{帧率\}|level/.test(cfg.scout) ? cfg.scout : DEFAULT_SCOUT_FULL);
  const r1 = parseJson(await ask([text(`${scout}\n\n候选切点（秒）：${cuts.join('、')}\n\n全片梗概：\n${overview}`), ...sheets.map(image)], cfg.system, 2, cfg.model));
  const segments: Segment[] = (r1.segments || []).map((g: any) => ({ start: Number(g.start), end: Number(g.end), level: g.level === 'B' ? 'B' : 'A', why: String(g.why || ''), questions: Array.isArray(g.questions) ? g.questions.map(String) : [] })).filter((g: Segment) => g.end > g.start);
  log(`找到 ${segments.length} 个复查段（A ${segments.filter(g => g.level === 'A').length} 个按每秒 ${rate.A.toFixed(1)} 帧，B ${segments.filter(g => g.level === 'B').length} 个按原始 ${rate.B.toFixed(0)} 帧）${cfg.cutReview ? '，另复查每个切点首尾帧' : ''}…`);
  const plan = shots.map(s => ({ ...planFrames(s, coarseTs, segments, rate, !!cfg.cutReview), segs: segments.filter(g => g.end > s.start && g.start < s.end) }));
  const frames = await pool(shots, 4, async (_, i) => Promise.all(plan[i].ts.map((t, k) => frameAt(file, t, path.join(workDir, `f${i}_${k}.jpg`), frameW))));
  const segText = (segs: Segment[]) => segs.map(g => `${g.start.toFixed(2)}–${g.end.toFixed(2)}s［${g.level}］${g.why}${g.questions.length ? `（要确认：${g.questions.join('；')}）` : ''}`).join('；');

  // Shots over budget: read their frames in consecutive chunks first, keep the notes, analyse from notes + a subset.
  const chunkNotes: string[] = shots.map(() => '');
  const big = shots.map((_, i) => i).filter(i => plan[i].ts.length > BUDGET);
  if (big.length) log(`${big.length} 个镜头帧数超过单批 ${BUDGET} 张，分连续批次查看…`);
  await pool(big, 3, async i => {
    const notes: string[] = [];
    for (let k = 0; k < plan[i].ts.length; k += BUDGET) {
      const ts = plan[i].ts.slice(k, k + BUDGET), fs_ = frames[i].slice(k, k + BUDGET);
      notes.push(await ask([
        text(`镜头${i + 1}（${shots[i].start.toFixed(2)}–${shots[i].end.toFixed(2)}s）的连续帧，第 ${k / BUDGET + 1} 批：${ts[0].toFixed(2)}–${ts[ts.length - 1].toFixed(2)}s。${notes.length ? `前几批的记录：\n${notes.join('\n')}\n` : ''}请按时间顺序记录这一批里的状态变化（起始→过程→结束）、运镜和遮挡，带秒数。只写看得见的。`),
        ...ts.flatMap((t, j) => [text(`${t.toFixed(2)}s`), image(fs_[j])])
      ], cfg.system, 2, cfg.model));
    }
    chunkNotes[i] = notes.join('\n');
  });

  const sendTs = plan.map((p, i) => chunkNotes[i] ? evenly(p.ts, 24) : p.ts);
  const batches: number[][] = []; let cur: number[] = [], n = 0;
  shots.forEach((_, i) => { const k = sendTs[i].length; if (cur.length && (n + k > BUDGET || cur.length >= 6)) { batches.push(cur); cur = []; n = 0; } cur.push(i); n += k; });
  if (cur.length) batches.push(cur);
  const timeline = shots.map((s, i) => `镜头${i + 1}: ${s.start.toFixed(2)}–${s.end.toFixed(2)}s`).join('\n');
  let done = 0;
  const results = await pool(batches, 3, async batch => {
    const parts = [text(`全片梗概：\n${overview}\n\n全片镜头时间表（ffmpeg 阈值 ${thr} 检测，可能有极少误切或漏切）：\n${timeline}\n\n请分析下面这些镜头：`)];
    for (const i of batch) {
      const p = plan[i], ts = sendTs[i];
      parts.push(text(`—— 镜头${i + 1}（${shots[i].start.toFixed(2)}–${shots[i].end.toFixed(2)}s），帧时间：${ts.map(t => t.toFixed(2) + 's').join('、')}${p.segs.length ? `。加密复查段：${segText(p.segs)}` : ''}${chunkNotes[i] ? `\n这个镜头共 ${p.ts.length} 帧，已分批逐帧看过，记录如下（以此为准，下面只附部分帧）：\n${chunkNotes[i]}` : ''}`));
      const idx = new Map(p.ts.map((t, k) => [t, k]));
      ts.forEach(t => parts.push(image(frames[i][idx.get(t)!])));
    }
    parts.push(text(`${cfg.rules}\n\n${cfg.schema}\n\n只输出 JSON：{"shots":[...]}，覆盖镜头 ${batch.map(i => i + 1).join('、')}；每个对象的 "i" 是镜头序号。`));
    const out = parseJson(await ask(parts, cfg.system, 2, cfg.model));
    log(`已分析 ${(done += batch.length)}/${shots.length} 个镜头`);
    return (out.shots || []) as any[];
  });
  const byI = new Map(results.flat().map((r: any) => [Number(r.i), { ...r, 动作阶段: fmtStages(r['动作阶段']), 不确定项: fmtList(r['不确定项']) }]));
  const analysed: Analysed[] = shots.map((s, i) => ({
    ...s, fields: byI.get(i + 1) || {}, keyframe: key[i],
    sampling: `全片定频：粗看 ${coarse}fps ${plan[i].coarse} 帧${plan[i].dense ? `，复查 ${plan[i].dense} 帧：${segText(plan[i].segs)}` : ''}${plan[i].edge ? '，切点首尾各 1 帧' : ''}；共 ${plan[i].ts.length} 帧（${frameW}px）${chunkNotes[i] ? `，分 ${Math.ceil(plan[i].ts.length / BUDGET)} 批连续查看` : ''}`
  }));
  return { total, cuts, overview, analysed, segments };
}
