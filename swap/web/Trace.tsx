// 链路复盘: everything one job did, step by step: what went into each model, what came out, what QA said.
import React, { useEffect, useState } from 'react';
import { api, JobSummary, TemplateCard } from './api';

const STAGE: Record<string, string> = { checking: '检查中', framing: '出预览图', pick: '等待选图', slots: '等你确认', rendering: '生成视频', done: '完成', failed: '失败' };
const JOIN: Record<string, string> = { start: '第一段', hard: '在剪辑点切开（和前一段同时生成）', soft: '镜头中间切开（接着上一段的最后一帧生成）' };
const MODE: Record<string, string> = { O: '替换（其余一律不变）', M: '换人/换场景（保留动作和运镜）', R: '风格化（只保留动作和构图）' };
const secs = (ms?: number) => ms == null ? '' : ms < 60_000 ? `${(ms / 1000).toFixed(0)} 秒` : `${(ms / 60_000).toFixed(1)} 分钟`;
const when = (t: number) => new Date(t).toLocaleString('zh-CN', { hour12: false });

/** 我的作品: every job as a playable result with what was chosen and which models ran. */
export function Works() {
  const [jobs, setJobs] = useState<JobSummary[]>();
  const [all, setAll] = useState(false);
  useEffect(() => { api.jobs().then(setJobs); }, []);
  if (!jobs) return <main className="job"><p className="muted">加载中…</p></main>;
  if (!jobs.length) return <main className="job"><p className="muted">还没有作品</p></main>;
  const shown = all ? jobs : jobs.filter(j => j.results.length);
  return <main className="works job">
    <h2>我的作品 <small>{jobs.filter(j => j.results.length).length} 个成片 · 共 {jobs.length} 次生成</small>
      <button className="ghost small" onClick={() => setAll(!all)}>{all ? '只看成片' : '显示全部（含失败）'}</button></h2>
    <div className="workGrid">{shown.map(j => <Work key={j.id} j={j} />)}</div>
  </main>;
}

function Work({ j }: { j: JobSummary }) {
  const [k, setK] = useState(0), [cmp, setCmp] = useState(false);
  const r = j.results[k], took = j.seconds.length > 1 ? Math.max(...j.seconds) - Math.min(...j.seconds) : undefined;
  const choices = j.versions.slice(1).map(v => v.replace(/^.*?：/, '')).join('、');
  return <article className="work">
    {r ? <video key={r.final + cmp} src={(cmp ? r.compare : r.final) + "#t=1"} controls playsInline loop preload="metadata" />
      : <div className="workEmpty"><img src={j.upload} /><span className={'stageTag ' + j.stage}>{STAGE[j.stage] || j.stage}</span></div>}
    {j.results.length > 1 && <div className="workTabs">{j.results.map((x, i) => <button key={x.label} className={i === k ? 'on' : ''} onClick={() => setK(i)}>
      {i === 0 ? '最终版' : x.label.replace(/^.*?：/, '')}</button>)}</div>}
    <div className="workMeta">
      <header><b>{j.title}{j.engine?.video.includes('模拟') && <em className="demoTag">演示</em>}</b>{r && <button className="ghost small" onClick={() => setCmp(!cmp)}>{cmp ? '只看结果' : '对比原片'}</button>}</header>
      <div className="workPick"><img src={j.upload} /><dl>
        <dt>主角</dt><dd>{j.mode || '替换'}</dd>
        <dt>选项</dt><dd>{choices || '无'}</dd>
        <dt>模型</dt><dd>{j.engine ? `${j.engine.video.replace('博观 ', '')} · 图 ${j.engine.image.replace('博观 ', '')}` : '—'}</dd>
        <dt>费用</dt><dd>{j.cost != null ? `${j.cost.toFixed(2)} 元${j.costUnknown ? `（另有 ${j.costUnknown} 项未知）` : ''}` : '未记录'}{took ? ` · 用时 ${secs(took)}` : ''}</dd>
      </dl></div>
      <footer><time>{when(j.created)}</time>{r && <a href={r.final} download={`${j.title}-${j.id}.mp4`}>下载</a>}<a href={'#trace/' + j.id}>链路复盘 →</a></footer>
    </div>
  </article>;
}

