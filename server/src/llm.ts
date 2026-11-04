import { config } from './config.js';

// Chat Completions types (OpenAI-compatible, as served by the Meta Model API).
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type ToolDef = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

const MODEL_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_S ?? 90) * 1000;

export async function chat(messages: Message[], tools?: ToolDef[], model = config.modelId): Promise<{
  content: string | null;
  toolCalls: ToolCall[];
}> {
  const body: Record<string, unknown> = { model, messages };
  if (tools?.length) body.tools = tools;

  let timeouts = 0;
  for (let attempt = 0; ; attempt++) {
    // Slides run in parallel: a dropped connection or a rate limit is retried, not fatal.
    // A call that hangs is cut at MODEL_TIMEOUT_S and tried once more, so a run never stalls.
    const res = await fetch(`${config.modelBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.modelApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    }).catch((error: Error) => {
      if (error.name === 'TimeoutError' && ++timeouts >= 2) throw new Error(`The model took over ${MODEL_TIMEOUT_MS / 1000} s twice`);
      if (attempt >= 4) throw error;
      return undefined;
    });
    if (!res) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (res.ok) {
      const json = (await res.json()) as {
        choices: { message: { content: string | null; tool_calls?: ToolCall[] } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
      };
      charge(json.usage, model);
      const message = json.choices[0]?.message;
      return { content: message?.content ?? null, toolCalls: message?.tool_calls ?? [] };
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 4) {
      throw new Error(`Model API ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    const after = Number(res.headers.get('retry-after'));
    await new Promise((r) => setTimeout(r, after > 0 ? Math.min(after, 30) * 1000 : 1000 * 2 ** attempt + Math.random() * 1000));
  }
}

// US$ per 1M tokens (dev.meta.ai/docs/pricing-rate-limits, 2026-10).
const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  'muse-spark-1.3': { input: 1.25, cached: 0.15, output: 4.25 },
  'muse-spark-1.3-contributor': { input: 0.1, cached: 0.002, output: 0.2 },
  'muse-wonder-1.0': { input: 4, cached: 0.2, output: 20 },
};

// One run at a time (GIMP is single), so a process-wide meter is enough.
let spent = 0;
let tokens = 0;

export function spentUsd(): number {
  return spent;
}

// Every token the models read and wrote, for the live counter.
export function spentTokens(): number {
  return tokens;
}

export function addCost(usd: number): void {
  spent += usd;
}

function charge(usage: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined, model: string): void {
  const price = PRICES[model] ?? PRICES['muse-spark-1.3'];
  if (!usage) return;
  tokens += (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const input = (usage.prompt_tokens ?? 0) - cached;
  spent += (input * price.input + cached * price.cached + (usage.completion_tokens ?? 0) * price.output) / 1e6;
}

export function imagePart(base64Png: string, mime = 'image/png'): ContentPart {
  return { type: 'image_url', image_url: { url: `data:${mime};base64,${base64Png}` } };
}

// Models sometimes wrap JSON in prose or code fences; take the outermost object.
export function parseJson<T>(text: string | null): T {
  if (!text) throw new Error('Empty model response');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`No JSON in model response: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1)) as T;
}

export async function chatJson<T>(messages: Message[], model = config.modelId): Promise<T> {
  const first = await chat(messages, undefined, model);
  try {
    return parseJson<T>(first.content);
  } catch (error) {
    const retry = await chat([
      ...messages,
      { role: 'assistant', content: first.content },
      { role: 'user', content: `That was not valid JSON (${(error as Error).message}). Reply with the JSON object only.` },
    ], undefined, model);
    return parseJson<T>(retry.content);
  }
}
