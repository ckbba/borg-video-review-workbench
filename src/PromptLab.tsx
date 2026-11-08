// 拆解设置: every version of the breakdown prompt (「拆解提示词」) with what its breakdowns got wrong.
// Problems are the 原片拆解 annotations on shots produced by that version, counted by 问题类型,
// so a prompt or model change can be judged by whether those counts go down.
import React, { useEffect, useMemo, useState } from 'react';
import { createPrompt, listPrompts, activatePrompt, PromptVersion } from './base';

const FIELDS: [keyof PromptVersion, string, number][] = [['system', '系统指令', 2], ['overview', '梗概提示（先看全片代表帧）', 3], ['scout', '复杂段提示（第一轮看完后，找出要加密抽帧的时间段）', 5], ['rules', '写作规则', 10], ['schema', '输出格式', 8]];
const sampling = (v: PromptVersion) => v.strategy === '全片定频'
  ? `全片定频：全片 ${v.coarseFps || 5} 帧/秒（${v.sheetWidth || 384}px），A 级 ${v.aFps || 10} 帧/秒、B 级原始帧率（${v.frameWidth || 640}px）${v.cutReview ? '，切点复查' : ''}，切点阈值 ${v.sceneThreshold || 0.16}，不限每镜帧数`
  : v.strategy === '两轮动态' ? `两轮动态：粗看 ${v.frames} 帧/镜，复杂段 ${v.denseFps} 帧/秒` : `固定 ${v.frames} 帧/镜`;
const usesScout = (v: PromptVersion) => v.strategy === '两轮动态' || v.strategy === '全片定频';

