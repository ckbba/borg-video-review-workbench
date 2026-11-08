// 博观 (BORG RISE) through its CLI, the channel the workbench already uses.
// Image: multi-reference generation (seeddream-5.0 by default; nanobanana-pro returned 403 upstream on 3 Nov). Video: 全能参考 with the source as @视频1;
// Seedance treats a reference video plus an edit prompt as an edit. 博观 has no Seedance draft, so every run is final.
import fs from 'node:fs';
import path from 'node:path';
import { borg } from '../../../server/recreate';
import { imageCost, videoCost } from '../../../src/pricing';
import { probe } from '../media';
import type { ImageEditor, Log, VideoEditor } from '../types';

const IMAGE_MODEL = process.env.SWAP_BORG_IMAGE_MODEL || 'image-2.5-flare';
const VIDEO_MODEL = process.env.SWAP_BORG_VIDEO_MODEL || 'seedance-2.5';
// MiniMax offers 480p / 768p; Seedance 480p / 720p / 1080p.
// Lowest resolution unless asked otherwise: cost first (480p is about half of 768p / 720p).
const VIDEO_SIZE = process.env.SWAP_BORG_VIDEO_SIZE || '480p';

/** Every http(s) URL anywhere in a CLI reply, in order. Replies differ per capability, so look everywhere. */
export function urlsIn(x: any, exts: RegExp): string[] {
  const out: string[] = [];
  const walk = (v: any) => {
    if (typeof v === 'string') { if (/^https?:\/\//.test(v) && exts.test(v.split('?')[0])) out.push(v); }
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(x);
  return [...new Set(out)];
}

async function download(url: string, file: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}

// 博观 cuts Seedance's moderation messages short ("...because the input video "); say what they mean.
function explain(msg: string) {
  if (/sensitive/i.test(msg)) return `输入没有通过视频模型的审核（通常是写实真人脸，尤其是近景大脸）。可以重试一次，或换成非写实形象。（${msg.trim()}）`;
  if (/input video/i.test(msg)) return `原视频没有通过视频模型的审核，通常是因为画面里有写实真人。请换成没有真人脸的模板视频。（${msg.trim()}）`;
  if (/input image|real person|likeness/i.test(msg)) return `图片没有通过视频模型的审核，通常是因为有写实人脸。（${msg.trim()}）`;
  return msg;
}

async function waitTask(taskId: string, log: Log, maxMin: number) {
  for (let i = 0; i < maxMin * 4; i++) {
    const d = await borg(['task', 'status', '--task-id', taskId], 120_000).catch(e => ({ status: 'poll-error', error: e.message }));
    if (d.status === 'completed' || d.status === 'success') return d;
    if (['failed', 'error', 'cancelled'].includes(d.status)) throw new Error(explain(String(d.error?.message || d.message || d.error || d.status).replace(/^任务执行失败: /, '')));
    if (i % 4 === 0) log(`生成中…（${d.status}${d.progress ? ` ${d.progress}%` : ''}）`);
    await new Promise(r => setTimeout(r, 15_000));
  }
  throw new Error(`等待超过 ${maxMin} 分钟`);
}

export const borgImage: ImageEditor = {
  name: `博观 ${IMAGE_MODEL}`,
  async targetFrames({ prompt, refs, ratio, count, outDir, log, bill }) {
    log(`生成预览图（${IMAGE_MODEL}）…`);
    const d = await borg(['image', 'generate', `--prompt=${prompt.replace(/\r?\n/g, ' ')}`, ...refs.map(f => `--ref-file=${f}`),
      `--model=${IMAGE_MODEL}`, `--ratio=${ratio}`, `--count=${count}`, '--wait', '--timeout=600']);
    if (d.success === false || !d.taskId) throw new Error(d.error?.message || d.message || '预览图生成失败');
    // Only a finished task's own result counts. The first reply also carries the uploaded references, and on 6 Nov a failed
    // task's @image1 was downloaded as its "result": five keyframes that were just the source frames.
    const units = `${count} 张`;
    let done;
    try { done = await waitTask(d.taskId, log, 10); }
    catch (e: any) {
      bill?.({ model: IMAGE_MODEL, units, taskId: d.taskId, yuan: 0, note: `失败未计费：${e.message.slice(0, 40)}` });
      throw new Error(e.message.replace(/com\.[\w.]+Exception:\s*/, ''));
    }
    bill?.({ model: IMAGE_MODEL, units, taskId: d.taskId, yuan: imageCost(IMAGE_MODEL, count)?.yuan });
    const urls = urlsIn(done.result, /\.(png|jpe?g|webp)$/i);
    if (!urls.length) throw new Error('预览图任务完成了，但没有拿到图片地址');
    return Promise.all(urls.slice(0, count).map((u, i) => download(u, path.join(outDir, `frame-${i + 1}${path.extname(u.split('?')[0]) || '.png'}`))));
  }
};

export const borgVideo: VideoEditor = {
  name: `博观 ${VIDEO_MODEL}`,
  minSeconds: VIDEO_MODEL.startsWith('minimax') ? 5 : 4,
  maxSeconds: 15, // 全能参考: reference videos may total 15 s
  maxRefs: VIDEO_MODEL.startsWith('minimax') ? 4 : 5, // MiniMax refused a fifth on 5 Nov
  // 博观's 全能参考 names references in Chinese, numbered per kind.
  bindRefs: p => p.replace(/@image(\d+)/g, '@图片$1').replace(/@video(\d+)/g, '@视频$1').replace(/@audio(\d+)/g, '@音频$1'),
  async edit({ prompt, source, images, audio, ratio, duration, outFile, log, bill }) {
    if (prompt.length > 2500) throw new Error(`提示词 ${prompt.length} 字，超过 2500 字上限`);
    // MiniMax's moderation is not deterministic: on 4 Nov the same inputs were refused once ("new_sensitive")
    // and passed twice in a row. Retry a moderation refusal; anything else fails at once.
    for (let attempt = 1; ; attempt++) {
      // The soundtrack is the usual suspect for a music-rights refusal: the last try goes without it.
      if (audio && attempt === MODERATION_TRIES && attempt > 1) { audio.dropped = true; log('最后一次重试去掉参考音频'); }
      const useAudio = audio && !audio.dropped;
      try { return await editOnce({ prompt: useAudio ? `${prompt} ${audio!.line}` : prompt, source, images, audio: useAudio ? audio : undefined, ratio, duration, outFile, log, bill }); }
      catch (e: any) {
        if (attempt >= MODERATION_TRIES || !/审核|sensitive/i.test(e.message)) throw e;
        log(`被审核拦截，自动重试（第 ${attempt + 1}/${MODERATION_TRIES} 次）`);
      }
    }
  }
};

const MODERATION_TRIES = Number(process.env.SWAP_MODERATION_TRIES || 3);

async function editOnce({ prompt, source, images, audio, ratio, duration, outFile, log, bill }: Parameters<VideoEditor['edit']>[0]) {
  const d = await borg(['video', 'reference', `--prompt=${prompt.replace(/\r?\n/g, ' ')}`, ...images.map(f => `--image-file=${f}`), `--video-file=${source}`,
    ...(audio ? [`--audio-file=${audio.file}`] : []),
    `--model=${VIDEO_MODEL}`, `--size=${VIDEO_SIZE}`, `--ratio=${ratio}`, `--duration=${Math.round(duration)}`, '--sound=off', '--count=1', '--request-timeout-ms=180000']);
  const taskId = d.taskId || d.response?.data?.task_id || d.response?.task_id;
  if (!d.success || !taskId) throw new Error(d.error?.message || d.message || '提交失败');
  log(`已提交视频任务 ${taskId}`);
  const units = `${Math.round(duration)} 秒 ${VIDEO_SIZE}${images.length ? ` · ${images.length} 张参考图` : ''}${audio ? ' · 参考音频' : ''}`;
  let done;
  // Costs come from our price table (src/pricing.ts), not the CLI's deduction. A refused task produced nothing: 0.
  try { done = await waitTask(taskId, log, 30); }
  catch (e: any) { bill?.({ model: VIDEO_MODEL, units, taskId, yuan: 0, note: `失败未计费：${e.message.slice(0, 40)}` }); throw e; }
  const inputVideoSec = (await probe(source)).seconds;
  bill?.({ model: VIDEO_MODEL, units, taskId, yuan: videoCost(VIDEO_MODEL, { size: VIDEO_SIZE, outputSec: Math.round(duration), images: images.length, inputVideoSec, ratio })?.yuan });
  const url = done.result?.video_url || urlsIn(done, /\.(mp4|mov)$/i)[0];
  if (!url) throw new Error('视频任务完成了，但没有拿到视频地址');
  return download(url, outFile);
}

