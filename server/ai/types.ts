export type Purpose = 'classify' | 'draft' | 'incident_brief';

export type ModelMessage =
  | { role: 'user'; content: string }
  | { role: 'tool_call'; toolUseId: string; input: unknown; raw?: unknown }
  | { role: 'tool_error'; toolUseId: string; error: string };

export interface ModelRequest {
  purpose: Purpose;
  model: string;
  system: string;
  messages: ModelMessage[];
  tool: { name: string; description: string; inputSchema: Record<string, unknown> };
  maxTokens: number;
  timeoutMs: number;
}

export interface ModelResponse {
  toolInput: unknown;
  /** Null when the model returned no tool call. */
  toolUseId: string | null;
  inputTokens: number;
  outputTokens: number;
  /** Provider-specific assistant content, replayed verbatim in repair turns. */
  raw?: unknown;
}

/** Thin transport over a model provider. Validation, retries on bad output, and tracing live in structured.ts. */
export interface ModelClient {
  readonly name: string;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

export type AiErrorKind = 'transient' | 'permanent' | 'invalid_output' | 'budget' | 'disabled';

export class AiError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AiError';
  }
}
