// Keeps the recreation video following the source clock.
// Small drift is absorbed by nudging playbackRate; only large drift seeks, so a buffering clip
// doesn't fall into a seek → rebuffer → seek loop. Outside the clip's range the recreation rests paused.
export const HARD_DRIFT = 0.6;
const SOFT_DRIFT = 0.08;
const held = new WeakSet<HTMLVideoElement>();

export function recreationTarget(sourceTime: number, offset: number, duration: number) {
  const t = sourceTime - offset;
  return { t: Math.min(Math.max(t, 0), Number.isFinite(duration) ? duration : Math.max(t, 0)), inside: t >= 0 && (!Number.isFinite(duration) || t < duration - 0.05) };
}

export function follow(src: HTMLVideoElement, rec: HTMLVideoElement, offset: number, rate: number, playing: boolean) {
  const { t, inside } = recreationTarget(src.currentTime, offset, rec.duration);
  const drift = rec.currentTime - t;
  if (!inside || !playing) {
    if (!rec.paused) rec.pause();
    if (held.has(src)) held.delete(src);
    rec.playbackRate = rate;
    if (Math.abs(drift) > 0.04) rec.currentTime = t;
    return inside;
  }
  // one side buffering: hold the other instead of letting them drift apart
  if (rec.readyState < 3 && !rec.seeking) { if (!src.paused) { src.pause(); held.add(src); } }
  else if (held.has(src)) { held.delete(src); src.play().catch(() => {}); }
  if (src.readyState < 3) { if (!rec.paused) rec.pause(); return inside; }
  if (Math.abs(drift) > HARD_DRIFT) rec.currentTime = t;
  rec.playbackRate = Math.abs(drift) > SOFT_DRIFT && Math.abs(drift) <= HARD_DRIFT ? rate * (drift > 0 ? 0.94 : 1.06) : rate;
  if (rec.paused && !rec.seeking) rec.play().catch(() => {});
  return inside;
}
