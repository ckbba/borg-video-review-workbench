import { describe, expect, it } from 'vitest';
import { minimaxH3MaxCost, seedance25Cost } from './pricing';

// expected values are rows read from the 「seedance2.5价格计算器」 Base
describe('Seedance 2.5 price', () => {
  it('480p 16:9 without video input', () => {
    expect(seedance25Cost({ size: '480p', outputSec: 4 })).toMatchObject({ tokens: 38430, yuan: 2.69 });
    expect(seedance25Cost({ size: '480p', outputSec: 5 })).toMatchObject({ tokens: 48037.5, yuan: 3.36 });
  });
  it('with a video input, billed input seconds = max(ceil(out × 2/3), input)', () => {
    expect(seedance25Cost({ size: '480p', outputSec: 5, inputVideoSec: 4 })).toMatchObject({ tokens: 86467.5, yuan: 3.63 });
    expect(seedance25Cost({ size: '480p', outputSec: 4, inputVideoSec: 3 })?.tokens).toBe(67252.5);
    expect(seedance25Cost({ size: '480p', outputSec: 15, inputVideoSec: 10 })?.tokens).toBe(240187.5);
  });
  it('1080p uses 77 / 46', () => {
    expect(seedance25Cost({ size: '1080p', outputSec: 5 })).toMatchObject({ tokens: 243000, yuan: 18.71 });
  });
  it('9:16 costs the same as 16:9', () => {
    expect(seedance25Cost({ size: '720p', ratio: '9:16', outputSec: 4 })?.tokens).toBe(86400);
  });
});

describe('MiniMax H3 Max price', () => {
  it('output per second, first two images free', () => {
    expect(minimaxH3MaxCost({ size: '480p', outputSec: 10, images: 2 })?.yuan).toBe(3.3);
    expect(minimaxH3MaxCost({ size: '768p', outputSec: 6, images: 5 })?.yuan).toBe(4.5);
  });
  it('input video billed at the output tier', () => {
    expect(minimaxH3MaxCost({ size: '480p', outputSec: 5, inputVideoSec: 5 })?.yuan).toBe(3.5);
  });
  it('unsupported size returns null', () => { expect(minimaxH3MaxCost({ size: '720p', outputSec: 5 })).toBeNull(); });
});
