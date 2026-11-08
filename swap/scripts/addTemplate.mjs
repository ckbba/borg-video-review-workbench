// Turns a clip into a template folder: prepared source (upright, 24 fps, H.264, trimmed), a cover and a
// template.json to fill in. Usage:
//   npm run swap:template -- <id> <clip> [--start 0] [--end 10] [--cover 0.5] [--title 名称]
// Then edit swap/templates/<id>/template.json: who, frameAt, slot (preset + fill + framePrompt), versions.
// Presets: swap/vendor/alter/references/presets.md.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [id, clip, ...rest] = process.argv.slice(2);
if (!id || !clip || !/^[\w-]+$/.test(id)) { console.error('用法：npm run swap:template -- <id> <clip> [--start s] [--end s] [--cover s] [--title 名称]'); process.exit(1); }
const opt = k => { const i = rest.indexOf('--' + k); return i >= 0 ? rest[i + 1] : undefined; };
const ff = process.env.FFMPEG_BIN || 'ffmpeg', fp = process.env.FFPROBE_BIN || 'ffprobe';
const dir = path.resolve('swap/templates', id);
fs.mkdirSync(dir, { recursive: true });

const span = [...(opt('start') ? ['-ss', opt('start')] : []), ...(opt('end') ? ['-to', opt('end')] : [])];
execFileSync(ff, ['-nostdin', '-v', 'error', '-y', ...span, '-i', clip,
  '-vf', "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))',fps=24,format=yuv420p",
  '-c:v', 'libx264', '-crf', '18', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', path.join(dir, 'source.mp4')]);
execFileSync(ff, ['-nostdin', '-v', 'error', '-y', '-ss', opt('cover') || '0.5', '-i', path.join(dir, 'source.mp4'), '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '3', path.join(dir, 'cover.jpg')]);

const p = JSON.parse(execFileSync(fp, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path.join(dir, 'source.mp4')]).toString());
const v = p.streams.find(s => s.codec_type === 'video'), seconds = Math.round(Number(p.format.duration) * 100) / 100;
const r = v.width / v.height, ratio = r > 2 ? '21:9' : r > 1.5 ? '16:9' : r > 1.1 ? '4:3' : r > 0.9 ? '1:1' : r > 0.7 ? '3:4' : '9:16';
const file = path.join(dir, 'template.json');
if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({
  id, title: opt('title') || id, desc: '一句话说明这条模板', source: 'source.mp4', cover: 'cover.jpg', ratio, seconds,
  who: 'the person, described without the thing that changes', frameAt: Number(opt('cover') || 0.5),
  slot: { id: 'main', label: '商品', hint: '上传一张清楚的商品图', preset: 'product-swap', fill: { object: '', product: 'the product from @image2' },
    framePrompt: 'Photo retouch. Keep the photograph @image1 exactly as it is ... It must look photographed, not pasted on. No text, no letters, no logos.' },
  versions: []
}, null, 2));
console.log(`模板目录：${dir}\n${seconds}s，${v.width}x${v.height}，${ratio}\n下一步：编辑 template.json`);
