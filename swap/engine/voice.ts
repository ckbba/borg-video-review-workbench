// 配音和字幕: runs on a finished picture and never calls a video model, so changing a word costs nothing.
//
//   transcribe (Whisper, timed lines) → rewrite (apply the change list) → speak (edge-tts, one file per line, fitted to
//   the line's slot) → mix over the background → burn our own subtitles
//
// The background is the source sound with the centre cancelled, which takes out most of a centred voice. It is a
// stand-in for real stem separation; a mono source has nothing to cancel, so its background is dropped.
// The voice is a preset, never a clone of the person in the source.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ask, image, parseJson, text } from '../../server/llm';
import { duration, FFMPEG, run } from '../../server/shots';
import { frameAt } from './media';
import { compare, probe } from './media';
import { dirOf, getJob, say, update } from './pipeline';
import type { CopyItem, Job, VoiceLine } from './types';

const VOICE = process.env.SWAP_TTS_VOICE || 'zh-CN-XiaoxiaoNeural';
/** Preset voices by speaker: never a clone of the people in the source. */
export const VOICES = { f: VOICE, m: process.env.SWAP_TTS_VOICE_MALE || 'zh-CN-YunxiNeural' };
const FONT = process.env.SWAP_SUB_FONT || 'Microsoft YaHei';
// turbo (large-v3-turbo): small heard 海蓝之谜 as 海南之民 (9 Nov). It takes about 1.5 GB of GPU memory; the 4 GB card has it.
const WHISPER = process.env.SWAP_WHISPER_MODEL || 'turbo';
/** Faster than this a Chinese line stops being comfortable to listen to. */
const MAX_TEMPO = 1.6;
/** Characters that fit across a phone-width frame at the subtitle size. */
const CAPTION_WIDTH = 16;
/** Where burned-in captions sit, as fractions of the height. New jobs have none; older pictures get this band blurred. */
const BAND = { y: 0.75, h: 0.065 };

const ENV = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
const rel = (f: string) => path.relative(process.cwd(), f).split(path.sep).join('/');
const exec = (bin: string, args: string[]) => new Promise<string>((res, rej) =>
  execFile(bin, args, { maxBuffer: 16 << 20, timeout: 600_000, env: ENV }, (e, out, err) => e ? rej(new Error(String(err || e).slice(-300))) : res(out)));

// Whisper and edge-tts may live in a different Python from the one on PATH.
let python: Promise<string> | undefined;
const findPython = () => python ??= (async () => {
  for (const bin of [process.env.SWAP_VOICE_PYTHON, 'python', 'py', 'python3'].filter(Boolean) as string[])
    if (await exec(bin, ['-c', 'import whisper, edge_tts']).then(() => true, () => false)) return bin;
  python = undefined;
  throw new Error('没有找到装了 whisper 和 edge-tts 的 Python，请设置 SWAP_VOICE_PYTHON');
})();

export async function transcribe(source: string, dir: string): Promise<VoiceLine[]> {
  // Named after the model, so a job heard by an older model is heard again by the current one.
  const audio = path.join(dir, `audio-${WHISPER}.mp3`), cached = audio.replace(/\.mp3$/, '.json');
  if (!fs.existsSync(cached)) {
    await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-i', source, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', audio]);
    await exec(await findPython(), ['-m', 'whisper', rel(audio), '--model', WHISPER, '--language', 'zh', '--task', 'transcribe', '--output_format', 'json',
      '--output_dir', rel(dir), '--initial_prompt', '以下是普通话的电商口播，使用简体中文。', '--verbose', 'False']);
  }
  return JSON.parse(fs.readFileSync(cached, 'utf8')).segments.filter(trustedSpeech)
    .map((s: any) => ({ start: Number(s.start), end: Number(s.end), from: String(s.text).trim(), to: String(s.text).trim() }))
    .filter((l: VoiceLine) => l.from);
}

/** Whisper invents speech over music ("请点赞 订阅 转发 打赏…" across 15 s of a Kelme film with no voice, 6 Nov), and that
 *  line then got burned in and read aloud. Whisper's own rule for silence: a high no-speech score AND low confidence in
 *  the words; the score alone sat at 0.60 on every clear line of a loud talk-over film (9 Nov, La Mer), which lost all 50.
 *  A line far too slow to be speech is no line either. */
