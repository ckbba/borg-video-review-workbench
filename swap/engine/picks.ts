// 按镜头挑图: a close-up should get the sharpest detail photo, a back shot the back photo. Before this the pictures were
// used in upload order, so a small full-body shot uploaded first could take the only free reference slot of a close-up.
import type { Plan } from './types';

export const SCENE_PHOTOS = 3;
export type PhotoPicks = {
  photos: { file: string; view: string; note: string }[];
  scenes: Record<string, { files: string[]; why: string }>;
  /** How many photos there were: a photo added on 开始前确认 means picking again. */
  of?: number;
  /** Chinese: the photos disagree (colour, or not the same thing). Shown in 链路复盘 only, for now. */
  issue?: string;
};

export const PICK_ASK = (plan: Plan, n: number) => `用户上传了 ${n} 张同一件商品（${plan.subject}）的照片，要替换原片里的：${plan.target}。
下面先是这 ${n} 张照片（按编号），然后是原片每个场景的一帧，以及这个场景里要替换的东西是什么状态。
给每个场景挑最有用的照片，最多 ${SCENE_PHOTOS} 张，最有用的排最前面。

挑图标准：
1. 这个场景看到的角度和部位，要在照片里看得清：特写选细节最清楚的，背面镜头选背面照，侧面镜头选侧面照。
2. 照片里商品占比大、清晰的优先；全身小图看不清细节，特写镜头不要排第一。
3. 至少留一张能看清商品整体外观的。
4. 颜色明显和其他照片不一致的（比如光线造成的偏色）不要排第一，并写进 issue；看起来不是同一件商品的也写进 issue，这张不要选。

只输出 JSON：
{"photos":[{"n":编号,"view":"中文，如 正面全身、背面、平铺、胸口特写","note":"中文，一句话，可空"}],
 "scenes":[{"id":"场景id","order":[编号],"why":"中文一句话"}],
 "issue":"中文，没有问题就留空"}`;

export function parsePicks(j: any, uploads: string[], sceneIds: string[]): PhotoPicks {
  const fileOf = (n: any) => uploads[Number(n) - 1];
  const scenes: PhotoPicks['scenes'] = {};
  for (const s of Array.isArray(j?.scenes) ? j.scenes : []) {
    const id = String(s?.id);
    if (!sceneIds.includes(id)) continue;
    const files = [...new Set<string>((Array.isArray(s.order) ? s.order : []).map(fileOf).filter(Boolean))].slice(0, SCENE_PHOTOS);
    if (files.length) scenes[id] = { files, why: String(s.why || '') };
  }
  return {
    photos: (Array.isArray(j?.photos) ? j.photos : []).filter((p: any) => fileOf(p?.n)).map((p: any) => ({ file: fileOf(p.n), view: String(p.view || ''), note: String(p.note || '') })),
    scenes, issue: j?.issue ? String(j.issue) : undefined
  };
}

/** The real photos for one piece of video, which may span scenes: each scene's best first, then its next best. Only what was
 *  picked: a free slot must not bring a cabin photo into an exterior shot. With no picks at all, upload order. */
export function photosForScenes(picks: PhotoPicks | undefined, scenes: string[], uploads: string[]) {
  const lists = scenes.map(s => picks?.scenes[s]?.files || []);
  const out: string[] = [];
  for (let k = 0; k < SCENE_PHOTOS; k++) for (const l of lists) if (l[k] && !out.includes(l[k])) out.push(l[k]);
  return out.length ? out : uploads;
}
