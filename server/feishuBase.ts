// Vite dev-server middleware that reads/writes the Feishu Base through the locally logged-in lark-cli.
// The browser never sees Feishu credentials; attachments are downloaded once into .cache/media and served with Range support.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { videoCost } from '../src/pricing';
import { llmLabel, LLM } from './llm';
import { DRAFT_RULES_R1, draftPrompt, submitVideo, VIDEO_MODELS, waitVideo } from './recreate';
import { analyseVideo, DEFAULT_PROMPT, duration, FFMPEG, frameAt, OPTIONS, pick, PromptCfg, reviseShot, run, TEXT_FIELDS } from './shots';

export const BASE_TOKEN = process.env.REPRO_BASE_TOKEN || 'XA84bEbEOaHwe7sK0gpcfmpQn25';
const T = { case: '案例', shot: '原片镜头', gen: '生成记录', note: '复盘备注', asset: '资产', prompt: '拆解提示词', rprompt: '复刻提示词', model: '模型' };
let CACHE = path.resolve('.cache/media'); // re-rooted to the Vite project root in configureServer
const NPM = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm/node_modules/@larksuite/cli/bin/lark-cli.exe') : '';
const BIN = process.env.LARK_CLI_BIN || (NPM && fs.existsSync(NPM) ? NPM : 'lark-cli');

function lark(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(BIN, ['base', ...args, '--as', 'user', '--base-token', BASE_TOKEN], {
      maxBuffer: 64 * 1024 * 1024, cwd: CACHE,
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }
    }, (err, stdout, stderr) => {
      let out: any;
      try { out = JSON.parse(stdout.slice(stdout.indexOf('{'))); } catch { return reject(new Error((stderr || stdout || String(err)).slice(0, 500))); }
      if (!out.ok) return reject(new Error(out.error?.message || 'lark-cli failed'));
      resolve(out.data);
    });
  });
}

// record-list returns {fields, data:[[...]], record_id_list}; turn it into [{_id, ...fields}]
async function listAll(table: string) {
  const rows: any[] = [];
  for (let offset = 0; ; offset += 200) {
    const d = await lark(['+record-list', '--table-id', table, '--limit', '200', '--offset', String(offset), '--format', 'json']);
    d.data.forEach((r: any[], i: number) => rows.push(Object.fromEntries([['_id', d.record_id_list[i]], ...d.fields.map((f: string, j: number) => [f, r[j]])])));
    if (d.data.length < 200) return rows;
  }
}

const ids = (v: any) => (Array.isArray(v) ? v.map((x: any) => x.id) : []);
const one = (v: any) => (Array.isArray(v) ? v[0] : v) ?? null;
const att = (table: string, rec: string, v: any) => (Array.isArray(v) && v[0] ? { url: `/api/base/media/${encodeURIComponent(table)}/${rec}/${v[0].file_token}`, name: v[0].name, token: v[0].file_token } : null);
const recId = (d: any) => JSON.stringify(d).match(/rec[A-Za-z0-9]{10,}/)?.[0];
// lark-cli only reads files relative to its cwd, so stage them inside the cache directory
const rel = (file: string) => { const r = path.relative(CACHE, file); return r.startsWith('..') ? null : './' + r.split(path.sep).join('/'); };
async function upload(table: string, record: string, field: string, file: string) {
  let r = rel(file);
  if (!r) { const tmp = path.join(CACHE, 'tmp', path.basename(file)); fs.mkdirSync(path.dirname(tmp), { recursive: true }); fs.copyFileSync(file, tmp); r = rel(tmp)!; }
  return lark(['+record-upload-attachment', '--table-id', table, '--record-id', record, '--field-id', field, '--file', r]);
}

export const DIMS = ['人工-商品一致性', '人工-动作道具', '人工-角色一致性', '人工-镜头结构', '人工-运镜构图', '人工-画面质量'];
const scoresOf = (g: any) => ({ dims: Object.fromEntries(DIMS.map(k => [k, g[k] ?? null])), veto: g['一票否决'] || [], tags: g['问题标签'] || [], total: g['人工总分'] || '', verdict: g['判定'] || '' });

async function fieldMeta(table: string) {
  const d = await lark(['+field-list', '--table-id', table]);
  return Object.fromEntries(d.fields.map((x: any) => [x.name, x]));
}
// Scoring rubric comes from the Base itself (field descriptions and select options), so editing it there updates the panel.
async function scoreMeta() {
  const [g, s] = await Promise.all([fieldMeta(T.gen), fieldMeta(T.shot)]);
  return {
    dims: DIMS.map(k => ({ key: k, label: k.replace('人工-', ''), hint: g[k]?.description || '' })),
    veto: (g['一票否决']?.options || []).map((o: any) => o.name), tags: (g['问题标签']?.options || []).map((o: any) => o.name),
    shotIssues: (s['分析问题']?.options || []).map((o: any) => o.name), shotRatingHint: s['分析评分']?.description || '',
    noteTypes: ((await fieldMeta(T.note))['问题类型']?.options || []).map((o: any) => o.name)
  };
}

const shotOut = (s: any) => ({
  id: s._id, code: s['镜头编号'], start: s['开始(秒)'], end: s['结束(秒)'],
  text: [s['景别'] && one(s['景别']), s['视角'] && one(s['视角']), s['机位与运镜'], s['主体动作'], s['道具/商品状态'], s['画面内可见'] && `画面内：${s['画面内可见']}`].filter(Boolean).join('｜') || s['原片描述'] || '',
  verified: one(s['人工核对']),
  fields: Object.fromEntries([...TEXT_FIELDS.map(k => [k, s[k] || '']), ['景别', one(s['景别']) || ''], ['视角', one(s['视角']) || ''], ['边界类型', one(s['边界类型']) || ''], ['难度标签', s['难度标签'] || []], ['可替换槽位', s['可替换槽位'] || []]]),
  rating: s['分析评分'] ?? null, issues: s['分析问题'] || [], source: one(s['分析来源']) || '', remark: s['备注'] || '',
  keyframe: att(T.shot, s._id, s['核对关键帧']), promptId: one(ids(s['拆解版本'])), sampling: s['抽帧说明'] || '',
  // value of each field before its first edit, so the panel can offer a one-click reset
  original: (() => { try { return JSON.parse(s['初始分析'] || '{}'); } catch { return {}; } })()
});