export function JobsPage({ templates }: { templates: TemplateCard[] }) {
  const [jobs, setJobs] = useState<JobSummary[]>();
  useEffect(() => { api.jobs().then(setJobs); }, []);
  const title = (id: string) => templates.find(t => t.id === id)?.title || id;
  return <main className="job">
    <h2>链路复盘</h2>
    <p className="muted">每次生成都在这里，点进去能看到每一步给模型的输入、提示词、输出和质检结果。</p>
    <CaseNotes />
    {!jobs ? <p className="muted">加载中…</p> : !jobs.length ? <p className="muted">还没有生成记录</p> :
      <div className="jobList">{jobs.map(j => <a key={j.id} href={'#trace/' + j.id} className="jobRow">
        <img src={j.upload} />
        <div><b>{title(j.templateId)}</b><span>{j.versions.join(' → ') || '—'}</span></div>
        <span className={'stageTag ' + j.stage}>{STAGE[j.stage] || j.stage}</span>
        <time>{when(j.created)}</time>
      </a>)}</div>}
  </main>;
}

export function TracePage({ id, at }: { id: string; at?: string }) {
  const [d, setD] = useState<any>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    let alive = true, timer = 0;
    const tick = () => api.trace(id).then(x => {
      if (!alive) return; setD(x);
      if (!['done', 'failed', 'pick', 'slots'].includes(x.job.stage)) timer = window.setTimeout(tick, 4000);
    }).catch(e => setErr(e.message));
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [id]);
  if (err) return <main className="job"><p className="error">{err}</p></main>;
  if (!d) return <main className="job"><p className="muted">加载中…</p></main>;
  const { job, template: t, presets } = d;
  if (job.replica) return <ReplicaTrace job={job} at={at} />;
  const span = job.versions.map((v: any) => [v.startedAt, v.endedAt]).flat().filter(Boolean);
  let n = 0;
  return <main className="job trace">
    <a className="back" href="#jobs">← 全部记录</a>
    <h2>链路复盘 · {t?.title || (job.templateId === 'text' ? '文字改视频' : job.templateId)}</h2>
    <p className="muted">{when(job.created)} · {STAGE[job.stage]}{span.length > 1 ? ` · 视频部分共 ${secs(Math.max(...span) - Math.min(...span))}` : ''} · <a href={'#job/' + job.id}>回到结果页</a></p>

    <Costs items={job.costs || []} />

    <Box n={++n} title="引擎配置" sub="每个部件用的是哪个实现（环境变量切换）">
      <dl className="kv">
        <dt>素材检查</dt><dd>{job.engine?.guard || '—'}</dd>
        <dt>预览图 / 参考帧</dt><dd>{job.engine?.image || '—'}</dd>
        <dt>视频编辑</dt><dd>{job.engine?.video || '—'}</dd>
        <dt>自动质检</dt><dd>{job.engine?.checker || '—'}</dd>
      </dl>
    </Box>

    <Box n={++n} title="用户输入" sub="用户在页面上做的全部操作">
      <div className="inputs">
        <Fig src={job.upload} cap="上传的图" />
        {t && <figure><video src={t.source} muted controls /><figcaption>模板原片 · {t.seconds} 秒</figcaption></figure>}
      </div>
      <p>选择：{job.versions.length ? job.versions.map((v: any) => v.label).join(' → ') : '（还没选预览图）'}</p>
    </Box>

    <Box n={++n} title="素材检查" sub="上传后、花钱前，先判断图里有没有写实人脸">
      {job.guard ? <p className={job.guard.ok ? '' : 'error'}>
        人脸：<b>{({ none: '没有人脸', real: '写实人脸', stylised: '非写实（卡通/3D）', unknown: '未检查' } as any)[job.guard.face]}</b>
        {' · '}{job.guard.ok ? '通过' : '拦下'}{job.guard.message ? ` · ${job.guard.message}` : ''}</p> : <p className="muted">—</p>}
    </Box>

    <Box n={++n} title="预览图（目标帧）" sub="从原片取一帧，让图片模型只把主角换成用户的图；视频模型会照着这张图做">
      {job.framing ? <>
        <Refs refs={job.framing.refs} />
        <Prompt label={`给 ${job.framing.model} 的指令`} text={job.framing.prompt} />
        <p className="muted small">出了 {job.frames.length} 张{job.framing.attempts > 1 ? `（重新生成过 ${job.framing.attempts - 1} 次）` : ''}{job.picked != null ? `，用户选了第 ${job.picked + 1} 张` : ''}</p>
        <div className="inputs">{job.frames.map((f: string, i: number) => <Fig key={f} src={f} cap={`候选 ${i + 1}`} on={i === job.picked} />)}</div>
      </> : <p className="muted">—</p>}
    </Box>

    {job.versions.map((v: any, vi: number) => {
      const p = presets[v.preset];
      return <Box key={v.id} n={++n} title={`视频：${v.label}`} sub={vi === 0 ? '输入：模板原片' : '输入：上一步的结果（一次只改一样东西，所以串起来做）'} status={v.status}>
        {p && <dl className="kv">
          <dt>预设</dt><dd>{v.preset}（{p.group}）· {MODE[p.mode]}</dd>
          <dt>保持不变的主体</dt><dd>{v.who}</dd>
          <dt>质检模式</dt><dd>{p.check}</dd>
          <dt>耗时</dt><dd>{secs(v.endedAt && v.startedAt ? v.endedAt - v.startedAt : undefined) || '进行中'}</dd>
        </dl>}
        {v.segments?.length > 1 && <p className="segPlan">分成 {v.segments.length} 段：{v.segments.map((s: any) => `${s.start.toFixed(1)}–${s.end.toFixed(1)}s`).join(' ｜ ')}</p>}
        {v.segments?.map((s: any) => <div key={s.index} className="seg">
          <header><b>{v.segments.length > 1 ? `第 ${s.index + 1} 段` : '整段'} · {s.start.toFixed(2)}–{s.end.toFixed(2)} 秒</b><span>{JOIN[s.join]}</span></header>
          {s.autoFrame && <div className="sub">
            <h4>后台自动生成参考帧</h4>
            <Refs refs={s.autoFrame.refs} />
            <Prompt label="指令" text={s.autoFrame.prompt} />
            <div className="inputs"><Fig src={s.autoFrame.out} cap="生成的参考帧" /></div>
          </div>}
          <h4>送进视频模型{s.model ? `（${s.model}）` : ''}</h4>
          <div className="inputs">
            {s.source && <figure><video src={s.source} muted controls /><figcaption>@video1 这一段的输入视频</figcaption></figure>}
            {s.images.map((r: any) => <Fig key={r.role} src={r.file} cap={r.role} />)}
            {s.audio && <figure><audio src={s.audio.file} controls /><figcaption className={s.audio.dropped ? 'error' : ''}>{s.audio.role}</figcaption></figure>}
          </div>
          {s.sentPrompt && <Prompt label="提示词（实际发出的原文）" text={s.sentPrompt} />}
          {s.edit && <>
            <h4>模型返回{s.ms ? ` · ${secs(s.ms)}` : ''}</h4>
            <div className="inputs"><figure><video src={s.edit} muted controls /><figcaption>原始输出（未对齐、无声）</figcaption></figure></div>
          </>}
          {s.seam && <>
            <h4>接缝：左 = 上一段最后一帧，右 = 这一段第一帧</h4>
            <p className="muted small">{s.join === 'soft' ? '镜头中间切开：两张应该几乎一样，人物不能变样或跳位' : '剪辑点切开：画面本来就会变，看人物是否还是同一个人'}</p>
            <div className="inputs"><Fig src={s.seam} cap="接缝对比" wide /></div>
          </>}
          {s.qa && <div className={'qa ' + (s.qa.pass ? 'pass' : 'warn')}>
            <b>{s.qa.pass ? '质检通过' : '质检提示'}</b> {s.qa.summary}
            {s.qa.metrics && <div className="metrics">{Object.entries(s.qa.metrics).map(([k, x]: any) =>
              <span key={k}>{k} <b>{k === '改动面积' ? `${(x * 100).toFixed(1)}%` : x}</b></span>)}</div>}
            <p className="muted small">结构相似度：输出和原片的轮廓有多像（替换类要 ≥ 0.45）；动作相关度：动作是否跟上原片（要 ≥ 0.60）</p>
            <div className="inputs">{s.qa.sheet && <Fig src={s.qa.sheet} cap="上：原片 下：输出（8 个时刻）" wide />}{s.qa.crops && <Fig src={s.qa.crops} cap="改动最大处的原尺寸截图" wide />}</div>
          </div>}
        </div>)}
        {v.final && <>
          <h4>交付：{v.segments?.length > 1 ? '按帧拼接、' : ''}对齐原片帧数、剪掉结尾跑偏、合回原声</h4>
          <div className="inputs"><figure><video src={v.final} controls /><figcaption>最终视频</figcaption></figure><figure><video src={v.compare} controls /><figcaption>和原片对比</figcaption></figure></div>
        </>}
        {v.error && <p className="error">{v.error}</p>}
      </Box>;
    })}

    <Box n={++n} title="完整日志">
      <pre className="log">{job.log.join('\n')}</pre>
    </Box>
  </main>;
}

