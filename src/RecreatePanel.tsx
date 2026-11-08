// 新建复刻: pick shots → pick replacement assets (they become @图片1..N in this order) → let the model draft
// the prompt from the shot analysis + open review notes → edit it → submit through 博观 and wait for the result.
import React, { useEffect, useMemo, useState } from 'react';
import { Asset, BaseCase, call, Job, listAssets, waitJob } from './base';
import { videoCost } from './pricing';

type ModelInfo = { label: string; sizes: string[]; min: number; max: number; sound: boolean; maxRefs: number; priced?: boolean };
const ROLE: Record<string, string> = { 商品图: '商品外观（唯一商品母版）', 角色三视图: '人物身份与服装（唯一人物母版）', 场景锚点: '场景与光线', 道具状态图: '道具外观与状态' };

export function RecreatePanel({ data, onClose, onDone }: { data: BaseCase; onClose: () => void; onDone: (genId: string) => void }) {
  const shots = data.shots;
  const [models, setModels] = useState<Record<string, ModelInfo>>({});
  const [model, setModel] = useState('seedance-2.5');
  const [size, setSize] = useState('480p');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [assets, setAssets] = useState<Asset[]>([]);
  const [chosen, setChosen] = useState<{ id: string; role: string }[]>([]);
  const [draft, setDraft] = useState<{ prompt: string; duration: number; span: number; rules: string } | null>(null);
  const [busy, setBusy] = useState(''); const [err, setErr] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  useEffect(() => {
    call<Record<string, ModelInfo>>('/api/base/recreate/models').then(setModels).catch(e => setErr(e.message));
    // every usable asset, this case's own first: the same product is often reused across cases
    const mine = (x: Asset) => (x.cases.some(c => c.id === data.case.id) ? 0 : x.common ? 1 : 2);
    listAssets().then(a => setAssets(a.filter(x => x.file && x.status !== '废弃').sort((x, y) => mine(x) - mine(y)))).catch(e => setErr(e.message));
  }, []);
  const m = models[model];
  const sel = shots.filter(s => picked.has(s.id));
  const span = sel.length ? sel[sel.length - 1].end - sel[0].start : 0;
  const gaps = sel.some((s, i) => i > 0 && shots.indexOf(s) !== shots.indexOf(sel[i - 1]) + 1);
  const toggleShot = (id: string) => { setDraft(null); setPicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; }); };
  const toggleAsset = (a: Asset) => { setDraft(null); setChosen(c => c.some(x => x.id === a.id) ? c.filter(x => x.id !== a.id) : [...c, { id: a.id, role: ROLE[a.type] || a.type }]); };
  const problems = [!sel.length && '先选镜头', gaps && '镜头要连续', m && span > m.max && `共 ${span.toFixed(1)} 秒，超过 ${m.label} 单次上限 ${m.max} 秒`, m && chosen.length > m.maxRefs && `${m.label} 最多 ${m.maxRefs} 张参考图`].filter(Boolean) as string[];
  const price = draft ? videoCost(model, { size, ratio: '16:9', outputSec: draft.duration, images: chosen.length }) : null;
  const cost = price ? `约 ¥${price.yuan.toFixed(2)}` : '价格未知';

  const body = () => ({ caseId: data.case.id, shotIds: sel.map(s => s.id), assets: chosen, model });
  const doDraft = async () => {
    setBusy('draft'); setErr('');
    try { setDraft(await call('/api/base/recreate/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) })); }
    catch (e: any) { setErr(e.message); } finally { setBusy(''); }
  };
  const submit = async () => {
    if (!draft) return; setBusy('run'); setErr('');
    try {
      const j = await call<Job>('/api/base/recreate/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body(), prompt: draft.prompt, duration: draft.duration, size, version: data.case.version || 'V1' }) });
      const end = await waitJob(j.id, setJob);
      if (end.status === 'done' && end.result?.genId) onDone(end.result.genId); else setErr(end.error || '生成失败');
    } catch (e: any) { setErr(e.message); } finally { setBusy(''); }
  };
  const assetOf = (id: string) => assets.find(a => a.id === id);

  return <div className="modal"><div className="dialog wide recreatePanel">
    <h2>新建复刻｜{data.case.name}</h2>
    <div className="rpGrid">
      <section>
        <h3>① 选镜头 <small>{sel.length ? `${sel[0].code}–${sel[sel.length - 1].code}，共 ${span.toFixed(2)} 秒` : '连续的几个镜头'}</small></h3>
        <div className="rpShots">{shots.map(s => <label key={s.id} className={picked.has(s.id) ? 'on' : ''}><input type="checkbox" checked={picked.has(s.id)} onChange={() => toggleShot(s.id)} />
          <b>{s.code}</b><span>{s.start.toFixed(1)}–{s.end.toFixed(1)}s</span><em className={s.verified === '已核对' ? 'ok' : s.verified === '有疑问' ? 'warn' : ''}>{s.verified || '未核对'}</em>
          <small>{data.notes.filter(n => n.stage === '原片拆解' && n.shotIds.includes(s.id)).length ? `✎${data.notes.filter(n => n.stage === '原片拆解' && n.shotIds.includes(s.id)).length}` : ''}</small></label>)}</div>
        <p className="hint">镜头的批注会作为纠正一起交给起草模型（以批注为准）。</p>
      </section>
      <section>
        <h3>② 选素材 <small>按点选顺序编号为 @图片1、@图片2…</small></h3>
        <div className="rpAssets">{assets.map(a => { const i = chosen.findIndex(c => c.id === a.id); return <button key={a.id} className={i >= 0 ? 'on' : ''} onClick={() => toggleAsset(a)} title={a.desc}>
          {i >= 0 && <i>@图片{i + 1}</i>}<img src={a.file!.url} alt="" loading="lazy" /><b>{a.name}</b><em>{a.type}</em></button>; })}</div>
        {chosen.map((c, i) => <label key={c.id} className="rpRole">@图片{i + 1}｜{assetOf(c.id)?.name} 的职责<input value={c.role} onChange={e => { setDraft(null); setChosen(cs => cs.map(x => x.id === c.id ? { ...x, role: e.target.value } : x)); }} /></label>)}
        <p className="hint">没有合适的素材？去左侧 ▣ 资产库点「上传素材」。</p>
        <h3>③ 模型</h3>
        <div className="rpRow">
          <label>视频模型<select value={model} onChange={e => { setModel(e.target.value); setDraft(null); setSize(models[e.target.value]?.sizes[0] || '480p'); }}>{Object.entries(models).map(([k, v]) => <option key={k} value={k}>{v.label}（{v.min}–{v.max}s）</option>)}</select></label>
          <label>分辨率<select value={size} onChange={e => setSize(e.target.value)}>{m?.sizes.map(s => <option key={s}>{s}</option>)}</select></label>
        </div>
      </section>
    </div>
    {draft && <section className="rpDraft">
      <h3>④ 复刻提示词 <small>规则 {draft.rules}｜生成 {draft.duration} 秒（镜头共 {draft.span} 秒，多出的部分后期裁掉）｜{cost}｜可以直接改</small></h3>
      <textarea rows={14} value={draft.prompt} onChange={e => setDraft({ ...draft, prompt: e.target.value })} />
    </section>}
    {job && <pre className="rpLog">{job.log.slice(-6).join('\n')}</pre>}
    {err && <p className="err">{err}</p>}
    <div className="right">
      <button className="secondary" disabled={busy === 'run'} onClick={onClose}>关闭</button>
      <button className="secondary" disabled={!!busy || problems.length > 0} title={problems.join('；')} onClick={doDraft}>{busy === 'draft' ? '起草中…（约 1 分钟）' : draft ? '重新起草' : '起草提示词'}</button>
      {draft && <button disabled={!!busy || problems.length > 0} onClick={submit}>{busy === 'run' ? '生成中…（几分钟，可以先关掉看别的）' : `提交到博观生成（${cost}）`}</button>}
    </div>
    {problems.length > 0 && <small className="hint">{problems.join('；')}</small>}
  </div></div>;
}
