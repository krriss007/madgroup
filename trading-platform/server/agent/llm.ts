export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmDecision {
  action: 'buy' | 'sell' | 'hold' | 'close';
  confidence: number;
  reason: string;
  slAtr?: number;
  tpAtr?: number;
}

export interface LlmOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Pull the first JSON object out of a model reply (handles ```json fences and stray prose). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Model reply did not contain JSON');
  return JSON.parse(body.slice(start, end + 1));
}

/** Validate and normalise a trading decision. Anything malformed becomes an error (never a trade). */
export function parseDecision(text: string): LlmDecision {
  const raw = extractJson(text) as Record<string, unknown>;
  const action = String(raw.action ?? '').toLowerCase();
  if (!['buy', 'sell', 'hold', 'close'].includes(action)) throw new Error(`Invalid action "${action}"`);
  const confidence = Number(raw.confidence ?? 0);
  const decision: LlmDecision = {
    action: action as LlmDecision['action'],
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    reason: String(raw.reason ?? '').slice(0, 300) || 'No reason given',
  };
  if (raw.slAtr !== undefined && Number.isFinite(Number(raw.slAtr))) decision.slAtr = Number(raw.slAtr);
  if (raw.tpAtr !== undefined && Number.isFinite(Number(raw.tpAtr))) decision.tpAtr = Number(raw.tpAtr);
  return decision;
}

/** Minimal OpenAI-compatible chat-completions client. */
export class LlmClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: LlmOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  get model(): string {
    return this.opts.model;
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  async complete(messages: ChatTurn[], opts: { json?: boolean } = {}): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages,
      temperature: 0.2,
    };
    if (opts.json) body.response_format = { type: 'json_object' };
    const res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      throw new Error(`LLM request failed: HTTP ${res.status} ${detail}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM returned an empty reply');
    return content;
  }

  async decide(system: string, snapshot: unknown): Promise<LlmDecision> {
    const text = await this.complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(snapshot) },
      ],
      { json: true },
    );
    return parseDecision(text);
  }
}
