// Stage ①: review the original-video breakdown before any recreation.
// Watch the original, check each shot's analysis against it, score it, note problems,
// then fix it by hand or let the model rewrite it from your notes. Everything writes to 「原片镜头」/「复盘备注」.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { BaseCase, BaseNote, FrameMark, Shot } from './base';
import { editNote, markQuotes, patchShot, postNote, removeNote, reviseShot, setNoteStatus } from './base';

const VIEWS = ['第三人称', '主观视角', '无人物'], SIZES = ['大全景', '全景', '中景', '近景', '特写', '大特写'];
const LONG = ['机位与运镜', '构图', '光影', '首帧状态', '主体动作', '动作阶段', '人物眼神', '道具/商品状态', '画面内可见', '与下一镜衔接', '不确定项', '对白/画外音', '原片描述'];
const typing = (e: KeyboardEvent) => (e.target as HTMLElement)?.matches?.('input,textarea,select,[contenteditable=true]');
function applyPatch(s: Shot, patch: Record<string, any>): Shot {
  const n = { ...s, fields: { ...s.fields } };
  for (const [k, v] of Object.entries(patch)) {
    if (k === '分析评分') n.rating = v; else if (k === '分析问题') n.issues = v; else if (k === '人工核对') n.verified = v; else if (k === '备注') n.remark = v; else n.fields[k] = v ?? '';
  }
  return n;
}
const statusClass =(s: Shot) => s.verified === '已核对' ? 'ok' : s.verified === '有疑问' ? 'warn' : s.rating && s.rating <= 2 ? 'bad' : '';

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;

