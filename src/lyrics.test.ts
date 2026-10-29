import { describe, expect, it } from 'vitest';
import { parseTimedPrompt, passageAtTime } from './lyrics';

describe('immersive prompt lyrics', () => {
  it('parses all timed lines with a segment offset', () => {
    const rows=parseTimedPrompt('0.0-1.0秒：开场\n1.0秒硬切。1.0-2.6秒：追逐',30,'seg2');
    expect(rows.map(x=>[x.start,x.end,x.text])).toEqual([[30,31,'开场'],[31,32.6,'追逐']]);
  });
  it('selects the active lyric by global playback time',()=>{
    const rows=parseTimedPrompt('0-2秒：A\n2-4秒：B',60,'seg3');
    expect(passageAtTime(rows,63)?.text).toBe('B');
  });
});
