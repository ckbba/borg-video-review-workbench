// Recreation: turn verified shot analyses + the case's replacement assets into a video-model prompt,
// submit it through the 博观 CLI (@borgrise/cli), and wait for the result.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { ask, LLM } from './llm';

// Drafting rules, version R1. Each line answers a mistake already seen in review (see 拆解设置 / 复盘备注).
export const DRAFT_RULES_R1 = `你要把原片镜头分析改写成一条给视频生成模型的复刻提示词。规则：
1. 只写画面里要出现的东西，用正面描述。限制只放在最后的【负面约束】里，不要在描述里写"一闪而过""不可读"这类会被理解成"没有"的话。
2. 每个镜头单独一段，开头写本地时间区间和景别，例如【镜头1｜0.0–2.9秒｜特写】。镜头之间写明"X秒硬切"。
3. 每个镜头写清视角：第三人称还是主观视角、摄影机在人物的哪个方位、哪些身体部位入画、从画面哪一侧进入、脸是否可见。
4. 写清首帧状态：第一帧画面里已经有什么（例如"首帧手已握住相机"），不要把首帧就存在的东西写成"伸入""出现"。
5. 写清过程变化：从什么状态变到什么状态、快慢（例如"双眼由闭缓缓睁开，微微抬头看向镜头"），以及摄影机运动（推近、拉远、跟随、横移）。
6. 左右同时写两种：人物自身的左右手，以及在画面中的方位（例如"女子右手（画面左侧）"）。
7. 道具和布料写清位置与轨迹（例如"薄纱斜向上，位于画面高度一半处，上缘不高于鼻尖"）。
8. 素材用 @图片N 引用，每张图只承担一个职责：商品图只约束商品外观，人物图只约束人物身份与服装。商品外观、颜色、按键、屏幕以商品图为准，不要按原片改写成别的样子。
9. 原片里的人物、品牌字、Logo 一律不要写进提示词，人物只用 @图片 的人物；画面里不生成任何文字、字幕、水印。
10. 审核人的批注是对原分析的纠正，和原分析冲突时以批注为准。
11. 开头一段写整体：16:9 横屏、写实商业广告质感、总时长、光线与色调；结尾写【声音】和【负面约束】。`;

// Optional camera-parameter rule, appended to whatever version is in use when REPRO_DRAFT_CAMERA=1.
// Off by default: on the pajama film (6 Nov) it added little over R1 and dropped "平视"; kept for a later A/B on films with real camera moves.
export const CAMERA_RULE = `附加规则：每个镜头再写一行【镜头参数】，原片分析里有的都写上，没有的不要编：机位高度（低位 / 平视 / 高位）、俯仰（仰拍 / 平拍 / 俯拍）、焦段感（广角 / 标准 / 长焦）、景深（背景清晰 / 虚化）、运镜方式和速度（锁定、缓慢前推、快速横移、手持轻晃等）、运镜起止（从什么景别到什么景别）。`;
export const withCameraRule = (rules: string, on = process.env.REPRO_DRAFT_CAMERA === '1') => on ? `${rules}\n${CAMERA_RULE}` : rules;

export type DraftInput = {
  shots: { code: string; start: number; end: number; fields: Record<string, any>; corrections: string[] }[];
  assets: { n: number; name: string; role: string; desc: string }[];
  overview: string; model: string; duration: number; rules: string; sound: boolean;
};