export function ShotReview({ data, header, nav, onShot, onNotes }: { data: BaseCase; header: React.ReactNode; nav: React.ReactNode; onShot: (s: Shot) => void; onNotes: (n: BaseNote[]) => void }) {
  const shots = data.shots;
  const video = useRef<HTMLVideoElement>(null);
  const [cur, setCur] = useState(() => { const id = localStorage.getItem('review-focus-shot'); localStorage.removeItem('review-focus-shot'); return Math.max(0, shots.findIndex(s => s.id === id)); });
  const [time, setTime] = useState(shots[0]?.start || 0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(() => localStorage.getItem('review-shot-loop') === '1');
  const [muted, setMuted] = useState(true);
  const [rate, setRate] = useState(() => Number(localStorage.getItem('review-shot-rate')) || 1);
  const listBox = useRef<HTMLDivElement>(null);
  // Alt+drag over a shot's analysis text opens a bubble to annotate exactly that span; Alt+click a highlight edits it.
  const [bubble, setBubble] = useState<{ shotId: string; quote: string; noteId?: string; body: string; types?: string[]; x: number; y: number; mark?: FrameMark } | null>(null);
  const annots = useMemo(() => data.notes.filter(x => x.stage === '原片拆解' && x.quote), [data.notes]);
  const pick = (e: React.MouseEvent, s: Shot, i: number) => {
    if (!e.altKey) return;
    const sel = window.getSelection(); const text = (sel?.rangeCount ? sel.getRangeAt(0).toString() : '').trim();
    if (!sel || !text || !(e.currentTarget as HTMLElement).querySelector('.promptcopy')?.contains(sel.anchorNode)) return;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (i !== cur) go(i, false);
    setBubble({ shotId: s.id, quote: text, body: '', x: r.left, y: r.bottom });
  };
  const editAnnot = (e: React.MouseEvent, id: string) => {
    if (!e.altKey) return; e.stopPropagation(); e.preventDefault();
    const a = annots.find(x => x.id === id); if (!a) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setBubble({ shotId: a.shotIds[0], quote: a.quote!, noteId: id, body: a.body, types: a.types, x: r.left, y: r.bottom });
  };
  const saveBubble = async (body: string, types: string[]) => {
    const b = bubble; if (!b) return; const s = shots.find(x => x.id === b.shotId)!;
    try {
      if (b.noteId) { await editNote(b.noteId, body, types); onNotes(data.notes.map(x => x.id === b.noteId ? { ...x, body, types } : x)); }
      else {
        const at = b.mark ? b.mark.t : s.start, quote = b.mark ? '' : b.quote;
        const id = await postNote({ caseId: data.case.id, genId: null, at, start: s.start, end: s.end, body, keep: '', change: '', shotIds: [s.id], target: `原片｜${s.code}`, stage: '原片拆解', quote, mark: b.mark, types });
        onNotes([...data.notes, { id, localId: '', at, start: s.start, end: s.end, body, keep: '', change: '', genId: null, shotIds: [s.id], stage: '原片拆解', quote, types, mark: b.mark || null, target: '', createdAt: new Date().toISOString() }]);
      }
      setBubble(null); window.getSelection()?.removeAllRanges();
    } catch (err: any) { alert(`批注没有写入多维表格：${err.message}`); }
  };
  // Alt+drag on the picture draws a circle; it is stored in normalised picture coordinates so letterboxing and resizing don't matter.
  const marks = useMemo(() => data.notes.filter(x => x.stage === '原片拆解' && x.mark), [data.notes]);
  const [stroke, setStroke] = useState<[number, number][] | null>(null);
  const drew = useRef(false);
  const pictureRect = () => {
    const v = video.current!; const r = v.getBoundingClientRect(); const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
    const scale = Math.min(r.width / vw, r.height / vh), w = vw * scale, h = vh * scale;
    return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
  };
  const norm = (e: React.MouseEvent): [number, number] => { const p = pictureRect(); return [Math.min(1, Math.max(0, (e.clientX - p.left) / p.width)), Math.min(1, Math.max(0, (e.clientY - p.top) / p.height))]; };
  const drawStart = (e: React.MouseEvent) => { if (!e.altKey || !video.current) return; e.preventDefault(); setPlaying(false); video.current.pause(); setStroke([norm(e)]); };
  const drawMove = (e: React.MouseEvent) => { if (stroke) setStroke(s => s && [...s, norm(e)]); };
  const drawEnd = (e: React.MouseEvent) => {
    if (!stroke) return; const pts = stroke; setStroke(null);
    if (pts.length < 4) return; drew.current = true;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const mark: FrameMark = { t: Math.round((video.current?.currentTime || time) * 100) / 100, pts: pts.filter((_, i) => i % 2 === 0).map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]), box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(v => Math.round(v * 1000) / 1000) as any };
    const owner = shots.find(s => mark.t >= s.start && mark.t < s.end) || shot;
    setBubble({ shotId: owner.id, quote: `画面 ${fmt(mark.t)} 圈选`, body: '', x: e.clientX, y: e.clientY, mark });
  };
  const openMark = (n: BaseNote, e: React.MouseEvent) => {
    e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setBubble({ shotId: n.shotIds[0], quote: `画面 ${fmt(n.mark!.t)} 圈选`, noteId: n.id, body: n.body, types: n.types, x: r.left, y: r.bottom, mark: n.mark! });
  };
  const seekMark = (t: number) => { setPlaying(false); video.current?.pause(); if (video.current) video.current.currentTime = t; setTime(t); const i = shots.findIndex(s => t >= s.start && t < s.end); if (i >= 0) setCur(i); };
  const shownMarks = marks.filter(n => Math.abs(time - n.mark!.t) < (playing ? 0.12 : 0.25));
  const dropBubble = async () => {
    const b = bubble; if (!b?.noteId) return setBubble(null);
    try { await removeNote(b.noteId); onNotes(data.notes.filter(x => x.id !== b.noteId)); setBubble(null); } catch (err: any) { alert(err.message); }
  };
  const shot = shots[cur];
  const listRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const go = (i: number, play = playing) => {
    const k = Math.max(0, Math.min(shots.length - 1, i)); setCur(k);
    if (video.current) { video.current.currentTime = shots[k].start + 0.01; setTime(shots[k].start); }
    if (play) video.current?.play().catch(() => {});
  };
  // rAF instead of timeupdate: shots can be 0.2s long, timeupdate fires only every ~250ms
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = video.current; if (!v) return;
      const t = v.currentTime; setTime(t);
      const s = shots[cur];
      if (loop && s && t >= s.end - 0.03) v.currentTime = s.start + 0.01;
      else if (!loop) { const i = shots.findIndex(x => t >= x.start && t < x.end); if (i >= 0 && i !== cur) setCur(i); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, [playing, loop, cur, shots]);
  useEffect(() => { const v = video.current; if (!v) return; playing ? v.play().catch(() => setPlaying(false)) : v.pause(); }, [playing]);
  // Scroll only the shot list itself: scrollIntoView would also scroll the clipped page and push the header off screen.
  useEffect(() => {
    const box = listBox.current, el = shot && listRefs.current[shot.id]; if (!box || !el) return;
    const top = el.offsetTop - box.offsetTop, bottom = top + el.offsetHeight;
    if (top < box.scrollTop) box.scrollTo({ top, behavior: 'smooth' });
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTo({ top: bottom - box.clientHeight, behavior: 'smooth' });
  }, [shot?.id]);
  useEffect(() => { if (video.current) video.current.playbackRate = rate; localStorage.setItem('review-shot-rate', String(rate)); }, [rate]);
  const RATES = [0.25, 0.5, 1, 1.5, 2];
  const stepRate = (d: number) => setRate(r => RATES[Math.max(0, Math.min(RATES.length - 1, RATES.indexOf(r) + d))] ?? 1);

  // Apply edits optimistically and merge only the patched keys back, so quick successive edits
  // (rating, then an issue chip) don't overwrite each other with a stale copy of the shot.
  const latest = useRef(shots); latest.current = shots;
  const save = async (patch: Record<string, any>) => {
    if (!shot) return; const id = shot.id;
    const now = () => latest.current.find(x => x.id === id)!;
    onShot(applyPatch(now(), patch));
    try { const back = await patchShot(id, patch); onShot({ ...applyPatch(now(), patch), text: back.text, original: back.original }); }
    catch (e: any) { alert(`没有写入多维表格：${e.message}`); }
  };
  const setVerified = (v: string) => save({ '人工核对': v });
  const setRating = (n: number | null) => save({ '分析评分': n });

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      if (k === ' ') { e.preventDefault(); setPlaying(p => !p); }
      else if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); go(cur + (k === 'ArrowLeft' ? -1 : 1)); }
      else if (/^[0-5]$/.test(k)) { e.preventDefault(); setRating(k === '0' ? null : Number(k)); }
      else if (k === 'v' || k === 'V') { e.preventDefault(); setVerified(shot.verified === '已核对' ? '未核对' : '已核对'); }
      else if (k === 'q' || k === 'Q') { e.preventDefault(); setVerified(shot.verified === '有疑问' ? '未核对' : '有疑问'); }
      else if (k === '[' || k === ']') { e.preventDefault(); stepRate(k === '[' ? -1 : 1); }
      else if (k === 'l' || k === 'L') { e.preventDefault(); setLoop(x => { localStorage.setItem('review-shot-loop', x ? '0' : '1'); return !x; }); }
    };
    window.addEventListener('keydown', fn); return () => window.removeEventListener('keydown', fn);
  });

  const verified = shots.filter(s => s.verified === '已核对').length;
  const rated = shots.filter(s => s.rating);
  const avg = rated.length ? (rated.reduce((a, s) => a + (s.rating || 0), 0) / rated.length).toFixed(1) : '—';
  const total = data.case.duration || shots[shots.length - 1]?.end || 1;

  if (!shot) return <div className="app">{nav}<main className="work review">{header}<div className="empty"><div><h2>这个案例还没有原片镜头</h2><p>回到首页点「用 GPT 拆解镜头」。</p></div></div></main></div>;
  return <div className="app">{nav}
    <main className="work review">
      {header}
      <section className="reviewStage">
        <div className={`video audioToggle ${muted ? 'muted' : 'audible'} ${stroke ? 'drawing' : ''}`} onClick={() => { if (drew.current) { drew.current = false; return; } setMuted(m => !m); }} onMouseDown={drawStart} onMouseMove={drawMove} onMouseUp={drawEnd} onMouseLeave={drawEnd} title="Alt+拖动 在画面上圈选并备注">
          <div className="badge">原片｜{shot.code}｜{shot.start.toFixed(2)}–{shot.end.toFixed(2)}s</div>
          <div className="audioBadge">{muted ? '🔇 点击开启声音' : '🔊 声音已开启'}</div>
          <video ref={video} src={data.case.source?.url} muted={muted} playsInline onLoadedMetadata={e => { e.currentTarget.currentTime = shots[cur].start + 0.01; e.currentTarget.playbackRate = rate; }} onPause={() => setPlaying(false)} onPlay={() => setPlaying(true)} />
          {(stroke || shownMarks.length > 0) && video.current && (() => { const p = pictureRect(), host = video.current.parentElement!.getBoundingClientRect(); return <div className="markLayer" style={{ left: p.left - host.left, top: p.top - host.top, width: p.width, height: p.height }}>
            <svg viewBox="0 0 1 1" preserveAspectRatio="none">
              {shownMarks.map(n => <polyline key={n.id} points={n.mark!.pts.map(q => q.join(',')).join(' ')} className="markPath" />)}
              {stroke && <polyline points={stroke.map(q => q.join(',')).join(' ')} className="markPath live" />}
            </svg>
            {shownMarks.map(n => <button key={n.id} className="markTag" style={{ left: `${n.mark!.box[2] * 100}%`, top: `${n.mark!.box[1] * 100}%` }} onMouseDown={e => e.stopPropagation()} onClick={e => openMark(n, e)} title="点击编辑或删除">✎ {n.body.slice(0, 18)}{n.body.length > 18 ? '…' : ''}</button>)}
          </div>; })()}
        </div>
        <div className="stripBar"><div className="shotStrip" title="绿=已核对 黄=有疑问 红=评分≤2">
          {shots.map((s, i) => <button key={s.id} className={`${statusClass(s)} ${i === cur ? 'cur' : ''}`} style={{ left: `${s.start / total * 100}%`, width: `${(s.end - s.start) / total * 100}%` }} onClick={() => go(i)} title={`${s.code} ${s.start}–${s.end}s`} />)}
          <i className="playhead" style={{ left: `${time / total * 100}%` }} />
          {marks.map(n => <i key={n.id} className="markDot" style={{ left: `${n.mark!.t / total * 100}%` }} title={`${fmt(n.mark!.t)} 画面圈选：${n.body}`} onClick={() => seekMark(n.mark!.t)} />)}
        </div>
        <span className="stripTime">{fmt(time)} / {fmt(total)}<small>本镜 {Math.max(0, time - shot.start).toFixed(2)} / {(shot.end - shot.start).toFixed(2)}s</small></span>
        <div className="rates" title="倍速（[ 减速　] 加速）">{RATES.map(r => <button key={r} className={r === rate ? 'on' : ''} onClick={() => setRate(r)}>{r}×</button>)}</div></div>
      </section>
      <section className="prompt shotList">
        <b>原片镜头分析｜已核对 {verified}/{shots.length}｜平均分 {avg}</b>
        <div className="promptScroll" ref={listBox}>{shots.map((s, i) => { const mine = annots.filter(a => a.shotIds.includes(s.id)); return <div role="button" key={s.id} ref={el => { listRefs.current[s.id] = el as any; }} className={`row ${i === cur ? 'active' : ''} ${statusClass(s)}`} onMouseUp={e => pick(e, s, i)} onClick={e => { if (!e.altKey && !window.getSelection()?.toString()) go(i); }}>
          <span>{s.code}｜{s.start.toFixed(1)}–{s.end.toFixed(1)}s{s.rating ? ` ★${s.rating}` : ''}{s.verified === '已核对' ? ' ✓' : s.verified === '有疑问' ? ' ?' : ''}{mine.length ? ` ✎${mine.length}` : ''}</span><span className="promptcopy">{markQuotes(s.text, mine).map((r, k) => r.noteId
            ? <mark key={k} data-note={r.noteId} className="annot" title={`${mine.find(a => a.id === r.noteId)?.body}（Alt+点击编辑）`} onMouseDown={e => { if (e.altKey) e.preventDefault(); }} onClick={e => editAnnot(e, r.noteId!)}>{r.text}</mark>
            : <React.Fragment key={k}>{r.text}</React.Fragment>)}</span>
        </div>; })}</div>
        {bubble && <AnnotBubble key={bubble.noteId || bubble.quote} b={bubble} typeOptions={data.scoreMeta.noteTypes || []} onSave={saveBubble} onDelete={dropBubble} onClose={() => setBubble(null)} />}
      </section>
      <div className="controls">
        <button onClick={() => setPlaying(p => !p)}>{playing ? '❚❚' : '▶'}</button><span>{time.toFixed(2)}s</span>
        <button className="secondary" onClick={() => go(cur - 1)}>上一镜</button><button className="secondary" onClick={() => go(cur + 1)}>下一镜</button>
        <label className="continuous"><input type="checkbox" checked={loop} onChange={e => { setLoop(e.target.checked); localStorage.setItem('review-shot-loop', e.target.checked ? '1' : '0'); }} />循环当前镜头</label>
        <small className="shortcutHint">空格 播放　←/→ 上/下一镜　Alt+划词 批注　Alt+拖画面 圈选　[ / ] 倍速　1–5 评分　V 已核对　Q 有疑问　L 循环</small>
      </div>
    </main>
    <ShotPanel key={shot.id} data={data} shot={shot} onShot={onShot} onNotes={onNotes} save={save} setVerified={setVerified} setRating={setRating} time={time} onSeek={seekMark} />
  </div>;
}

