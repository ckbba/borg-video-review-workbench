// 素材员: a small agent that looks online for pictures of what the user's uploads lack.
//
// The model decides what to search and which picture will do; this file does the rest and holds the limits. It has
// no way to spend generation money and nothing it finds is used until the user says yes on 开始前确认.
// Screen operations are not given to it at all: those must come from the user, never from a stranger's screenshot.
// If it fails, the job simply goes on and the page asks the user, as it did before.
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { image, respond, text } from '../../server/llm';
import { frameAt } from './media';
import type { Gap, ScoutStep, WebPic } from './types';

// 6 Nov, Firefly: low effort and a 2.5 min cap were quicker but missed the cabin one run in three, and its pictures were
// weaker. So it searches properly again, in the background: the confirm page opens at once and pictures appear as found.
export const SCOUT = { rounds: 8, views: 16, seconds: 360, bytes: 12 * 1024 * 1024, width: 1280 };
/** Only parts the user is unlikely to have (a car's cabin): another angle they can simply upload, a screen only they can film. */
export const searchable = (g: Gap) => g.kind === 'part';

const RULES = `你是视频复刻的素材员。用户要把原片里的东西换成自己的商品，但用户的图缺了一些部位或角度。你的任务是联网找到这些部位的真实图片。

做法：
1. 用 web_search 搜索，优先汽车之家、太平洋汽车这类图库和品牌官网，搜索词要带具体型号。
2. 从搜索结果里拿到图片文件直链，调用 view_images 下载来看。每次给满 4 张，减少来回。
3. 亲眼看过之后，符合要求的调用 accept_image，每个缺口最多选 1 张。
4. 选到就立刻 accept_image；所有缺口都选好就马上 finish，不要再找更好的。找不到的缺口不用选，finish 时写明原因，用户会自己补。

选图标准：
- 必须是同一型号。看不出是不是同款，就算没找到；相近车型、同品牌其他型号都不能用。
- 用户的图如果认不出具体型号，又没有商品名，就不要猜，直接 finish。
- 优先实拍，能看清结构，尽量接近原片这一帧的机位。
- 不要带大水印、拼图、文字海报、AI 生成图和渲染得看不清结构的图。
- 配色不一样可以用，只看形状和结构，并在理由里写明。
- 只选你亲眼看过的图，不要凭网页描述判断。

每看完一批图，用一两句中文说清每张为什么要或不要，这些话会给用户复盘。`;

const TOOLS = [
  { type: 'web_search' },
  { type: 'function', name: 'view_images', description: '下载图片直链并查看，返回每张图的编号。',
    parameters: { type: 'object', properties: { images: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, page: { type: 'string', description: '图片所在网页' } }, required: ['url'] } } }, required: ['images'] } },
  { type: 'function', name: 'accept_image', description: '给一个缺口选定一张看过的图。',
    parameters: { type: 'object', properties: { gap: { type: 'integer', description: '缺口编号' }, id: { type: 'string', description: '图片编号' }, why: { type: 'string', description: '中文一句话：为什么是同款，能看到什么' } }, required: ['gap', 'id', 'why'] } },
  { type: 'function', name: 'finish', description: '结束。', parameters: { type: 'object', properties: { note: { type: 'string', description: '中文：没找到的缺口及原因' } }, required: ['note'] } }
];

/** Only public web addresses: a page could otherwise point the server at itself or the local network. */
export function privateIp(ip: string) {
  const a = ip.replace(/^::ffff:/i, '');
  if (net.isIPv4(a)) { const [x, y] = a.split('.').map(Number); return x === 0 || x === 10 || x === 127 || (x === 100 && y >= 64 && y < 128) || (x === 169 && y === 254) || (x === 172 && y >= 16 && y < 32) || (x === 192 && y === 168) || x >= 224; }
  const low = a.toLowerCase();
  return low === '::1' || low === '::' || /^f[cd]/.test(low) || /^fe[89ab]/.test(low);
}
async function publicUrl(raw: string) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('只能下载网页图片');
  const ips = net.isIP(u.hostname) ? [u.hostname] : (await dns.lookup(u.hostname, { all: true })).map(x => x.address);
  if (!ips.length || ips.some(privateIp)) throw new Error('这个地址不是公网');
  return u;
}

export async function download(raw: string, file: string, page?: string) {
  let at = raw;
  for (let hop = 0; hop < 4; hop++) {
    const u = await publicUrl(at);
    const r = await fetch(u, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0', ...(page ? { Referer: page } : {}) }, signal: AbortSignal.timeout(30_000) });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { at = new URL(r.headers.get('location')!, u).href; continue; }
    if (!r.ok) throw new Error(`下载失败 ${r.status}`);
    if (!(r.headers.get('content-type') || '').startsWith('image/')) throw new Error('不是图片');
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length > SCOUT.bytes) throw new Error('图片太大');
    const raw2 = file + '.src'; fs.writeFileSync(raw2, b);
    return frameAt(raw2, 0, file, SCOUT.width); // re-encoding also proves it is a picture
  }
  throw new Error('跳转太多');
}

export type ScoutInput = { subject: string; name?: string; prompt?: string; notes?: string[]; uploads: string[]; gaps: Gap[]; known?: WebPic[]; dir: string; log: (s: string) => void;
  /** Called after every round, so a run cut short still leaves its record. */ onStep?: (steps: ScoutStep[]) => void;
  /** Called the moment a picture is chosen, so the page can show it while the search goes on. */ onFound?: (gap: number, pic: WebPic) => void;
  /** True once the user has moved on: no further rounds, and nothing from this run may be used. */ stop?: () => boolean;
  /** Tests stand in for the model and the network here. */ call?: typeof respond; fetchImage?: typeof download };