export async function loadCase(caseId?: string) {
  const [cases, shots, gens, notes, meta, prompts] = await Promise.all([listAll(T.case), listAll(T.shot), listAll(T.gen), listAll(T.note), scoreMeta(), listAll(T.prompt)]);
  const named = cases.filter(x => x['案例名']);
  const c = caseId ? cases.find(x => x._id === caseId) : named[0];
  if (!c) throw new Error('多维表格里没有案例');
  const inCase = (r: any) => ids(r['所属案例']).includes(c._id);
  return {
    cases: named.map(x => ({ id: x._id, name: x['案例名'] })),
    case: { id: c._id, name: c['案例名'], duration: c['原片时长(秒)'], source: att(T.case, c._id, c['原片视频']), status: one(c['状态']) || '' },
    shots: shots.filter(inCase).sort((a, b) => a['开始(秒)'] - b['开始(秒)']).map(shotOut),
    gens: gens.filter(g => inCase(g) && g['生成视频']?.length).map(g => ({
      id: g._id, label: g['段落'] || g['生成编号'], version: one(g['版本']) || '未分版本', adopted: !!g['是否采用'],
      shotIds: ids(g['关联镜头']), assetIds: ids(g['引用资产']), prompt: g['复刻提示词'] || '', video: att(T.gen, g._id, g['生成视频']),
      score: g['人工总分'] || '', verdict: g['判定'] || '', scores: scoresOf(g)
    })),
    scoreMeta: meta, prompts: Object.fromEntries(prompts.filter(p => p['版本']).map(p => [p._id, p['版本']])),
    notes: notes.filter(inCase).map(n => ({
      id: n._id, localId: n['本地ID'] || '', at: n['时间点(秒)'], start: n['开始(秒)'], end: n['结束(秒)'],
      body: n['备注'] || '', keep: n['保留什么'] || '', change: n['修改什么'] || '',
      genId: one(ids(n['生成记录'])), shotIds: ids(n['原片镜头']), stage: one(n['阶段']) || '', quote: n['引用原文'] || '', types: n['问题类型'] || [], status: one(n['处理状态']) || '待处理', mark: n['画面标记'] ? (() => { try { return JSON.parse(n['画面标记'] || '{}'); } catch { return {}; } })() : null, target: n['观看对象'] || '', createdAt: n['创建时间'] || ''
    }))
  };
}

async function listCases() {
  const [cases, shots, gens] = await Promise.all([listAll(T.case), listAll(T.shot), listAll(T.gen)]);
  return cases.filter(c => c['案例名']).map(c => {
    const mine = shots.filter(s => ids(s['所属案例']).includes(c._id));
    const first = mine.sort((a, b) => a['开始(秒)'] - b['开始(秒)']).find(s => s['核对关键帧']?.length);
    return {
      id: c._id, name: c['案例名'], duration: c['原片时长(秒)'] || 0, status: one(c['状态']) || '', category: one(c['商品类目']) || '', type: one(c['视频类型']) || '',
      shots: mine.length, verified: mine.filter(s => one(s['人工核对']) === '已核对').length,
      gens: gens.filter(g => ids(g['所属案例']).includes(c._id)).length, cost: c['累计成本(元)'] || '',
      thumb: first ? att(T.shot, first._id, first['核对关键帧']) : null, hasSource: !!c['原片视频']?.length
    };
  });
}


// One generation record with everything needed to audit it: full prompt, referenced assets in @图片N order, linked shots.
// The 引用资产 link keeps submission order, so assets[i] is @图片{i+1} in the prompt.
const genBrief = (g: any, shotBy: Map<string, any>, assetBy: Map<string, any>) => ({
  id: g._id, label: g['段落'] || g['生成编号'], version: one(g['版本']) || '', status: one(g['任务状态']) || '', adopted: !!g['是否采用'],
  caseId: one(ids(g['所属案例'])), hasVideo: !!g['生成视频']?.length,
  shots: ids(g['关联镜头']).map(id => shotBy.get(id)?.['镜头编号']).filter(Boolean),
  assetNames: ids(g['引用资产']).map(id => assetBy.get(id)?.['资产名']).filter(Boolean)
});
async function genIndex() {
  const [gens, shots, assets, cases] = await Promise.all([listAll(T.gen), listAll(T.shot), listAll(T.asset), listAll(T.case)]);
  return { gens, cases, shotBy: new Map(shots.map(s => [s._id, s])), assetBy: new Map(assets.map(a => [a._id, a])) };
}
async function listGens() {
  const { gens, shotBy, assetBy } = await genIndex();
  return gens.filter(g => g['段落'] || g['复刻提示词']).map(g => genBrief(g, shotBy, assetBy));
}
async function getGen(id: string) {
  const { gens, cases, shotBy, assetBy } = await genIndex();
  const g = gens.find(x => x._id === id);
  const c = cases.find(x => x._id === one(ids(g?.['所属案例'])));
  if (!g) throw new Error('找不到这条生成记录');
  return {
    ...genBrief(g, shotBy, assetBy),
    prompt: g['复刻提示词'] || '', mode: one(g['生成模式']) || '', taskId: g['任务ID'] || '', fail: g['失败原因'] || '',
    cost: g['成本(元)'] ?? '', seconds: g['生成时长(秒)'] ?? '', source: one(g['提示词来源']) || '', tool: one(g['生成工具']) || '', remark: g['备注'] || '',
    video: att(T.gen, g._id, g['生成视频']), sourceVideo: c ? att(T.case, c._id, c['原片视频']) : null,
    tags: g['问题标签'] || [], score: g['人工总分'] || '', verdict: g['判定'] || '',
    assets: ids(g['引用资产']).map(aid => assetBy.get(aid)).filter(Boolean).map((a: any) => ({
      id: a._id, name: a['资产名'], type: one(a['资产类型']) || '', status: one(a['状态']) || '', desc: a['描述'] || '', remark: a['备注'] || '', file: att(T.asset, a._id, a['文件'])
    }))
  };
}