function HighlightArea({ value, quotes, rows, readOnly, onChange, onBlur }: { value: string; quotes: string[]; rows: number; readOnly: boolean; onChange: (v: string) => void; onBlur: () => void }) {
  const back = useRef<HTMLDivElement>(null);
  const runs = markQuotes(value, quotes.map((q, i) => ({ id: String(i), quote: q })));
  return <div className={`hlArea ${readOnly ? 'locked' : ''}`}>
    <div className="hlBack" ref={back} aria-hidden>{runs.map((r, i) => r.noteId ? <mark key={i}>{r.text}</mark> : <span key={i}>{r.text}</span>)}{'\n'}</div>
    <textarea rows={rows} value={value} readOnly={readOnly} onChange={e => onChange(e.target.value)} onBlur={onBlur} onScroll={e => { if (back.current) back.current.scrollTop = e.currentTarget.scrollTop; }} />
  </div>;
}

function AnnotBubble({ b, typeOptions, onSave, onDelete, onClose }: { b: { quote: string; noteId?: string; body: string; types?: string[]; x: number; y: number }; typeOptions: string[]; onSave: (body: string, types: string[]) => Promise<void>; onDelete: () => void; onClose: () => void }) {
  const [body, setBody] = useState(b.body); const [busy, setBusy] = useState(false);
  const [types, setTypes] = useState<string[]>(b.types || []);
  const x = Math.max(8, Math.min(b.x, window.innerWidth - 380)), below = b.y + 230 < window.innerHeight;
  const save = async () => { if (!body.trim()) return; setBusy(true); await onSave(body.trim(), types); setBusy(false); };
  return <div className="annotBubble" style={below ? { left: x, top: b.y + 8 } : { left: x, bottom: window.innerHeight - b.y + 30 }} onMouseUp={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
    <q>{b.quote}</q>
    <textarea autoFocus value={body} onChange={e => setBody(e.target.value)} placeholder="画面里实际是什么？例如：首帧就有手和相机，不是突然伸入" onKeyDown={e => { if (e.key === 'Escape') onClose(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); }} />
    {typeOptions.length > 0 && <div className="typeChips" title="这是拆解的哪类错误？用于按提示词版本/模型统计">{typeOptions.map(t => <button key={t} type="button" className={types.includes(t) ? 'on' : ''} onClick={() => setTypes(ts => ts.includes(t) ? ts.filter(x => x !== t) : [...ts, t])}>{t}</button>)}</div>}
    <div className="right">{b.noteId && <button className="secondary danger" disabled={busy} onClick={onDelete}>取消批注</button>}<button className="secondary" onClick={onClose}>关闭</button><button disabled={busy || !body.trim()} onClick={save}>{busy ? '保存中…' : b.noteId ? '保存修改' : '保存批注'}</button></div>
    <small>Ctrl+Enter 保存　Esc 关闭</small>
  </div>;
}

function ShotPanel({ data, shot, onShot, onNotes, save, setVerified, setRating, time, onSeek }: { data: BaseCase; shot: Shot; onShot: (s: Shot) => void; onNotes: (n: BaseNote[]) => void; save: (p: Record<string, any>) => Promise<void>; setVerified: (v: string) => void; setRating: (n: number | null) => void; time: number; onSeek: (t: number) => void }) {
  const [draft, setDraft] = useState<Record<string, any>>(shot.fields);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [proposal, setProposal] = useState<{ fields: Record<string, string>; reason: string; model: string } | null>(null);
  const [zoom, setZoom] = useState(false);
  const notes = useMemo(() => data.notes.filter(n => n.shotIds.includes(shot.id) && n.stage === '原片拆解'), [data.notes, shot.id]);
  useEffect(() => setDraft(shot.fields), [shot.fields]);
  // A field holding a quoted annotation is locked so the quote keeps pointing at real text; unlock on purpose.
  const [unlocked, setUnlocked] = useState<Set<string>>(new Set());
  const quotesIn = (k: string) => notes.filter(n => n.quote && String(shot.fields[k] || '').includes(n.quote));
  const original = shot.original || {};
  const reset = (k: string) => { if (!(k in original)) return; setDraft({ ...draft, [k]: original[k] }); save({ [k]: original[k] || null }); };
  const resetBtn = (k: string) => k in original ? <button type="button" className="resetField" title={`恢复为初始分析：${String(original[k] || '（空）').slice(0, 80)}`} onClick={e => { e.preventDefault(); if (confirm(`把「${k}」恢复成初始分析？`)) reset(k); }}>↺</button> : null;

  const commit = (k: string) => { if ((draft[k] || '') !== (shot.fields[k] || '')) save({ [k]: draft[k] }); };
  const toggleIssue = (x: string) => save({ '分析问题': shot.issues.includes(x) ? shot.issues.filter(y => y !== x) : [...shot.issues, x] });
  const addNote = async () => {
    if (!note.trim()) return; setBusy('note');
    try {
      const id = await postNote({ caseId: data.case.id, genId: null, at: time, start: shot.start, end: shot.end, body: note, keep: '', change: '', shotIds: [shot.id], target: `原片｜${shot.code}`, stage: '原片拆解' });
      onNotes([...data.notes, { id, localId: '', at: time, start: shot.start, end: shot.end, body: note, keep: '', change: '', genId: null, shotIds: [shot.id], stage: '原片拆解', target: '', createdAt: new Date().toISOString() }]); setNote('');
    } catch (e: any) { alert(e.message); } finally { setBusy(''); }
  };
  const askAI = async () => {
    setBusy('ai'); setProposal(null);
    try { setProposal(await reviseShot(shot.id, { notes: [...notes.filter(n => !n.mark && n.status !== '已修正').map(n => n.quote ? `针对原文「${n.quote}」：${n.body}` : n.body), note].filter(Boolean), issues: shot.issues, marks: notes.filter(n => n.mark && n.status !== '已修正').map(n => ({ t: n.mark!.t, box: n.mark!.box, body: n.body })) })); }
    catch (e: any) { alert(`模型修改失败：${e.message}`); } finally { setBusy(''); }
  };
  const accept = async (keys: string[]) => {
    if (!proposal) return; setBusy('accept');
    const patch = Object.fromEntries(keys.map(k => [k, proposal.fields[k]]));
    // The old rating/issues/verification describe the text being replaced, so archive them in 备注 and start a new review round.
    // Notes are kept (they are the evidence for the prompt-version stats) but marked 已修正 so they are not sent again.
    const open = notes.filter(n => n.status !== '已修正');
    const old = `修订前：${shot.verified || '未核对'}｜评分 ${shot.rating ?? '—'}｜问题 ${shot.issues.join('、') || '无'}｜批注 ${open.length} 条`;
    const remark = `【${new Date().toLocaleDateString()} AI 按审核意见修改】${proposal.reason}\n${old}`;
    await save({ ...patch, '备注': shot.remark ? `${shot.remark}\n${remark}` : remark, '分析评分': null, '分析问题': [], '人工核对': '未核对' });
    await Promise.all(open.map(n => setNoteStatus(n.id, '已修正').catch(() => {})));
    onNotes(data.notes.map(n => open.some(o => o.id === n.id) ? { ...n, status: '已修正' } : n));
    setProposal(null); setBusy('');
  };
  const changed = proposal ? Object.keys(proposal.fields).filter(k => (proposal.fields[k] || '') !== (shot.fields[k] || '')) : [];

  return <aside className="notes shotPanel">
    <header><b>{shot.code}｜镜头核对</b><span title="生成这条分析的模型与拆解提示词版本（见左侧 ⚙ 拆解设置）">{shot.source}{shot.promptId && data.prompts?.[shot.promptId] ? `｜拆解 ${data.prompts[shot.promptId]}` : ''}</span></header>
    <div className="list">
      {shot.sampling && <small className="hint sampling" title="拆解时这个镜头看了几帧、为什么加密">🎞 {shot.sampling}</small>}
      {shot.keyframe && <img className="keyframe" src={shot.keyframe.url} alt="" onClick={() => setZoom(true)} title="点击放大" />}
      <div className="verifyRow">
        {['未核对', '已核对', '有疑问'].map(v => <button key={v} className={shot.verified === v ? `on v${v}` : ''} onClick={() => setVerified(v)}>{v}</button>)}
      </div>
      <div className="dimHead"><b>分析准确度</b><span className="stars">{[1, 2, 3, 4, 5].map(n => <button key={n} className={(shot.rating || 0) >= n ? 'on' : ''} onClick={() => setRating(shot.rating === n ? null : n)}>★</button>)}</span></div>
      {data.scoreMeta.shotRatingHint && <small className="hint">{data.scoreMeta.shotRatingHint}</small>}
      <div className="chips">{data.scoreMeta.shotIssues.map(x => <button key={x} className={shot.issues.includes(x) ? 'on veto' : ''} onClick={() => toggleIssue(x)}>{x}</button>)}</div>

      <div className="noteBox">
        <b>审核备注 <small>{notes.some(n => n.quote) ? `划词批注 ${notes.filter(n => n.quote).length} 条｜` : ''}Alt+划选下方分析文字可直接批注</small></b>
        {notes.map(n => <article key={n.id} className={n.quote || n.mark ? 'quoted' : ''} onMouseEnter={() => document.querySelector(`mark[data-note="${n.id}"]`)?.classList.add('flash')} onMouseLeave={() => document.querySelector(`mark[data-note="${n.id}"]`)?.classList.remove('flash')}>{n.mark && <q className="frameQ" onClick={() => onSeek(n.mark!.t)} title="跳到这一帧">🎯 画面 {n.mark.t.toFixed(2)}s 圈选</q>}{n.quote && <q>{n.quote}{!shot.text.includes(n.quote) && <em className="stale">原文已改</em>}</q>}<button className="deleteNote" onClick={async () => { await removeNote(n.id); onNotes(data.notes.filter(x => x.id !== n.id)); }}>删除</button>{n.status && n.status !== '待处理' && <div className={`noteStatus s-${n.status}`}>{n.status === '已修正' ? '已修正，待复核' : '复核后仍存在'}
          <button onClick={async () => { const s = n.status === '已修正' ? '仍存在' : '已修正'; await setNoteStatus(n.id, s); onNotes(data.notes.map(x => x.id === n.id ? { ...x, status: s } : x)); }}>{n.status === '已修正' ? '标为仍存在' : '标为已修正'}</button></div>}
        {(n.types || []).length > 0 && <div className="typeTags">{n.types!.map(t => <em key={t}>{t}</em>)}</div>}<p>{n.body}</p></article>)}
        <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="哪里写错了？例如：不是第一人称，是右前方斜俯；纸上画满线稿" />
        <div className="right"><button className="secondary" disabled={!note.trim() || !!busy} onClick={addNote}>{busy === 'note' ? '保存中…' : '保存备注'}</button><button disabled={!!busy || (!notes.length && !note.trim() && !shot.issues.length)} onClick={askAI}>{busy === 'ai' ? 'GPT 修改中…（约半分钟）' : '让 GPT 按备注修改'}</button></div>
      </div>

      {proposal && <div className="proposal">
        <b>修改建议｜{proposal.model}</b><p className="reason">{proposal.reason}</p>
        {changed.length === 0 && <p className="muted">模型认为不需要改。</p>}
        {changed.map(k => <div key={k} className="diff"><span>{k}</span><del>{String(shot.fields[k] || '（空）')}</del><ins>{proposal.fields[k]}</ins></div>)}
        <div className="right"><button className="secondary" onClick={() => setProposal(null)}>放弃</button>{changed.length > 0 && <button disabled={busy === 'accept'} onClick={() => accept(changed)}>{busy === 'accept' ? '写入中…' : '全部采用'}</button>}</div>
      </div>}

      <div className="fields">
        <div className="grid">
          <label>景别{resetBtn('景别')}<select value={draft['景别'] || ''} onChange={e => { setDraft({ ...draft, 景别: e.target.value }); save({ '景别': e.target.value || null }); }}><option value="">—</option>{SIZES.map(x => <option key={x}>{x}</option>)}</select></label>
          <label>视角{resetBtn('视角')}<select value={draft['视角'] || ''} onChange={e => { setDraft({ ...draft, 视角: e.target.value }); save({ '视角': e.target.value || null }); }}><option value="">—</option>{VIEWS.map(x => <option key={x}>{x}</option>)}</select></label>
        </div>
        {LONG.map(k => { const qs = quotesIn(k), locked = qs.length > 0 && !unlocked.has(k); return <label key={k} className={qs.length ? 'annotated' : ''}>
          <span className="fieldHead">{k}{qs.length > 0 && <em>✎ {qs.length} 条批注</em>}{qs.length > 0 && <button type="button" className="lockField" title={locked ? '有批注，已锁定。点击解锁后可以编辑（批注可能对不上原文）' : '点击重新锁定'} onClick={e => { e.preventDefault(); if (locked && !confirm('解锁后修改这段文字，划词批注的高亮可能对不上。继续？')) return; setUnlocked(u => { const n = new Set(u); locked ? n.add(k) : n.delete(k); return n; }); }}>{locked ? '🔒' : '🔓'}</button>}{resetBtn(k)}</span>
          <HighlightArea rows={k === '原片描述' || k === '主体动作' ? 4 : 2} value={draft[k] || ''} quotes={qs.map(n => n.quote!)} readOnly={locked} onChange={v => setDraft({ ...draft, [k]: v })} onBlur={() => commit(k)} />
        </label>; })}
        <small className="hint">文字框离开焦点即保存到多维表格。有批注的字段会锁定（🔒）；改过的字段旁有 ↺，可恢复成初始分析。</small>
      </div>
    </div>
    {zoom && shot.keyframe && <div className="modal" onClick={() => setZoom(false)}><img className="zoomed" src={shot.keyframe.url} alt="" /></div>}
  </aside>;
}
