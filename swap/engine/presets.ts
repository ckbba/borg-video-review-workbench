// Prompt builder. Reads ALTER's tested presets as they ship (swap/vendor/alter/references/presets.json) so an
// updated skill drops in without edits here. A prompt = the mode's opening block + the preset's change line + close.
import fs from 'node:fs';
import path from 'node:path';
import type { CheckMode } from './types';

type Preset = { name: string; group: string; mode: 'O' | 'M' | 'R'; target_frame: boolean | 'optional'; style?: string; change: string; fill: Record<string, string>; check: CheckMode };
type Book = { openings: Record<string, string>; close: Record<string, string>; presets: Preset[]; restyle_target_frame: string };

let book: Book | undefined;
export function presetBook(dir = path.resolve('swap/vendor/alter/references')): Book {
  return book ??= JSON.parse(fs.readFileSync(path.join(dir, 'presets.json'), 'utf8'));
}
export function preset(name: string): Preset {
  const p = presetBook().presets.find(x => x.name === name);
  if (!p) throw new Error(`没有这个预设：${name}`);
  return p;
}

const PHOTO_RESTYLES = new Set(['noir', 'animation-to-live']); // keep a photographic result: shorter opening
const fillIn = (s: string, vars: Record<string, string>) =>
  s.replace(/\{(\w+)\}/g, (_, k) => { if (vars[k] == null) throw new Error(`预设缺少填空：${k}`); return vars[k]; });

/** Builds the edit prompt. `hasTargetFrame` binds @image1 the way the preset expects it. */
export function buildPrompt(name: string, who: string, fill: Record<string, string>, hasTargetFrame: boolean): { prompt: string; check: CheckMode } {
  const p = preset(name), b = presetBook(), vars = { who, ...fill };
  if (p.mode === 'R') {
    const key = PHOTO_RESTYLES.has(p.name) ? 'R_photo' : 'R';
    const parts = [fillIn(b.openings[key], { ...vars, style: fillIn(p.style || '', vars) }), fillIn(p.change, vars)];
    if (hasTargetFrame) parts.push(b.restyle_target_frame);
    parts.push(b.close[key]);
    return { prompt: parts.join(' '), check: p.check };
  }
  // A prompt-only preset given a picture (a soft segment's previous frame): bind it as the first frame.
  const bind = hasTargetFrame && !needsImage(name) ? [b.restyle_target_frame] : [];
  return { prompt: [fillIn(b.openings[p.mode], vars), fillIn(p.change, vars), ...bind, b.close[p.mode]].join(' '), check: p.check };
}

/** Presets whose change line points at a reference image cannot run from the prompt alone. */
export const needsImage = (name: string) => /@image/.test(preset(name).change);