async function listAssets() {
  const [assets, gens, cases] = await Promise.all([listAll(T.asset), listAll(T.gen), listAll(T.case)]);
  const genBy = new Map(gens.map(g => [g._id, g])), caseBy = new Map(cases.map(c => [c._id, c['案例名']]));
  return assets.filter(a => a['资产名']).map(a => ({
    id: a._id, name: a['资产名'], type: one(a['资产类型']) || '', slot: one(a['替换槽位']) || '', status: one(a['状态']) || '',
    desc: a['描述'] || '', remark: a['备注'] || '', common: !!a['通用资产'], file: att(T.asset, a._id, a['文件']),
    cases: ids(a['所属案例']).map(id => ({ id, name: caseBy.get(id) || '' })),
    usedBy: ids(a['被引用记录']).map(id => genBy.get(id)).filter(Boolean).map((g: any) => ({
      id: g._id, label: g['段落'] || g['生成编号'], version: one(g['版本']) || '', caseId: one(ids(g['所属案例'])), adopted: !!g['是否采用'], ok: one(g['任务状态']) === '成功', hasVideo: !!g['生成视频']?.length
    }))
  }));
}

// Writes only the scoring fields; formulas (人工总分/判定) are read back so the panel shows the Base's own result.
async function patchScores(id: string, x: any) {
  const rec: any = {};
  for (const k of DIMS) if (k in (x.dims || {})) rec[k] = x.dims[k];
  if (x.veto) rec['一票否决'] = x.veto;
  if (x.tags) rec['问题标签'] = x.tags;
  await lark(['+record-upsert', '--table-id', T.gen, '--record-id', id, '--json', JSON.stringify(rec)]);
  await new Promise(r => setTimeout(r, 1500)); // formulas recompute asynchronously after a write
  const row = (await listAll(T.gen)).find(r => r._id === id);
  if (!row) throw new Error('写入后读不到这条生成记录');
  return scoresOf(row);
}

const SHOT_WRITABLE = new Set([...TEXT_FIELDS, '景别', '视角', '边界类型', '难度标签', '可替换槽位', '分析评分', '分析问题', '人工核对', '分析来源', '备注', '开始(秒)', '结束(秒)']);
async function patchShot(id: string, x: Record<string, any>) {
  const rec: any = Object.fromEntries(Object.entries(x).filter(([k]) => SHOT_WRITABLE.has(k)));
  if (!Object.keys(rec).length) throw new Error('没有可写的字段');
  // Snapshot a field's value the first time it changes; writing the snapshot value back clears it (= reset).
  const SNAP = [...TEXT_FIELDS, '景别', '视角'];
  const before = (await listAll(T.shot)).find(r => r._id === id);
  if (!before) throw new Error('找不到这个镜头');
  if (Object.keys(rec).some(k => SNAP.includes(k))) {
    const cur = shotOut(before);
    if (cur) {
      const snap: Record<string, any> = { ...cur.original };
      for (const k of Object.keys(rec)) if (SNAP.includes(k)) {
        const next = rec[k] ?? '', old = cur.fields[k] ?? '';
        if (!(k in snap) && next !== old) snap[k] = old;
        else if (k in snap && next === snap[k]) delete snap[k];
      }
      rec['初始分析'] = Object.keys(snap).length ? JSON.stringify(snap) : '';
    }
  }
  await lark(['+record-upsert', '--table-id', T.shot, '--record-id', id, '--json', JSON.stringify(rec)]);
  // the Base reads back stale right after a write, so answer from the row we just wrote
  return shotOut({ ...before, ...rec });
}

async function createNote(n: any) {
  const rec: any = {
    '备注': n.body, '时间点(秒)': n.at, '开始(秒)': n.start, '结束(秒)': n.end, '保留什么': n.keep || '', '修改什么': n.change || '',
    '所属案例': [{ id: n.caseId }], '观看对象': n.target || '', '来源': n.source || '工作台', '本地ID': n.localId || '', '阶段': n.stage || '复刻', '引用原文': n.quote || '', '画面标记': n.mark ? JSON.stringify(n.mark) : '', '问题类型': n.types || []
  };
  if (n.genId) rec['生成记录'] = [{ id: n.genId }];
  if (n.shotIds?.length) rec['原片镜头'] = n.shotIds.map((id: string) => ({ id }));
  return recId(await lark(['+record-upsert', '--table-id', T.note, '--json', JSON.stringify(rec)]));
}

// ---- background jobs (upload / breakdown), polled by the browser ----
type Job = { id: string; kind: string; status: 'running' | 'done' | 'error'; log: string[]; error?: string; result?: any };
const jobs = new Map<string, Job>();
function startJob(kind: string, fn: (log: (s: string) => void) => Promise<any>) {
  const job: Job = { id: Math.random().toString(36).slice(2, 10), kind, status: 'running', log: [] };
  jobs.set(job.id, job);
  const log = (s: string) => { job.log.push(`${new Date().toLocaleTimeString()} ${s}`); };
  fn(log).then(r => { job.result = r; job.status = 'done'; log('完成'); }).catch(e => { job.error = e.message; job.status = 'error'; log('出错：' + e.message); });
  return job;
}

