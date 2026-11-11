// The user-facing page: pick a template → upload one picture → pick a preview → get the videos.
// Everything technical (prompts, presets, models, QA) stays on the server.
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, CopyItem, EngineConfig, FitView, GapView, JobView, ProductView, readFile, readImage, TemplateCard, VersionView } from './api';
import { JobsPage, TracePage, Works } from './Trace';
import './swap.css';

const useHash = () => {
  const [h, set] = useState(location.hash.slice(1));
  useEffect(() => { const f = () => set(location.hash.slice(1)); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return h;
};
const go = (h: string) => { location.hash = h; };

function App() {
  const hash = useHash();
  const [templates, setTemplates] = useState<TemplateCard[]>();
  const [cfg, setCfg] = useState<EngineConfig>();
  useEffect(() => { api.templates().then(setTemplates); api.config().then(setCfg); }, []);
  const [kind, id, sub] = hash.split('/');
  const t = templates?.find(x => x.id === (kind === 't' ? id : undefined));
  return <div className="sw">
    <header className="top">
      <a className="brand" href="#">一键复刻</a>
      <nav className="topnav"><a href="#">视频</a><a href="#text">文字改视频</a><a href="#works">我的作品</a><a href="#jobs">链路复盘</a></nav>
      {cfg && <span className="engine" title={`预览图：${cfg.image}\n视频：${cfg.video}\n检查：${cfg.guard}\n质检：${cfg.checker}`}>{cfg.video.includes('模拟') ? '演示模式（不扣费）' : cfg.video}</span>}
    </header>
    {kind === 'works' ? <Works />
      : kind === 'jobs' ? <JobsPage templates={templates || []} />
      : kind === 'trace' && id ? <TracePage id={id} at={sub} />
      : kind === 'job' && id ? <JobPage id={id} templates={templates || []} />
      : kind === 'text' ? <TextPage cfg={cfg} />
      : kind === 'own' ? <ReplicaPage cfg={cfg} />
      : t ? <ReplicaPage t={t} cfg={cfg} />
      : <Home templates={templates} />}
  </div>;
}

function Home({ templates }: { templates?: TemplateCard[] }) {
  return <main className="home">
    <h1>选一个喜欢的视频，放进你的图，一键复刻</h1>
    <p className="sub">镜头、动作、运镜、节奏都和原片一样，只把人或商品换成你的。</p>
    {!templates ? <p className="muted">加载中…</p> : !templates.length ? <p className="muted">还没有模板</p> :
      <div className="cards">{templates.map(t => <button key={t.id} className="card" onClick={() => go('t/' + t.id)}>
        <video src={t.video} poster={t.cover} muted loop playsInline onMouseEnter={e => e.currentTarget.play()} onMouseLeave={e => e.currentTarget.pause()} />
        <b>{t.title}</b><span>{t.desc}</span>
        {t.note && <em>{t.note}</em>}
      </button>)}
        <button className="card textCard" onClick={() => go('own')}>
          <div className="textCardArt">上传<br />我的视频</div>
          <b>用我自己的视频</b><span>找到一个喜欢的视频，放进你的商品或人像，一键复刻。</span>
        </button>
        <button className="card textCard" onClick={() => go('text')}>
          <div className="textCardArt">换背景<br />换物品</div>
          <b>文字改视频</b><span>上传你自己的视频，用一句话说要把背景或某样东西换成什么，人物和动作不变。</span>
        </button>
      </div>}
  </main>;
}

/** 一键复刻: a video (a template or the user's own) + their pictures + optional words. Nothing else to decide. */
function ReplicaPage({ t, cfg }: { t?: TemplateCard; cfg?: EngineConfig }) {
  const [video, setVideo] = useState<{ data: string; url: string }>();
  const [images, setImages] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('');
  const [styles, setStyles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [products, setProducts] = useState<ProductView[]>([]);
  /** '' = not saved; 'new' = a new product named `newName`; else a product id. */
  const [pid, setPid] = useState('');
  const [scout, setScout] = useState(false);
  const [newName, setNewName] = useState('');
  useEffect(() => { api.products().then(setProducts).catch(() => setProducts([])); }, []);
  const product = products.find(p => p.id === pid);
  const putProduct = (p: ProductView) => setProducts(x => x.map(y => y.id === p.id ? p : y));
  const addImages = async (fs?: FileList | null) => {
    const list = [...(fs || [])].filter(f => f.type.startsWith('image/'));
    if (!list.length) return;
    setErr(undefined);
    const read = await Promise.all(list.map(readImage));
    setImages(x => [...x, ...read].slice(0, 8));
  };
  const takeVideo = async (f?: File) => {
    if (!f) return;
    if (!f.type.startsWith('video/')) return setErr('请上传视频文件（MP4 / MOV / WEBM）');
    if (f.size > 100 * 1024 * 1024) return setErr('视频请小于 100MB');
    setErr(undefined); setVideo({ data: await readFile(f), url: URL.createObjectURL(f) });
  };
  const start = async () => {
    setBusy(true); setErr(undefined);
    try {
      const j = await api.replica({ templateId: t?.id, video: t ? undefined : video!.data, images, prompt, styles,
        productId: product?.id, productName: pid === 'new' ? newName : undefined, scout });
      go('job/' + j.id);
    }
    catch (e: any) { setErr(e.message); setBusy(false); }
  };
  const ready = (images.length > 0 || !!product?.photos.length) && (t || video) && (pid !== 'new' || newName.trim());
  return <main className="tpl">
    <a className="back" href="#">← 全部视频</a>
    <div className="tplGrid">
      {t ? <div className="player"><video src={t.video} poster={t.cover} controls loop autoPlay muted playsInline /><small>原片 · {t.seconds} 秒{t.note ? ` · ${t.note}` : ''}</small></div>
        : <label className={'player drop videoDrop' + (video ? ' has' : '')} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); takeVideo(e.dataTransfer.files[0]); }}>
          {video ? <video src={video.url} controls loop autoPlay muted playsInline />
            : <><b>点击或拖入你喜欢的视频</b><span>MP4 / MOV，60 秒以内</span></>}
          <input type="file" accept="video/mp4,video/quicktime,video/webm" hidden onChange={e => takeVideo(e.target.files?.[0])} />
        </label>}
      <div className="panel">
        <h2>{t ? t.title : '用我自己的视频'}</h2>
        <p className="muted">镜头、构图、动作和节奏都照原片，只把里面的东西换成你的。</p>
        <Step n={1} title="放入你的图（人像或商品）" />
        <ProductPick products={products} pid={pid} setPid={setPid} newName={newName} setNewName={setNewName} product={product} put={putProduct} />
        <div className="uploads">
          {images.map((src, i) => <div key={i} className="thumb"><img src={src} /><button title="去掉" onClick={() => setImages(x => x.filter((_, k) => k !== i))}>×</button></div>)}
          {images.length < 8 && <label className="thumb add" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); addImages(e.dataTransfer.files); }}>
            <b>+</b><span>{images.length ? '再加一张' : '点击或拖入'}</span>
            <input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={e => addImages(e.target.files)} />
          </label>}
        </div>
        <p className="muted small">{product?.photos.length ? `商品库里的 ${product.photos.length} 张实拍图会一起用，这里只放新的角度即可。` : '一张就能做；原片里有侧面、背面或鞋底时，多放几个角度会准很多（最多 8 张，AI 会给每个镜头挑最合适的）。缺的角度 AI 会补，但细节可能不准。'}</p>
        <Step n={2} title="想怎么改？（可以不写）" />
        <textarea className="textAsk" rows={3} maxLength={500} value={prompt} placeholder="例：把女主手里的手机换成我的手机；衣服保留原片的" onChange={e => setPrompt(e.target.value)} />
        <Step n={3} title="想要哪些风格？" />
        <div className="chips">
          <button className="on" disabled>原片风格</button>
          {(cfg?.styles || []).map(s => <button key={s.id} className={styles.includes(s.id) ? 'on' : ''}
            onClick={() => setStyles(x => x.includes(s.id) ? x.filter(y => y !== s.id) : [...x, s.id])}>{s.label}</button>)}
        </div>
        <p className="muted small">原片风格一定会做；每多选一种风格，多生成一条视频。</p>
        <label className="scoutSwitch"><input type="checkbox" checked={scout} onChange={e => setScout(e.target.checked)} />
          <span><b>联网找缺的素材</b>原片拍到了你图里没有的部位（比如只给了汽车外观，原片拍了内饰）时，AI 去网上找同款实拍图给你确认。不用干等：确认页会先打开，找到的图几分钟内陆续出现。</span></label>
        <button className="primary" disabled={!ready || busy} onClick={start}>{busy ? '提交中…' : `一键复刻${styles.length ? `（${styles.length + 1} 条）` : ''}`}</button>
        <p className="muted small">提交后不用再操作，等几分钟就能下载成片。{cfg && t && t.seconds > cfg.maxSeconds ? ' 视频较长，会分段生成，时间会久一些。' : ''}</p>
        {err && <p className="error">{err}</p>}
      </div>
    </div>
  </main>;
}

