import { describe, expect, it } from 'vitest';
import { saveProject, loadProject, listProjects, deleteProject } from './storage';
import { createProject } from './model';

describe('project storage', () => {
  it('persists, lists and deletes projects', () => {
    localStorage.clear();
    const p = createProject({ name:'Stored', source:{name:'s',url:'s',duration:1}, recreation:{name:'r',url:'r',duration:1}, promptText:'0-1 x', sessionId:'' });
    saveProject(p);
    expect(loadProject(p.id)?.name).toBe('Stored');
    expect(listProjects()).toHaveLength(1);
    deleteProject(p.id);
    expect(loadProject(p.id)).toBeNull();
  });
});