async function sourceFile(caseId: string) {
  const c = (await listAll(T.case)).find(x => x._id === caseId);
  const a = att(T.case, caseId, c?.['原片视频']);
  if (!a) throw new Error('这个案例还没有原片视频');
  return { c, file: await cachedMedia(T.case, caseId, a.token) };
}

async function createCase(file: string, meta: { name: string; category?: string; type?: string }, log: (s: string) => void) {
  const total = await duration(file);
  log(`原片 ${total.toFixed(1)} 秒，写入「案例」表…`);
  const rec: any = { '案例名': meta.name, '原片时长(秒)': Math.round(total * 10) / 10, '状态': '拆解中', '当前版本': 'V1' };
  if (meta.category) rec['商品类目'] = meta.category;
  if (meta.type) rec['视频类型'] = meta.type;
  const id = recId(await lark(['+record-upsert', '--table-id', T.case, '--json', JSON.stringify(rec)]));
  if (!id) throw new Error('案例创建失败');
  log('上传原片到多维表格（大文件需要一两分钟）…');
  await upload(T.case, id, '原片视频', file);
  const c = (await listAll(T.case)).find(x => x._id === id);
  const token = c?.['原片视频']?.[0]?.file_token;
  if (token) fs.renameSync(file, path.join(CACHE, token)); // already have the bytes; seed the media cache
  return { caseId: id };
}

// ---- breakdown prompt versions (「拆解提示词」) ----
const promptOut = (p: any): PromptCfg & { status: string; note: string; createdAt: string } => ({
  id: p._id, version: p['版本'] || '', status: one(p['状态']) || '', model: p['模型'] || DEFAULT_PROMPT.model, frames: Number(p['每镜抽帧数']) || DEFAULT_PROMPT.frames,
  system: p['系统指令'] || '', overview: p['梗概提示'] || '', rules: p['写作规则'] || '', schema: p['输出格式'] || '', note: p['改动说明'] || '', createdAt: p['创建时间'] || '',
  strategy: one(p['抽帧策略']) || '固定', scout: p['复杂段提示'] || DEFAULT_PROMPT.scout || '',
  // 加密帧率 0 = native frame rate, so only fall back when the cell is empty
  denseFps: p['加密帧率'] === null || p['加密帧率'] === undefined || p['加密帧率'] === '' ? 4 : Number(p['加密帧率']),
  coarseFps: Number(p['粗看帧率']) || undefined, sceneThreshold: Number(p['切点阈值']) || undefined, cutReview: !!p['切点复查'],
  aFps: Number(p['A级帧率']) || undefined, sheetWidth: Number(p['粗看帧宽']) || undefined, frameWidth: Number(p['复查帧宽']) || undefined
});
async function activePrompt(): Promise<PromptCfg> {
  const rows = (await listAll(T.prompt)).filter(p => p['版本']);
  const p = rows.filter(r => one(r['状态']) === '使用中').sort((a, b) => String(b['创建时间']).localeCompare(String(a['创建时间'])))[0];
  if (!p) return DEFAULT_PROMPT;
  const c = promptOut(p);
  return { ...c, system: c.system || DEFAULT_PROMPT.system, overview: c.overview || DEFAULT_PROMPT.overview, rules: c.rules || DEFAULT_PROMPT.rules, schema: c.schema || DEFAULT_PROMPT.schema, scout: c.scout || DEFAULT_PROMPT.scout };
}
// Every version with what its breakdowns got wrong: annotations on its shots grouped by problem type.
async function listPrompts() {
  const [prompts, shots, notes, cases] = await Promise.all([listAll(T.prompt), listAll(T.shot), listAll(T.note), listAll(T.case)]);
  const caseName = new Map(cases.map(c => [c._id, c['案例名']]));
  const shotBy = new Map(shots.map(s => [s._id, s]));
  return prompts.filter(p => p['版本']).sort((a, b) => String(b['创建时间']).localeCompare(String(a['创建时间']))).map(p => {
    const mine = shots.filter(s => ids(s['拆解版本']).includes(p._id));
    const mineIds = new Set(mine.map(s => s._id));
    const problems = notes.filter(n => one(n['阶段']) === '原片拆解' && ids(n['原片镜头']).some(id => mineIds.has(id))).map(n => {
      const s = shotBy.get(ids(n['原片镜头'])[0]);
      return { id: n._id, caseId: one(ids(s?.['所属案例'])), caseName: caseName.get(one(ids(s?.['所属案例']))) || '', shotId: s?._id, shot: s?.['镜头编号'] || '', types: n['问题类型'] || [], quote: n['引用原文'] || '', mark: !!n['画面标记'], body: n['备注'] || '' };
    });
    const rated = mine.filter(s => s['分析评分']);
    return { ...promptOut(p), shots: mine.length, verified: mine.filter(s => one(s['人工核对']) === '已核对').length,
      avg: rated.length ? Math.round(rated.reduce((a, s) => a + Number(s['分析评分']), 0) / rated.length * 10) / 10 : null,
      cases: [...new Set(mine.map(s => caseName.get(one(ids(s['所属案例'])))).filter(Boolean))], problems };
  });
}
async function createPrompt(x: any) {
  if (!x.version?.trim()) throw new Error('缺少版本号');
  const rows = (await listAll(T.prompt)).filter(p => p['版本']);
  if (rows.some(p => p['版本'] === x.version.trim())) throw new Error(`版本 ${x.version} 已存在`);
  const live = x.status !== '待试用'; // 待试用: saved for comparison, the live version stays
  if (live) for (const p of rows.filter(r => one(r['状态']) === '使用中')) await lark(['+record-upsert', '--table-id', T.prompt, '--record-id', p._id, '--json', JSON.stringify({ '状态': '历史' })]);
  const rec = { '版本': x.version.trim(), '状态': live ? '使用中' : '待试用', '模型': x.model || DEFAULT_PROMPT.model, '每镜抽帧数': Number(x.frames) || DEFAULT_PROMPT.frames,
    '系统指令': x.system || '', '梗概提示': x.overview || '', '写作规则': x.rules || '', '输出格式': x.schema || '', '改动说明': x.note || '',
    '抽帧策略': ['两轮动态', '全片定频'].includes(x.strategy) ? x.strategy : '固定', '复杂段提示': x.scout || '', '加密帧率': Number.isFinite(Number(x.denseFps)) ? Number(x.denseFps) : 4,
    '粗看帧率': Number(x.coarseFps) || null, '切点阈值': Number(x.sceneThreshold) || null, '切点复查': !!x.cutReview,
    'A级帧率': Number(x.aFps) || null, '粗看帧宽': Number(x.sheetWidth) || null, '复查帧宽': Number(x.frameWidth) || null };
  return { id: recId(await lark(['+record-upsert', '--table-id', T.prompt, '--json', JSON.stringify(rec)])) };
}
async function activatePrompt(id: string) {
  for (const p of (await listAll(T.prompt)).filter(p => p['版本'])) {
    const want = p._id === id ? '使用中' : '历史';
    if (one(p['状态']) !== want) await lark(['+record-upsert', '--table-id', T.prompt, '--record-id', p._id, '--json', JSON.stringify({ '状态': want })]);
  }
  return { ok: true };
}

