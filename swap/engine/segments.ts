// Long sources: the video models take at most ~15 s, so a source is cut into segments, each edited on its own
// and joined back frame-exact under the source sound (the method of ALTER's alter_split / alter_assemble).
//
// A boundary is either `hard` (a real shot change: the picture jumps anyway, so segments can run in parallel)
// or `soft` (inside one continuous shot: the next segment starts from the previous result's last frame,
// so they run one after the other and the seam does not jump).
import { FFMPEG, run } from '../../server/shots';
import { probe } from './media';
import fs from 'node:fs';
import path from 'node:path';

export type Cut = { t: number; hard: boolean };
export type Segment = { index: number; start: number; end: number; /** how this segment joins the previous one */ join: 'start' | 'hard' | 'soft' };

/** Plans segments of [min, max] seconds. Hard cuts are preferred; a shot longer than `limit` is split evenly (soft).
 *  `max` is the length aimed for, `limit` what the model accepts: a piece only goes past `max` to avoid a soft seam. */
export function planSegments(total: number, hardCuts: number[], min: number, max: number, limit = max): Segment[] {
  if (total <= max) return [{ index: 0, start: 0, end: total, join: 'start' }];
  // 1. shots, each split into equal soft pieces no longer than max
  const edges = [0, ...hardCuts.filter(c => c > 0.2 && c < total - 0.2).sort((a, b) => a - b), total];
  const pieces: { start: number; end: number; join: 'start' | 'hard' | 'soft' }[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const a = edges[i], b = edges[i + 1], n = Math.ceil((b - a) / limit - 1e-9);
    for (let k = 0; k < n; k++) pieces.push({ start: a + (b - a) * k / n, end: a + (b - a) * (k + 1) / n, join: k ? 'soft' : i ? 'hard' : 'start' });
  }
  // 2. merge neighbours while they fit: fewer seams, fewer runs
  const segs: typeof pieces = [];
  for (const p of pieces) {
    const last = segs[segs.length - 1];
    if (last && p.end - last.start <= max) last.end = p.end; else segs.push({ ...p });
  }
  // 3. too short: merge into a neighbour if it fits, else move the boundary (that boundary becomes soft)
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.end - s.start >= min) continue;
    const prev = segs[i - 1], next = segs[i + 1];
    if (prev && s.end - prev.start <= limit) { prev.end = s.end; segs.splice(i--, 1); }
    else if (next && next.end - s.start <= limit) { next.start = s.start; next.join = s.join; segs.splice(i--, 1); }
    else if (prev) { s.start = s.end - min; prev.end = s.start; s.join = 'soft'; }
    else if (next) { s.end = s.start + min; next.start = s.end; next.join = 'soft'; }
  }
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return segs.map((s, index) => ({ index, start: r(s.start), end: r(s.end), join: index ? s.join : 'start' }));
}

/** Frame-exact cut of [start, end) seconds, video and audio, re-encoded so every piece starts on a keyframe. */
export async function cutPiece(source: string, s: Segment, out: string) {
  const { fps } = await probe(source);
  const a = Math.round(s.start * fps), b = Math.round(s.end * fps);
  await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-i', source,
    '-vf', `trim=start_frame=${a}:end_frame=${b},setpts=PTS-STARTPTS`, '-af', `atrim=start=${a / fps}:end=${b / fps},asetpts=PTS-STARTPTS`,
    '-c:v', 'libx264', '-crf', '17', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out]);
  return out;
}

/** Conforms an edited piece to its source piece: same size, fps and exact frame count.
 *  Models are asked for whole seconds (11 s for a 10.6 s piece) and spread the action over what they return,
 *  so the edit is retimed to the piece's length, never cut: cutting drops the end of the action and the next
 *  segment then jumps (seen on 4 Nov: 277 frames for a 255-frame piece, the character jumped across the frame). */
