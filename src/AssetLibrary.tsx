// Asset library: every image/video in 「资产」, with where each one was used.
// The 生成记录 tab lists every generation; opening one shows its full prompt with the assets placed at each @图片N.
import React, { useEffect, useMemo, useState } from 'react';
import { Asset, CaseSummary, GenBrief, listAssets, listCases, listGens } from './base';
import { GenDetail } from './GenDetail';

// Category is derived from 资产类型 + 替换槽位 so existing rows need no migration;
// original-video frames stay separate because they must never be uploaded as generation references.
const CATS = ['角色', '商品', '道具', '场景', '原片参考', '参考音视频', '其他'];
const CAT_HINT: Record<string, string> = { 原片参考: '只用于对照，不要当参考图上传给模型', 参考音视频: '参考视频 / 参考音频' };
const COMMON = '__common';
export function catOf(a: { type: string; slot: string }) {
  if (a.type === '原片参考帧') return '原片参考';
  if (a.type === '参考视频' || a.type === '参考音频') return '参考音视频';
  if (a.slot === '人物' || a.type === '角色三视图') return '角色';
  if (a.slot === '商品' || a.type === '商品图') return '商品';
  if (a.slot === '道具' || a.type === '道具状态图') return '道具';
  if (a.slot === '场景' || a.type === '场景锚点') return '场景';
  return '其他';
}
function useStored(key: string, init: string) {
  const [v, setV] = useState(() => localStorage.getItem(key) ?? init);
  return [v, (x: string) => { setV(x); localStorage.setItem(key, x); }] as const;
}

export type AssetFocus ={ genId: string; snippet?: string } | null;