// ---- recreation: assets, drafting, submitting ----
async function createAsset(file: string, q: Record<string, string>) {
  const rec: any = { '资产名': q.name, '资产类型': q.type || '商品图', '替换槽位': q.slot || '无', '描述': q.desc || '', '状态': '可用', '通用资产': false };
  if (q.caseId) rec['所属案例'] = [{ id: q.caseId }];
  const id = recId(await lark(['+record-upsert', '--table-id', T.asset, '--json', JSON.stringify(rec)]));
  if (!id) throw new Error('资产没有写入');
  await upload(T.asset, id, '文件', file);
  return { id };
}
async function activeDraftRules() {
  const rows = (await listAll(T.rprompt)).filter(p => p['版本']);
  let p = rows.find(r => one(r['状态']) === '使用中');
  if (!p) {
    const id = recId(await lark(['+record-upsert', '--table-id', T.rprompt, '--json', JSON.stringify({ '版本': 'R1', '状态': '使用中', '起草模型': LLM.model, '起草规则': DRAFT_RULES_R1, '改动说明': '初始版本：把 V1/V2/V3 和 Osmo 拆解里出现过的错误（首帧状态、过程变化、左右、位置、原片 IP 回流、负面写法）写成规则。' })]));
    return { id, version: 'R1', model: LLM.model, rules: DRAFT_RULES_R1 };
  }
  return { id: p._id, version: p['版本'], model: p['起草模型'] || LLM.model, rules: p['起草规则'] || DRAFT_RULES_R1 };
}
// Shots + their open review notes + the chosen assets, in the order they will be numbered @图片1..N.
async function recreateContext(x: { caseId: string; shotIds: string[]; assets: { id: string; role: string }[]; hints?: { at: number; text: string }[] }) {
  const [shots, notes, assets, cases] = await Promise.all([listAll(T.shot), listAll(T.note), listAll(T.asset), listAll(T.case)]);
  const picked = x.shotIds.map(id => shots.find(s => s._id === id)).filter(Boolean).sort((a: any, b: any) => a['开始(秒)'] - b['开始(秒)']);
  if (!picked.length) throw new Error('没有选镜头');
  const open = (n: any) => one(n['阶段']) === '原片拆解' && one(n['处理状态']) !== '已修正';
  const c = cases.find(k => k._id === x.caseId);
  return {
    shots: picked.map((s: any) => ({
      id: s._id, code: s['镜头编号'], start: s['开始(秒)'], end: s['结束(秒)'], fields: shotOut(s).fields,
      corrections: [...(x.hints || []).filter((h: any) => h.at >= s['开始(秒)'] && h.at < s['结束(秒)']).map((h: any) => h.text), ...notes.filter(n => open(n) && ids(n['原片镜头']).includes(s._id)).map(n => n['画面标记'] ? `画面圈选（${(() => { try { return JSON.parse(n['画面标记']).t; } catch { return '?'; } })()}s）：${n['备注']}` : n['引用原文'] ? `原文「${n['引用原文']}」→ ${n['备注']}` : n['备注'])]
    })),
    assets: x.assets.map((a, i) => { const r = assets.find(k => k._id === a.id); if (!r) throw new Error('找不到素材 ' + a.id); return { id: r._id, n: i + 1, name: r['资产名'], role: a.role, desc: r['描述'] || '', file: att(T.asset, r._id, r['文件']) }; }),
    overview: String(c?.['整体结论'] || '').replace(/^【GPT 梗概】\n/, '')
  };
}
async function draftRecreate(x: any) {
  const m = VIDEO_MODELS[x.model]; if (!m) throw new Error('不支持的模型 ' + x.model);
  const ctx = await recreateContext(x); const rules = await activeDraftRules();
  const span = ctx.shots.at(-1)!.end - ctx.shots[0].start;
  const duration = Math.min(m.max, Math.max(m.min, Math.ceil(span)));
  if (span > m.max) throw new Error(`选中的镜头共 ${span.toFixed(1)} 秒，超过 ${m.label} 单次上限 ${m.max} 秒，请少选几个镜头`);
  if (ctx.assets.length > m.maxRefs) throw new Error(`${m.label} 最多 ${m.maxRefs} 张参考图`);
  const prompt = await draftPrompt({ shots: ctx.shots, assets: ctx.assets, overview: ctx.overview, model: m.label, duration, rules: rules.rules, sound: m.sound }, rules.model);
  return { prompt, duration, span: Math.round(span * 100) / 100, rules: rules.version, model: rules.model };
}
async function runRecreate(x: any, log: (s: string) => void) {
  const m = VIDEO_MODELS[x.model]; if (!m) throw new Error('不支持的模型 ' + x.model);
  const ctx = await recreateContext(x); const rules = await activeDraftRules();
  const start = ctx.shots[0].start, end = ctx.shots.at(-1)!.end;
  log('准备素材文件…');
  // the media cache names files by token only; 博观 keeps the extension it sees, and Seedance rejects URLs without one
  const images = await Promise.all(ctx.assets.map(async a => {
    if (!a.file) throw new Error(`素材「${a.name}」没有文件`);
    const src = await cachedMedia(T.asset, a.id, a.file.token);
    const ext = (path.extname(a.file.name || '').toLowerCase().match(/^.(jpe?g|png|webp|gif|bmp|tiff?)$/) || ['.jpg'])[0];
    const out = path.join(CACHE, 'tmp', 'recreate', `${a.file.token}${ext}`); fs.mkdirSync(path.dirname(out), { recursive: true });
    if (!fs.existsSync(out)) fs.copyFileSync(src, out);
    return out;
  }));
  log(`提交到博观：${m.label}｜${x.size}｜${x.duration} 秒｜${images.length} 张参考图`);
  const label = `${m.label}｜原片${start}–${end}s｜${ctx.shots.map(s => s.code).join('-')}`;
  const base: any = {
    '段落': label, '版本': x.version || 'V1', '所属案例': [{ id: x.caseId }], '模型': [{ id: x.model === 'seedance-2.5' ? 'reczz28TgdmyTbIQ' : 'reczz28UWJvqcLeK' }],
    '分辨率': x.size.toUpperCase().replace('P', 'P'), '生成工具': '博观cli', '提示词来源': 'GPT-6.1 SOL', '生成模式': '参考图生视频',
    '生成时长(秒)': x.duration, '复刻提示词': x.prompt, '引用资产': ctx.assets.map(a => ({ id: a.id })), '关联镜头': ctx.shots.map(s => ({ id: s.id })),
    '复刻版本': rules.id ? [{ id: rules.id }] : []
  };
  let taskId = '';
  try {
    taskId = (await submitVideo({ prompt: x.prompt, images, model: x.model, size: x.size, duration: x.duration })).taskId;
    log(`已提交，任务 ${taskId}`);
    const { url } = await waitVideo(taskId, log);
    log('下载视频…');
    const dir = path.join(CACHE, 'tmp', 'recreate'); fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${taskId}.mp4`);
    fs.writeFileSync(out, Buffer.from(await (await fetch(url)).arrayBuffer()));
    const cost = videoCost(x.model, { size: x.size, ratio: '16:9', outputSec: x.duration, images: images.length })?.yuan ?? null;
    const id = recId(await lark(['+record-upsert', '--table-id', T.gen, '--json', JSON.stringify({ ...base, '任务状态': '成功', '任务ID': taskId, '采用秒数': Math.round((end - start) * 10) / 10, '是否采用': true, '成本(元)': cost, '备注': `工作台提交｜复刻规则 ${rules.version}｜${new Date().toLocaleString()}` })]));
    log('上传生成视频和分屏对比…');
    await upload(T.gen, id!, '生成视频', out);
    const { file: src } = await sourceFile(x.caseId);
    const split = path.join(dir, `${taskId}_分屏对比.mp4`), d = (end - start).toFixed(3);
    await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-ss', String(start), '-t', d, '-i', src, '-t', d, '-i', out, '-filter_complex',
      '[0:v]scale=854:480,setsar=1,fps=24[l];[1:v]scale=854:480,setsar=1,fps=24[r];[l][r]hstack[v]', '-map', '[v]', '-map', '1:a?', '-t', d, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-c:a', 'aac', split]);
    await upload(T.gen, id!, '分屏对比', split);
    return { genId: id, taskId };
  } catch (e: any) {
    await lark(['+record-upsert', '--table-id', T.gen, '--json', JSON.stringify({ ...base, '任务状态': '失败', '任务ID': taskId, '失败原因': e.message.slice(0, 500), '成本(元)': 0 })]).catch(() => {});
    throw e;
  }
}

async function breakdown(caseId: string, log: (s: string) => void) {
  const existing = (await listAll(T.shot)).filter(s => ids(s['所属案例']).includes(caseId));
  if (existing.length) throw new Error(`这个案例已经有 ${existing.length} 个镜头，为避免覆盖人工核对结果，没有重新拆解`);
  const { file } = await sourceFile(caseId);
  const cfg = await activePrompt();
  log(`拆解提示词 ${cfg.version}｜模型 ${cfg.model}｜${cfg.strategy === '全片定频' ? `全片定频（全片 ${cfg.coarseFps || 5} 帧/秒，A 级 ${cfg.aFps || 10} 帧/秒，B 级原始帧率，切点阈值 ${cfg.sceneThreshold || 0.16}）` : cfg.strategy === '两轮动态' ? `两轮动态抽帧（粗看 ${cfg.frames} 帧/镜，复杂段每秒 ${cfg.denseFps} 帧）` : `每镜 ${cfg.frames} 帧`}`);
  const work = path.join(CACHE, 'breakdown', caseId);
  const { cuts, overview, analysed } = await analyseVideo(file, work, log, 6, cfg);
  log('写入「原片镜头」表…');
  const fields = ['镜头编号', '所属案例', '序号', '开始(秒)', '结束(秒)', '景别', '视角', '边界类型', ...TEXT_FIELDS.filter(k => k !== '对白/画外音'), '难度标签', '可替换槽位', '人工核对', '分析来源', '拆解版本', '抽帧说明'];
  const rows = analysed.map((s, i) => {
    const f = s.fields;
    return [`S${String(i + 1).padStart(2, '0')}`, [{ id: caseId }], i + 1, s.start, s.end, pick(f['景别'], OPTIONS.景别)[0] || null, pick(f['视角'], OPTIONS.视角)[0] || null, pick(f['边界类型'], OPTIONS.边界类型)[0] || null,
      ...TEXT_FIELDS.filter(k => k !== '对白/画外音').map(k => String(f[k] || '')), pick(f['难度标签'], OPTIONS.难度标签), pick(f['可替换槽位'], OPTIONS.可替换槽位), '未核对', 'GPT-6.1 SOL', cfg.id ? [{ id: cfg.id }] : [], s.sampling || ''];
  });
  const created: string[] = [];
  for (let i = 0; i < rows.length; i += 100) {
    const tmp = path.join(CACHE, 'tmp', `shots_${caseId}_${i}.json`); fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ fields, rows: rows.slice(i, i + 100) }));
    const d = await lark(['+record-batch-create', '--table-id', T.shot, '--json', '@' + rel(tmp)]);
    created.push(...(d.record_id_list || []));
  }
  log(`已写入 ${created.length} 个镜头，上传核对关键帧…`);
  let n = 0;
  await Promise.all(Array.from({ length: 4 }, async (_, w) => {
    for (let i = w; i < created.length; i += 4) { await upload(T.shot, created[i], '核对关键帧', analysed[i].keyframe).catch(() => {}); if (++n % 10 === 0) log(`关键帧 ${n}/${created.length}`); }
  }));
  await lark(['+record-upsert', '--table-id', T.case, '--record-id', caseId, '--json', JSON.stringify({ '切点': cuts.join(','), '整体结论': `【GPT 梗概】\n${overview}` })]).catch(() => {});
  return { shots: created.length };
}

async function revise(shotId: string, x: { notes?: string[]; issues?: string[]; marks?: { t: number; box: number[]; body: string }[] }) {
  const shot = (await listAll(T.shot)).find(s => s._id === shotId);
  if (!shot) throw new Error('找不到这个镜头');
  const caseId = one(ids(shot['所属案例']));
  const { c, file } = await sourceFile(caseId);
  const s = shot['开始(秒)'], e = shot['结束(秒)'], d = e - s;
  const times = d < 0.6 ? [s + d / 2] : [s + d * 0.15, s + d / 2, e - d * 0.15];
  const dir = path.join(CACHE, 'tmp', 'revise'); fs.mkdirSync(dir, { recursive: true });
  const frames = await Promise.all(times.map((t, k) => frameAt(file, t, path.join(dir, `${shotId}_${k}.jpg`), 640)));
  // frame marks: the frame at the marked time with the reviewer's circle drawn as a red box
  const marks = await Promise.all((x.marks || []).map(async (m, k) => {
    const [x0, y0, x1, y1] = m.box.map(v => Math.min(1, Math.max(0, v)));
    const out = path.join(dir, `${shotId}_mark${k}.jpg`);
    await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-ss', m.t.toFixed(3), '-i', file, '-frames:v', '1',
      '-vf', `scale=640:-2,drawbox=x=iw*${x0.toFixed(4)}:y=ih*${y0.toFixed(4)}:w=iw*${(x1 - x0).toFixed(4)}:h=ih*${(y1 - y0).toFixed(4)}:color=red@0.95:t=4`, '-q:v', '4', out]);
    return { file: out, t: m.t, body: m.body };
  }));
  const cur = shotOut(shot).fields;
  const overview = String(c?.['整体结论'] || '').replace(/^【GPT 梗概】\n/, '');
  const r = await reviseShot({ frames, times, current: cur, notes: x.notes || [], issues: x.issues || [], overview, marks });
  // select fields must stay within the Base's options; fall back to the current value
  for (const k of ['景别', '视角'] as const) r.fields[k] = pick(r.fields[k], OPTIONS[k])[0] || cur[k];
  return { ...r, model: llmLabel() };
}

// Warm the cache in the background so the first play of a clip does not wait for the whole download.
let warming = false;
async function prefetch(d: any) {
  if (warming) return; warming = true;
  const urls = [d.case.source?.url, ...d.gens.map((g: any) => g.video?.url)].filter(Boolean);
  try { for (const u of urls) { const [, , , table, rec, token] = u.split('/').map(decodeURIComponent); await cachedMedia(table, rec, token).catch(() => {}); } }
  finally { warming = false; }
}

const pending = new Map<string, Promise<string>>();
async function cachedMedia(table: string, rec: string, token: string) {
  const file = path.join(CACHE, token);
  if (fs.existsSync(file)) return file;
  if (!pending.has(token)) pending.set(token, (async () => {
    await lark(['+record-download-attachment', '--table-id', table, '--record-id', rec, '--file-token', token, '--output', `./${token}.part`, '--overwrite']);
    fs.renameSync(path.join(CACHE, `${token}.part`), file);
    return file;
  })().finally(() => pending.delete(token)));
  return pending.get(token)!;
}

function mimeOf(file: string) {
  const b = Buffer.alloc(12); const fd = fs.openSync(file, 'r'); fs.readSync(fd, b, 0, 12, 0); fs.closeSync(fd);
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'video/mp4';
}
function sendFile(req: any, res: any, file: string) {
  const size = fs.statSync(file).size;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  res.setHeader('Content-Type', mimeOf(file)); res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Cache-Control', 'private, max-age=86400');
  if (!m) { res.setHeader('Content-Length', size); return fs.createReadStream(file).pipe(res); }
  const start = m[1] ? Number(m[1]) : size - Number(m[2]), end = m[1] && m[2] ? Number(m[2]) : size - 1;
  res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`); res.setHeader('Content-Length', end - start + 1);
  fs.createReadStream(file, { start, end }).pipe(res);
}

