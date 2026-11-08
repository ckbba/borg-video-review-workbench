// Rewrites past jobs' costs with our price table (src/pricing.ts). The old figure is kept as `billedByCli`.
//   node swap/scripts/repriceCosts.mjs
// Input-video seconds were not logged: 一键复刻 jobs read them from their segments, other jobs use the output length.
import fs from 'node:fs';
import { imageCost, videoCost } from '../../src/pricing.ts';

let jobs = 0, before = 0, after = 0;
for (const id of fs.readdirSync('swap/data/jobs')) {
  const file = `swap/data/jobs/${id}/job.json`;
  if (!fs.existsSync(file)) continue;
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!j.costs?.length) continue;
  for (const c of j.costs) {
    if (c.model === 'mock' || c.model.startsWith('grok')) continue;
    c.billedByCli ??= c.yuan ?? null;
    before += c.billedByCli || 0;
    const v = /^(\d+) 秒 (\d+p)(?: · (\d+) 张参考图)?/.exec(c.units);
    if (c.note?.startsWith('失败')) { c.yuan = 0; continue; }
    if (v) {
      const seg = j.replica?.segments?.[Number(/第 (\d+)\//.exec(c.step)?.[1] || 1) - 1];
      c.yuan = videoCost(c.model, { size: v[2], outputSec: Number(v[1]), images: Number(v[3] || 0), inputVideoSec: seg ? seg.end - seg.genStart : Number(v[1]), ratio: j.replica ? '9:16' : '16:9' })?.yuan;
    } else c.yuan = imageCost(c.model, Number(/\d+/.exec(c.units)?.[0] || 1))?.yuan;
    after += c.yuan || 0;
  }
  jobs++;
  fs.writeFileSync(file, JSON.stringify(j, null, 1));
}
console.log(`${jobs} 个任务：CLI 合计 ${before.toFixed(2)} 元 → 价目表合计 ${after.toFixed(2)} 元`);
