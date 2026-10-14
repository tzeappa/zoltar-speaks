import Anthropic from '@anthropic-ai/sdk';
import { AiError, type ModelClient, type ModelMessage, type ModelRequest, type ModelResponse } from './types.ts';

type ApiMessage = Anthropic.MessageParam;

function toolUseIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Anthropic.ContentBlock[]).flatMap((b) => (b.type === 'tool_use' ? [b.id] : []));
}

export function toApiMessages(messages: ModelMessage[], toolName: string): ApiMessage[] {
  return messages.map((m, i): ApiMessage => {
    switch (m.role) {
      case 'user':
        return { role: 'user', content: m.content };
      case 'tool_call':
        return {
          role: 'assistant',
          // Replay the original blocks when available: models that think require their thinking blocks back.
          content:
            (m.raw as Anthropic.ContentBlockParam[] | undefined) ??
            [{ type: 'tool_use', id: m.toolUseId, name: toolName, input: m.input as Record<string, unknown> }],
        };
      case 'tool_error': {
        // The API rejects a turn that leaves any replayed tool_use unanswered.
        const prev = messages[i - 1];
        const others = prev?.role === 'tool_call' ? toolUseIds(prev.raw).filter((id) => id !== m.toolUseId) : [];
        return {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: m.toolUseId, content: m.error, is_error: true },
            ...others.map(
              (id): Anthropic.ToolResultBlockParam => ({
                type: 'tool_result',
                tool_use_id: id,
                content: 'Ignored. Submit the whole result in one tool call.',
                is_error: true,
              }),
            ),
          ],
        };
      }
    }
  });
}

function classifyError(err: unknown): AiError {
  if (err instanceof Anthropic.APIConnectionError) return new AiError('transient', err.message, err);
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    const transient = status === 408 || status === 409 || status === 429 || status >= 500;
    return new AiError(transient ? 'transient' : 'permanent', `HTTP ${status}: ${err.message}`, err);
  }
  return new AiError('transient', String(err), err);
}

const isForcedToolUnsupported = (err: unknown) =>
  err instanceof Anthropic.BadRequestError && /tool_choice/i.test(err.message) && /not supported/i.test(err.message);

export class AnthropicClient implements ModelClient {
  readonly name = 'anthropic';
  private readonly sdk: Anthropic;
  /** Models that reject a forced tool choice. They get `auto`, and the prompt plus validation keep them on the tool. */
  private readonly autoToolChoice = new Set<string>();

  constructor(apiKey: string) {
    // No SDK retries: each would get the full AI_TIMEOUT_MS again. Transient errors go back to the job queue, which
    // retries with backoff.
    this.sdk = new Anthropic({ apiKey, maxRetries: 0 });
  }

  private create(req: ModelRequest, forced: boolean): Promise<Anthropic.Message> {
    return this.sdk.messages.create(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: toApiMessages(req.messages, req.tool.name),
        tools: [
          {
            name: req.tool.name,
            description: req.tool.description,
            input_schema: req.tool.inputSchema as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: forced
          ? { type: 'tool', name: req.tool.name, disable_parallel_tool_use: true }
          : { type: 'auto', disable_parallel_tool_use: true },
      },
      { timeout: req.timeoutMs },
    );
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const forced = !this.autoToolChoice.has(req.model);
    let msg: Anthropic.Message;
    try {
      msg = await this.create(req, forced);
    } catch (err) {
      if (!forced || !isForcedToolUnsupported(err)) throw classifyError(err);
      this.autoToolChoice.add(req.model);
      try {
        msg = await this.create(req, false);
      } catch (retryErr) {
        throw classifyError(retryErr);
      }
    }

    const block = msg.content.find((b) => b.type === 'tool_use');
    return {
      toolInput: block?.type === 'tool_use' ? block.input : undefined,
      toolUseId: block?.type === 'tool_use' ? block.id : null,
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      raw: msg.content,
    };
  }
}
