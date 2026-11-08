// Home: every case in the Base, plus "新建案例" (upload original → optional GPT shot breakdown).
import React, { useEffect, useState } from 'react';
import { CaseSummary, Job, listCases, startBreakdown, uploadCase, waitJob } from './base';

const CATEGORIES = ['3C数码', '美妆个护', '服饰鞋包', '食品饮料', '家居日用', '其他'];
const TYPES = ['口播', '开箱测评', '产品展示', '剧情广告', '其他'];

export function CaseHome({ onOpen, llm }: { onOpen: (id: string, stage: 'source' | 'recreate') => void; llm: string }) {
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [job, setJob] = useState<{ title: string; job?: Job; upload?: number } | null>(null);
  const load = () => listCases().then(setCases).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  const follow = async (title: string, j: Job, open?: (r: any) => void) => {
    setJob({ title, job: j });
    const done = await waitJob(j.id, x => setJob({ title, job: x }));
    load();
    if (done.status === 'done' && open) open(done.result);
  };
  const breakdown = async (c: CaseSummary) => {
    try { await follow(`拆解镜头｜${c.name}`, await startBreakdown(c.id), () => onOpen(c.id, 'source')); } catch (e: any) { alert(e.message); }
  };

  return <main className="caseHome">
    <header><div><h1>复刻案例</h1><p>先拆解并核对原片，再进入复刻对比。数据都在飞书多维表格里。</p></div><button onClick={() => setCreating(true)}>＋ 新建案例</button></header>
    {err && <p className="err">读取失败：{err}</p>}
    {!cases && !err && <p className="muted">正在读取多维表格…</p>}
    <div className="caseGrid">
      {cases?.map(c => {
        const pct = c.shots ? Math.round(c.verified / c.shots * 100) : 0;
        return <article key={c.id} className="caseCard">
          <div className="thumb" onClick={() => c.shots && onOpen(c.id, 'source')}>{c.thumb ? <img src={c.thumb.url} alt="" loading="lazy" /> : <span>{c.hasSource ? '还没有拆解镜头' : '没有原片'}</span>}</div>
          <div className="body">
            <b>{c.name}</b>
            <small>{[c.category, c.type, c.duration ? `${c.duration.toFixed(1)}s` : '', c.status].filter(Boolean).join(' · ')}</small>
            <div className="steps">
              <div className={c.shots ? (c.verified === c.shots ? 'done' : 'doing') : ''}><span>① 原片拆解</span><em>{c.shots ? `已核对 ${c.verified}/${c.shots}` : '未拆解'}</em><i style={{ width: pct + '%' }} /></div>
              <div className={c.gens ? 'doing' : ''}><span>② 复刻</span><em>{c.gens ? `${c.gens} 次生成${c.cost ? `｜¥${c.cost}` : ''}` : '未开始'}</em></div>
            </div>
            <div className="actions">
              {c.shots ? <button onClick={() => onOpen(c.id, 'source')}>核对原片</button> : c.hasSource ? <button onClick={() => breakdown(c)}>用 GPT 拆解镜头</button> : null}
              {c.gens > 0 && <button className="secondary" onClick={() => onOpen(c.id, 'recreate')}>复刻对比</button>}
            </div>
          </div>
        </article>;
      })}
    </div>
    {creating && <NewCase llm={llm} onClose={() => setCreating(false)} onStart={async (file, meta) => {
      setCreating(false);
      setJob({ title: `新建案例｜${meta.name}`, upload: 0 });
      try { await follow(`新建案例｜${meta.name}`, await uploadCase(file, meta, p => setJob({ title: `新建案例｜${meta.name}`, upload: p })), r => r?.shots && onOpen(r.caseId, 'source')); }
      catch (e: any) { setJob({ title: `新建案例｜${meta.name}`, job: { id: '', kind: '', status: 'error', log: [], error: e.message } }); }
    }} />}
    {job && <JobPanel {...job} onClose={() => job.job?.status !== 'running' && setJob(null)} />}
  </main>;
}

function NewCase({ onClose, onStart, llm }: { onClose: () => void; onStart: (f: File, meta: Record<string, string>) => void; llm: string }) {
  const [file, setFile] = useState<File>(); const [name, setName] = useState(''); const [category, setCategory] = useState(''); const [type, setType] = useState('');
  const [analyse, setAnalyse] = useState(true);
  return <div className="modal"><div className="dialog">
    <h2>新建复刻案例</h2>
    <p className="hint">上传原片后会写入「案例」表。勾选自动拆解时，ffmpeg 先找出硬切，再把每个镜头的帧交给 {llm || 'GPT-6.1 SOL'} 写分析，结果进「原片镜头」表，等你核对。</p>
    <label>原片视频<input type="file" accept="video/*" onChange={e => { const f = e.target.files?.[0]; setFile(f); if (f && !name) setName(f.name.replace(/\.[^.]+$/, '')); }} /><small>{file ? `${file.name}｜${(file.size / 1048576).toFixed(1)} MB` : '未选择'}</small></label>
    <label>案例名<input value={name} onChange={e => setName(e.target.value)} placeholder="例如：某品牌保温杯口播爆款" /></label>
    <div className="grid">
      <label>商品类目<select value={category} onChange={e => setCategory(e.target.value)}><option value="">不填</option>{CATEGORIES.map(x => <option key={x}>{x}</option>)}</select></label>
      <label>视频类型<select value={type} onChange={e => setType(e.target.value)}><option value="">不填</option>{TYPES.map(x => <option key={x}>{x}</option>)}</select></label>
    </div>
    <label className="check"><input type="checkbox" checked={analyse} onChange={e => setAnalyse(e.target.checked)} />上传后自动拆解镜头（约每 30 秒原片 1–2 分钟）</label>
    <div className="right"><button className="secondary" onClick={onClose}>取消</button><button disabled={!file || !name} onClick={() => onStart(file!, { name, category, type, analyse: analyse ? '1' : '0' })}>开始</button></div>
  </div></div>;
}

function JobPanel({ title, job, upload, onClose }: { title: string; job?: Job; upload?: number; onClose: () => void }) {
  const running = !job || job.status === 'running';
  return <div className="jobPanel">
    <header><b>{title}</b><span className={job?.status || 'running'}>{!job ? `上传原片 ${Math.round((upload || 0) * 100)}%` : job.status === 'running' ? '进行中…' : job.status === 'done' ? '完成' : '出错'}</span>{!running && <button className="secondary" onClick={onClose}>关闭</button>}</header>
    {!job && <div className="bar"><i style={{ width: `${(upload || 0) * 100}%` }} /></div>}
    {job && <pre>{job.log.join('\n')}{job.error ? `\n${job.error}` : ''}</pre>}
  </div>;
}
