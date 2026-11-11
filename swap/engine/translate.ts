// Chinese readings of the English prompts, for the 链路复盘 page only. The models still get the English
// (ALTER's presets were tuned in English). Cached on disk so each prompt is translated once.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ask, text } from '../../server/llm';
import { DATA } from './pipeline';

const FILE = path.join(DATA, 'translations.json');
let cache: Record<string, string> | undefined;
/** The page asks for every prompt at once; the model's account refuses too many at a time (11 Nov: "concurrency limit
 *  exceeded" on segment 2). So one runs at a time, the same prompt is asked once, and a refusal waits and tries again. */
const pending = new Map<string, Promise<string>>();
let queue: Promise<unknown> = Promise.resolve();
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const busy = (e: any) => /concurren|too many|rate limit|429|overload/i.test(String(e?.message || e));

async function translate(en: string) {
  for (let k = 0; ; k++) {
    try {
      return (await ask([text(en)],
        '把这段给 AI 图片/视频模型的英文指令翻译成通顺的中文，给不懂英文的产品经理看。@image1、@video1、@图片1 这类引用原样保留。只输出译文。', 1)).trim();
    } catch (e) { if (k >= 4 || !busy(e)) throw e; await wait(1500 * 2 ** k); }
  }
}

export async function toChinese(en: string): Promise<string> {
  cache ??= fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
  const key = crypto.createHash('sha1').update(en).digest('hex');
  if (cache![key]) return cache![key];
  if (!pending.has(key)) {
    const job = queue.then(() => translate(en)).then(zh => {
      cache![key] = zh;
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(cache, null, 1));
      return zh;
    }).finally(() => pending.delete(key));
    queue = job.catch(() => undefined);
    pending.set(key, job);
  }
  return pending.get(key)!;
}
