// Turns the /api/base/case payload (served by server/feishuBase.ts) into the workbench Project shape,
// and writes review notes back to the Feishu Base 「复盘备注」 table.
import type { Passage, Project, Recreation, ReviewNote } from './model';

export type Scores = { dims: Record<string, number | null>; veto: string[]; tags: string[]; total: string; verdict: string };
export type ScoreMeta = { dims: { key: string; label: string; hint: string }[]; veto: string[]; tags: string[]; shotIssues: string[]; shotRatingHint: string; noteTypes?: string[] };
export type Media = { url: string; name: string; token?: string };
export type Shot = { id: string; code: string; start: number; end: number; text: string; verified: string | null; fields: Record<string, any>; rating: number | null; issues: string[]; source: string; remark: string; keyframe: Media | null; original?: Record<string, any>; promptId?: string | null; sampling?: string };
export type BaseNote = { id: string; localId: string; at: number; start: number; end: number; body: string; keep: string; change: string; genId: string | null; shotIds: string[]; stage: string; quote?: string; types?: string[]; status?: string; mark?: FrameMark | null; target: string; createdAt: string };
// A circle drawn on the source frame: t in seconds, pts/box normalised to the video picture (0–1).
export type FrameMark = { t: number; pts: [number, number][]; box: [number, number, number, number] };

export type BaseCase = {
  prompts?: Record<string, string>;
  scoreMeta: ScoreMeta;
  cases: { id: string; name: string }[];
  case: { id: string; name: string; duration: number; source: Media | null; status?: string; version?: string };
  shots: Shot[];
  gens: { id: string; label: string; version: string; adopted: boolean; shotIds: string[]; assetIds?: string[]; prompt: string; video: { url: string; name: string }; score: string; verdict: string; scores: Scores }[];
  notes: BaseNote[];
};

export const isBaseProject = (p: Project) => p.id.startsWith('base-');