export async function conformPiece(piece: string, edited: string, out: string) {
  const [p, e] = await Promise.all([probe(piece), probe(edited)]);
  const k = p.frames / p.fps / e.seconds;
  await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-i', edited, '-vf',
    `setpts=${k.toFixed(6)}*PTS,scale=${p.width}:${p.height}:force_original_aspect_ratio=increase,crop=${p.width}:${p.height},fps=${p.fps},tpad=stop_mode=clone:stop=${Math.ceil(p.fps)},trim=end_frame=${p.frames},setpts=PTS-STARTPTS,format=yuv420p`,
    '-an', '-c:v', 'libx264', '-crf', '17', out]);
  return out;
}

export async function joinPieces(pieces: string[], out: string) {
  const list = out + '.txt';
  fs.writeFileSync(list, pieces.map(p => `file '${path.resolve(p).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out]);
  return out;
}

/** The last frame of a clip, for the next soft segment to start from. */
export async function lastFrame(file: string, out: string) {
  await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-sseof', '-0.2', '-i', file, '-update', '1', '-q:v', '2', out]);
  return out;
}

/** [start, end) of a soundtrack as MP3, for an audio reference. Returns undefined when the file has no sound. */
export async function cutAudio(file: string, start: number, end: number, out: string) {
  if (!(await probe(file)).audio) return undefined;
  await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-ss', String(start), '-to', String(end), '-i', file, '-vn', '-ac', '2', '-ar', '44100', '-b:a', '160k', out]);
  return out;
}

/** The seam between two pieces as one picture: last frame of `a` | first frame of `b`. */
export async function seamImage(a: string, b: string, out: string) {
  await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-sseof', '-0.1', '-i', a, '-i', b, '-filter_complex',
    '[0:v]select=eq(n\\,0),scale=-2:360[x];[1:v]select=eq(n\\,0),scale=-2:360[y];[x][y]hstack', '-frames:v', '1', '-q:v', '3', out]);
  return out;
}

/** Joins pieces into one clip. A piece with `overlap` > 0 starts that many seconds before the previous piece ends
 *  (both were generated over the same source frames), and the two are crossfaded across it, so a seam inside a
 *  shot blends instead of jumping. `overlap` 0 is a straight cut. */
export async function stitch(items: { file: string; overlap: number }[], fps: number, out: string) {
  if (items.length === 1) { fs.copyFileSync(items[0].file, out); return out; }
  const lens = await Promise.all(items.map(async x => (await probe(x.file)).frames / fps));
  const prep = items.map((_, i) => `[${i}:v]fps=${fps},settb=AVTB,setpts=PTS-STARTPTS,format=yuv420p[i${i}]`);
  const steps: string[] = [];
  let acc = 'i0', total = lens[0];
  items.slice(1).forEach((x, k) => {
    const i = k + 1, next = `c${i}`, d = Math.min(x.overlap, lens[i] - 0.05, total - 0.05);
    if (d > 0.01) { steps.push(`[${acc}][i${i}]xfade=transition=fade:duration=${d.toFixed(4)}:offset=${(total - d).toFixed(4)}[${next}]`); total += lens[i] - d; }
    else { steps.push(`[${acc}][i${i}]concat=n=2:v=1:a=0[${next}]`); total += lens[i]; }
    acc = next;
  });
  await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', ...items.flatMap(x => ['-i', x.file]), '-filter_complex', [...prep, ...steps].join(';'),
    '-map', `[${acc}]`, '-an', '-c:v', 'libx264', '-crf', '17', '-pix_fmt', 'yuv420p', out]);
  return out;
}

/** Structural similarity of two pictures, 0..1 (1 = identical). */
export async function ssim(a: string, b: string) {
  const o = await run(FFMPEG, ['-nostdin', '-i', a, '-i', b, '-lavfi', '[0:v]scale=320:180,format=gray[x];[1:v]scale=320:180,format=gray[y];[x][y]ssim', '-f', 'null', '-']);
  return Number(o.match(/All:([\d.]+)/)?.[1] ?? NaN);
}
