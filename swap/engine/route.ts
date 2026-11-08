// 路线: how much machinery a film needs. 6 Nov, Kelme: one person, one top, one scene. The full route took 26 yuan and 16 min;
// two pictures and one sentence came out about the same. So a film with nothing hard about it goes the short way.
import type { Plan } from './types';

export type Route = { kind: 'simple' | 'full'; reasons: string[] };

/** A film this far over the model's limit loses its last frames rather than go to two runs and a seam. */
export const OVER_LIMIT = 0.3;

/** Each reason is something a single run cannot do; any one of them means the full route. */
export function routeOf(plan: Plan, seconds: number, maxSeconds: number, force = process.env.SWAP_ROUTE): Route {
  const reasons: string[] = [];
  if (plan.by !== 'llm') reasons.push('没有方案模型的判断，不知道片子难不难');
  if (plan.variants.length > 1) reasons.push(`原片里有 ${plan.variants.length} 个款，要按秒切换`);
  if (plan.scenes.length > 1) reasons.push(`有 ${plan.scenes.length} 个场景，换场景后商品容易走样`);
  if (seconds > maxSeconds + OVER_LIMIT) reasons.push(`${seconds.toFixed(0)} 秒，超过模型一次能做的 ${maxSeconds} 秒，要分段`);
  const keep = plan.shots.filter(s => !s.change).length;
  if (keep) reasons.push(`有 ${keep} 个镜头不用改，要保留原片`);
  const hard = (plan.gaps || []).filter(g => g.kind === 'part' || g.kind === 'screen');
  if (hard.length) reasons.push(`需要处理 ${hard.map(g => g.label).join('、')}`);
  if (plan.shots.some(s => s.fit === 'no')) reasons.push('有做不出来的镜头');
  if (force === 'simple') return { kind: 'simple', reasons: ['手动指定（SWAP_ROUTE）'] };
  if (force === 'full') return { kind: 'full', reasons: ['手动指定（SWAP_ROUTE）'] };
  return reasons.length ? { kind: 'full', reasons } : { kind: 'simple', reasons: ['一款、一个场景、一次能生成完'] };
}

/** The sentence that did as well as everything else on the Kelme film: what to swap, which picture for what, nothing else. */
export function simplePrompt(plan: Plan, pictures: number, userPrompt: string, dropText?: boolean, fix = '') {
  const more = Array.from({ length: Math.max(0, pictures - 1) }, (_, i) => `@image${i + 2}`).join(' and ');
  return [
    `Replace ${(plan.target || 'the main subject').slice(0, 300).replace(/^The /, 'the ').replace(/\.$/, '')} in @video1 with the one in @image1.`,
    more ? `Its details and logos must be exactly as in ${more}.` : '',
    'Everything else stays exactly as in @video1: people, faces, motion, camera, cuts and timing.',
    userPrompt ? `Also: ${userPrompt}.` : '',
    dropText ? 'Remove all captions and decorative titles of @video1.' : '',
    fix
  ].filter(Boolean).join(' ');
}