const PH: Record<string, string> = { waiting: 'waiting', running: 'running', done: 'done', skipped: 'done', failed: 'failed' };

/** 链路复盘 for a 一键复刻 job: every phase with what went in, the instruction, what came out and what the checks said. */
function ReplicaTrace({ job, at }: { job: any; at?: string }) {
  useEffect(() => { if (at) document.querySelector(`[data-at~="${at}"]`)?.scrollIntoView({ block: 'start' }); }, [at]);
  const r = job.replica, plan = r.plan, v = job.versions[0];
  const ph = (id: string) => r.phases.find((p: any) => p.id === id) || {};
  const sub = (id: string) => { const p = ph(id); return p.note ? `${p.status === 'skipped' ? '跳过：' : ''}${p.note}` : undefined; };
  const st = (id: string) => PH[ph(id).status];
  const scene = (id: string) => plan?.scenes.find((c: any) => c.id === id);
  const variant = (id?: string) => plan?.variants?.find((x: any) => x.id === id);
  let n = 0;
  return <main className="job trace">
    <a className="back" href="#jobs">← 全部记录</a>
    <h2>链路复盘 · 一键复刻</h2>
    <p className="muted">{when(job.created)} · {STAGE[job.stage]}{v.startedAt && v.endedAt ? ` · 共 ${secs(v.endedAt - v.startedAt)}` : ''} · <a href={'#job/' + job.id}>回到结果页</a></p>
    {job.error && <p className="error">{job.error}</p>}
    <CaseNotes id={job.id} />
    <Costs items={job.costs || []} />

    <Box n={++n} title="输入" sub="用户给的全部东西">
      <dl className="kv">
        <dt>引擎</dt><dd>图 {job.engine?.image} · 视频 {job.engine?.video} · 质检 {job.engine?.checker} · {job.engine?.guard}</dd>
        <dt>用户的话</dt><dd>{r.prompt || '（没写）'}</dd>
        <dt>配音和字幕</dt><dd>{r.voiceOn === false ? '关（保留原声）' : '开'}</dd>
      </dl>
      <div className="inputs">
        <figure><video src={r.source} muted controls /><figcaption>原片</figcaption></figure>
        {r.uploads.map((f: string, i: number) => <Fig key={f} src={f} cap={`用户的图 ${i + 1}`} />)}
        {(r.shapeRefs || []).map((f: string, i: number) => <Fig key={f} src={f} cap={`补充角度图 ${i + 1}（只看形状）`} />)}
      </div>
    </Box>

    <Box n={++n} at="review plan" title="看懂原片 + 制定方案" sub={sub('plan')} status={st('plan')}>
      {plan ? <>
        <p>{plan.summary}</p>
        <dl className="kv">
          <dt>方案来源</dt><dd>{plan.by === 'llm' ? '多模态模型' : '基础方案（没调模型）'}</dd>
          <dt>要换的</dt><dd>{plan.target}</dd>
          <dt>换成</dt><dd>{plan.subject}</dd>
          <dt>保持不变</dt><dd>{plan.keep}</dd>
          <dt>补的角度</dt><dd>{plan.views?.join('、') || '不用补'}</dd>
          {plan.variants?.length > 0 && <><dt>版本</dt><dd>{plan.variants.map((x: any) => `${x.label}${x.main ? '（主）' : ''}${x.desc ? '：' + x.desc : ''}`).join('；')}</dd></>}
        </dl>
        <table className="costs"><thead><tr><th>镜头</th><th>时间</th><th>处理</th><th>场景</th><th>状态说明</th></tr></thead>
          <tbody>{plan.shots.map((s: any) => <tr key={s.index}><td>{s.index}</td><td>{s.start.toFixed(2)}–{s.end.toFixed(2)}s</td>
            <td>{s.change ? '改' : '用原片'}</td><td>{s.change ? s.scene : '—'}</td><td>{s.note}</td></tr>)}</tbody></table>
      </> : <p className="muted">—</p>}
    </Box>

    {r.route && <div className="qa pass"><b>走了{r.route.kind === 'simple' ? '简单路线' : '完整路线'}</b> {r.route.reasons.join('；')}</div>}
    {plan?.gaps?.length > 0 && <Box n={++n} title="找素材" sub={r.scout ? `${r.scout.rounds} 轮，看了 ${r.scout.viewed} 张图，找到 ${r.scout.found} 项。结束原因：${r.scout.stopped}` : '素材员没有运行'}>
      {plan.gaps.map((g: any, i: number) => <div key={i} className={'qa ' + (g.found ? 'pass' : 'warn')}>
        <b>{({ part: '部位', screen: '屏幕操作', cast: '人物' } as any)[g.kind] || '角度'} · {g.label}（原片 {g.at.toFixed(1)}s）· {g.found ? (g.kind === 'cast' ? 'AI 生成了' : '找到了') : g.kind === 'screen' ? '只能用户提供' : '没找到'}</b>
        {g.need && <p>{g.need}</p>}{g.fallback && <p className="muted">不补：{g.fallback}</p>}
        <div className="inputs">{g.frame && <Fig src={g.frame} cap="原片这一帧" />}{g.found && <Fig src={g.found.file} cap={g.found.why || '选中的图'} wide />}</div>
      </div>)}
      {(r.scout?.steps || []).map((s: any) => <div key={s.round} className="seg">
        <b>第 {s.round} 轮 · {s.seconds} 秒</b>
        {s.searches.length > 0 && <p>搜索：{s.searches.join(' / ')}</p>}
        {s.said && <p className="muted">{s.said}</p>}
        {s.pics.length > 0 && <div className="inputs">{s.pics.map((p: any) => p.file ? <Fig key={p.id} src={p.file} cap={p.id} /> : <span key={p.id} className="muted small">{p.id} 下载失败：{p.error}</span>)}</div>}
        {s.pics.map((p: any) => p.page && <div key={p.id}><a className="muted small" href={p.page} target="_blank" rel="noreferrer">{p.id} 来源</a></div>)}
        {s.picks.map((p: any, i: number) => <p key={i}>{p.refused ? `没选上 ${p.id}：${p.refused}` : `选定 ${p.id} → ${p.gap}：${p.why}`}</p>)}
        {s.finish && <p>结束：{s.finish}</p>}
      </div>)}
    </Box>}

    <Box n={++n} at="assets" title="补全素材" sub={sub('assets')} status={st('assets')}>
      {r.sheet ? <div className={'qa ' + (r.sheet.ok ? 'pass' : 'warn')}>
        <b>多视图设定图（补 {r.sheet.views.join('、')}）· {r.sheet.file ? '已采用' : '没采用'}</b> {r.sheet.issue}
        {r.sheet.file && <div className="inputs"><Fig src={r.sheet.file} cap="设定图" wide /></div>}
      </div> : null}
      {(r.variantAssets || []).map((a: any) => <div key={a.id} className={'qa ' + (a.ok === false ? 'warn' : 'pass')}>
        <b>{a.label}{a.own ? '（用户换的图）' : '（自动改色）'}</b> {a.issue}
        {a.file && <div className="inputs"><Fig src={a.file} cap={a.label} /></div>}
      </div>)}
      {r.photoPicks && <div className={'qa ' + (r.photoPicks.issue ? 'warn' : 'pass')}>
        <b>按镜头挑图</b> {r.photoPicks.issue}
        {r.photoPicks.photos.length > 0 && <p className="muted">{r.photoPicks.photos.map((x: any, i: number) => `${i + 1}. ${x.view}${x.note ? '：' + x.note : ''}`).join('　')}</p>}
        {Object.entries(r.photoPicks.scenes).map(([s, x]: any) => <div key={s}><p>场景 {s}：{x.why}</p>
          <div className="inputs">{x.files.map((f: string, i: number) => <Fig key={f} src={f} cap={i ? `第 ${i + 1} 选` : '首选'} />)}</div></div>)}
      </div>}
      {!r.sheet && !r.variantAssets?.length && !r.photoPicks && <p className="muted">—</p>}
    </Box>

    <Box n={++n} at="keyframes" title="制作关键画面" sub={sub('keyframes')} status={st('keyframes')}>
      {r.keyframes.length ? r.keyframes.map((k: any) => <div key={k.scene} className="seg">
        <header><b>场景 {k.scene} · 原片第 {k.at.toFixed(2)} 秒</b><span>做了 {k.tries} 次{variant(scene(k.scene)?.variant) ? ` · ${variant(scene(k.scene)?.variant).label}` : ''}</span></header>
        <div className="inputs"><Fig src={k.source} cap="原片这一帧" />{k.out && <Fig src={k.out} cap="关键画面（最后一次）" />}</div>
        {k.prompt && <Prompt label="给图片模型的指令" text={k.prompt} />}
        {k.ok != null && <div className={'qa ' + (k.ok ? 'pass' : 'warn')}><b>{k.ok ? '验收通过' : '验收提示'}</b> {k.issue}</div>}
      </div>) : <p className="muted">—</p>}
    </Box>

    <Box n={++n} at="generate repair" title="生成视频 + 检查修复" sub={[sub('generate'), sub('repair')].filter(Boolean).join(' · ')} status={st('repair') === 'waiting' ? st('generate') : st('repair')}>
      {r.segments.length > 1 && <p className="segPlan">分成 {r.segments.length} 段：{r.segments.map((s: any) => `${s.start.toFixed(1)}–${s.end.toFixed(1)}s`).join(' ｜ ')}</p>}
      {r.segments.map((s: any) => <div key={s.index} className="seg">
        <header><b>{r.segments.length > 1 ? `第 ${s.index + 1} 段` : '整段'} · {s.start.toFixed(2)}–{s.end.toFixed(2)} 秒</b>
          <span>{JOIN[s.join]} · 场景 {s.scenes.join('、')} · 生成 {s.tries} 次{s.repaired ? '，用的是重做的那次' : ''}</span></header>
        <div className="inputs">
          {s.source && <figure><video src={s.source} muted controls /><figcaption>@video1 输入</figcaption></figure>}
          {s.images.map((f: string, i: number) => <Fig key={f + i} src={f} cap={`@image${i + 1}`} />)}
          {s.fit && <figure><video src={s.fit} muted controls /><figcaption>输出（已对齐时长）</figcaption></figure>}
        </div>
        {s.prompt && <Prompt label="给视频模型的提示词" text={s.prompt} />}
        {s.qa && <div className={'qa ' + (s.qa.pass ? 'pass' : 'warn')}><b>{s.qa.pass ? '质检通过' : '质检提示'}</b> {s.qa.summary}
          {s.qa.seam != null && <span className="muted small"> · 接缝相似度 {s.qa.seam}</span>}</div>}
        {s.error && <p className="error">{s.error}</p>}
      </div>)}
      {!r.segments.length && <p className="muted">—</p>}
    </Box>

    <Box n={++n} at="compose voice" title="合成 + 配音和字幕" sub={[sub('compose'), sub('voice')].filter(Boolean).join(' · ')} status={st('voice') || st('compose')}>
      {r.voice?.lines?.length > 0 && <table className="costs"><thead><tr><th>时间</th><th>谁说</th><th>原口播</th><th>新口播</th></tr></thead>
        <tbody>{r.voice.lines.map((l: any, i: number) => <tr key={i}><td>{l.start.toFixed(1)}s</td><td>{({ m: '男', f: '女' } as any)[l.voice] || '—'}{l.onScreen === false ? ' · 画外' : ''}</td><td>{l.from}</td><td>{l.to}</td></tr>)}</tbody></table>}
      {r.voice?.error && <p className="error">{r.voice.error}</p>}
      {v.final ? <div className="inputs">
        {r.picture && r.picture !== v.final && <figure><video src={r.picture} controls /><figcaption>画面成片（原声）</figcaption></figure>}
        <figure><video src={v.final} controls /><figcaption>最终视频</figcaption></figure>
        <figure><video src={v.compare} controls /><figcaption>和原片对比</figcaption></figure>
      </div> : <p className="muted">—</p>}
    </Box>

    <Box n={++n} title="完整日志"><pre className="log">{job.log.join('\n')}</pre></Box>
  </main>;
}