export function AssetLibrary({ onOpenGen, focus = null }: { onOpenGen: (caseId: string, genId: string) => void; focus?: AssetFocus }) {
  const [tab, setTab] = useState<'assets' | 'gens'>(focus ? 'gens' : 'assets');
  const [open, setOpen] = useState<AssetFocus>(focus);
  const [gens, setGens] = useState<GenBrief[] | null>(null);
  const [gq, setGq] = useState(''); const [gver, setGver] = useState('');
  useEffect(() => { setOpen(focus); if (focus) setTab('gens'); }, [focus?.genId, focus?.snippet]);
  useEffect(() => { if (tab === 'gens' && !gens) listGens().then(setGens).catch(e => setErr(e.message)); }, [tab]);
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [err, setErr] = useState('');
  const [cat, setCat] = useStored('asset-cat', ''); const [proj, setProj] = useStored('asset-proj', localStorage.getItem('review-case') || '');
  const [status, setStatus] = useState(''); const [use, setUse] = useState(''); const [q, setQ] = useState('');
  const [zoom, setZoom] = useState<Asset | null>(null);
  const [uploading, setUploading] = useState(false);
  useEffect(() => { listAssets().then(setAssets).catch(e => setErr(e.message)); }, []);
  const projects = useMemo(() => { const m = new Map<string, string>(); assets?.forEach(a => a.cases.forEach(c => m.set(c.id, c.name))); return [...m]; }, [assets]);
  const projOk = !proj || proj === COMMON || projects.some(([id]) => id === proj); // a remembered case may have no assets
  const inProj = (a: Asset) => !proj || !projOk || (proj === COMMON ? a.common || !a.cases.length : a.cases.some(c => c.id === proj) || a.common);
  // every filter except the category, so the sidebar counts show what each category would contain
  const base = (assets || []).filter(a => inProj(a) && (!status || a.status === status)
    && (!use || (use === 'used' ? a.usedBy.length > 0 : a.usedBy.length === 0)) && (!q || [a.name, a.desc, ...a.usedBy.map(u => u.version + u.label)].join(' ').toLowerCase().includes(q.toLowerCase())));
  const shown = base.filter(a => !cat || catOf(a) === cat);
  const count = (c: string) => base.filter(a => catOf(a) === c).length;
  const groups = cat ? [[cat, shown] as const] : CATS.map(c => [c, shown.filter(a => catOf(a) === c)] as const).filter(([, l]) => l.length);
  const versions = useMemo(() => [...new Set(gens?.map(g => g.version).filter(Boolean))], [gens]);
  const gshown = (gens || []).filter(g => (!gver || g.version === gver) && (!gq || [g.version, g.label, g.status, ...g.shots, ...g.assetNames].join(' ').toLowerCase().includes(gq.toLowerCase())));

  if (open) return <main className="assetLib"><GenDetail genId={open.genId} snippet={open.snippet} onBack={() => setOpen(null)} onOpenGen={onOpenGen} /></main>;

  return <main className="assetLib">
    <header>
      <div><h1>资产库 <button className="uploadBtn" onClick={() => setUploading(true)}>＋ 上传素材</button></h1><div className="libTabs"><button className={tab === 'assets' ? 'on' : ''} onClick={() => setTab('assets')}>资产</button><button className={tab === 'gens' ? 'on' : ''} onClick={() => setTab('gens')}>生成记录</button></div><p>{tab === 'gens' ? (gens ? `${gens.length} 条生成记录，显示 ${gshown.length} 条。点一条看当时的素材和完整提示词` : '正在读取多维表格…') : <>{assets ? `${assets.length} 个资产，显示 ${shown.length} 个` : '正在读取多维表格…'}。点「用于」里的记录看当时的完整提示词</>}。</p></div>
      {tab === 'gens' ? <div className="filters">
        <input placeholder="搜镜头簇/镜头号/资产名，如 U05-A、S24" value={gq} onChange={e => setGq(e.target.value)} />
        <select value={gver} onChange={e => setGver(e.target.value)}><option value="">全部版本</option>{versions.map(v => <option key={v}>{v}</option>)}</select>
      </div> : <div className="filters">
        <input placeholder="搜名称/描述/用于哪条记录" value={q} onChange={e => setQ(e.target.value)} />
        <select value={status} onChange={e => setStatus(e.target.value)}><option value="">全部状态</option>{['可用', '待修', '废弃'].map(t => <option key={t}>{t}</option>)}</select>
        <select value={use} onChange={e => setUse(e.target.value)}><option value="">全部</option><option value="used">被引用过</option><option value="unused">未被引用</option></select>
      </div>}
    </header>
    {err && <p className="err">读取失败：{err}</p>}
    {tab === 'gens' ? <div className="genList">{gshown.map(g => <button key={g.id} className={`s-${g.status}`} onClick={() => setOpen({ genId: g.id })}>
      <b>{g.version}</b><span className="lbl">{g.label}</span><em>{g.status}{g.adopted ? '｜采用' : ''}</em>
      <small>{g.shots.length ? g.shots.join(' ') : '未关联镜头'}</small><small>{g.assetNames.length ? `${g.assetNames.length} 张素材：${g.assetNames.join('、')}` : '无参考图'}</small>
    </button>)}</div> :
    <div className="assetBody">
      <aside className="assetSide">
        <b>项目</b>
        <button className={!proj || !projOk ? 'on' : ''} onClick={() => setProj('')}>全部项目<em>{assets?.length || 0}</em></button>
        {projects.map(([id, name]) => <button key={id} className={proj === id ? 'on' : ''} title={name} onClick={() => setProj(id)}>{name}<em>{assets?.filter(a => a.cases.some(c => c.id === id)).length}</em></button>)}
        <button className={proj === COMMON ? 'on' : ''} onClick={() => setProj(COMMON)}>通用 / 未归属<em>{assets?.filter(a => a.common || !a.cases.length).length || 0}</em></button>
        <b>分类</b>
        <button className={!cat ? 'on' : ''} onClick={() => setCat('')}>全部<em>{base.length}</em></button>
        {CATS.map(c => <button key={c} className={cat === c ? 'on' : ''} disabled={!count(c)} onClick={() => setCat(c)}><i className={`dot c-${c}`} />{c}<em>{count(c)}</em></button>)}
        {proj && proj !== COMMON && <small>选了项目时，通用资产也会一起显示</small>}
      </aside>
      <div className="assetGroups">
      {!shown.length && assets && <p className="muted">这个筛选下没有资产。</p>}
      {groups.map(([g, list]) => <section key={g}>
      <h3><i className={`dot c-${g}`} />{g}<span>{list.length}</span><small>{CAT_HINT[g]}</small></h3>
      <div className="assetGrid">
      {list.map(a => {
        const ok = a.usedBy.filter(u => u.ok), fail = a.usedBy.length - ok.length;
        return <article key={a.id} className={`assetCard s-${a.status}`}>
          <div className="thumb" onClick={() => a.file && setZoom(a)}>{a.file ? (a.type === '参考视频' ? <video src={a.file.url} muted /> : <img src={a.file.url} alt="" loading="lazy" />) : <span>无文件</span>}</div>
          <div className="body">
            <b title={a.name}>{a.name}</b>
            <div className="tags"><em>{a.type}</em>{a.slot && a.slot !== '无' && <em>槽位：{a.slot}</em>}<em className={`st ${a.status}`}>{a.status}</em>{a.common && <em>通用</em>}</div>
            {a.desc && <p className="desc" title={a.desc}>{a.desc}</p>}
            {a.remark && <p className="remark" title={a.remark}>⚠ {a.remark}</p>}
            <div className="used">
              <span>用于 {ok.length} 次成功生成{fail ? `，${fail} 次失败` : ''}</span>
              <div>{ok.map(u => <button key={u.id} className={u.adopted ? 'adopted' : ''} title={u.adopted ? '已采用' : '未采用'} onClick={() => setOpen({ genId: u.id })}>{u.version}｜{u.label.split('｜').slice(0, 2).join('｜')}</button>)}</div>
            </div>
          </div>
        </article>;
      })}
      </div></section>)}
      </div>
    </div>}
    {uploading && <UploadAsset onClose={() => setUploading(false)} onDone={() => { setUploading(false); listAssets().then(setAssets); }} />}
    {zoom?.file && <div className="modal" onClick={() => setZoom(null)}>
      <div className="assetZoom" onClick={e => e.stopPropagation()}>
        {zoom.type === '参考视频' ? <video src={zoom.file.url} controls autoPlay /> : <img src={zoom.file.url} alt="" />}
        <div><b>{zoom.name}</b><p>{zoom.desc}</p>{zoom.remark && <p className="remark">⚠ {zoom.remark}</p>}<button className="secondary" onClick={() => setZoom(null)}>关闭</button></div>
      </div>
    </div>}
  </main>;
}

