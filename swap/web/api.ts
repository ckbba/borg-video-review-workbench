export type TemplateCard = {
  id: string; title: string; desc: string; ratio: string; seconds: number; note?: string;
  video: string; cover?: string; slot: { label: string; hint: string; modes: { id: string; label: string; hint?: string }[] }; versions: { id: string; label: string }[];
  choices: { id: string; label: string; options: { id: string; label: string }[] }[];
};
export type VersionView = { id: string; label: string; status: 'waiting' | 'running' | 'done' | 'failed'; step?: string; error?: string; final?: string; compare?: string; check?: { pass: boolean; summary: string } };
export type JobView = {
  id: string; templateId: string; slotMode?: string; mock?: boolean; stage: 'checking' | 'framing' | 'pick' | 'slots' | 'rendering' | 'done' | 'failed';
  message: string; error?: string; guard?: { ok: boolean; face: string; message?: string };
  upload: string; frames: string[]; picked?: number; log: string[]; versions: VersionView[];
  replica?: ReplicaView;
};
export type PhaseView = { id: string; label: string; status: 'waiting' | 'running' | 'done' | 'skipped' | 'failed'; note?: string };
export type CopyItem = { at: number; from: string; to: string; sure: boolean; why?: string; src?: 'voice' | 'caption' | 'both' };
export type SlotView = { id: string; label: string; main: boolean; at: number; frame?: string; image?: string; own: boolean };
export type GapView = { label: string; at: number; frame?: string; kind: 'angle' | 'part' | 'screen'; shots?: number[]; need?: string; fallback?: string; found?: { url: string; page?: string; why?: string } };
export type FitView = { start: number; end: number; fit: 'good' | 'rough' | 'no'; why: string; change?: boolean; thumb?: string; variant?: string; pics?: string[] };
export type ReplicaView = { photoIssue?: string; keyframeStop?: boolean; route?: { kind: 'simple' | 'full'; reasons: string[] }; scouting: boolean; fit: FitView[]; gaps: GapView[]; styles: { id: string; label: string }[]; voice?: { status: 'running' | 'done' | 'failed'; error?: string; lines?: number }; copy: CopyItem[]; copyCheck?: { heard: number; done: boolean; error?: string }; slots: SlotView[]; phases: PhaseView[]; summary?: string; uploads: string[]; source: string; sheet?: string; variants: { label: string; url: string }[];
  keyframes: { scene: string; url: string; ok?: boolean }[]; redoError?: string; segments: { status: string; repaired?: boolean; pass?: boolean; start: number; end: number; lookBad: boolean; yuan?: number }[] };
export type JobSummary = { id: string; templateId: string; title: string; created: number; stage: string; message: string; upload: string; versions: string[];
  mode?: string; results: { label: string; final: string; compare: string; pass?: boolean }[];
  engine?: { image: string; video: string }; cost?: number; costUnknown: number; seconds: number[] };
export type ProductView = { id: string; name: string; updated: number; jobs: number; notes: string[]; photos: { file: string; angle?: string; web?: boolean; url: string }[] };
export type EngineConfig = { image: string; video: string; guard: string; checker: string; minSeconds: number; maxSeconds: number; styles: { id: string; label: string }[] };

async function call<T>(url: string, body?: any): Promise<T> {
  const r = await fetch('/api/swap' + url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
export const api = {
  config: () => call<EngineConfig>('/config'),
  templates: () => call<TemplateCard[]>('/templates'),
  job: (id: string) => call<JobView>(`/jobs/${id}`),
  jobs: () => call<JobSummary[]>('/jobs'),
  trace: (id: string) => call<any>(`/jobs/${id}/trace`),
  cases: () => call<{ text: string }>('/cases').then(r => r.text),
  zh: (text: string) => call<{ zh: string }>('/translate', { text }).then(r => r.zh),
  create: (templateId: string, image: string, extras: string[], force = false, mode?: string) => call<JobView>('/jobs', { templateId, image, extras, force, mode }),
  createText: (video: string, kind: 'background' | 'object', text: string) => call<JobView>('/text-jobs', { video, kind, text }),
  replica: (x: { templateId?: string; video?: string; images: string[]; prompt: string; styles?: string[]; productId?: string; productName?: string; scout?: boolean }) => call<JobView>('/replica', x),
  products: () => call<ProductView[]>('/products'),
  addNote: (id: string, text: string) => call<ProductView>(`/products/${id}/notes`, { text }),
  removeNote: (id: string, index: number) => call<ProductView>(`/products/${id}/notes/remove`, { index }),
  hidePhoto: (id: string, file: string) => call<ProductView>(`/products/${id}/photos/hide`, { file }),
  slots: (id: string, x: { images: Record<string, string>; angles: Record<string, string>; answers: Record<number, string>; kept: number[]; mode?: 'all' | 'fit' | 'cancel' }) => call<JobView>(`/jobs/${id}/slots`, x),
  restyle: (id: string, style: string) => call<JobView>(`/jobs/${id}/restyle`, { style }),
  voiceover: (id: string) => call<JobView>(`/jobs/${id}/voiceover`, {}),
  saveCopy: (id: string, items: CopyItem[]) => call<JobView>(`/jobs/${id}/copy`, { items }),
  pick: (id: string, index: number) => call<JobView>(`/jobs/${id}/pick`, { index }),
  redo: (id: string, index: number) => call<JobView>(`/jobs/${id}/redo`, { index }),
  resume: (id: string) => call<JobView>(`/jobs/${id}/resume`, {}),
  retry: (id: string) => call<JobView>(`/jobs/${id}/retry`, {})
};

export const readFile = (f: File) => readImage(f);
export const readImage = (f: File) => new Promise<string>((res, rej) => {
  const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f);
});
