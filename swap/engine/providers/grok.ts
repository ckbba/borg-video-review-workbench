// Grok Imagine video edit through the 65535 gateway's async task API (/v1/tasks, operation "edit").
// Edit keeps the source's length, ratio and resolution (max 720p) and accepts sources up to 8.7 s; reference
// images go in as <IMAGE_n>. No audio reference: the pipeline puts the source sound back anyway.
// Billing: the task's `cost_usd` is actually yuan on this gateway (按元计费，非美元). A moderation refusal costs ¥0.02.
// Tested 4 Nov: a 3 s 480p clip with one reference image, done in ~47 s, ¥0.42; a real face passed.
import fs from 'node:fs';
import path from 'node:path';
import { FFMPEG, run } from '../../../server/shots';
import type { VideoEditor } from '../types';

const BASE = process.env.S65535_BASE_URL || 'https://task-api-1-cn.65535.space';
const MODEL = process.env.SWAP_GROK_VIDEO_MODEL || 'grok-imagine-video';
const MAX_REFS = 7;

function key() {
  const k = process.env.S65535_API_KEY;
  if (!k) throw new Error('没有配置 S65535_API_KEY（写在项目根目录 .env.local）');
  return k;
}

async function api(method: string, p: string, body?: any) {
  const r = await fetch(BASE + p, { method, headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || d.message || `HTTP ${r.status}`);
  return d;
}

const dataUri = (file: string, mime: string) => `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
const imageMime = (f: string) => /\.png$/i.test(f) ? 'image/png' : /\.webp$/i.test(f) ? 'image/webp' : 'image/jpeg';

function explain(code: string, msg: string) {
  if (/moderat|sensitive|safety|policy/i.test(code + msg)) return `没有通过 Grok 的内容审核（扣 ¥0.02）。（${msg || code}）`;
  return msg || code || '任务失败';
}

export const grokVideo: VideoEditor = {
  name: `65535 ${MODEL}`,
  minSeconds: 2,
  maxSeconds: 8, // edit input is capped at 8.7 s
  bindRefs: p => p.replace(/@image(\d+)/g, '<IMAGE_$1>'),
  async edit({ prompt, source, images, audio, ratio, outFile, log, bill }) {
    if (audio) audio.dropped = true;
    // Output inherits the source resolution, capped at 720p: send 720p so the request stays small.
    const portrait = ratio === '9:16' || ratio === '3:4';
    const small = path.join(path.dirname(outFile), path.basename(outFile, '.mp4') + '-in.mp4');
    await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-i', source, '-vf', portrait ? "scale='min(720,iw)':-2" : "scale=-2:'min(720,ih)'",
      '-an', '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', small]);
    const refs = images.slice(0, MAX_REFS);
    const input: any = { prompt, video: { url: dataUri(small, 'video/mp4') } };
    if (refs.length) { input.input_mode = 'reference'; input.reference_image_urls = refs.map(f => dataUri(f, imageMime(f))); }
    const d = await api('POST', '/v1/tasks', { kind: 'video', model: MODEL, operation: 'edit', input });
    if (!d.id) throw new Error('提交失败：没有返回任务 ID');
    log(`已提交视频任务 ${d.id}`);
    const units = `编辑 ${refs.length ? `· ${refs.length} 张参考图` : ''}`.trim();
    for (let i = 0; i < 30 * 12; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const t = await api('GET', `/v1/tasks/${d.id}`).catch(e => ({ status: 'poll-error', error_message: e.message }));
      if (t.status === 'done') {
        bill?.({ model: MODEL, units: `${t.seconds ?? '?'} 秒 ${units}`.trim(), taskId: d.id, yuan: t.cost_usd });
        const url = t.video_url || t.result_urls?.[0];
        if (!url) throw new Error('视频任务完成了，但没有拿到视频地址');
        const r = await fetch(url);
        if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`);
        fs.writeFileSync(outFile, Buffer.from(await r.arrayBuffer()));
        return outFile;
      }
      if (t.status === 'failed') {
        const msg = explain(t.error_code || '', t.error_message || '');
        bill?.({ model: MODEL, units, taskId: d.id, yuan: t.cost_usd, note: `失败：${msg.slice(0, 40)}` });
        throw new Error(msg);
      }
      if (i % 6 === 0) log(`生成中…（${t.status}${t.progress ? ` ${t.progress}%` : ''}）`);
    }
    throw new Error('等待超过 30 分钟');
  }
};
