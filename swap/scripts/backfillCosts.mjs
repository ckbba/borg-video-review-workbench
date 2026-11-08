// Adds a cost breakdown to jobs made before costs were recorded, from the video task ids in their log.
// Image calls of those jobs were not logged with task ids, so they are listed as unknown.
//   node swap/scripts/backfillCosts.mjs <jobId> [...]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const out = execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['-y', '@borgrise/cli@4.0.5', 'asset', 'list', '--page', '0', '--size', '100'], { maxBuffer: 64 << 20, shell: true }).toString();
const assets = []; const walk = v => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { if (v.taskId && v.cost != null) assets.push(v); else Object.values(v).forEach(walk); } };
walk(JSON.parse(out.slice(out.indexOf('{'))));
for (const id of process.argv.slice(2)) {
  const file = `swap/data/jobs/${id}/job.json`, j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (j.costs?.length) { console.log(id, '已有费用记录，跳过'); continue; }
  const costs = [{ step: '预览图', model: j.framing?.model?.replace('博观 ', '') || '?', units: `${j.frames.length} 张`, note: '补录：没有任务号', at: j.created }];
  for (const line of j.log) {
    const m = /^(\S+) (.+?)：(?:(第 \d+\/\d+ 段)：)?已提交视频任务 ([\w-]+)/.exec(line);
    if (!m) continue;
    const a = assets.filter(x => x.taskId === m[4]);
    costs.push({ step: `${m[2]}${m[3] ? ' · ' + m[3] : ''} · 视频`, model: a[0]?.model || '?', units: a[0] ? `${a[0].inputParams?.duration} 秒 ${a[0].inputParams?.size}` : '—',
      taskId: m[4], yuan: a.length ? a.reduce((s, x) => s + Number(x.cost), 0) : undefined, note: a.length ? undefined : '没有产出（失败或被拦截）', at: j.created });
  }
  j.costs = costs; fs.writeFileSync(file, JSON.stringify(j, null, 1));
  console.log(id, costs.map(c => `${c.step} ${c.yuan ?? '?'}`).join(' | '));
}