export const trustedSpeech = (s: { start: number; end: number; text: string; no_speech_prob?: number; avg_logprob?: number }) => {
  const seconds = Number(s.end) - Number(s.start), chars = String(s.text).replace(/\s/g, '').length;
  const silent = (s.no_speech_prob ?? 0) >= 0.6 ? (s.avg_logprob ?? -2) < -1 : (s.no_speech_prob ?? 0) >= 0.4 && (s.avg_logprob ?? -2) < -0.8;
  return !silent && !(seconds >= 5 && chars / seconds < 1.2);
};

/** Exact replacement only: what the rewrite falls back to without the model. */
export const applyCopy = (line: string, copy: CopyItem[]) => copy.reduce((s, c) => s.split(c.from).join(c.to), line);

/** Two steps in one model call: `from` is corrected against the captions burned into the film (9 Nov, La Mer: Whisper heard
 *  海蓝之谜 as 海南之民 and got the prices wrong, while the captions said it right), then the change list is applied.
 *  `frames`: one frame per line, taken where its caption shows. */
/** `swap`: what the film sold and what it sells now, so every mention of the old product changes, not only the lines the
 *  change list happens to quote (9 Nov: 海蓝之谜 stayed in the voice where no caption had listed it).
 *  The same call says who speaks each line: a second call with 50 pictures failed silently and left one voice for all. */
async function rewrite(lines: VoiceLine[], copy: CopyItem[], frames: string[] = [], swap?: { from: string; to: string; name?: string }, log?: (m: string) => void): Promise<VoiceLine[]> {
  const local = lines.map(l => ({ ...l, to: applyCopy(l.from, copy) }));
  try {
    const j = parseJson(await ask([text(`下面是一条口播的语音转写（每行有时间，可能有错别字、听错的品牌名和数字）${frames.length ? '，每行后面是说这句时的一帧画面，画面上的字幕通常就是这句话的原文' : ''}，最后是一份改动清单（原文 → 改写）。
${swap ? `这条视频原来卖的是：${swap.from}。现在换成了：${swap.name || swap.to}。\n` : ''}第一步，校对：${frames.length ? '画面上有这句的字幕时，按字幕改正转写（品牌、型号、数字、价格以字幕为准）；没有字幕的行，' : ''}按上下文改正明显听错的词，得到 fixed。
第二步，改写：把改动清单用到 fixed 上，改动清单优先；${swap ? '清单没列到的地方，凡是提到原来商品的品牌、名称的，也一律换成新商品的叫法（用中文常用的叫法，不要写成"××瓶装护肤品"这种生硬说法）；' : ''}别的不要动，字数尽量和原行一样，得到 text。
text 里不要出现"待确认""需确认""以页面为准"这类说明文字。价格和规格数字：改动清单里给了新数字就用新数字（念法跟着原话，原话说"三百五十九"就念成新数字的说法），没给的保留原片的数字，绝不模糊成"另一个价""这个价"。
第三步，谁在说：${frames.length ? '看这句的画面，画面里的人这时在张嘴说话，就是他/她说的（onScreen=true）；闭着嘴在听，就是画外的人在说（onScreen=false）。' : ''}再看内容，一问一答通常是两个人轮流说。voice 填说话人性别：男 "m"，女 "f"；判断不了就和上一句的另一个人相反。
只输出 JSON：{"lines":[{"i":行号,"fixed":"校对后的原话","text":"改写后的这一行","voice":"m","onScreen":true}]}，每一行都要输出。

改动清单：
${copy.map(c => `${c.from} → ${c.to}`).join('\n') || '（没有）'}

转写：`), ...lines.flatMap((l, i) => [text(`${i} ${l.start.toFixed(1)}s ${l.from}`), ...(frames[i] ? [image(frames[i])] : [])])], '你是严谨的电商文案编辑，只输出 JSON。', 2));
    return lines.map((l, i) => {
      const x = j.lines?.find((y: any) => Number(y.i) === i);
      return { ...l, from: String(x?.fixed || l.from).trim(), to: String(x?.text || local[i].to).trim(),
        ...(['m', 'f'].includes(x?.voice) ? { voice: x.voice, onScreen: x.onScreen !== false } : {}) };
    });
  } catch (e: any) { log?.(`改写文案没有完成（${e.message}），只按清单替换`); return local; }
}

