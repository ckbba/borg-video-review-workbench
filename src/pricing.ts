// Seedance 2.5 price, same rules as the 「seedance2.5价格计算器」 Base form (larkoffice share shrcnhVCMxKxcwW1QML5r9u8nvh),
// which follows the official ModelArk pricing:
//   tokens = (billed input video seconds + output seconds) × long × short × fps / 1024
//   billed input seconds = 0 without a video input, otherwise max(ceil(output × 2/3), input video seconds)
//   price  = tokens × unit / 1,000,000; unit (元/百万 token): 480p/720p 70 (no video in) or 42 (video in), 1080p 77 / 46.
// Shared by the server (writes 成本(元)) and the browser (shows the estimate before submitting).
export const SEEDANCE25_UNIT: Record<string, { noVideo: number; withVideo: number }> = {
  '480p': { noVideo: 70, withVideo: 42 }, '720p': { noVideo: 70, withVideo: 42 }, '1080p': { noVideo: 77, withVideo: 46 }
};
// Output pixel size per resolution and aspect ratio — only sizes that appear in the calculator
// (最低token限制 table, and 1920×1080 in the price table). Anything else returns null instead of a guess.
const DIMS: Record<string, Record<string, [number, number]>> = {
  '480p': { '16:9': [854, 480], '4:3': [752, 560], '1:1': [640, 640], '21:9': [992, 432] },
  '720p': { '16:9': [1280, 720], '4:3': [1112, 834], '1:1': [960, 960] },
  '1080p': { '16:9': [1920, 1080] }
};
const norm = (r: string) => ({ '9:16': '16:9', '3:4': '4:3' } as Record<string, string>)[r] || r;

export function seedance25Cost(x: { size: string; ratio?: string; outputSec: number; inputVideoSec?: number; fps?: number }) {
  const size = x.size.toLowerCase(), unit = SEEDANCE25_UNIT[size];
  const dims = DIMS[size]?.[norm(x.ratio || '16:9')];
  if (!unit || !dims) return null;
  const inVid = x.inputVideoSec || 0;
  const billedIn = inVid > 0 ? Math.max(Math.ceil(x.outputSec * 2 / 3), inVid) : 0;
  const tokens = (billedIn + x.outputSec) * dims[0] * dims[1] * (x.fps || 24) / 1024;
  const price = tokens * (inVid > 0 ? unit.withVideo : unit.noVideo) / 1e6;
  return { tokens: Math.round(tokens * 10) / 10, yuan: Math.round(price * 100) / 100, perSec: Math.round(price / x.outputSec * 1000) / 1000 };
}

// MiniMax H3 Max (480p / 768p only), per-second pricing:
//   images: first 2 free, then 0.5 元 each; input video 480p 0.37 / 768p 0.97 元/s (tier follows the output);
//   output 480p 0.33 / 768p 0.50 元/s.
export const MINIMAX_H3MAX = { freeImages: 2, perImage: 0.5, inVideo: { '480p': 0.37, '768p': 0.97 }, out: { '480p': 0.33, '768p': 0.5 } } as const;
export function minimaxH3MaxCost(x: { size: string; outputSec: number; images?: number; inputVideoSec?: number }) {
  const size = x.size.toLowerCase() as '480p' | '768p';
  if (!(size in MINIMAX_H3MAX.out)) return null;
  const yuan = Math.max(0, (x.images || 0) - MINIMAX_H3MAX.freeImages) * MINIMAX_H3MAX.perImage
    + (x.inputVideoSec || 0) * MINIMAX_H3MAX.inVideo[size] + x.outputSec * MINIMAX_H3MAX.out[size];
  return { yuan: Math.round(yuan * 100) / 100, perSec: Math.round(yuan / x.outputSec * 1000) / 1000 };
}

// Image generation: our own rate, 0.1 元 per image for the image-2 family. Other models have no agreed price: null.
export function imageCost(model: string, count: number) {
  return /^image-2(\.|-|$)/.test(model) ? { yuan: Math.round(count * 0.1 * 100) / 100 } : null;
}

// One entry point for whichever model a generation used.
export function videoCost(model: string, x: { size: string; outputSec: number; images?: number; inputVideoSec?: number; ratio?: string }) {
  if (model === 'seedance-2.5') return seedance25Cost(x);
  if (model === 'minimax-h3-max') return minimaxH3MaxCost(x);
  return null;
}