export async function draftPrompt(x: DraftInput, draftModel = LLM.model) {
  const t0 = x.shots[0].start;
  const shotText = x.shots.map((s, i) => [
    `镜头${i + 1}（原片 ${s.code}，本地 ${(s.start - t0).toFixed(2)}–${(s.end - t0).toFixed(2)} 秒）`,
    ...Object.entries(s.fields).filter(([k, v]) => v && typeof v === 'string' && !['难度标签', '可替换槽位'].includes(k)).map(([k, v]) => `  ${k}：${v}`),
    ...(s.corrections.length ? ['  审核人批注（以此为准）：', ...s.corrections.map(c => '   - ' + c)] : [])
  ].join('\n')).join('\n\n');
  const assets = x.assets.map(a => `@图片${a.n}：${a.name}｜职责：${a.role}${a.desc ? `｜${a.desc}` : ''}`).join('\n');
  const out = await ask([{ type: 'input_text', text:
`${withCameraRule(x.rules)}

全片梗概（只用来理解上下文，不要照抄原片人物）：
${x.overview || '无'}

要复刻的镜头（共 ${(x.shots.at(-1)!.end - t0).toFixed(2)} 秒，生成 ${x.duration} 秒，多出的时间只延续最后一个镜头，后期裁掉）：
${shotText}

可用素材（按 @图片 编号）：
${assets || '无'}

目标视频模型：${x.model}；${x.sound ? '有声音，写环境音和音效，不要人声旁白' : '模型不出声音，不写【声音】'}。
直接输出提示词正文，不要解释。` }], '你是写视频生成提示词的广告导演，写得具体、可执行。', 2, draftModel);
  return out.trim().replace(/^```\w*\n?|```$/g, '').trim();
}

// ---- 博观 CLI ----
const NPX = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npx-cli.js');
const CLI = '@borgrise/cli@4.0.5';
export function borg(args: string[], timeout = 420_000): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [NPX, '-y', CLI, ...args], { maxBuffer: 32 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      try { resolve(JSON.parse(stdout.slice(stdout.indexOf('{')))); }
      catch { reject(new Error((stderr || stdout || String(err)).slice(-600))); }
    });
  });
}
// Per-model options as listed by 博观's own config (/api/modelParamConfig/listByCategory/video_generate).
export const VIDEO_MODELS: Record<string, { label: string; sizes: string[]; min: number; max: number; sound: boolean; maxRefs: number; priced?: boolean }> = {
  'seedance-2.5': { label: 'Seedance 2.5', sizes: ['480p', '720p', '1080p'], min: 4, max: 30, sound: true, maxRefs: 5, priced: true }, // cost: src/pricing.ts
  'minimax-h3-max': { label: 'MiniMax H3 Max', sizes: ['480p', '768p'], min: 5, max: 15, sound: false, maxRefs: 4 }
};
export async function submitVideo(x: { prompt: string; images: string[]; model: string; size: string; duration: number }) {
  const m = VIDEO_MODELS[x.model];
  if (x.prompt.length > 2500) throw new Error(`提示词 ${x.prompt.length} 字，超过博观全能参考 2500 字符上限`);
  const args = ['video', 'reference', `--prompt=${x.prompt.replace(/\r?\n/g, ' ')}`, ...x.images.map(f => `--image-file=${f}`),
    `--model=${x.model}`, `--size=${x.size}`, '--ratio=16:9', `--duration=${x.duration}`, ...(m?.sound ? ['--sound=on'] : []), '--count=1', '--request-timeout-ms=180000'];
  const d = await borg(args);
  const taskId = d.taskId || d.response?.data?.task_id || d.response?.task_id;
  if (!d.success || !taskId) throw new Error(d.error?.message || '提交失败');
  return { taskId, raw: d };
}
export async function waitVideo(taskId: string, log: (s: string) => void, maxMin = 25) {
  for (let i = 0; i < maxMin * 2; i++) {
    const d = await borg(['task', 'status', '--task-id', taskId], 120_000).catch(e => ({ status: 'poll-error', error: e.message }));
    if (d.status === 'completed') return { url: d.result?.video_url as string };
    if (['failed', 'error', 'cancelled'].includes(d.status)) throw new Error(String(d.error || d.status).replace(/^任务执行失败: /, ''));
    if (i % 2 === 0) log(`生成中…（${d.status}${d.progress ? ` ${d.progress}%` : ''}）`);
    await new Promise(r => setTimeout(r, 30_000));
  }
  throw new Error(`等待超过 ${maxMin} 分钟`);
}
