import { AiError, type ModelClient, type ModelMessage, type ModelRequest, type ModelResponse } from './types.ts';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  done_reason?: string;
}

export interface OllamaOptions {
  url: string;
  /** Context window in tokens. Ollama's default is small enough to silently cut off the playbook in draft prompts. */
  numCtx: number;
  fetchFn?: typeof fetch;
}

/** Ollama has no tool_use ids; the repair turn is plain chat, so the id only needs to be unique per call. */
let nextId = 1;

export function toChatMessages(system: string, toolDescription: string, messages: ModelMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [
    { role: 'system', content: `${system}\n\n${toolDescription} Reply with a single JSON object that matches the schema.` },
  ];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'tool_call') out.push({ role: 'assistant', content: typeof m.input === 'string' ? m.input : JSON.stringify(m.input) });
    else out.push({ role: 'user', content: m.error });
  }
  return out;
}

/**
 * Local models through Ollama's chat API. Structured output uses `format` with the tool's JSON schema, which
 * constrains generation to the schema; small local models follow that far more reliably than tool calling.
 */
export class OllamaClient implements ModelClient {
  readonly name = 'ollama';
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: OllamaOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.opts.url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: req.model,
          messages: toChatMessages(req.system, req.tool.description, req.messages),
          format: req.tool.inputSchema,
          stream: false,
          think: false,
          keep_alive: '30m',
          options: { temperature: 0, num_predict: req.maxTokens, num_ctx: this.opts.numCtx },
        }),
        signal: AbortSignal.timeout(req.timeoutMs),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new AiError('transient', `Ollama did not answer within ${req.timeoutMs} ms`, err);
      }
      throw new AiError('transient', `Ollama not reachable at ${this.opts.url}. Start it with \`make services\`.`, err);
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      if (res.status === 404) {
        throw new AiError('permanent', `Ollama model ${req.model} is not installed. Run \`ollama pull ${req.model}\` or \`make services\`.`);
      }
      throw new AiError(res.status >= 500 || res.status === 429 ? 'transient' : 'permanent', `Ollama HTTP ${res.status}: ${detail}`);
    }

    const body = (await res.json()) as ChatResponse;
    const text = body.message?.content ?? '';
    let toolInput: unknown = text;
    try {
      toolInput = JSON.parse(text);
    } catch {
      // Left as text: validation fails with a readable error and the repair turn shows the model what it sent.
    }
    return {
      toolInput,
      toolUseId: `ollama-${nextId++}`,
      inputTokens: body.prompt_eval_count ?? 0,
      outputTokens: body.eval_count ?? 0,
    };
  }
}

export interface OllamaStatus {
  reachable: boolean;
  version?: string;
  missingModels: string[];
  error?: string;
}

/** Whether Ollama answers and has every model the config needs. Never throws. */
export async function ollamaStatus(url: string, models: string[], fetchFn: typeof fetch = fetch): Promise<OllamaStatus> {
  try {
    const signal = AbortSignal.timeout(2_000);
    const [version, tags] = await Promise.all([
      fetchFn(`${url}/api/version`, { signal }).then((r) => r.json() as Promise<{ version?: string }>),
      fetchFn(`${url}/api/tags`, { signal }).then((r) => r.json() as Promise<{ models?: { name: string }[] }>),
    ]);
    const installed = new Set((tags.models ?? []).map((m) => m.name));
    const has = (m: string) => installed.has(m) || (!m.includes(':') && installed.has(`${m}:latest`));
    return { reachable: true, version: version.version, missingModels: [...new Set(models)].filter((m) => !has(m)) };
  } catch (err) {
    return { reachable: false, missingModels: [...new Set(models)], error: err instanceof Error ? err.message : String(err) };
  }
}
