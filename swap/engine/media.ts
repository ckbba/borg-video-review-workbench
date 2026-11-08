// ffmpeg steps the pipeline needs. Everything here is local and free; no step calls a vendor.
import { FFMPEG, FFPROBE, frameAt, run } from '../../server/shots';

export { frameAt };

export type Probe = { seconds: number; width: number; height: number; fps: number; frames: number; audio: boolean };
export async function probe(file: string): Promise<Probe> {
  const j = JSON.parse(await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]));
  const v = j.streams.find((s: any) => s.codec_type === 'video');
  const [a, b] = String(v.avg_frame_rate || v.r_frame_rate).split('/').map(Number);
  const fps = b ? a / b : a, seconds = Number(j.format.duration);
  return { seconds, width: v.width, height: v.height, fps, frames: Number(v.nb_frames) || Math.round(seconds * fps), audio: j.streams.some((s: any) => s.codec_type === 'audio') };
}

/** What every source goes through once: upright, SDR, constant frame rate, H.264, long side ≤ 1920, trimmed. */
export async function prepare(input: string, out: string, o: { start?: number; end?: number; fps?: number } = {}) {
  const span = [...(o.start ? ['-ss', String(o.start)] : []), ...(o.end ? ['-to', String(o.end)] : [])];
  await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', ...span, '-i', input,
    '-vf', `scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))',fps=${o.fps || 24},format=yuv420p`,
    '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);
  return out;
}

/** The size to crop to when a film is wider or taller than MiniMax takes (5 Nov: "aspect ratio 2.592, expected in [0.4, 2.5]"). */
export const fitAspect = (w: number, h: number, lo = 0.4, hi = 2.5) =>
  w / h > hi ? { width: Math.floor(h * hi / 2) * 2, height: h } : w / h < lo ? { width: w, height: Math.floor(w / lo / 2) * 2 } : undefined;
export async function cropCentre(src: string, size: { width: number; height: number }, out: string) {
  await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-i', src, '-vf', `crop=${size.width}:${size.height}`, '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-c:a', 'copy', '-movflags', '+faststart', out]);
  return out;
}
/** The image model has no ratio wider than 16:9 that suits a film: bars go on before, and come off after. */
export async function letterbox(file: string, out: string) {
  await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-i', file, '-vf', 'pad=iw:trunc(iw*9/16/2)*2:0:(oh-ih)/2:black', '-frames:v', '1', '-q:v', '2', out]);
  return out;
}
export async function unbox(file: string, aspect: number, out: string) {
  await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-i', file, '-vf', `crop=iw:trunc(iw/${aspect}/2)*2`, '-frames:v', '1', '-q:v', '2', out]);
  return out;
}

/** Conforms an edit to its source (size, fps, frame count), drops trailing frames that drifted, puts the source sound back. */
export async function finish(source: string, output: string, out: string, trimTail = 0) {
  const s = await probe(source);
  const frames = Math.max(1, s.frames - trimTail);
  await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-i', output, '-i', source,
    '-filter_complex', `[0:v]scale=${s.width}:${s.height}:force_original_aspect_ratio=decrease,pad=${s.width}:${s.height}:(ow-iw)/2:(oh-ih)/2,fps=${s.fps},tpad=stop_mode=clone:stop=3,format=yuv420p[v]`,
    '-map', '[v]', ...(s.audio ? ['-map', '1:a:0', '-c:a', 'aac'] : []), '-frames:v', String(frames),
    '-c:v', 'libx264', '-crf', '18', '-movflags', '+faststart', '-shortest', out]);
  return out;
}

/** Source and result side by side (or stacked for portrait), source sound, for sharing a before/after. */
export async function compare(source: string, final: string, out: string) {
  const s = await probe(source), wide = s.width >= s.height;
  const h = wide ? 540 : 960;
  await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-i', source, '-i', final, '-filter_complex',
    `[0:v]scale=-2:${h}[a];[1:v]scale=-2:${h}[b];[a][b]${wide ? 'vstack' : 'hstack'}=inputs=2,format=yuv420p[v]`,
    '-map', '[v]', ...(s.audio ? ['-map', '0:a:0', '-c:a', 'aac'] : []), '-c:v', 'libx264', '-crf', '20', '-shortest', '-movflags', '+faststart', out]);
  return out;
}

/** A poster frame for cards. */
export const poster = (file: string, out: string, t = 0.5) => frameAt(file, t, out, 640);