/** 商品库: pick the product so its real photos and known pitfalls come along, and this job's photos are kept for next time. */
function ProductPick({ products, pid, setPid, newName, setNewName, product, put }: { products: ProductView[]; pid: string; setPid: (s: string) => void;
  newName: string; setNewName: (s: string) => void; product?: ProductView; put: (p: ProductView) => void }) {
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string>();
  const act = (f: Promise<ProductView>) => f.then(p => { put(p); setErr(undefined); }).catch(e => setErr(e.message));
  return <div className="product">
    <label className="productRow">
      <span>商品</span>
      <select value={pid} onChange={e => setPid(e.target.value)}>
        <option value="">不存入商品库</option>
        <option value="new">+ 新商品</option>
        {products.map(p => <option key={p.id} value={p.id}>{p.name}（{p.photos.length} 张图{p.notes.length ? `，${p.notes.length} 条要点` : ''}）</option>)}
      </select>
    </label>
    {pid === 'new' && <input className="productName" value={newName} maxLength={60} placeholder="商品名，例：安踏 C202 6代 PRO 白橙" onChange={e => setNewName(e.target.value)} />}
    {pid === 'new' && <p className="muted small">这次上传的图和补拍的角度会存进这个商品，下次换别的视频直接选它。</p>}
    {product && <>
      {!!product.photos.length && <div className="uploads lib">{product.photos.map(x => <div key={x.file} className="thumb">
        <img src={x.url} />{(x.angle || x.web) && <em>{x.web ? `网图${x.angle ? ' · ' + x.angle : ''}` : x.angle}</em>}
        <button title="这张不再使用（文件保留）" onClick={() => act(api.hidePhoto(product.id, x.file))}>×</button>
      </div>)}</div>}
      <div className="notes">
        <b>商品要点</b><span className="muted small">以前出过的错写在这里，生成和验收都会逐条核对</span>
        {product.notes.map((n, i) => <div key={i} className="note"><span>{n}</span><button title="删掉这条" onClick={() => act(api.removeNote(product.id, i))}>×</button></div>)}
        <div className="noteAdd">
          <input value={note} maxLength={200} placeholder="例：蓝色飞线只在外侧，内侧是纯白" onChange={e => setNote(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && note.trim()) { act(api.addNote(product.id, note)); setNote(''); } }} />
          <button className="ghost small" disabled={!note.trim()} onClick={() => { act(api.addNote(product.id, note)); setNote(''); }}>添加</button>
        </div>
      </div>
    </>}
    {err && <p className="error">{err}</p>}
  </div>;
}

const TEXT_KINDS = {
  background: { label: '换背景', placeholder: '例：飞机舷窗边的座位，窗外是蓝天和云海，白天' },
  object: { label: '换物品', placeholder: '例：把桌上的玻璃杯换成一碗豚骨拉面，有溏心蛋、叉烧和筷子' }
} as const;

