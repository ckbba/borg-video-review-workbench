import type { Project } from './model';
const KEY = 'borg-video-review-projects-v1';

export function listProjects(): Project[] {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
export function saveProject(project: Project) {
  const all = listProjects();
  const index = all.findIndex(p => p.id === project.id);
  if (index >= 0) all[index] = project; else all.unshift(project);
  localStorage.setItem(KEY, JSON.stringify(all));
}
export function loadProject(id: string) { return listProjects().find(p => p.id === id) || null; }
export function deleteProject(id: string) { localStorage.setItem(KEY, JSON.stringify(listProjects().filter(p => p.id !== id))); }