export function PromptLab({ onOpenShot }: { onOpenShot: (caseId: string, shotId: string) => void }) {
  const [list, setList] = useState<PromptVersion[] | null>(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState('');
  const [type, setType] = useState('');
  const [draft, setDraft] = useState<PromptVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => listPrompts().then(l => { setList(l); setSel(s => s || l.find(p => p.status === '使用中')?.id || l[0]?.id || ''); }).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);
  const p = list?.find(x => x.id === sel);
  const types = useMemo(() => [...new Set((list || []).flatMap(v => v.problems.flatMap(x => x.types)))], [list]);
  const count = (v: PromptVersion, t: string) => v.problems.filter(x => x.types.includes(t)).length;

  const fork = () => p && setDraft({ ...p, id: '', version: nextVersion(list!.map(v => v.version)), note: '' });
  const save = async () => {
    if (!draft) return; setBusy(true);
    try { const r = await createPrompt(draft); setDraft(null); await load(); setSel(r.id); }
    catch (e: any) { alert(e.message); } finally { setBusy(false); }
  };

  return <main className="assetLib promptLab">
    <header><div><h1>拆解设置</h1><p>原片拆解用的提示词版本，以及每个版本拆出来的镜头被人工标了哪些问题。新拆解的案例总是用「使用中」的版本。</p></div></header>
    {err && <p className="err">读取失败：{err}</p>}
    {!list ? <p className="hint">正在读取多维表格…</p> : <>
      <table className="plMatrix">
        <thead><tr><th>版本</th><th>状态</th><th>模型</th><th>抽帧</th><th>用于</th><th>镜头</th><th>已核对</th><th>平均分</th><th>问题批注</th>{types.map(t => <th key={t}>{t}</th>)}</tr></thead>
        <tbody>{list.map(v => <tr key={v.id} className={v.id === sel ? 'on' : ''} onClick={() => { setSel(v.id); setDraft(null); }}>
          <td><b>{v.version}</b></td><td><em className={v.status === '使用中' ? 'live' : ''}>{v.status}</em></td><td>{v.model}</td><td>{sampling(v)}</td>
          <td>{v.cases.join('、') || '—'}</td><td>{v.shots}</td><td>{v.verified}/{v.shots}</td><td>{v.avg ?? '—'}</td><td>{v.problems.length}</td>
          {types.map(t => <td key={t} className={count(v, t) ? 'hot' : ''}>{count(v, t) || ''}</td>)}
        </tr>)}</tbody>
      </table>

      {draft ? <section className="plEdit">
        <h2>新建版本 <input value={draft.version} onChange={e => setDraft({ ...draft, version: e.target.value })} /></h2>
        <div className="plRow"><label>模型<input value={draft.model} onChange={e => setDraft({ ...draft, model: e.target.value })} /></label><label>抽帧策略<select value={draft.strategy} onChange={e => { const v = e.target.value; setDraft({ ...draft, strategy: v, ...(v === '全片定频' && draft.strategy !== v ? { coarseFps: draft.coarseFps || 5, aFps: draft.aFps || 10, sceneThreshold: draft.sceneThreshold || 0.16, cutReview: true, sheetWidth: draft.sheetWidth || 384, frameWidth: draft.frameWidth || 640 } : {}) }); }}><option>固定</option><option>两轮动态</option><option>全片定频</option></select></label>
          {draft.strategy === '全片定频' ? <>
            <label>全片粗看（帧/秒）<input type="number" min={1} max={12} step={0.5} value={draft.coarseFps || 5} onChange={e => setDraft({ ...draft, coarseFps: Number(e.target.value) })} /></label>
            <label>A 级复查（帧/秒）<input type="number" min={4} max={25} step={0.5} value={draft.aFps || 10} onChange={e => setDraft({ ...draft, aFps: Number(e.target.value) })} /></label>
            <label>联系表格宽（px）<input type="number" min={160} max={960} step={16} value={draft.sheetWidth || 384} onChange={e => setDraft({ ...draft, sheetWidth: Number(e.target.value) })} /></label>
            <label>送模型帧宽（px）<input type="number" min={256} max={1280} step={16} value={draft.frameWidth || 640} onChange={e => setDraft({ ...draft, frameWidth: Number(e.target.value) })} /></label>
            <label>切点阈值<input type="number" min={0.05} max={0.6} step={0.01} value={draft.sceneThreshold || 0.16} onChange={e => setDraft({ ...draft, sceneThreshold: Number(e.target.value) })} /></label>
            <label className="check"><input type="checkbox" checked={!!draft.cutReview} onChange={e => setDraft({ ...draft, cutReview: e.target.checked })} />切点复查</label>
          </> : <>
          <label>{draft.strategy === '两轮动态' ? '第一轮每镜粗看帧数' : '每镜抽帧数'}<input type="number" min={1} max={12} value={draft.frames} onChange={e => setDraft({ ...draft, frames: Number(e.target.value) })} /></label>
          {draft.strategy === '两轮动态' && <label>复杂段加密（帧/秒）<input type="number" min={1} max={12} value={draft.denseFps} onChange={e => setDraft({ ...draft, denseFps: Number(e.target.value) })} /></label>}</>}
          <label>保存为<select value={draft.status === '待试用' ? '待试用' : '使用中'} onChange={e => setDraft({ ...draft, status: e.target.value })}><option>使用中</option><option>待试用</option></select></label></div>
        {draft.strategy === '两轮动态' && <p className="hint">两轮动态：先用粗看帧 + ffmpeg 测的每镜画面变化量，让模型列出复杂时间段（眼睛开合、转身、布料运动、运镜等）；再只在这些时间段内按上面的帧率加密抽帧（每镜最多 12 帧），并告诉模型这一段要逐帧写出过程。每个镜头为什么加密会记在「原片镜头」的「抽帧说明」里。</p>}
        {draft.strategy === '全片定频' && <p className="hint">全片定频（GPT 网页版 Work 的做法）：第一轮不看镜头长短，整片按固定帧率抽帧做带时间码的联系表，让模型列出开合、遮挡替换、变形、快速推拉、甩镜、点击衔接、亮灭屏等短动作；模型把这些段分成 A 级（一般复杂运动，按上面的 A 级帧率）和 B 级（快速开合、遮挡替换、疑似切点，按原始帧率，25fps 即每帧），另加每个切点前后各 1 帧。一个 0.2 秒的闭合动作，6 帧/秒只剩 1–2 张，25 帧/秒有 5 张。不限每镜帧数：一批超过 48 张时分连续批次查看，时间轴保持完整。</p>}
        <label>改动说明（改了什么、想解决哪类问题）<textarea rows={2} value={draft.note} onChange={e => setDraft({ ...draft, note: e.target.value })} placeholder="例如：加规则要求写首帧状态和左右以人物自身为准，针对「首帧状态误判」「左右/朝向错」" /></label>
        {FIELDS.filter(([k]) => k !== 'scout' || usesScout(draft)).map(([k, label, rows]) => <label key={k}>{label}<textarea rows={rows} value={String(draft[k] || '')} onChange={e => setDraft({ ...draft, [k]: e.target.value })} /></label>)}
        <div className="right"><button className="secondary" onClick={() => setDraft(null)}>取消</button><button disabled={busy || !draft.version.trim() || !draft.note.trim()} onClick={save}>{busy ? '保存中…' : draft.status === '待试用' ? '保存为待试用' : '保存并设为使用中'}</button></div>
        <small className="hint">保存后旧版本变成「历史」，已拆好的镜头不变；之后新拆解的案例会用新版本。</small>
      </section> : p && <section className="plDetail">
        <div className="plHead"><h2>{p.version}<em className={p.status === '使用中' ? 'live' : ''}>{p.status}</em></h2>
          <div>{p.status !== '使用中' && <button className="secondary" onClick={async () => { await activatePrompt(p.id); load(); }}>设为使用中</button>}<button onClick={fork}>基于此版本新建</button></div></div>
        {p.note && <p className="plNote">{p.note}</p>}
        <h3>问题批注 <small>{p.problems.length} 条，点一条回到那个镜头</small></h3>
        <div className="plFilter"><button className={!type ? 'on' : ''} onClick={() => setType('')}>全部</button>{types.map(t => <button key={t} className={type === t ? 'on' : ''} onClick={() => setType(t)}>{t} {count(p, t)}</button>)}<button className={type === '未分类' ? 'on' : ''} onClick={() => setType('未分类')}>未分类 {p.problems.filter(x => !x.types.length).length}</button></div>
        <div className="plProblems">{p.problems.filter(x => !type || (type === '未分类' ? !x.types.length : x.types.includes(type))).map(x => <button key={x.id} onClick={() => x.caseId && x.shotId && onOpenShot(x.caseId, x.shotId)}>
          <b>{x.caseName}｜{x.shot}</b>{x.types.map(t => <em key={t}>{t}</em>)}
          {x.mark ? <q className="frameQ">🎯 画面圈选</q> : x.quote && <q>{x.quote}</q>}<span>{x.body}</span>
        </button>)}</div>
        <h3>完整提示词 <small>模型 {p.model}｜{sampling(p)}</small></h3>
        {FIELDS.filter(([k]) => k !== 'scout' || usesScout(p)).map(([k, label]) => <div key={k} className="plText"><b>{label}</b><pre>{String(p[k] || '（用默认）')}</pre></div>)}
      </section>}
    </>}
  </main>;
}

const nextVersion = (vs: string[]) => `P${Math.max(0, ...vs.map(v => Number(v.replace(/\D/g, '')) || 0)) + 1}`;
