// Side-panel scoring for the selected generation record; writes straight to 「生成记录」 in the Base.
// Keys (when not typing): ↑/↓ pick a dimension, 1–5 score it, 0 clears it.
import React, { useEffect, useRef, useState } from 'react';
import type { Scores, ScoreMeta } from './base';
import { patchScores } from './base';

const WEIGHTS = [0.3, 0.25, 0.15, 0.1, 0.05, 0.15]; // same weights as the 人工总分 formula
export function estimate(meta: ScoreMeta, s: Scores) {
  const v = meta.dims.map(d => s.dims[d.key]);
  if (v.some(x => !x)) return { total: '', verdict: s.veto.length ? '❌不可用' : '待评分' };
  const total = Math.round(v.reduce((a, x, i) => a + (x as number) * WEIGHTS[i], 0) * 20 * 10) / 10;
  return { total: String(total), verdict: s.veto.length ? '❌不可用' : total >= 80 ? '✅可用' : total >= 60 ? '⚠️需修' : '❌不可用' };
}

export function ScorePanel({ genId, label, meta, scores, onSaved, tabs }: { genId: string; label: string; meta: ScoreMeta; scores: Scores; onSaved: (s: Scores) => void; tabs: React.ReactNode }) {
  const [s, setS] = useState(scores);
  const [cur, setCur] = useState(0);
  const [status, setStatus] = useState('');
  const pending = useRef<Partial<Scores> & { dims?: Record<string, number | null> }>({});
  const timer = useRef<any>();
  useEffect(() => { setS(scores); setStatus(''); pending.current = {}; }, [genId]);

  const save = (patch: Partial<Scores>) => {
    const next = { ...s, ...patch, dims: { ...s.dims, ...(patch.dims || {}) } };
    setS(next);
    pending.current = { ...pending.current, ...patch, dims: { ...(pending.current.dims || {}), ...(patch.dims || {}) } };
    setStatus('保存中…');
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const body = pending.current; pending.current = {};
      try { const back = await patchScores(genId, body); setS(back); onSaved(back); setStatus('已写入多维表格'); }
      catch (e: any) { setStatus(`写入失败：${e.message}`); }
    }, 500);
  };
  const setDim = (i: number, v: number | null) => save({ dims: { [meta.dims[i].key]: v } });
  const toggle = (k: 'veto' | 'tags', x: string) => save({ [k]: s[k].includes(x) ? s[k].filter(y => y !== x) : [...s[k], x] } as any);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.matches('input,textarea,select,[contenteditable=true]')) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); setCur(c => (c + (e.key === 'ArrowUp' ? -1 : 1) + meta.dims.length) % meta.dims.length); }
      else if (/^[0-5]$/.test(e.key)) { e.preventDefault(); setDim(cur, e.key === '0' ? null : Number(e.key)); }
    };
    window.addEventListener('keydown', fn); return () => window.removeEventListener('keydown', fn);
  });

  const est = estimate(meta, s);
  const total = status === '已写入多维表格' ? s.total : est.total, verdict = status === '已写入多维表格' ? s.verdict : est.verdict;
  return <aside className="notes scorePanel">
    <header>{tabs}<span className={status.startsWith('写入失败') ? 'err' : ''}>{status}</span></header>
    <div className="list">
      <p className="scoreFor">{label}</p>
      {meta.dims.map((d, i) => <div key={d.key} className={`dim ${i === cur ? 'cur' : ''}`} onClick={() => setCur(i)}>
        <div className="dimHead"><b>{d.label}</b><span className="stars">{[1, 2, 3, 4, 5].map(n => <button key={n} className={(s.dims[d.key] || 0) >= n ? 'on' : ''} onClick={e => { e.stopPropagation(); setCur(i); setDim(i, s.dims[d.key] === n ? null : n); }}>★</button>)}</span></div>
        {i === cur && <small>{d.hint}</small>}
      </div>)}
      <div className="chips"><b>一票否决</b>{meta.veto.map(x => <button key={x} className={s.veto.includes(x) ? 'on veto' : ''} onClick={() => toggle('veto', x)}>{x}</button>)}</div>
      <div className="chips"><b>问题标签</b>{meta.tags.map(x => <button key={x} className={s.tags.includes(x) ? 'on' : ''} onClick={() => toggle('tags', x)}>{x}</button>)}</div>
    </div>
    <div className="scoreFoot"><div><span>人工总分</span><b>{total || '—'}</b></div><div><span>判定</span><b>{verdict}</b></div><small>↑/↓ 选维度　1–5 打分　0 清空　S 切换备注/打分</small></div>
  </aside>;
}