// "第2段 30-60s" / "U05-A｜原片34.2–38.8s｜首次提交" / "V3-A｜原片32.3–41.1s｜..."
export function rangeFromLabel(label: string): [number, number] | null {
  const m = label.match(/(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)\s*s/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
// A shot line starts with its time range, optionally after a cut cue ("1.0秒硬切。" / "2.0硬切。"):
//   "0.0–1.8秒：…"  or a header "【镜头1｜0.0–1.8秒｜报废箱近景】…" / "【镜头2｜1.45秒起｜…】" (open end = next shot).
// A header with no text after it takes the following plain lines as its text.
// Times mentioned mid-sentence (e.g. "镜头5–6纸张…" in a 【声音】 line) are ignored.
const HEAD = /^【([^】]*?)(\d+(?:\.\d+)?)\s*(?:[-–—~至]\s*(\d+(?:\.\d+)?)\s*秒?|秒\s*起)([^】]*)】\s*(.*)$/;
const PLAIN = /^(?:\d+(?:\.\d+)?\s*秒?\s*硬切[。.，,]?\s*)?(\d+(?:\.\d+)?)\s*[-–—~至]\s*(\d+(?:\.\d+)?)\s*秒\s*[：:]?\s*(.*)$/;
const clean = (x: string) => x.replace(/本地(?:时间)?(?=[｜|]|$)/, '').replace(/[｜|]{2,}/g, '｜').replace(/^[｜|\s]+|[｜|\s]+$/g, '');
export function parseGenPrompt(text: string, offset: number, end: number, prefix: string): Passage[] {
  const out: (Passage & { open?: boolean; collect?: boolean })[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    const head = line.match(HEAD), plain = !head && line.match(PLAIN);
    if (!head && !plain) {
      const last = out[out.length - 1];
      if (last?.collect && line && !line.startsWith('【')) last.text = (last.text ? last.text + '｜' : '') + line;
      else if (last) last.collect = false;
      return;
    }
    const a = Number(head ? head[2] : plain![1]), b = head ? (head[3] ? Number(head[3]) : NaN) : Number(plain![2]);
    const title = head ? clean(head[1] + head[4]) : '', body = head ? head[5] : plain![3];
    const start = r2(offset + a);
    if (start >= end - 0.01) return; // tail padding that gets trimmed in the edit
    out.push({ id: `${prefix}-${i}`, start, end: Number.isNaN(b) ? end : r2(Math.min(offset + b, end)), text: [title, body].filter(Boolean).join('｜'), open: Number.isNaN(b), collect: !!head && !body });
  });
  out.sort((x, y) => x.start - y.start);
  out.forEach((p, k) => { if (p.open) p.end = out.find((q, m) => m > k && q.start > p.start)?.start ?? end; });
  return out.map(({ open, collect, ...p }) => p);
}

export function fromBase(d: BaseCase): { project: Project; original: Passage[] } {
  const original = d.shots.map(s => ({ id: s.id, start: s.start, end: s.end, text: `${s.code}｜${s.text}` }));
  const recreations: Recreation[] = [];
  const promptVersions: Project['promptVersions'] = [];
  d.gens.forEach((g, i) => {
    const [start, end] = rangeFromLabel(g.label) || [0, d.case.duration || 0];
    const version = 1000 + i;
    let passages = parseGenPrompt(g.prompt, start, end, `g${i}`);
    if (!passages.length && g.prompt) passages = [{ id: `g${i}-all`, start, end, text: g.prompt }];
    promptVersions.push({ version, text: g.prompt, passages });
    recreations.push({
      id: g.id, name: g.video.name, url: g.video.url, duration: 0, attemptNo: i + 1, promptVersion: version,
      label: `${g.label}${g.adopted ? '' : '（未采用）'}${g.score ? `｜${g.score}分` : ''}`,
      group: g.version, sourceOffset: start, sourceEnd: end
    });
  });
  const notes: ReviewNote[] = d.notes.map(n => ({
    id: n.id, at: n.at, start: n.start, end: n.end, body: n.body, keep: n.keep, change: n.change,
    recreationId: n.genId || '', promptVersion: recreations.find(r => r.id === n.genId)?.promptVersion || 0,
    createdAt: n.createdAt ? new Date(Number(n.createdAt) || n.createdAt).toISOString() : ''
  }));
  const project: Project = {
    id: `base-${d.case.id}`, name: d.case.name, source: { name: d.case.source?.name || '原片', url: d.case.source?.url || '', duration: d.case.duration || 0 },
    recreations, selectedRecreationId: recreations[0]?.id || '', promptVersions, notes, sessionId: '', createdAt: ''
  };
  return { project, original };
}

export const shotsAt = (original: Passage[], at: number) => original.filter(s => at >= s.start && at < s.end).map(s => s.id);

export async function postNote(input: { caseId: string; genId: string | null; at: number; start: number; end: number; body: string; keep: string; change: string; shotIds: string[]; target: string; source?: string; localId?: string; stage?: string; quote?: string; mark?: FrameMark; types?: string[] }) {
  const r = await fetch('/api/base/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const j = await r.json();
  if (!r.ok || !j.id) throw new Error(j.error || '写入多维表格失败');
  return j.id as string;
}

export async function editNote(id: string, body: string, types?: string[]) {
  const r = await fetch(`/api/base/notes/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(types ? { body, types } : { body }) });
  if (!r.ok) throw new Error((await r.json()).error || '修改失败');
}

// Splits text into plain runs and runs covered by an annotation quote (first occurrence of each, overlaps skipped).
export type Run = { text: string; noteId?: string };
export function markQuotes(text: string, notes: { id: string; quote?: string }[]): Run[] {
  const hits = notes.filter(x => x.quote).map(x => ({ id: x.id, at: text.indexOf(x.quote!), len: x.quote!.length })).filter(h => h.at >= 0).sort((a, b) => a.at - b.at);
  const out: Run[] = []; let pos = 0;
  for (const h of hits) { if (h.at < pos) continue; if (h.at > pos) out.push({ text: text.slice(pos, h.at) }); out.push({ text: text.slice(h.at, h.at + h.len), noteId: h.id }); pos = h.at + h.len; }
  if (pos < text.length) out.push({ text: text.slice(pos) });
  return out;
}

export async function setNoteStatus(id: string, status: '待处理' | '已修正' | '仍存在') {
  const r = await fetch(`/api/base/notes/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
  if (!r.ok) throw new Error((await r.json()).error || '修改失败');
}

export async function removeNote(id: string) {
  const r = await fetch(`/api/base/notes/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json()).error || '删除失败');
}

export async function patchScores(genId: string, patch: Partial<Scores>): Promise<Scores> {
  const r = await fetch(`/api/base/gens/${genId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || '写入失败');
  return j;
}

// ---- cases / breakdown / shots / assets ----
export type CaseSummary = { id: string; name: string; duration: number; status: string; category: string; type: string; shots: number; verified: number; gens: number; cost: string; thumb: Media | null; hasSource: boolean };
export type Asset = { id: string; name: string; type: string; slot: string; status: string; desc: string; remark: string; common: boolean; file: Media | null; cases: { id: string; name: string }[];
  usedBy: { id: string; label: string; version: string; caseId: string | null; adopted: boolean; ok: boolean; hasVideo: boolean }[] };
export type Job = { id: string; kind: string; status: 'running' | 'done' | 'error'; log: string[]; error?: string; result?: any };

export async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init); const j = await r.json();
  if (!r.ok || j?.error) throw new Error(j?.error || `请求失败 ${r.status}`);
  return j;
}
const jsonInit = (method: string, body: any): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const listCases = () => call<CaseSummary[]>('/api/base/cases');
export type PromptVersion = { id: string; version: string; status: string; model: string; frames: number; strategy: string; scout: string; denseFps: number; coarseFps?: number; sceneThreshold?: number; cutReview?: boolean; aFps?: number; sheetWidth?: number; frameWidth?: number; system: string; overview: string; rules: string; schema: string; note: string; createdAt: string;
  shots: number; verified: number; avg: number | null; cases: string[];
  problems: { id: string; caseId: string | null; caseName: string; shotId?: string; shot: string; types: string[]; quote: string; mark: boolean; body: string }[] };
export const listPrompts = () => call<PromptVersion[]>('/api/base/prompts');
export const createPrompt = (p: Partial<PromptVersion>) => call<{ id: string }>('/api/base/prompts', jsonInit('POST', p));
export const activatePrompt = (id: string) => call<{ ok: boolean }>(`/api/base/prompts/${id}/activate`, { method: 'POST' });
export const listAssets = () => call<Asset[]>('/api/base/assets');
export const getJob = (id: string) => call<Job>(`/api/base/jobs/${id}`);
export const startBreakdown = (caseId: string) => call<Job>(`/api/base/cases/${caseId}/breakdown`, { method: 'POST' });
export const patchShot = (id: string, patch: Record<string, any>) => call<Shot>(`/api/base/shots/${id}`, jsonInit('PATCH', patch));
export const reviseShot = (id: string, x: { notes: string[]; issues: string[]; marks?: { t: number; box: number[]; body: string }[] }) => call<{ fields: Record<string, string>; reason: string; model: string }>(`/api/base/shots/${id}/revise`, jsonInit('POST', x));

// XHR so the browser can report upload progress for large originals
export function uploadCase(file: File, meta: Record<string, string>, onProgress: (p: number) => void): Promise<Job> {
  return new Promise((ok, fail) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/base/cases?' + new URLSearchParams(meta));
    x.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => { try { const j = JSON.parse(x.responseText); x.status < 300 && !j.error ? ok(j) : fail(new Error(j.error || x.statusText)); } catch (e) { fail(e); } };
    x.onerror = () => fail(new Error('上传中断'));
    x.send(file);
  });
}

export async function waitJob(id: string, onUpdate: (j: Job) => void) {
  for (;;) {
    const j = await getJob(id); onUpdate(j);
    if (j.status !== 'running') return j;
    await new Promise(r => setTimeout(r, 1500));
  }
}

export type GenBrief = { id: string; label: string; version: string; status: string; adopted: boolean; caseId: string | null; hasVideo: boolean; shots: string[]; assetNames: string[] };
export type GenAsset = { id: string; name: string; type: string; status: string; desc: string; remark: string; file: Media | null };
export type GenDetail = GenBrief & { video: Media | null; sourceVideo: Media | null; prompt: string; mode: string; taskId: string; fail: string; cost: number | ''; seconds: number | ''; source: string; tool: string; remark: string; tags: string[]; score: string; verdict: string; assets: GenAsset[] };
export const listGens = () => call<GenBrief[]>('/api/base/gens');
export const getGen = (id: string) => call<GenDetail>(`/api/base/gens/${id}`);

// Splits one prompt line into text and @图片N tokens. assets[i] is @图片{i+1}; a token past the end is a dangling alias
// (a retry dropped that image but kept the wording), which is exactly what a reviewer needs to see.
export type PromptPiece = { text: string } | { ref: number; asset: GenAsset | null };
export function splitPromptRefs(line: string, assets: GenAsset[]): PromptPiece[] {
  const out: PromptPiece[] = []; let last = 0;
  for (const m of line.matchAll(/@图片(\d+)/g)) {
    if (m.index! > last) out.push({ text: line.slice(last, m.index) });
    const n = Number(m[1]); out.push({ ref: n, asset: assets[n - 1] || null });
    last = m.index! + m[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last) });
  return out;
}

// Finds the prompt line a workbench passage came from, so the detail view can scroll to it.
export function findPromptLine(lines: string[], passage: string): number {
  const parts = passage.split('｜').map(s => s.trim()).filter(s => s.length >= 4).sort((a, b) => b.length - a.length);
  for (const p of parts) for (const n of [16, 8]) {
    const probe = p.slice(0, n); const i = lines.findIndex(l => l.includes(probe));
    if (i >= 0) return i;
  }
  return -1;
}
