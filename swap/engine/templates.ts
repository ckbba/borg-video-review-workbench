// Templates are folders: swap/templates/<id>/template.json + the prepared source clip + a cover.
// Make one with `npm run swap:template` (see swap/scripts/addTemplate.ts).
import fs from 'node:fs';
import path from 'node:path';
import { needsImage, preset } from './presets';
import type { Template } from './types';

export const TEMPLATES = path.resolve('swap/templates');

export function listTemplates(): Template[] {
  if (!fs.existsSync(TEMPLATES)) return [];
  return fs.readdirSync(TEMPLATES)
    .filter(d => fs.existsSync(path.join(TEMPLATES, d, 'template.json')))
    .map(getTemplate);
}

export function getTemplate(id: string): Template {
  const file = path.join(TEMPLATES, id, 'template.json');
  if (!/^[\w-]+$/.test(id) || !fs.existsSync(file)) throw new Error(`没有这个模板：${id}`);
  const t: Template = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Fail on load, not after a paid step: every preset must exist.
  const all = [...(t.choices || []).flatMap(c => c.options), ...t.versions];
  [t.slot.preset, ...(t.slot.modes || []).map(m => m.preset || t.slot.preset), ...all.map(v => v.preset)].forEach(preset);
  const bad = all.find(v => needsImage(v.preset) && !v.framePrompt);
  if (bad) throw new Error(`模板 ${id} 的 ${bad.id} 用了需要参考图的预设 ${bad.preset}，要么写 framePrompt，要么换纯文字预设`);
  return t;
}

/** Chained changes in run order: picked choice options first, then ticked versions. */
export const chainOf = (t: Template, extras: string[]) =>
  [...(t.choices || []).flatMap(c => c.options), ...t.versions].filter(v => extras.includes(v.id));

/** The template as one job sees it: the chosen slot mode folded into slot and whoAfter. */
export function withMode(t: Template, modeId?: string): Template {
  const m = t.slot.modes?.find(x => x.id === modeId) ?? t.slot.modes?.[0];
  if (!m) return t;
  return { ...t, whoAfter: m.whoAfter ?? t.whoAfter,
    slot: { ...t.slot, preset: m.preset ?? t.slot.preset, fill: m.fill, framePrompt: m.framePrompt, label: t.slot.label } };
}

export const templateFile = (t: Template, rel: string) => path.join(TEMPLATES, t.id, rel);
