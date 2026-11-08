// Output QA. `alterCheck` runs ALTER's own checker (Python + numpy + Pillow); `basicCheck` only compares length
// and is what the registry falls back to when that Python is not available.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { probe } from '../media';
import type { Checker } from '../types';

export const PYTHON = process.env.SWAP_PYTHON || 'python';
const SCRIPT = path.resolve('swap/vendor/alter/scripts/alter_check.py');
// ALTER reads ffprobe output as text; on Windows that defaults to the ANSI code page and breaks on UTF-8 tags.
const PY_ENV = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };

export const basicCheck: Checker = {
  name: '时长检查',
  async check(source, output) {
    const [s, o] = await Promise.all([probe(source), probe(output)]);
    const pass = Math.abs(s.seconds - o.seconds) < 0.6;
    return { pass, trimTail: 0, summary: pass ? '时长与原片一致' : `时长 ${o.seconds.toFixed(1)}s，原片 ${s.seconds.toFixed(1)}s` };
  }
};

export const alterCheck: Checker = {
  name: 'ALTER 质检',
  check(source, output, mode, outDir) {
    return new Promise((resolve, reject) => {
      // Exit 1 means CHECK, not a crash: read the report either way.
      // Relative paths: the project folder name is non-ASCII on some machines, and ffprobe's JSON echo of a
      // non-ASCII filename is what broke ALTER's probe under a non-UTF-8 console.
      const rel = (f: string) => path.relative(process.cwd(), f);
      execFile(PYTHON, ['-I', rel(SCRIPT), rel(source), rel(output), '--out', rel(outDir), '--mode', mode], { maxBuffer: 16 * 1024 * 1024, timeout: 600_000, env: PY_ENV }, (err, stdout, stderr) => {
        const file = path.join(outDir, 'report.json');
        if (!fs.existsSync(file)) return reject(new Error((stderr || stdout || String(err)).slice(-400)));
        const r = JSON.parse(fs.readFileSync(file, 'utf8'));
        const issues: string[] = (r.issues || []).map(String);
        // Tail drift is fixed by trimming, which finish() does; it does not fail the run.
        const trimTail = Number(issues.join(' ').match(/--trim-tail (\d+)/)?.[1] || 0);
        const real = issues.filter(s => !s.startsWith('tail drift'));
        resolve({
          pass: real.length === 0, trimTail, raw: r,
          sheet: fs.existsSync(path.join(outDir, 'sheet.jpg')) ? path.join(outDir, 'sheet.jpg') : undefined,
          summary: real.length ? `自动质检提示：${real.map(zh).join('；')}` : trimTail ? `自动质检通过（结尾 ${trimTail} 帧跑偏，已剪掉）` : '自动质检通过'
        });
      });
    });
  }
};

const ZH: [string, string][] = [
  ['length', '帧数和原片不一致'], ['restyle', '风格化不彻底，背景还像照片'], ['structure', '改动太多，画面结构和原片差别大'],
  ['drift', '中间有一段画面跑偏'], ['change', '替换可能没生效，或改动范围不对'], ['motion', '动作和原片对不上'],
  ['jump', '有跳帧或突变'], ['frozen', '有画面卡住不动']
];
const zh = (issue: string) => ZH.find(([k]) => issue.startsWith(k))?.[1] || issue;

/** True when the Python interpreter has what ALTER's checker needs. */
export function pythonReady(): Promise<boolean> {
  return new Promise(r => execFile(PYTHON, ['-I', '-c', 'import numpy, PIL'], { timeout: 20_000 }, e => r(!e)));
}
