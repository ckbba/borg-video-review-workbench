export type Media = { name: string; url: string; duration: number };
export type Passage = { id: string; start: number; end: number; text: string };
export type PromptVersion = { version: number; text: string; passages: Passage[] };
export type Recreation = Media & { id: string; attemptNo: number; label: string; promptVersion: number; sourceOffset?: number; sourceEnd?: number };
export type ReviewNote = { id: string; at: number; start: number; end: number; body: string; keep: string; change: string; recreationId: string; promptVersion: number; createdAt: string };
export type Project = { id: string; name: string; source: Media; recreations: Recreation[]; selectedRecreationId: string; promptVersions: PromptVersion[]; notes: ReviewNote[]; sessionId: string; createdAt: string };

const id = () => crypto.randomUUID();

export function parsePrompt(text: string): Passage[] {
  const passages: Passage[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^(\d+(?:\.\d+)?)\s*(?:-|–|—|~|至)\s*(\d+(?:\.\d+)?)\s*(?:秒|[sS](?=\s|[:：]|$))?\s*[:：]?\s*(.*)$/);
    if (match) passages.push({ id: id(), start: Number(match[1]), end: Number(match[2]), text: match[3] || line });
    else passages.push({ id: id(), start: index * 5, end: (index + 1) * 5, text: line });
  }
  return passages;
}

export function createProject(input: { name: string; source: Media; recreation: Media; promptText: string; sessionId: string }): Project {
  const recreationId = id();
  return {
    id: id(), name: input.name, source: input.source,
    recreations: [{ ...input.recreation, id: recreationId, attemptNo: 1, label: '复刻 V1', promptVersion: 1 }],
    selectedRecreationId: recreationId,
    promptVersions: [{ version: 1, text: input.promptText, passages: parsePrompt(input.promptText) }],
    notes: [], sessionId: input.sessionId, createdAt: new Date().toISOString()
  };
}

export function addRecreation(project: Project, media: Media, label = ''): Project {
  const recreation: Recreation = { ...media, id: id(), attemptNo: project.recreations.length + 1, label: label || `复刻 V${project.recreations.length + 1}`, promptVersion: project.promptVersions.at(-1)?.version || 1 };
  return { ...project, recreations: [...project.recreations, recreation], selectedRecreationId: recreation.id };
}

export function addNote(project: Project, input: Omit<ReviewNote, 'id'|'recreationId'|'promptVersion'|'createdAt'>): Project {
  const recreation = project.recreations.find(r => r.id === project.selectedRecreationId)!;
  const note: ReviewNote = { ...input, id: id(), recreationId: recreation.id, promptVersion: recreation.promptVersion, createdAt: new Date().toISOString() };
  return { ...project, notes: [...project.notes, note] };
}

export function deleteNote(project: Project, noteId: string): Project {
  return { ...project, notes: project.notes.filter(note => note.id !== noteId) };
}

export function currentPassage(passages: Passage[], time: number) { return passages.find(p => time >= p.start && time < p.end); }

export function exportReview(project: Project) {
  const recreation = project.recreations.find(r => r.id === project.selectedRecreationId)!;
  const notes = project.notes.filter(n=>n.recreationId===recreation.id).map(n => {
    const passage = project.promptVersions.find(p=>p.version===n.promptVersion)?.passages.find(p=>n.at>=p.start&&n.at<p.end);
    return { ...n, context: { sourceAsset: project.source.name, recreationAsset: recreation.name, recreationId: recreation.id, anchorSec: n.at, sourceRangeSec: [n.start,n.end], recreationLocalRangeSec: [Math.max(0,n.start-(recreation.sourceOffset||0)),Math.max(0,n.end-(recreation.sourceOffset||0))], promptVersion: n.promptVersion, promptPassageId: passage?.id || null, promptExcerpt: passage?.text || '', sessionId: project.sessionId || null } };
  });
  const json = { schemaVersion:'1.1', projectId:project.id, projectName:project.name, source:project.source, recreation, sessionId:project.sessionId, promptVersion:recreation.promptVersion, prompt:project.promptVersions.find(p=>p.version===recreation.promptVersion), notes };
  const lines = [`# ${project.name} 复盘`, '', `- 原片：${project.source.name}`, `- 复刻：${recreation.name}`, `- 原 Hermes Session：${project.sessionId || '未绑定'}`, `- 提示词版本：V${recreation.promptVersion}`, '', '## 时间点备注'];
  for (const n of json.notes) lines.push('', `### ${n.start.toFixed(1)}–${n.end.toFixed(1)}s`, n.body, `- 保留：${n.keep || '未填写'}`, `- 修改：${n.change || '未填写'}`);
  return { json, markdown: lines.join('\n') };
}