// Upload one image as a 「资产」 row. Type and slot decide how 新建复刻 uses it (商品图 → 商品外观, 角色三视图 → 人物身份).
const TYPES = ['商品图', '角色三视图', '场景锚点', '道具状态图', '关键帧', '参考视频'], SLOTS = ['商品', '人物', '场景', '道具', '无'];
function UploadAsset({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File>(); const [name, setName] = useState(''); const [type, setType] = useState('商品图'); const [slot, setSlot] = useState('商品');
  const [desc, setDesc] = useState(''); const [caseId, setCaseId] = useState(''); const [cases, setCases] = useState<CaseSummary[]>([]); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => { listCases().then(setCases).catch(() => {}); }, []);
  const save = async () => {
    if (!file) return; setBusy(true); setErr('');
    const q = new URLSearchParams({ name, type, slot, desc, caseId, ext: file.name.split('.').pop() || 'png' });
    try { const r = await fetch(`/api/base/assets?${q}`, { method: 'POST', body: file }); const j = await r.json(); if (!r.ok || j.error) throw new Error(j.error || '上传失败'); onDone(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return <div className="modal"><div className="dialog">
    <h2>上传素材</h2>
    <p className="hint">商品图：纯色或干净背景、无文字水印，每种状态（开合、亮灭屏）各一张。人物图：同一个人的正/侧/背，服装与要复刻的一致。不要上传原片截图当人物参考。</p>
    <label>图片<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { const f = e.target.files?.[0]; setFile(f); if (f && !name) setName(f.name.replace(/\.[^.]+$/, '')); }} /></label>
    {file && <img className="uploadPreview" src={URL.createObjectURL(file)} alt="" />}
    <label>名称<input value={name} onChange={e => setName(e.target.value)} placeholder="例如：商品_保温杯_正面" /></label>
    <div className="grid">
      <label>类型<select value={type} onChange={e => { setType(e.target.value); setSlot(e.target.value === '角色三视图' ? '人物' : e.target.value === '场景锚点' ? '场景' : e.target.value === '道具状态图' ? '道具' : '商品'); }}>{TYPES.map(t => <option key={t}>{t}</option>)}</select></label>
      <label>替换槽位<select value={slot} onChange={e => setSlot(e.target.value)}>{SLOTS.map(t => <option key={t}>{t}</option>)}</select></label>
    </div>
    <label>所属案例<select value={caseId} onChange={e => setCaseId(e.target.value)}><option value="">通用（不属于某个案例）</option>{cases.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
    <label>描述（起草提示词时会用到）<textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder="外观要点：颜色、材质、按键、屏幕、Logo 位置等" /></label>
    {err && <p className="err">{err}</p>}
    <div className="right"><button className="secondary" onClick={onClose}>取消</button><button disabled={!file || !name.trim() || busy} onClick={save}>{busy ? '上传中…' : '上传'}</button></div>
  </div></div>;
}
