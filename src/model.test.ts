import { describe, expect, it } from 'vitest';
import { createProject, addRecreation, addNote, deleteNote, currentPassage, exportReview } from './model';

describe('review workbench model', () => {
  it('creates a project with source and first recreation bound to prompt version', () => {
    const project = createProject({
      name: 'Fold8',
      source: { name: 'source.mp4', url: 'blob:source', duration: 30 },
      recreation: { name: 'v1.mp4', url: 'blob:v1', duration: 30 },
      promptText: '0-4.2 城市开场\n4.2-8.2 人物走出店门',
      sessionId: '20261028_demo'
    });
    expect(project.source.name).toBe('source.mp4');
    expect(project.recreations[0].promptVersion).toBe(1);
    expect(project.promptVersions[0].passages).toHaveLength(2);
  });

  it('adds a new recreation as another immutable attempt', () => {
    const project = createProject({ name:'x', source:{name:'s',url:'s',duration:10}, recreation:{name:'r1',url:'r1',duration:10}, promptText:'0-10 test', sessionId:'' });
    const next = addRecreation(project, { name:'r2', url:'r2', duration:9 }, 'V2');
    expect(next.recreations).toHaveLength(2);
    expect(next.recreations[1].attemptNo).toBe(2);
    expect(project.recreations).toHaveLength(1);
  });

  it('finds prompt passage by playback time', () => {
    const project = createProject({ name:'x', source:{name:'s',url:'s',duration:10}, recreation:{name:'r',url:'r',duration:10}, promptText:'0-4.2 first\n4.2-8.2 second', sessionId:'' });
    expect(currentPassage(project.promptVersions[0].passages, 5)?.text).toBe('second');
  });

  it('deletes one note without touching the others', () => {
    let project = createProject({ name:'x', source:{name:'s',url:'s',duration:10}, recreation:{name:'r',url:'r',duration:10}, promptText:'0-10 test', sessionId:'sid' });
    project = addNote(project, { at:2, start:1, end:3, body:'one', keep:'', change:'' });
    project = addNote(project, { at:5, start:4, end:6, body:'two', keep:'', change:'' });
    const next = deleteNote(project, project.notes[0].id);
    expect(next.notes.map(n=>n.body)).toEqual(['two']);
  });

  it('exports note context so another agent can resolve its timestamp and prompt', () => {
    let project = createProject({ name:'x', source:{name:'source.mp4',url:'/source.mp4',duration:10}, recreation:{name:'rec.mp4',url:'/rec.mp4',duration:10}, promptText:'0-10 test', sessionId:'sid' });
    project = addNote(project, { at:5, start:4, end:6, body:'推进太快', keep:'人物', change:'运镜' });
    const item:any = exportReview(project,[{id:'source-shot',start:0,end:10,text:'原片固定机位'}]).json.notes[0];
    expect(item.context).toMatchObject({sourceAsset:'source.mp4',recreationAsset:'rec.mp4',anchorSec:5,promptVersion:1,sourceAnalysisExcerpt:'原片固定机位'});
    expect(item.context.promptExcerpt).toBe('test');
  });

  it('stores a note with exact context and exports review', () => {
    let project = createProject({ name:'x', source:{name:'s',url:'s',duration:10}, recreation:{name:'r',url:'r',duration:10}, promptText:'0-10 test', sessionId:'sid' });
    project = addNote(project, { at:5, start:4, end:6, body:'推进太快', keep:'人物表演', change:'运镜' });
    const exported = exportReview(project);
    expect(exported.json.notes[0].promptVersion).toBe(1);
    expect(exported.markdown).toContain('推进太快');
    expect(exported.markdown).toContain('sid');
  });
});