/** One small frame per line, at its middle: where that line's caption is on screen. */
const lineFrames = (lines: VoiceLine[], source: string, dir: string) => {
  const d = path.join(dir, 'lines'); fs.mkdirSync(d, { recursive: true });
  return Promise.all(lines.slice(0, 80).map((l, i) => frameAt(source, (l.start + l.end) / 2, path.join(d, `l${i}.jpg`), 360).catch(() => '')));
};

/** The atempo needed for a spoken line to fit its slot, within what still sounds natural. */
export const fitTempo = (spoken: number, slot: number) => Math.min(MAX_TEMPO, Math.max(1, spoken / Math.max(slot, 0.2)));

async function speak(lines: VoiceLine[], total: number, dir: string) {
  const py = await findPython();
  return Promise.all(lines.map(async (l, i) => {
    const raw = path.join(dir, `line${i}.mp3`), fit = path.join(dir, `line${i}-fit.wav`);
    await exec(py, ['-m', 'edge_tts', '--voice', VOICES[l.voice || 'f'], '--text', l.to, '--write-media', rel(raw)]);
    const slot = (lines[i + 1]?.start ?? total) - l.start;
    await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-i', raw, '-af', `atempo=${fitTempo(await duration(raw), slot).toFixed(3)}`, '-ar', '44100', '-ac', '2', fit]);
    return fit;
  }));
}

const clock = (t: number) => { const c = Math.round(t * 100), p = (n: number, w = 2) => String(n).padStart(w, '0'); return `${Math.floor(c / 360000)}:${p(Math.floor(c / 6000) % 60)}:${p(Math.floor(c / 100) % 60)}.${p(c % 100)}`; };

/** One spoken line as short captions: split at punctuation (Chinese has no spaces to wrap at), timed by length. */
export function captions(lines: VoiceLine[], width = CAPTION_WIDTH) {
  return lines.flatMap((l, i) => {
    const parts: string[] = [];
    for (const raw of l.to.split(/[，。！？；、,.!?;\s]+/).filter(Boolean)) {
      const last = parts[parts.length - 1];
      if (last && last.length + raw.length <= Math.floor(width / 2)) parts[parts.length - 1] = `${last} ${raw}`;
      else { const n = Math.ceil(raw.length / Math.ceil(raw.length / width)); for (let k = 0; k < raw.length; k += n) parts.push(raw.slice(k, k + n)); }
    }
    const end = Math.min(l.end, lines[i + 1]?.start ?? l.end), per = (end - l.start) / (parts.join('').length || 1);
    let t = l.start;
    return parts.map(p => { const a = t; t += p.length * per; return { ...l, start: a, end: t, to: p }; });
  });
}