const body = (req: any) => new Promise<any>(r => { let s = ''; req.on('data', (c: any) => s += c); req.on('end', () => r(s ? JSON.parse(s) : {})); });
const json = (res: any, code: number, x: any) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(x)); };
const saveUpload = (req: any, file: string) => new Promise<void>((ok, fail) => { const w = fs.createWriteStream(file); req.pipe(w); w.on('finish', ok); w.on('error', fail); req.on('error', fail); });

export function feishuBase(): Plugin {
  return {
    name: 'feishu-base',
    configureServer(server) {
      CACHE = path.join(server.config.root, '.cache/media');
      fs.mkdirSync(CACHE, { recursive: true });
      server.middlewares.use('/api/base', async (req: any, res: any) => {
        const url = new URL(req.url, 'http://x'); const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        const q = Object.fromEntries(url.searchParams);
        try {
          if (req.method === 'GET' && parts[0] === 'case') { const d = await loadCase(parts[1]); json(res, 200, d); return prefetch(d); }
          if (req.method === 'GET' && parts[0] === 'cases') return json(res, 200, await listCases());
          if (req.method === 'GET' && parts[0] === 'assets') return json(res, 200, await listAssets());
          if (req.method === 'GET' && parts[0] === 'gens' && !parts[1]) return json(res, 200, await listGens());
          if (req.method === 'GET' && parts[0] === 'gens' && parts[1]) return json(res, 200, await getGen(parts[1]));
          if (req.method === 'GET' && parts[0] === 'media') return sendFile(req, res, await cachedMedia(parts[1], parts[2], parts[3]));
          if (req.method === 'GET' && parts[0] === 'jobs') { const j = jobs.get(parts[1]); return j ? json(res, 200, j) : json(res, 404, { error: '任务不存在（服务可能重启过）' }); }
          if (req.method === 'GET' && parts[0] === 'llm') return json(res, 200, { label: llmLabel() });
          if (req.method === 'POST' && parts[0] === 'cases' && !parts[1]) {
            if (!q.name) return json(res, 400, { error: '缺少案例名' });
            const tmp = path.join(CACHE, `upload_${Date.now()}.mp4`);
            await saveUpload(req, tmp);
            return json(res, 200, startJob('new-case', async log => {
              const r = await createCase(tmp, q as any, log);
              if (q.analyse === '1') Object.assign(r, await breakdown(r.caseId, log));
              return r;
            }));
          }
          if (req.method === 'POST' && parts[0] === 'cases' && parts[2] === 'breakdown') return json(res, 200, startJob('breakdown', log => breakdown(parts[1], log)));
          if (req.method === 'POST' && parts[0] === 'shots' && parts[2] === 'revise') return json(res, 200, await revise(parts[1], await body(req)));
          if (req.method === 'PATCH' && parts[0] === 'shots') return json(res, 200, await patchShot(parts[1], await body(req)));
          if (req.method === 'POST' && parts[0] === 'notes') return json(res, 200, { id: await createNote(await body(req)) });
          if (req.method === 'PATCH' && parts[0] === 'gens') return json(res, 200, await patchScores(parts[1], await body(req)));
          if (req.method === 'PATCH' && parts[0] === 'notes') { const x = await body(req); const rec: any = {}; if ('body' in x) rec['备注'] = x.body; if ('types' in x) rec['问题类型'] = x.types; if ('status' in x) rec['处理状态'] = x.status; await lark(['+record-upsert', '--table-id', T.note, '--record-id', parts[1], '--json', JSON.stringify(rec)]); return json(res, 200, { ok: true }); }
          if (req.method === 'GET' && parts[0] === 'prompts') return json(res, 200, await listPrompts());
          if (req.method === 'GET' && parts[0] === 'recreate' && parts[1] === 'models') return json(res, 200, VIDEO_MODELS);
          if (req.method === 'POST' && parts[0] === 'recreate' && parts[1] === 'draft') return json(res, 200, await draftRecreate(await body(req)));
          if (req.method === 'POST' && parts[0] === 'recreate' && parts[1] === 'submit') { const x = await body(req); return json(res, 200, startJob('recreate', log => runRecreate(x, log))); }
          if (req.method === 'POST' && parts[0] === 'assets') {
            if (!q.name) return json(res, 400, { error: '缺少素材名' });
            const tmp = path.join(CACHE, 'tmp', `asset_${Date.now()}.${(q.ext || 'png').replace(/\W/g, '')}`); fs.mkdirSync(path.dirname(tmp), { recursive: true });
            await saveUpload(req, tmp); return json(res, 200, await createAsset(tmp, q));
          }
          if (req.method === 'POST' && parts[0] === 'prompts' && !parts[1]) return json(res, 200, await createPrompt(await body(req)));
          if (req.method === 'POST' && parts[0] === 'prompts' && parts[2] === 'activate') return json(res, 200, await activatePrompt(parts[1]));
          if (req.method === 'DELETE' && parts[0] === 'notes') { await lark(['+record-delete', '--table-id', T.note, '--record-id', parts[1], '--yes']); return json(res, 200, { ok: true }); }
          json(res, 404, { error: 'not found' });
        } catch (e: any) { json(res, 500, { error: e.message }); }
      });
    }
  };
}