/** docs/replica-cases.md, split at its headings. With `id`: only the sections about that job, open. Without: all, folded. */
function CaseNotes({ id }: { id?: string }) {
  const [text, setText] = useState('');
  useEffect(() => { api.cases().then(setText).catch(() => {}); }, []);
  const sections = text.split(/^(?=##+ )/m).filter(x => x.startsWith('##'));
  const shown = id ? sections.filter(x => x.split('\n')[0].includes(id)) : sections;
  if (!shown.length) return null;
  return <section className="tbox cases">
    <details open={!!id}>
      <summary>{id ? '案例记录' : `案例记录（${sections.length} 条）`}</summary>
      {shown.map((x, i) => <CaseText key={i} text={x} />)}
    </details>
  </section>;
}

function CaseText({ text }: { text: string }) {
  const inline = (s: string) => s.split(/\*\*(.+?)\*\*/).map((x, i) => i % 2 ? <b key={i}>{x}</b> : x);
  const lines = text.split('\n').filter(l => l.trim());
  return <div>{lines.map((l, i) => l.startsWith('#') ? <h4 key={i}>{l.replace(/^#+\s*/, '')}</h4>
    : l.startsWith('- ') ? <p key={i} className="caseItem">{inline(l.slice(2))}</p> : <p key={i}>{inline(l)}</p>)}</div>;
}

function Costs({ items }: { items: any[] }) {
  const known = items.filter(c => c.yuan != null), total = known.reduce((a, c) => a + c.yuan, 0);
  const unknown = items.length - known.length;
  const byKind = (k: string) => known.filter(c => c.step.includes(k)).reduce((a, c) => a + c.yuan, 0);
  return <section className="tbox costBox">
    <header><i>¥</i><div><b>费用明细 · 合计 {total.toFixed(2)} 元</b>
      <span>{items.length} 次付费调用{unknown ? `，其中 ${unknown} 次没有价格` : ''} · 视频 {byKind('视频').toFixed(2)} 元 · 图片 {known.filter(c => /张$/.test(c.units)).reduce((a, c) => a + c.yuan, 0).toFixed(2)} 元 · 素材检查和翻译用的文本模型未计价</span></div></header>
    {items.length ? <table className="costs"><thead><tr><th>步骤</th><th>模型</th><th>用量</th><th>费用（元，按价目表）</th></tr></thead>
      <tbody>{items.map((c, i) => <tr key={i} className={c.note ? 'failRow' : ''}>
        <td>{c.step}{c.note ? <small> · {c.note}</small> : null}</td><td>{c.model}</td><td>{c.units}</td>
        <td className="num">{c.yuan != null ? c.yuan.toFixed(2) : '—'}</td></tr>)}</tbody></table>
      : <p className="muted">还没有付费调用</p>}
  </section>;
}

function Box({ n, title, sub, status, at, children }: { n: number; title: string; sub?: string; status?: string; at?: string; children: React.ReactNode }) {
  return <section className="tbox" data-at={at}>
    <header><i>{n}</i><div><b>{title}</b>{sub && <span>{sub}</span>}</div>{status && <em className={'stageTag ' + status}>{({ waiting: '排队', running: '进行中', done: '完成', failed: '失败' } as any)[status]}</em>}</header>
    {children}
  </section>;
}
const Fig = ({ src, cap, on, wide }: { src: string; cap: string; on?: boolean; wide?: boolean }) =>
  <figure className={(on ? 'on ' : '') + (wide ? 'wide' : '')}><a href={src} target="_blank"><img src={src} /></a><figcaption>{cap}</figcaption></figure>;
const Refs = ({ refs }: { refs: { role: string; file: string }[] }) =>
  <div className="inputs">{refs.map(r => <Fig key={r.role} src={r.file} cap={r.role} />)}</div>;
// Shown in Chinese by default; the English original (what the model actually got) is one click away.
function Prompt({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const [en, setEn] = useState(false);
  const [zh, setZh] = useState<string>();
  const [err, setErr] = useState<string>();
  useEffect(() => { api.zh(text).then(setZh).catch(e => setErr(e.message)); }, [text]);
  const shown = en ? text : zh;
  return <div className="prompt">
    <header><span>{label}</span><span className="promptTabs">
      <button className={en ? '' : 'on'} onClick={() => setEn(false)}>中文</button>
      <button className={en ? 'on' : ''} onClick={() => setEn(true)}>英文原文（实际发送）</button>
      <button onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? '已复制' : '复制原文'}</button>
    </span></header>
    <p className={en ? 'mono' : ''}>{shown ?? (err ? `翻译失败（${err}），点"英文原文"查看` : '翻译中…')}</p>
  </div>;
}
