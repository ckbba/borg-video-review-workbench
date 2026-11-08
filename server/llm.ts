// Model channel for shot analysis / revision. Defaults to the same relay Codex uses for GPT-6.1 SOL;
// override with REPRO_LLM_BASE_URL / REPRO_LLM_KEY_ENV (name of the env var holding the key) / REPRO_LLM_MODEL.
import fs from 'node:fs';

export const LLM = {
  baseUrl: process.env.REPRO_LLM_BASE_URL || 'https://airoutertest.vitamazing.top/v1',
  keyEnv: process.env.REPRO_LLM_KEY_ENV || 'AIROUTER_TEST_API_KEY',
  model: process.env.REPRO_LLM_MODEL || 'gpt-6.1-sol'
};
export const llmLabel = () => `${LLM.model}（${new URL(LLM.baseUrl).host}）`;

export type Part = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string };
export const text = (t: string): Part => ({ type: 'input_text', text: t });
export const image = (file: string): Part => ({ type: 'input_image', image_url: 'data:image/jpeg;base64,' + fs.readFileSync(file).toString('base64') });

export async function ask(parts: Part[], instructions: string, retries = 2, model = LLM.model): Promise<string> {
  const key = process.env[LLM.keyEnv];
  if (!key) throw new Error(`没有找到模型密钥环境变量 ${LLM.keyEnv}`);
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${LLM.baseUrl}/responses`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, instructions, input: [{ role: 'user', content: parts }] }),
        signal: AbortSignal.timeout(300_000)
      });
      const j: any = await r.json();
      if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
      const out = j.output?.filter((o: any) => o.type === 'message').flatMap((o: any) => o.content).map((c: any) => c.text || '').join('') || '';
      if (!out) throw new Error('模型没有返回文本');
      return out;
    } catch (e) { if (i >= retries) throw e; await new Promise(r => setTimeout(r, 2000 * (i + 1))); }
  }
}

/** One raw Responses API round, for loops that use tools: returns the output items. */
export async function respond(x: { instructions: string; input: any[]; tools: any[]; reasoning?: { effort: 'low' | 'medium' | 'high' } }, model = LLM.model): Promise<any[]> {
  const key = process.env[LLM.keyEnv];
  if (!key) throw new Error(`没有找到模型密钥环境变量 ${LLM.keyEnv}`);
  const r = await fetch(`${LLM.baseUrl}/responses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, ...x }), signal: AbortSignal.timeout(300_000)
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
  return j.output || [];
}

// Models sometimes wrap JSON in prose or code fences.
export function parseJson(s: string): any {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : s;
  const a = body.search(/[\[{]/), b = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  return JSON.parse(body.slice(a, b + 1));
}