/** Subtitles as ASS, sized to the video and sitting where the source's captions sat. */
export function assText(lines: VoiceLine[], w: number, h: number, font = FONT) {
  const size = Math.round(h * 0.03), bottom = Math.round(h * (1 - BAND.y - BAND.h) + h * 0.012);
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${w}\nPlayResY: ${h}\nWrapStyle: 0\n\n[V4+ Styles]\n` +
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV\n' +
    `Style: Default,${font},${size},&H00FFFFFF,&H64000000,&H00000000,1,1,2,0,2,${Math.round(w * 0.06)},${Math.round(w * 0.06)},${bottom}\n\n[Events]\n` +
    'Format: Layer, Start, End, Style, Text\n' +
    captions(lines).map(l => `Dialogue: 0,${clock(l.start)},${clock(l.end)},Default,${l.to.replace(/[{}\n]/g, '')}`).join('\n') + '\n';
}

async function mix(picture: string, source: string, lines: VoiceLine[], clips: string[], ass: string | undefined, blur: boolean, out: string) {
  const s = await probe(source), stereo = s.audio && (await run(FFMPEG, ['-hide_banner', '-i', source]).catch(e => e.message)).match(/Audio:.*stereo/) != null;
  const delayed = clips.map((_, i) => { const ms = Math.round(lines[i].start * 1000); return `[${i + 2}:a]adelay=${ms}|${ms}[v${i}]`; });
  const bed = stereo ? '[1:a]pan=stereo|c0=c0-c1|c1=c1-c0,volume=0.8[bed]' : `anullsrc=r=44100:cl=stereo:d=${s.seconds.toFixed(2)}[bed]`;
  const y = `ih*${BAND.y}`, band = blur ? `[0:v]split[p][c];[c]crop=iw:ih*${BAND.h}:0:${y},boxblur=14:2[b];[p][b]overlay=0:H*${BAND.y}[pic];[pic]` : '[0:v]';
  await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-i', picture, '-i', source, ...clips.flatMap(c => ['-i', c]), '-filter_complex',
    [ass ? `${band}ass=${rel(ass)}[vo]` : '[0:v]null[vo]', bed, ...delayed, `[bed]${clips.map((_, i) => `[v${i}]`).join('')}amix=inputs=${clips.length + 1}:duration=first:normalize=0[ao]`].join(';'),
    '-map', '[vo]', '-map', '[ao]', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-t', s.seconds.toFixed(3), out]);
  return out;
}

/** Puts the new voice and subtitles on `picture`. Returns the new file. */
export async function voiceover(id: string, picture: string) {
  const job = getJob(id), r = job.replica!, dir = path.join(dirOf(id), 'voice');
  fs.mkdirSync(dir, { recursive: true });
  say(id, '配音和字幕：听写原片口播');
  const heard = await transcribe(r.source, dir);
  if (!heard.length) throw new Error('原片里没有听到口播');
  say(id, '配音和字幕：校对、改写文案，分辨每句是谁说的');
  const swap = r.plan && { from: r.plan.target, to: r.plan.subject, name: r.productName };
  const lines = await rewrite(heard, r.copy || [], await lineFrames(heard, r.source, dir), swap, m => say(id, `配音和字幕：${m}`));
  const by = [...new Set(lines.map(l => l.voice || 'f'))].map(v => VOICES[v]).join(' / ');
  update(id, j => { j.replica!.voice = { ...j.replica!.voice, status: 'running', lines, by }; });
  say(id, `配音和字幕：配音 ${lines.length} 句`);
  const { seconds, width, height } = await probe(r.source);
  const clips = await speak(lines, seconds, dir);
  const subs = r.subtitles !== false, ass = path.join(dir, 'subs.ass');
  if (subs) fs.writeFileSync(ass, assText(lines, width, height));
  const out = await mix(picture, r.source, lines, clips, subs ? ass : undefined, subs && !r.plan?.dropText, path.join(dirOf(id), `voiced-${Date.now()}.mp4`));
  say(id, '配音和字幕：完成');
  return out;
}

const publish = async (j: Job, file: string) => {
  const r = j.replica!, old = j.versions[0].final, cmp = await compare(r.source, file, path.join(dirOf(j.id), 'compare.mp4'));
  update(j.id, x => {
    Object.assign(x.versions[0], { final: file, compare: cmp });
    x.replica!.voice = { ...x.replica!.voice, status: 'done', error: undefined };
  });
  if (old && old !== file && old !== r.picture) fs.rmSync(old, { force: true });
};

/** After the user edits the change list: redo sound and subtitles on the untouched picture, in the background. */
export function startVoiceover(id: string, subtitles?: boolean) {
  const j = getJob(id);
  if (j.stage !== 'done' || !j.versions[0].final) throw new Error('成片做好后才能更新配音和字幕');
  if (j.replica?.voice?.status === 'running') throw new Error('正在更新，请稍等');
  const picture = j.replica!.picture || j.versions[0].final;
  update(id, x => { if (subtitles != null) x.replica!.subtitles = subtitles; x.replica!.picture = picture; x.replica!.voice = { ...x.replica!.voice, status: 'running', error: undefined }; });
  void voiceover(id, picture).then(f => publish(getJob(id), f)).catch(e => update(id, x => {
    x.replica!.voice = { ...x.replica!.voice, status: 'failed', error: String(e.message || e) };
  }));
  return getJob(id);
}