function TextPage({ cfg }: { cfg?: EngineConfig }) {
  const [video, setVideo] = useState<{ data: string; url: string; seconds?: number }>();
  const [kind, setKind] = useState<keyof typeof TEXT_KINDS>('background');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const take = async (f?: File) => {
    if (!f) return;
    if (!f.type.startsWith('video/')) return setErr('请上传视频文件（MP4 / MOV / WEBM）');
    if (f.size > 100 * 1024 * 1024) return setErr('视频请小于 100MB');
    setErr(undefined); setVideo({ data: await readFile(f), url: URL.createObjectURL(f) });
  };
  const secs = video?.seconds, max = cfg?.maxSeconds || 8;
  const segs = secs ? Math.ceil(Math.min(secs, 30) / max) : 1;
  const start = async () => {
    setBusy(true); setErr(undefined);
    try { const j = await api.createText(video!.data, kind, text); go('job/' + j.id); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return <main className="tpl">
    <a className="back" href="#">← 首页</a>
    <div className="tplGrid">
      <label className={'player drop videoDrop' + (video ? ' has' : '')} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); take(e.dataTransfer.files[0]); }}>
        {video ? <video src={video.url} controls loop autoPlay muted playsInline onLoadedMetadata={e => { const d = e.currentTarget.duration; setVideo(v => v && { ...v, seconds: d }); }} />
          : <><b>点击或拖入视频</b><span>MP4 / MOV，30 秒以内，人物和镜头越稳效果越好</span></>}
        <input type="file" accept="video/mp4,video/quicktime,video/webm" hidden onChange={e => take(e.target.files?.[0])} />
      </label>
      <div className="panel">
        <h2>文字改视频</h2>
        <p className="muted">人物、口型、动作和运镜都照原片，只改你说的那一样。原声会放回去。</p>
        <Step n={1} title="上传视频" />
        {secs != null && <p className="muted small">{secs.toFixed(1)} 秒{secs > 30 ? '，只处理前 30 秒' : ''}{segs > 1 ? `，会分 ${segs} 段生成再拼起来` : ''}</p>}
        <Step n={2} title="改什么" />
        <div className="chips">{(Object.keys(TEXT_KINDS) as (keyof typeof TEXT_KINDS)[]).map(k =>
          <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{TEXT_KINDS[k].label}</button>)}</div>
        <Step n={3} title={kind === 'background' ? '换成什么样的背景' : '把什么换成什么'} />
        <textarea className="textAsk" rows={4} maxLength={400} value={text} placeholder={TEXT_KINDS[kind].placeholder} onChange={e => setText(e.target.value)} />
        <button className="primary" disabled={!video || !text.trim() || busy} onClick={start}>{busy ? '上传中…' : '生成视频'}</button>
        <p className="muted small">只用文字，不需要参考图；描述越具体越好（地点、时间、光线、物品的样子）。{segs > 1 && ' 分段生成时，段与段的接缝处背景可能略有变化。'}</p>
        {err && <p className="error">{err}</p>}
      </div>
    </div>
  </main>;
}

const Step = ({ n, title }: { n: number; title: string }) => <div className="step"><i>{n}</i>{title}</div>;

