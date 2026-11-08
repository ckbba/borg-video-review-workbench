// One generation record laid out for auditing: the source/recreation split it was reviewed with, the assets it was
// given (in @图片N order) and the full prompt, with each @图片N replaced by a thumbnail of that asset where it is used.
// The split and the assets stay pinned while the prompt scrolls; the prompt line under the playhead is highlighted.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { findPromptLine, GenAsset, GenDetail as Detail, getGen, parseGenPrompt, rangeFromLabel, splitPromptRefs } from './base';
import { passageAtTime } from './lyrics';
import { follow } from './sync';

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
// parseGenPrompt ids end in the prompt line index the passage starts on
const lineOf = (id: string) => Number(id.split('-').pop());

export function GenDetail({ genId, snippet, onBack, onOpenGen }: { genId: string; snippet?: string; onBack: () => void; onOpenGen: (caseId: string, genId: string) => void }) {
  const [g, setG] = useState<Detail | null>(null);
  const [err, setErr] = useState('');
  const [zoom, setZoom] = useState<GenAsset | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [follows, setFollows] = useState(() => localStorage.getItem('gen-detail-follow') !== 'off');
  const [srcMuted, setSrcMuted] = useState(true), [recMuted, setRecMuted] = useState(true);
  const src = useRef<HTMLVideoElement>(null), rec = useRef<HTMLVideoElement>(null);
  const lineRefs = useRef<Record<number, HTMLDivElement | null>>({});
  useEffect(() => { setG(null); setErr(''); setPlaying(false); getGen(genId).then(setG).catch(e => setErr(e.message)); }, [genId]);

  const [start, end] = useMemo(() => (g && rangeFromLabel(g.label)) || [0, Infinity], [g]);
  const lines = useMemo(() => (g?.prompt || '').split(/\r?\n/), [g]);
  const passages = useMemo(() => (g ? parseGenPrompt(g.prompt, start, Number.isFinite(end) ? end : 1e9, 'p') : []), [g, start, end]);
  const hitLine = useMemo(() => (snippet ? findPromptLine(lines, snippet) : -1), [lines, snippet]);
  const now = passages.length ? passageAtTime(passages, time) : undefined;
  const nowLine = now ? lineOf(now.id) : -1;
  const refs = useMemo(() => [...new Set((g?.prompt.match(/@图片\d+/g) || []).map(x => Number(x.slice(3))))].sort((a, b) => a - b), [g]);
  const dangling = refs.filter(n => !g?.assets[n - 1]);

  // start at the passage the reviewer clicked in the workbench, else at the start of this record's range
  const startAt = useMemo(() => passages.find(p => lineOf(p.id) === hitLine)?.start ?? start, [passages, hitLine, start]);
  const seek = (t: number) => { if (src.current) src.current.currentTime = t; setTime(t); if (src.current && rec.current) follow(src.current, rec.current, start, 1, playing); };
  useEffect(() => { lineRefs.current[hitLine >= 0 ? hitLine : -1]?.scrollIntoView({ block: 'center' }); }, [g, hitLine]);
  const top = useRef<HTMLDivElement>(null);
  // Lyric-style follow: centre the current line in the area below the pinned split/assets panel.
  // scrollIntoView would centre it in the whole viewport, i.e. behind the pinned panel.
  useEffect(() => {
    const el = lineRefs.current[nowLine], box = el?.closest('.assetLib') as HTMLElement | null;
    if (!follows || !el || !box) return;
    const pinned = top.current?.offsetHeight || 0, lane = box.clientHeight - pinned;
    const y = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTo({ top: Math.max(0, y - pinned - (lane - el.offsetHeight) / 2), behavior: 'smooth' });
  }, [nowLine, follows]);
  useEffect(() => {
    const a = src.current, b = rec.current; if (!a || !b) return;
    a.muted = srcMuted; b.muted = recMuted;
    if (playing) a.play().catch(() => {}); else { a.pause(); b.pause(); }
    follow(a, b, start, 1, playing);
  }, [playing, srcMuted, recMuted]);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement; if (t?.matches?.('input,textarea,select,[contenteditable=true]') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === ' ') { e.preventDefault(); setPlaying(p => !p); }
      if (e.key === 'v' || e.key === 'V') { e.preventDefault(); setFollows(f => { localStorage.setItem('gen-detail-follow', f ? 'off' : 'on'); return !f; }); }
    };
    window.addEventListener('keydown', fn); return () => window.removeEventListener('keydown', fn);
  }, []);

  if (err) return <section className="genDetail"><button className="secondary" onClick={onBack}>← 返回</button><p className="err">读取失败：{err}</p></section>;
  if (!g) return <section className="genDetail"><p className="hint">正在读取生成记录…</p></section>;
  const meta = [g.version, g.status, g.mode, g.tool, g.seconds !== '' && `${g.seconds}s`, g.cost !== '' && `¥${g.cost}`, g.source && `提示词：${g.source}`, g.verdict && g.verdict !== '待评分' && `${g.score}分 ${g.verdict}`].filter(Boolean);
  const onTime = () => {
    const a = src.current, b = rec.current; if (!a || !b) return;
    if (a.currentTime >= end) { a.currentTime = start; }
    setTime(a.currentTime); follow(a, b, start, 1, playing);
  };
  return <section className="genDetail">
    <div className="genTop" ref={top}>
      <header>
        <button className="secondary" onClick={onBack}>← 返回</button>
        <div><h2>{g.label}</h2><p>{meta.join(' · ')}{g.taskId && <> · <code>{g.taskId}</code></>}</p></div>
        {g.caseId && g.hasVideo && <button onClick={() => onOpenGen(g.caseId!, g.id)}>在工作台打开</button>}
      </header>
      <div className="genStage">
        {g.video && g.sourceVideo ? <div className="genSplit">
          <div className={`audioToggle ${srcMuted ? 'muted' : 'audible'}`} onClick={() => setSrcMuted(m => !m)}>
            <label>原片</label><div className="audioBadge">{srcMuted ? '🔇 点击开声音' : '🔊 声音已开'}</div>
            <video ref={src} src={g.sourceVideo.url} playsInline onLoadedMetadata={e => { e.currentTarget.currentTime = startAt; setTime(startAt); }} onTimeUpdate={onTime} />
          </div>
          <div className={`audioToggle ${recMuted ? 'muted' : 'audible'}`} onClick={() => setRecMuted(m => !m)}>
            <label>复刻｜{g.version}</label><div className="audioBadge">{recMuted ? '🔇 点击开声音' : '🔊 声音已开'}</div>
            <video ref={rec} src={g.video.url} playsInline onLoadedMetadata={() => src.current && rec.current && follow(src.current, rec.current, start, 1, false)} />
          </div>
          <div className="genBar">
            <button onClick={() => setPlaying(p => !p)}>{playing ? '❚❚' : '▶'}</button>
            <input type="range" min={start} max={Number.isFinite(end) ? end : src.current?.duration || 0} step="0.05" value={time} onChange={e => seek(Number(e.target.value))} />
            <span className="genTime">原片 {fmt(time)}<small>本段 {fmt(Math.max(0, time - start))} / {Number.isFinite(end) ? fmt(end - start) : '—'}</small></span>
            <button className={`followBtn ${follows ? 'on' : ''}`} title="开启时，下方提示词像歌词一样跟着播放进度滚动（V 键切换）" onClick={() => setFollows(f => { localStorage.setItem('gen-detail-follow', f ? 'off' : 'on'); return !f; })}>{follows ? '◉ 提示词跟随' : '○ 自由浏览'}</button>
            <small>空格 播放/暂停　V 跟随/自由浏览</small>
          </div>
        </div> : <p className="hint">{g.video ? '这个案例没有原片视频' : '这次没有生成视频（失败的提交）'}，无法分屏。</p>}
        <div className="genAssetsBox">
          <h3>输入素材 <small>{g.assets.length} 张，按 @图片N 顺序</small></h3>
          {g.assets.length ? <div className="genAssets">{g.assets.map((a, i) => <figure key={a.id} className={`s-${a.status}`} title={a.desc || a.name} onClick={() => a.file && setZoom(a)}>
            <i>@图片{i + 1}</i>{a.file ? <img src={a.file.url} alt="" loading="lazy" /> : <span>无文件</span>}
            <figcaption><b>{a.name}</b><em>{a.type}{a.status && a.status !== '可用' ? `｜${a.status}` : ''}</em></figcaption>
          </figure>)}</div> : <p className="hint">没有参考图{g.mode ? `（${g.mode}）` : ''}。</p>}
          {dangling.length > 0 && <p className="fail">提示词里的 {dangling.map(n => `@图片${n}`).join('、')} 这次没有提交对应的图（重试删了图、没改提示词）。</p>}
        </div>
      </div>
    </div>
    {g.fail && <p className="fail">失败原因：{g.fail}</p>}
    {g.shots.length > 0 && <p className="shots">关联镜头：{g.shots.join('、')}</p>}

    <h3>完整提示词 <small>{follows ? '跟随播放进度' : '自由浏览（按 V 恢复跟随）'}{hitLine >= 0 ? '｜虚线框是工作台里点的那一段' : ''}</small></h3>
    <div className={`genPrompt ${follows && nowLine >= 0 ? 'lyric' : ''}`}>{lines.map((line, i) => {
      const p = passages.find(x => lineOf(x.id) === i);
      return <div key={i} ref={el => { lineRefs.current[i] = el; }} className={[i === nowLine && 'now', i === hitLine && 'hit', p && 'timed'].filter(Boolean).join(' ')} onClick={p ? () => seek(p.start) : undefined}>
        {splitPromptRefs(line, g.assets).map((x, j) => 'text' in x ? <span key={j}>{x.text}</span>
          : x.asset ? <button key={j} className="refChip" title={x.asset.desc || x.asset.name} onClick={e => { e.stopPropagation(); setZoom(x.asset); }}>{x.asset.file && <img src={x.asset.file.url} alt="" />}@图片{x.ref}｜{x.asset.name}</button>
          : <mark key={j} className="refChip dangling" title="这次没有提交这张图">@图片{x.ref}｜未提交</mark>)}
        {line === '' && ' '}
      </div>;
    })}</div>

    {g.remark && <><h3>备注</h3><p className="genRemark">{g.remark}</p></>}
    {zoom?.file && <div className="modal" onClick={() => setZoom(null)}>
      <div className="assetZoom" onClick={e => e.stopPropagation()}>
        <img src={zoom.file.url} alt="" />
        <div><b>{zoom.name}</b><p>{zoom.desc}</p>{zoom.remark && <p className="remark">⚠ {zoom.remark}</p>}<button className="secondary" onClick={() => setZoom(null)}>关闭</button></div>
      </div>
    </div>}
  </section>;
}
