// Offline stand-ins: free, fast, deterministic. They run the whole pipeline and UI without a vendor account.
// The "edit" overlays the user's image in a corner and shifts the colour, so a result is visibly different.
import path from 'node:path';
import { FFMPEG, run } from '../../../server/shots';
import type { Guard, ImageEditor, VideoEditor } from '../types';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const SPEED = Number(process.env.SWAP_MOCK_DELAY_MS ?? 1500);

export const mockGuard: Guard = { name: '模拟检查', inspect: async () => ({ ok: true, face: 'unknown' }) };

export const mockImage: ImageEditor = {
  name: '模拟预览图',
  async targetFrames({ refs, count, outDir, log, bill }) {
    bill?.({ model: 'mock', units: `${count} 张`, yuan: 0 });
    const [frame, user] = refs;
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      log(`模拟生成预览图 ${i + 1}/${count}`);
      await sleep(SPEED);
      const file = path.join(outDir, `frame-${i + 1}.jpg`);
      await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-i', frame, ...(user ? ['-i', user] : []), '-filter_complex',
        user ? `[1:v]scale=-2:ih*0.4[u];[0:v]hue=h=${40 + i * 60}:s=1.2[b];[u][b]scale2ref=w=oh*mdar:h=main_h*0.35[u2][b2];[b2][u2]overlay=W-w-24:H-h-24` : `hue=h=${40 + i * 60}`,
        '-frames:v', '1', '-q:v', '2', file]);
      out.push(file);
    }
    return out;
  }
};

export const mockVideo: VideoEditor = {
  name: '模拟视频编辑',
  // Short on purpose, so the demo exercises segmenting.
  minSeconds: 2,
  maxSeconds: Number(process.env.SWAP_MOCK_MAX_SECONDS || 8),
  async edit({ source, images, duration, outFile, log, bill }) {
    bill?.({ model: 'mock', units: `${duration} 秒`, yuan: 0 });
    log('模拟视频编辑…');
    await sleep(SPEED * 2);
    // With a target frame: overlay it. Without (a prompt-only version): just shift the colour.
    const fx = images[0] ? ['-i', images[0], '-filter_complex', '[0:v]hue=h=50:s=1.15[b];[1:v][b]scale2ref=w=oh*mdar:h=main_h*0.28[u][b2];[b2][u]overlay=W-w-20:20']
      : ['-vf', 'hue=h=200:s=0.6,eq=contrast=1.3'];
    await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-i', source, ...fx, '-an', '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast', outFile]);
    return outFile;
  }
};
