// 只复刻能做的部分: the shots the plan marked fit=no are cut out of the source before anything is made, so every later
// step (keyframes, segments, compose, voice) simply works on a shorter film. Nothing downstream knows a cut happened.
import { FFMPEG, run } from '../../server/shots';
import type { CopyItem, Plan } from './types';

export type Span = { start: number; end: number };

/** Contiguous runs of the shots that stay. */
export function keptSpans(plan: Plan): Span[] {
  const out: Span[] = [];
  for (const s of plan.shots) {
    if (s.fit === 'no') continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last.end - s.start) < 0.01) last.end = s.end; else out.push({ start: s.start, end: s.end });
  }
  return out;
}
export const spanSeconds = (spans: Span[]) => spans.reduce((a, s) => a + s.end - s.start, 0);

/** A time in the source to the same moment in the cut film; undefined when that moment was cut out. */
export function remap(t: number, spans: Span[]): number | undefined {
  let before = 0;
  for (const s of spans) {
    if (t >= s.start - 1e-6 && t < s.end - 1e-6) return Math.round((before + t - s.start) * 1000) / 1000;
    before += s.end - s.start;
  }
}

/** The plan and the copy list, moved onto the cut film. Shots are renumbered; scenes keep their ids. */
export function trimPlan(plan: Plan, copy: CopyItem[] | undefined, spans: Span[]) {
  const kept = plan.shots.filter(s => s.fit !== 'no');
  const index = new Map(kept.map((s, i) => [s.index, i + 1]));
  const shots = kept.map((s, i) => ({ ...s, index: i + 1, start: remap(s.start, spans)!, end: remap(s.start, spans)! + (s.end - s.start) }));
  const mid = (n: number) => { const s = shots.find(x => x.index === n)!; return (s.start + s.end) / 2; };
  const scenes = plan.scenes.map(c => {
    const own = c.shots.map(n => index.get(n)).filter((n): n is number => n != null && shots[n - 1].change);
    const at = remap(c.keyAt, spans);
    return own.length ? { ...c, shots: own, keyAt: at ?? mid(own[0]) } : undefined;
  }).filter(<T,>(c: T | undefined): c is T => !!c);
  const variants = plan.variants.map(v => {
    const at = remap(v.at, spans), scene = scenes.find(c => c.variant === v.id);
    return at != null ? { ...v, at } : scene ? { ...v, at: scene.keyAt } : undefined;
  }).filter(<T,>(v: T | undefined): v is T => !!v);
  if (variants.length && !variants.some(v => v.main)) variants[0].main = true;
  const gaps = (plan.gaps || []).flatMap(g => { const at = remap(g.at, spans); return at == null ? [] : [{ ...g, at, shots: g.shots?.map(n => index.get(n)).filter((n): n is number => n != null) }]; });
  const newCopy = (copy || []).flatMap(c => { const at = remap(c.at, spans); return at == null ? [] : [{ ...c, at }]; });
  return { plan: { ...plan, shots, scenes, variants, gaps }, copy: newCopy };
}

/** The kept spans of the source, joined, picture and sound together. */
export async function cutSource(src: string, spans: Span[], audio: boolean, out: string) {
  const parts = spans.map((s, i) => `[0:v]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS[v${i}];` +
    (audio ? `[0:a]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS[a${i}];` : '')).join('');
  const ins = spans.map((_, i) => `[v${i}]${audio ? `[a${i}]` : ''}`).join('');
  await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-i', src, '-filter_complex', `${parts}${ins}concat=n=${spans.length}:v=1:a=${audio ? 1 : 0}[v]${audio ? '[a]' : ''}`,
    '-map', '[v]', ...(audio ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '160k'] : []), '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-movflags', '+faststart', out]);
  return out;
}