export type ScoutResult = { found: Record<number, WebPic>; rounds: number; viewed: number; stopped: string; steps: ScoutStep[] };

/** `gaps` keep their index in the plan, so the answer can be put back; only searchable ones are passed in the prompt. */
export async function scout(x: ScoutInput): Promise<ScoutResult> {
  const call = x.call || respond, fetchImage = x.fetchImage || download;
  const open = x.gaps.map((g, i) => ({ g, i })).filter(({ g }) => searchable(g));
  const out: ScoutResult = { found: {}, rounds: 0, viewed: 0, stopped: '没有要找的', steps: [] };
  if (!open.length) return out;
  fs.mkdirSync(x.dir, { recursive: true });
  const seen = new Map<string, WebPic>((x.known || []).map((k, i) => [`lib${i + 1}`, k]));
  const started = Date.now();
  const input: any[] = [{ role: 'user', content: [
    text(`用户的商品：${x.name || '（没写名字，看图判断）'}\n描述：${x.subject}${x.prompt ? `\n用户说明：${x.prompt}` : ''}${x.notes?.length ? `\n已知要点：\n${x.notes.map(n => '- ' + n).join('\n')}` : ''}\n下面先是用户的图。`),
    ...x.uploads.slice(0, 4).map(image),
    ...open.flatMap(({ g, i }) => [text(`缺口 ${i}：${g.label}（${g.view}）。这是原片里需要它的一帧：`), ...(g.frame ? [image(g.frame)] : [])]),
    ...(seen.size ? [text(`商品库里已有这些以前找到的图，合适就直接 accept_image，不用再搜：`), ...[...seen].flatMap(([id, k]) => [text(`${id}：${k.label || ''}`), image(k.file)])] : [])
  ] }];
  for (;;) {
    if (x.stop?.()) { out.stopped = '用户已开始生成，不再找'; break; }
    if (out.rounds >= SCOUT.rounds) { out.stopped = `到了 ${SCOUT.rounds} 轮上限`; break; }
    if (Date.now() - started > SCOUT.seconds * 1000) { out.stopped = '到了时间上限'; break; }
    out.rounds++;
    const items = await call({ instructions: RULES, input, tools: TOOLS });
    if (x.stop?.()) { out.stopped = '用户已开始生成，不再找'; break; }
    const calls = items.filter(o => o.type === 'function_call');
    const step: ScoutStep = { round: out.rounds, seconds: Math.round((Date.now() - started) / 1000), pics: [], picks: [],
      searches: items.filter(o => o.type === 'web_search_call').flatMap(o => o.action?.queries || (o.action?.query ? [o.action.query] : [])),
      said: items.filter(o => o.type === 'message').flatMap(o => o.content || []).map((c: any) => c.text || '').join(' ').trim() };
    out.steps.push(step);
    if (!calls.length) { out.stopped = '模型结束'; x.onStep?.(out.steps); break; }
    const shown: any[] = [];
    let done = false;
    for (const c of calls) {
      input.push({ type: 'function_call', call_id: c.call_id, name: c.name, arguments: c.arguments });
      let a: any = {}, result: string;
      try { a = JSON.parse(c.arguments || '{}'); } catch { /* answered below */ }
      if (c.name === 'view_images') {
        const lines = await Promise.all((a.images || []).slice(0, 4).map(async (im: any) => {
          if (out.viewed >= SCOUT.views) return `${im.url}：看图次数用完了`;
          const n = ++out.viewed, id = `web${n}`, file = path.join(x.dir, `${id}.jpg`);
          try {
            await fetchImage(String(im.url), file, im.page);
            seen.set(id, { file, url: String(im.url), page: im.page });
            shown.push(text(`图 ${id}：`), image(file));
            step.pics.push({ id, file, url: String(im.url), page: im.page });
            return `${id}：下载成功`;
          } catch (e: any) { step.pics.push({ id, url: String(im.url), page: im.page, error: e.message }); return `${im.url}：${e.message}`; }
        }));
        result = lines.join('\n') || '没有图片';
        x.log(`素材员看了 ${out.viewed} 张图`);
      } else if (c.name === 'accept_image') {
        const pic = seen.get(String(a.id)), gap = Number(a.gap);
        if (!pic) result = '这个编号没看过，先 view_images';
        else if (!open.some(o => o.i === gap)) result = '没有这个缺口';
        else { out.found[gap] = { ...pic, why: String(a.why || ''), label: x.gaps[gap].label }; x.onFound?.(gap, out.found[gap]); result = '已选定'; x.log(`素材员找到了${x.gaps[gap].label}`); }
        step.picks.push({ gap: x.gaps[gap]?.label || String(a.gap), id: String(a.id), why: String(a.why || ''), refused: result === '已选定' ? undefined : result });
      } else if (c.name === 'finish') { done = true; out.stopped = String(a.note || '完成'); result = '好'; step.finish = out.stopped; }
      else result = '没有这个工具';
      input.push({ type: 'function_call_output', call_id: c.call_id, output: result });
    }
    if (shown.length) input.push({ role: 'user', content: [text('下载到的图：'), ...shown] });
    x.onStep?.(out.steps);
    if (done) break;
  }
  return out;
}
