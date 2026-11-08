// Picks one implementation per part. Add a vendor: write providers/<name>.ts, register it in the tables below.
//   SWAP_PROVIDER=mock|borg      default for image + video (mock costs nothing)
//   SWAP_VIDEO=grok              Grok Imagine video edit via 65535 (needs S65535_API_KEY); images stay on borg
//   SWAP_IMAGE / SWAP_VIDEO      override one part, e.g. SWAP_IMAGE=borg SWAP_VIDEO=mock
//   SWAP_GUARD=none|llm          face screening (llm needs the workbench's model key)
//   SWAP_CHECK=auto|alter|basic  auto = ALTER's checker when its Python is ready
import { borgImage, borgVideo } from './providers/borg';
import { alterCheck, basicCheck, pythonReady } from './providers/checkers';
import { grokVideo } from './providers/grok';
import { llmGuard } from './providers/llmGuard';
import { mockGuard, mockImage, mockVideo } from './providers/mock';
import type { Checker, Guard, ImageEditor, VideoEditor } from './types';

const IMAGE: Record<string, ImageEditor> = { mock: mockImage, borg: borgImage };
const VIDEO: Record<string, VideoEditor> = { mock: mockVideo, borg: borgVideo, grok: grokVideo };
const GUARD: Record<string, Guard> = { none: mockGuard, llm: llmGuard };

export type Providers = { image: ImageEditor; video: VideoEditor; guard: Guard; checker: Checker };

function pick<T>(table: Record<string, T>, key: string, part: string): T {
  const x = table[key];
  if (!x) throw new Error(`${part} 没有 "${key}"，可选：${Object.keys(table).join(' / ')}`);
  return x;
}

let cached: Promise<Providers> | undefined;
export function providers(env = process.env): Promise<Providers> {
  return cached ??= (async () => {
    const base = env.SWAP_PROVIDER || 'mock';
    const check = env.SWAP_CHECK || 'auto';
    return {
      image: pick(IMAGE, env.SWAP_IMAGE || base, '预览图'),
      video: pick(VIDEO, env.SWAP_VIDEO || base, '视频编辑'),
      guard: pick(GUARD, env.SWAP_GUARD || (base === 'mock' ? 'none' : 'llm'), '素材检查'),
      checker: check === 'basic' ? basicCheck : check === 'alter' || await pythonReady() ? alterCheck : basicCheck
    };
  })();
}