function JobPage({ id, templates }: { id: string; templates: TemplateCard[] }) {
  const [job, setJob] = useState<JobView>();
  const [err, setErr] = useState<string>();
  const [choice, setChoice] = useState(0);
  useEffect(() => {
    let alive = true, timer = 0, onConfirm = false;
    const tick = async () => {
      // The confirm page keeps polling while the scout looks, so found pictures appear; what the user typed lives in Slots and stays.
      try {
        const j = await api.job(id); if (!alive) return; setJob(j); onConfirm = j.stage === 'slots';
        if (['done', 'failed', 'pick', 'slots'].includes(j.stage) && !(j.stage === 'slots' && j.replica?.scouting)) return;
      }
      catch (e: any) { if (!alive) return; if (!onConfirm) { setErr(e.message); return; } } // a blip must not wipe the confirm page
      timer = window.setTimeout(tick, 2000);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [id, job?.stage]);
  if (err) return <main className="job"><p className="error">{err}</p><a href="#">返回首页</a></main>;
  if (!job) return <main className="job"><p className="muted">加载中…</p></main>;
  const t = templates.find(x => x.id === job.templateId);
  const act = (p: Promise<JobView>) => p.then(setJob).catch(e => setErr(e.message));
  if (job.replica) return <ReplicaJob job={job} t={t} update={setJob} />;
  return <main className="job">
    <a className="back" href={t ? '#t/' + t.id : job.templateId === 'text' ? '#text' : '#'}>← {t?.title || (job.templateId === 'text' ? '文字改视频' : '返回')}</a>
    {job.templateId !== 'text' && <Progress stage={job.stage} />}
    <a className={'traceLink' + (job.templateId === 'text' ? ' solo' : '')} href={'#trace/' + job.id}>查看这次的完整链路 →</a>
    {(job.stage === 'checking' || job.stage === 'framing') && <Waiting text={job.message} sub="大约 30 秒" />}
    {job.stage === 'pick' && <section>
      <h2>选一张最像的</h2>
      <p className="muted">视频会照着这张图来做。都不满意可以再出两张，不用花视频的钱。</p>
      <div className="frames">{job.frames.map((f, i) => <button key={f} className={choice === i ? 'on' : ''} onClick={() => setChoice(i)}><img src={f} /></button>)}</div>
      <div className="row">
        <button className="primary" onClick={() => act(api.pick(id, choice))}>就用这张，生成视频</button>
        <button className="ghost" onClick={() => act(api.retry(id))}>都不满意，再来两张</button>
      </div>
    </section>}
    {(job.stage === 'rendering' || job.stage === 'done' || (job.stage === 'failed' && job.versions.length > 0)) && <section>
      <h2>{job.stage === 'rendering' ? '正在生成视频' : job.stage === 'done' ? '做好了' : '没有成功'}</h2>
      {job.stage === 'rendering' && <p className="muted">每个版本几分钟，可以先离开，稍后回到这个页面查看。</p>}
      <div className="results">{job.versions.map(v => <Result key={v.id} v={v} />)}</div>
    </section>}
    {job.stage === 'failed' && !job.versions.length && <section className="failBox">
      <h2>{job.message}</h2>
      <p>{job.error}</p>
      <div className="row">
        {t && <a className="primary" href={'#t/' + t.id}>换一张图</a>}
        {job.guard && !job.guard.ok && t && <button className="ghost" onClick={async () => {
          const img = await fetch(job.upload).then(r => r.blob()).then(b => readImage(new File([b], 'x', { type: b.type })));
          act(api.create(t.id, img, [], true, job.slotMode).then(j => { go('job/' + j.id); return j; }));
        }}>我确认可以使用，继续</button>}
      </div>
    </section>}
  </main>;
}

const PHASE_TIP: Record<string, string> = {
  review: '逐个镜头看原片', plan: '决定哪些镜头要改、哪些直接用原片', assets: '你的图缺少原片需要的角度时自动补上',
  keyframes: '每个场景做一张改好的画面，并一起检查', generate: '分段同时生成', repair: '检查动作、外观和接缝，有问题的段自动重做', compose: '拼接成完整视频', voice: '按新文案配音、上字幕'
};

function ReplicaJob({ job, t, update }: { job: JobView; t?: TemplateCard; update: (j: JobView) => void }) {
  const r = job.replica!, v = job.versions[0];
  const done = r.phases.filter(p => p.status === 'done' || p.status === 'skipped').length;
  const segs = r.segments.length, segDone = r.segments.filter(s => s.status === 'done').length;
  const again = t ? '#t/' + t.id : '#own';
  // A finished step reopens what it showed: 看懂原片 / 制定方案 / 补全素材 bring back the timeline of 开始前确认,
  // the later ones scroll to their part of this page. The full record stays one link away.
  const [view, setView] = useState<string>();
  const ANCHOR: Record<string, string> = { keyframes: '.kfs', generate: '.redo', repair: '.redo', compose: '.result', voice: '.changes' };
  const open = (p: typeof r.phases[number]) => {
    if (p.status === 'waiting' || p.status === 'running') return;
    if (['review', 'plan', 'assets'].includes(p.id) && r.fit.length && job.stage !== 'slots') { setView(p.id); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    setView(undefined);
    const el = ANCHOR[p.id] && document.querySelector(ANCHOR[p.id]);
    if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    else go(`trace/${job.id}/${p.id}`);
  };
  return <main className="job">
    <a className="back" href={again}>← {t?.title || '用我自己的视频'}</a>
    <a className="traceLink solo" href={'#trace/' + job.id}>查看这次的完整链路 →</a>
    {job.mock && <p className="mockNote">这是演示模式做的：没有调用真实模型，结果只是原片加了色调和参考图，不是复刻效果。要真实生成，请在真实模式的服务里重新提交。</p>}
    <div className="replica">
      <section className="phases">
        <div className="bar"><i style={{ width: `${Math.round(done / r.phases.length * 100)}%` }} /></div>
        <ol>{r.phases.map(p => <li key={p.id} className={'ph-' + p.status + (view === p.id ? ' on' : '')} role="link" title="回到这一步" onClick={() => open(p)}>
          <i>{p.status === 'done' ? '✓' : p.status === 'skipped' ? '–' : p.status === 'failed' ? '!' : p.status === 'running' ? <span className="dot" /> : ''}</i>
          <div><b>{p.label}</b><span>{p.status === 'skipped' ? `不需要${p.note ? '：' + p.note : ''}` : p.note || PHASE_TIP[p.id]}
            {p.id === 'generate' && p.status === 'running' && segs > 1 ? `（${segDone}/${segs}）` : ''}</span></div>
        </li>)}</ol>
        {r.summary && <p className="plan">方案：{r.summary}</p>}
        {r.route && <RouteNote route={r.route} />}
      </section>
      <section className="replicaMain">
        {view && <PlanReview job={job} at={view} close={() => setView(undefined)} />}
        {job.stage === 'slots' ? <Slots job={job} update={update} />
          : v.status === 'done' && v.final ? <><Result v={v} /><Redo job={job} update={update} /></>
          : job.stage === 'failed' ? <div className="failBox"><h2>{job.message === '已取消' ? '已取消' : '没有成功'}</h2><p>{job.error}</p>{r.keyframeStop && <button className="ghost" onClick={() => api.resume(job.id).then(update)}>仍然生成视频</button>}<a className="primary" href={again}>再试一次</a></div>
          : <Waiting text={job.message} sub="大约几分钟，可以先离开，稍后回来看" />}
        {job.stage !== 'slots' && (r.copy.length > 0 || r.copyCheck) && <ChangeList job={job} update={update} />}
        {v.status === 'done' && <StyleVersions job={job} update={update} />}
        {(r.sheet || r.variants.length > 0 || r.keyframes.length > 0) && <div className="kfs">
          <h3>AI 做的关键画面</h3>
          <div>{r.sheet && <figure><img src={r.sheet} /><figcaption>补全的素材</figcaption></figure>}
            {r.variants.map(a => <figure key={a.label}><img src={a.url} /><figcaption>{a.label}</figcaption></figure>)}
            {r.keyframes.map(k => <figure key={k.scene}><img src={k.url} /><figcaption>场景 {k.scene}{k.ok === false ? ' · 没通过验收' : ''}</figcaption></figure>)}</div>
        </div>}
      </section>
    </div>
  </main>;
}

/** 再要一版: the finished film in another style. Each one is one more video run. */
function StyleVersions({ job, update }: { job: JobView; update: (j: JobView) => void }) {
  const made = job.versions.slice(1), busy = made.some(v => v.status === 'running');
  const [err, setErr] = useState<string>();
  useEffect(() => {
    if (!busy) return;
    const t = window.setInterval(() => api.job(job.id).then(update).catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [busy, job.id]);
  const go = (id: string) => api.restyle(job.id, id).then(update).catch(e => setErr(e.message));
  return <div className="kfs styles">
    <h3>再要一版</h3>
    <div className="chips">{job.replica!.styles.map(s => { const v = made.find(x => x.id === s.id);
      return <button key={s.id} className={v ? 'on' : ''} disabled={v?.status === 'running'} onClick={() => go(s.id)}>{s.label}{v?.status === 'running' ? ' · 生成中' : v?.status === 'done' ? ' · 重做' : ''}</button>; })}</div>
    <p className="muted small">每一版多生成一次视频。</p>
    {err && <p className="error">{err}</p>}
    {made.length > 0 && <div className="results">{made.map(v => <Result key={v.id} v={v} />)}</div>}
  </div>;
}

/** What a shot is made from. keep: the source as is; none: cut or not makeable; missing: a part nobody has a picture of yet. */
type ShotAsset = { kind: 'keep' | 'none' | 'part' | 'missing' | 'slot' | 'base'; label: string; pic?: string; /** All photos picked for this shot. */ pics?: string[]; slot?: string; gap?: number; own?: boolean; auto?: boolean };
const RouteNote = ({ route }: { route: NonNullable<JobView['replica']>['route'] & {} }) => <p className={'routeNote ' + route.kind}>
  <b>{route.kind === 'simple' ? '简单路线' : '完整路线'}</b>
  {route.kind === 'simple' ? '：把原片和你的图交给模型生成一次，不做关键画面，也不自动重做。' : '：先做关键画面，再分段生成，有问题自动重做一次。'}
  <span>原因：{route.reasons.join('；')}</span></p>;
const FIT_LABEL = { good: '效果好', rough: '效果打折', no: '做不出来' } as const;

/** 时间轴: the film on a ruler. Each shot is a thumbnail coloured by whether it can be made; pins mark missing pictures
 *  and colour versions. Click anywhere to jump there and play. */
function Timeline({ src, fit, pieces, marks, assets, gapsAt, pick, reject }: { src: string; fit: FitView[]; pieces: FitView[]; marks: { at: number; label: string; kind: string; pic?: string }[];
  assets: ShotAsset[]; gapsAt: (s: FitView, k: number) => { i: number; g: GapView; pic?: string; web: boolean }[];
  /** Absent: looking back at a job that already started, nothing can be changed. */
  pick?: (a: { slot?: string; gap?: number }, f?: File) => void; reject?: (gap: number) => void }) {
  const v = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0);
  const total = fit[fit.length - 1].end;
  const k = Math.max(0, fit.findIndex(s => t >= s.start && t < s.end)), idx = fit.findIndex(s => t >= s.start && t < s.end) < 0 ? fit.length - 1 : k;
  const cur = fit[idx], asset = assets[idx];
  // Jumping from a ruler click plays, to check the shot; from a picture or pin it stays still, to work on it.
  const seek = (x: number, play = true) => { const el = v.current; if (!el) return; el.currentTime = Math.max(0, Math.min(total - 0.05, x)); setT(el.currentTime); if (play) void el.play().catch(() => {}); else el.pause(); };
  const pos = (x: number) => `${Math.max(0, Math.min(100, x / total * 100))}%`;
  const file = (a: { slot?: string; gap?: number }, label: string) => pick && <label className="ghost small" onClick={() => v.current?.pause()}>{label}
    <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e => { pick(a, e.target.files?.[0]); e.target.value = ''; }} /></label>;
  // Neighbouring shots using the same picture read as one block.
  const runs = assets.reduce<{ a: ShotAsset; start: number; end: number; first: number }[]>((out, a, i) => {
    const l = out[out.length - 1], same = l && l.a.kind === a.kind && l.a.pic === a.pic && l.a.gap === a.gap && l.a.slot === a.slot;
    if (same) l.end = fit[i].end; else out.push({ a, start: fit[i].start, end: fit[i].end, first: i });
    return out;
  }, []);
  return <div className="tl">
    <div className="tlTop">
      <video ref={v} src={src} controls playsInline onTimeUpdate={e => setT(e.currentTarget.currentTime)} />
      <div className="tlSide">
        <div className={'tlNow ' + cur.fit}>
          <small>{clock(cur.start)}–{clock(cur.end)} · 当前镜头</small>
          <b>{cur.change === false ? '不用改，直接用原片' : FIT_LABEL[cur.fit]}</b>
          {cur.why && <p>{cur.why}</p>}
          {asset.kind === 'slot' && <div className="tlUse"><img src={asset.pic} className={asset.auto ? 'auto' : ''} />
            <div><b>{asset.label}</b><span>{asset.own ? '用你换的这张图' : asset.auto ? '用你的图自动改色' : '用你上传的图'}</span></div>{file({ slot: asset.slot }, '换图')}</div>}
          {asset.kind === 'base' && <div className="tlUse"><img src={asset.pic} /><div><b>你的图</b><span>这个镜头按它替换</span></div></div>}
          {(asset.pics?.length || 0) > 1 && <div className="tlPics">{asset.pics!.map(u => <img key={u} src={u} />)}<span>这段用这 {asset.pics!.length} 张，第一张最重要</span></div>}
          {gapsAt(cur, idx).map(({ i, g, pic, web }) => <div key={i} className="tlUse">
            {pic ? <img src={pic} /> : <div className="emptyPic small">?</div>}
            <div><b>{g.kind === 'screen' ? '屏幕操作：' : '缺：'}{g.label}</b>
              <span>{g.kind === 'screen' ? '需要实车操作，现在还不能上传视频' : web ? '联网找到的图' : pic ? '用你这张图' : '还没有图，不补的话细节靠 AI 推测'}</span></div>
            {g.kind !== 'screen' && file({ gap: i }, pic ? '换图' : '补一张')}
            {web && reject && <button className="ghost small" onClick={() => reject(i)}>不用这张</button>}
          </div>)}
        </div>
        <div className="tlPieces">
          {pieces.map((s, i) => <button key={i} className={s.fit + (cur.start >= s.start && cur.start < s.end ? ' on' : '')} onClick={() => seek(s.start)}>
            <span>{clock(s.start)}–{clock(s.end)}</span>{s.why || FIT_LABEL[s.fit]}</button>)}
        </div>
      </div>
    </div>
    <div className="tlTrack" onClick={e => { const r = e.currentTarget.getBoundingClientRect(); seek((e.clientX - r.left) / r.width * total); }}>
      <div className="tlMarks">{marks.map((m, i) => <span key={i} className={'tlMark ' + m.kind} style={{ left: pos(m.at) }} title={m.label}
        onClick={e => { e.stopPropagation(); seek(m.at, false); }}>{m.pic ? <img src={m.pic} /> : <i />}</span>)}</div>
      <div className="tlAssets">{runs.map((x, i) => <div key={i} style={{ flex: x.end - x.start }} title={x.a.label}
        className={'tlAsset ' + x.a.kind + (x.a.auto ? ' auto' : '') + (idx >= x.first && t >= x.start && t < x.end ? ' on' : '')}
        onClick={e => { e.stopPropagation(); seek(x.start + 0.01, false); }}>
        {x.a.pic ? <i style={{ backgroundImage: `url("${x.a.pic}")` }} /> : x.a.kind === 'missing' ? <span>?</span> : x.a.kind === 'keep' ? <span>原片</span> : <span>×</span>}</div>)}</div>
      <div className="tlStrip">{fit.map((s, i) => <div key={i} className={'tlShot ' + s.fit + (i === idx ? ' on' : '')} style={{ flex: s.end - s.start }}
        title={`${clock(s.start)}–${clock(s.end)} ${FIT_LABEL[s.fit]}${s.why ? '：' + s.why : ''}`}>{s.thumb && <img src={s.thumb} />}<i /></div>)}</div>
      <div className="tlHead" style={{ left: pos(t) }}><em>{clock(t)}</em></div>
      <div className="tlRuler">{Array.from({ length: Math.floor(total / 5) + 1 }, (_, n) => <span key={n} style={{ left: pos(n * 5) }}>{clock(n * 5)}</span>)}</div>
    </div>
    <div className="tlLegend"><span className="good">效果好</span><span className="rough">效果打折</span><span className="no">做不出来</span>
      <span className="pin">{pick ? '上排是每段换成的图：点一下选中，在上面换图；"?" 是缺素材' : '上排是每段用的图，"?" 是当时缺的素材'}</span></div>
  </div>;
}

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

type Replica = NonNullable<JobView['replica']>;
const covers = (g: GapView, s: FitView, k: number) => g.shots?.length ? g.shots.includes(k + 1) : g.at >= s.start && g.at < s.end;
/** What each shot will be made from: this is what the timeline's upper row shows. `slotPic` / `gapPic` give the user's own picks. */
function shotAssets(r: Replica, slotPic: (id: string) => string | undefined, gapPic: (g: GapView, i: number) => string | undefined): ShotAsset[] {
  return r.fit.map((s, k) => {
    if (s.change === false) return { kind: 'keep', label: '不用改，直接用原片' };
    if (s.fit === 'no') return { kind: 'none', label: '做不出来' };
    const part = r.gaps.findIndex(g => (g.kind === 'part' || g.kind === 'cast') && covers(g, s, k));
    if (part >= 0) { const pic = gapPic(r.gaps[part], part); return { kind: pic ? 'part' : 'missing', gap: part, pic, label: r.gaps[part].label }; }
    const v = r.slots.find(x => x.id === s.variant), own = v && slotPic(v.id);
    if (v) return { kind: 'slot', slot: v.id, pic: own || (v.main && s.pics?.[0]) || v.image, pics: v.main && !own ? s.pics : undefined, label: v.label, own: !!own, auto: !v.main && !own };
    return { kind: 'base', pic: s.pics?.[0] || r.uploads[0], pics: s.pics, label: '你的图' };
  });
}
/** Neighbouring shots with the same verdict read as one piece; only the ones that are not plain good. */
const fitPieces = (fit: FitView[]) => fit.reduce<FitView[]>((out, s) => { const l = out[out.length - 1]; if (l && l.fit === s.fit && l.why === s.why) l.end = s.end; else out.push({ ...s }); return out; }, []).filter(s => s.fit !== 'good');
function FitSummary({ fit }: { fit: FitView[] }) {
  const secs = (k: string) => fit.filter(s => s.fit === k).reduce((a, s) => a + s.end - s.start, 0);
  const total = fit.length ? fit[fit.length - 1].end : 0, no = secs('no'), rough = secs('rough'), pct = (x: number) => Math.round(x / total * 100);
  if (!no && !rough) return null;
  return <div className="fit">
    <b>效果好 {pct(total - no - rough)}% · 效果打折 {pct(rough)}% · 做不出来 {pct(no)}%</b>
    <ul>
      <li><span className="dotg" />能复刻，效果和原片差不多：{Math.round(total - no - rough)} 秒</li>
      {rough > 0 && <li><span className="doty" />能做，但细节可能和你的实物不完全一样：{Math.round(rough)} 秒</li>}
      {no > 0 && <li><span className="dotr" />做不出来：{Math.round(no)} 秒</li>}
    </ul>
  </div>;
}
const gapMarks = (gaps: GapView[], pic: (g: GapView, i: number) => string | undefined) =>
  gaps.map((g, i) => ({ at: g.at, label: ({ part: '缺部位', screen: '屏幕操作', angle: '缺角度', cast: '换人物' } as any)[g.kind] + '：' + g.label, kind: g.kind, pic: g.kind === 'screen' ? undefined : pic(g, i) }));

/** 回看: a started job's 开始前确认 as it was decided — the timeline, the plan and the copy — without changing anything. */
function PlanReview({ job, at, close }: { job: JobView; at: string; close: () => void }) {
  const r = job.replica!, pic = (g: GapView) => g.found?.url;
  const ph = r.phases.find(p => p.id === at);
  return <div className="slots confirm review">
    <header className="reviewHead"><h2>{ph?.label}<small>{ph?.note}</small></h2>
      <button className="ghost small" onClick={close}>← 回到成片</button></header>
    {r.summary && <p className="plan">方案：{r.summary}</p>}
    {r.route && <RouteNote route={r.route} />}
    <FitSummary fit={r.fit} />
    <Timeline src={r.source} fit={r.fit} pieces={fitPieces(r.fit)} assets={shotAssets(r, () => undefined, pic)}
      gapsAt={(s, k) => r.gaps.flatMap((g, i) => covers(g, s, k) ? [{ i, g, pic: g.kind === 'screen' ? undefined : pic(g), web: !!g.found }] : [])}
      marks={gapMarks(r.gaps, pic)} />
    <a className="traceLink solo" href={`#trace/${job.id}/${at}`}>这一步给模型的输入和输出 →</a>
  </div>;
}

const SRC = { voice: '口播', caption: '字幕', both: '口播+字幕' } as const;
/** The lines that no longer fit the new product, as AI rewrote them. Every line can be edited; a click on the time jumps the video there. */
function CopyRows({ items, edit }: { items: CopyItem[]; edit?: (i: number, to: string) => void }) {
  const [open, setOpen] = useState<number[]>([]);
  const seek = (t: number) => { const v = document.querySelector<HTMLVideoElement>('.replicaMain video'); if (v) { v.currentTime = t; v.play().catch(() => {}); } };
  // Prices come first and on their own: only the user knows them, and the film's number stays until they fill one in.
  const prices = items.map((c, i) => ({ c, i })).filter(x => x.c.price);
  return <>{prices.length > 0 && <div className="priceBox">
    <b>价格和规格，只有你知道</b><span className="muted small">不填就保留原片的数字，发布前请核对</span>
    {prices.map(({ c, i }) => <label key={i} className="priceRow">
      <button type="button" className="at" onClick={e => { e.preventDefault(); seek(c.at); }}>{clock(c.at)}</button>
      <span className="was">{c.from}{c.why ? <small>{c.why}</small> : null}</span><i>→</i>
      {edit ? <input value={c.to === c.from ? '' : c.to} maxLength={40} placeholder="你的价格 / 规格" onChange={e => edit(i, e.target.value.trim() ? e.target.value : c.from)} /> : <em>{c.to === c.from ? '保留原片' : c.to}</em>}
    </label>)}
  </div>}
  <ul className="copyRows">{items.map((c, i) => { if (c.price) return null; const editing = edit && (!c.sure || open.includes(i));
    return <li key={i} className={c.sure ? '' : 'check'}>
      <button className="at" onClick={() => seek(c.at)}>{clock(c.at)}</button>
      <i>{c.sure ? '✓' : '!'}</i>
      <div>
        <p>{c.src && <em className="src">{SRC[c.src]}</em>}<s>{c.from}</s> → {editing ? null : c.to}
          {edit && c.sure && !editing && <button className="linkBtn" onClick={() => setOpen(x => [...x, i])}>改</button>}</p>
        {editing && <input value={c.to} maxLength={200} onChange={e => edit!(i, e.target.value)} />}
        {c.why && <span>{c.why}</span>}
      </div>
    </li>; })}</ul></>;
}

/** 开始前确认: what only the user can settle, before money is spent. Everything has a default, so it can all be skipped. */
function Slots({ job, update }: { job: JobView; update: (j: JobView) => void }) {
  const r = job.replica!, slots = r.slots.length > 1 ? r.slots : [], gaps = r.gaps;
  const asks = r.copy.map((c, i) => ({ ...c, i })).filter(c => !c.sure);
  const [images, setImages] = useState<Record<string, string>>({});
  const [angles, setAngles] = useState<Record<string, string>>({});
  const [rejected, setRejected] = useState<number[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const read = async (f: File | undefined, use: (d: string) => void) => { if (f?.type.startsWith('image/')) use(await readImage(f)); };
  const go = async (mode: 'all' | 'fit' | 'cancel' = 'all') => {
    setBusy(true); setErr(undefined);
    try { update(await api.slots(job.id, { images, angles, answers: Object.fromEntries(Object.entries(answers).filter(([i, t]) => t.trim() && !(r.copy[Number(i)].price && t === r.copy[Number(i)].from))), kept: gaps.flatMap((g, i) => found(g, i) ? [i] : []), mode })); } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  const fit = r.fit || [], secs = (k: string) => fit.filter(s => s.fit === k).reduce((a, s) => a + s.end - s.start, 0);
  const total = fit.length ? fit[fit.length - 1].end : 0, no = secs('no');
  const pieces = fitPieces(fit);
  // The copy as AI rewrote it, with the user's edits on top; only edited lines are sent.
  const copy = r.copy.map((c, i) => answers[i] != null ? { ...c, to: answers[i] } : c);
  const found = (g: GapView, i: number) => (g.found && !angles[i] && !rejected.includes(i) ? g.found : undefined);
  const gapPic = (g: GapView, i: number) => angles[i] || found(g, i)?.url;
  const assets = shotAssets(r, id => images[id], gapPic);
  const pickTl = (a: { slot?: string; gap?: number }, f?: File) => read(f, d => {
    if (a.slot) setImages(x => ({ ...x, [a.slot!]: d }));
    else if (a.gap != null) setAngles(x => ({ ...x, [a.gap!]: d }));
  });
  const looking = (g: GapView, i: number) => r.scouting && g.kind === 'part' && !g.found && !angles[i];
  const pics = gaps.map((g, i) => ({ g, i })).filter(({ g }) => g.kind !== 'screen'), screens = gaps.filter(g => g.kind === 'screen');
  const open = pics.filter(({ g, i }) => !angles[i] && !found(g, i)).length + screens.length + asks.filter(c => answers[c.i] == null).length;
  let n = 0;
  return <div className="slots confirm">
    <h2>开始前确认</h2>
    <p className="muted">AI 看完了视频，下面都已配好。不改也能直接生成，还没有开始花钱。</p>
    {r.photoIssue && <p className="mockNote">素材提醒：{r.photoIssue}</p>}
    {r.route && <RouteNote route={r.route} />}

    <FitSummary fit={fit} />
    {fit.length > 0 && <Timeline src={r.source} fit={fit} pieces={pieces} assets={assets} pick={pickTl} reject={i => setRejected(x => [...x, i])}
      gapsAt={(s, k) => gaps.flatMap((g, i) => covers(g, s, k) ? [{ i, g, pic: g.kind === 'screen' ? undefined : gapPic(g, i), web: !angles[i] && !!found(g, i) }] : [])}
      marks={gapMarks(gaps, gapPic)} />}

    {slots.length > 0 && <>
      <h3><i>{++n}</i>要换的款 <small>找到 {slots.length} 款</small></h3>
      {slots.map(s => <div key={s.id} className="slot">
        {s.frame && <img src={s.frame} />}<i>→</i><img src={images[s.id] || s.image} className={images[s.id] || s.main ? '' : 'auto'} />
        <div><b>{s.label}</b><span>{images[s.id] ? '用你换的这张图' : s.main ? '用你上传的图' : '用你的图自动改色'}</span></div>
        <label className="ghost small">换图<input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e => read(e.target.files?.[0], d => setImages(x => ({ ...x, [s.id]: d })))} /></label>
      </div>)}
    </>}

    {pics.length > 0 && <>
      <h3><i>{++n}</i>缺的素材 <small className="todo">可以跳过</small></h3>
      {pics.map(({ g, i }) => { const f = found(g, i); return <div key={i} className="slot">
        {g.frame && <img src={g.frame} />}<i>→</i>
        {angles[i] ? <img src={angles[i]} /> : f ? <img src={f.url} /> : <div className="emptyPic">{looking(g, i) ? <span className="dot" /> : '?'}</div>}
        <div><b>{g.kind === 'cast' ? <>原片 {clock(g.at)} 的人换成：{g.label}</> : <>原片 {clock(g.at)} 拍到了{g.label}</>}</b>
          {looking(g, i) && <span className="looking">正在联网找同款图，找到会自动显示在这里。不用等，也可以自己补一张。</span>}
          <span>{angles[i] ? '会用你这张图' : f && g.kind === 'cast' ? '按你的要求，AI 生成了这个人。不满意可以换成你自己的照片' : f ? <>联网找到的图，只参考结构，不当实拍。{f.why} {f.page && <a href={f.page} target="_blank" rel="noreferrer">来源</a>}</>
            : g.need || '你的图里没有这个角度。不补的话，AI 只按大致样子推测，细节可能和实物不一样'}</span>
          {!angles[i] && !f && g.fallback && <span>不补：{g.fallback}</span>}
        </div>
        <div className="slotBtns">
          {f && <button className="ghost small" onClick={() => setRejected(x => [...x, i])}>不用这张</button>}
          <label className="ghost small">{angles[i] || f ? '换图' : '补一张'}<input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e => read(e.target.files?.[0], d => setAngles(x => ({ ...x, [i]: d })))} /></label>
        </div>
      </div>; })}
    </>}

    {screens.length > 0 && <>
      <h3><i>{++n}</i>屏幕操作 <small className="todo">需要你判断</small></h3>
      {screens.map((g, i) => <div key={i} className="slot">
        {g.frame && <img src={g.frame} />}
        <div><b>原片 {clock(g.at)} 演示了{g.label}</b><span>{g.need}</span>{g.fallback && <span>不补时建议：{g.fallback}</span>}</div>
      </div>)}
      <p className="error">这类操作是事实，AI 画不准，现在也还不能把你拍的操作视频剪进来。选"只复刻能做的部分"会剪掉这些镜头；选"全部都做"的话，这些镜头的屏幕内容不可信，不要当真实操作演示发布。</p>
    </>}

    <h3><i>{++n}</i>字幕和口播{copy.length ? <> 要改 {copy.length} 处 {asks.length ? <small className="todo">{asks.length} 处需要你确认</small> : <small>AI 已改好，可以再改</small>}</> : null}</h3>
    {copy.length ? <>
      <p className="muted small">换成你的东西后，原片里这些话就对不上了。AI 先改好了；打 ! 的是看图确定不了的（品牌、材质、功能），请你核对。每一句都可以自己改。</p>
      <CopyRows items={copy} edit={(i, to) => setAnswers(x => ({ ...x, [i]: to }))} />
    </> : <p className="muted small"><CopyNone r={r} /></p>}

    {no > 0 ? <div className="row choose">
      <button className="primary" disabled={busy} onClick={() => go('fit')}>只复刻能做的部分<small>剪掉 {Math.round(no)} 秒，成片约 {Math.round(total - no)} 秒</small></button>
      <button className="ghost" disabled={busy} onClick={() => go('all')}>全部都做<small>做不了的片段效果不保证</small></button>
      <button className="ghost" disabled={busy} onClick={() => go('cancel')}>不做了<small>不花钱</small></button>
    </div> : <div className="row">
      <button className="primary" disabled={busy} onClick={() => go()}>{busy ? '提交中…' : '开始生成'}</button>
      <span className="muted small">{open ? `还有 ${open} 项用默认处理` : '都确认好了'}</span>
    </div>}
    {r.scouting && <p className="muted small">还在联网找图。现在开始的话就不再找，已经显示出来的图会用上。</p>}
    {no > 0 && <p className="muted small">剪掉片段后，口播也会跟着断开，成片可能讲不完整。{open ? `另有 ${open} 项用默认处理。` : ''}</p>}
    {err && <p className="error">{err}</p>}
  </div>;
}

/** What changes in the captions and voiceover: only the changed lines; a click jumps the video to that second. */
function ChangeList({ job, update }: { job: JobView; update: (j: JobView) => void }) {
  const [items, setItems] = useState<CopyItem[]>(job.replica!.copy);
  const [dirty, setDirty] = useState(false);
  const [subs, setSubs] = useState(job.replica!.subtitles);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const voice = job.replica!.voice;
  const voicing = voice?.status === 'running';
  // The job page stops polling once a job is done; a voice update runs after that.
  useEffect(() => {
    if (!voicing || job.stage !== 'done') return;
    const t = window.setInterval(() => api.job(job.id).then(update).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [voicing, job.stage, job.id]);
  const set = (i: number, to: string) => { setItems(x => x.map((c, k) => k === i ? { ...c, to } : c)); setDirty(true); };
  const save = async () => {
    setBusy(true); setErr(undefined);
    try { await api.saveCopy(job.id, items); update(await api.voiceover(job.id, subs)); setDirty(false); } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const check = items.filter(c => !c.sure && !(c.price && c.to !== c.from)).length;
  if (!items.length) return <div className="changes"><h3>字幕和口播</h3><p className="muted small"><CopyNone r={job.replica!} /></p></div>;
  return <div className="changes">
    <h3>字幕和口播要改 {items.length} 处{check ? <small>{check} 处需要你确认</small> : null}</h3>
    <CopyRows items={items} edit={set} />
    <label className="subsSwitch"><input type="checkbox" checked={subs} onChange={e => { setSubs(e.target.checked); setDirty(true); }} />成片加字幕<span className="muted small">关掉就只有新配音，字幕你可以自己在剪辑软件里加</span></label>
    <div className="row">
      <button className="primary small" disabled={busy || voicing || job.stage !== 'done' || (!dirty && voice?.status === 'done')} onClick={save}>{voicing ? '更新中…' : '更新配音和字幕'}</button>
      <span className="muted small">{voicing ? '大约一分钟，不用重新生成视频' : voice?.status === 'failed' ? `没有成功：${voice.error}` : voice?.status === 'done' ? `已配好 ${voice.lines || ''} 句，不花视频的钱` : '只重做声音和字幕，不花视频的钱'}</span>
    </div>
    {err && <p className="error">{err}</p>}
  </div>;
}

/** Why there is nothing to change, so the user knows the check ran. */
const CopyNone = ({ r }: { r: Replica }) => <>{!r.copyCheck ? '这次没有检查口播和字幕，保留原声。'
  : r.copyCheck.error ? `口播和字幕没检查完（${r.copyCheck.error}），保留原声。`
  : r.copyCheck.heard ? `AI 听了 ${r.copyCheck.heard} 句口播、看了画面上的字幕，没有和你的东西对不上的地方，不用改。`
  : '原片里没有口播（只有音乐），画面上也没有要改的字幕，保留原声。'}</>;

function Progress({ stage }: { stage: JobView['stage'] }) {
  const steps = ['上传', '选预览图', '生成视频', '完成'];
  const at = { checking: 0, framing: 0, pick: 1, rendering: 2, done: 3, failed: -1 }[stage];
  return <ol className="progress">{steps.map((s, i) => <li key={s} className={i < at ? 'done' : i === at ? 'now' : ''}>{s}</li>)}</ol>;
}

const Waiting = ({ text, sub }: { text: string; sub?: string }) => <div className="waiting"><div className="spin" /><b>{text}</b>{sub && <span>{sub}</span>}</div>;

/** 重做这段: only the piece that came out wrong. It costs money, so it always asks first. */
function Redo({ job, update }: { job: JobView; update: (j: JobView) => void }) {
  const r = job.replica!, [busy, setBusy] = useState(false), [err, setErr] = useState<string>();
  if (r.route?.kind === 'simple' || !r.segments.length) return null;
  const go = async (i: number) => {
    const s = r.segments[i];
    if (!confirm(`重新生成 ${clock(s.start)}–${clock(s.end)}${s.yuan ? `，约 ${s.yuan.toFixed(2)} 元` : ''}（如果缺关键画面，会先补，每张 0.1 元）。确定吗？`)) return;
    setBusy(true); setErr(undefined);
    try { update(await api.redo(job.id, i)); } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return <div className="redo"><h3>哪段不满意？</h3>
    <p className="muted small">只重做这一段，其他段不动。</p>
    {r.segments.map((s, i) => <div key={i} className="redoRow">
      <span>{clock(s.start)}–{clock(s.end)}</span><span className={s.lookBad ? 'warn' : 'muted'}>{s.lookBad ? '检查发现明显问题' : '没发现明显问题'}</span>
      <button className="ghost small" disabled={busy} onClick={() => go(i)}>重做这段{s.yuan ? `（约 ${s.yuan.toFixed(2)} 元）` : ''}</button>
    </div>)}
    {r.redoError && <p className="error">上次重做没成功：{r.redoError}。成片没变。</p>}
    {err && <p className="error">{err}</p>}
  </div>;
}

function Result({ v }: { v: VersionView }) {
  const [cmp, setCmp] = useState(false);
  return <div className={'result ' + v.status}>
    <header><b>{v.label}</b><span>{{ waiting: '排队中', running: '生成中', done: '完成', failed: '失败' }[v.status]}</span></header>
    {v.status === 'done' && v.final ? <>
      <video src={cmp ? v.compare : v.final} controls playsInline loop key={String(cmp) + v.final} />
      <div className="row">
        <a className="primary small" href={v.final} download={`${v.label}.mp4`}>下载</a>
        <button className="ghost small" onClick={() => setCmp(!cmp)}>{cmp ? '只看结果' : '和原片对比'}</button>
      </div>
      {v.check && !v.check.pass && <p className="warn">{v.check.summary}</p>}
    </> : v.status === 'failed' ? <p className="error">{v.error}</p> : <Waiting text={v.status === 'waiting' ? '等前一步完成' : v.step || '生成中'} sub={v.status === 'running' ? '每段几分钟' : undefined} />}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
