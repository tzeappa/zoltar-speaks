import type { Config } from '../config.ts';
import { AnthropicClient } from './anthropic.ts';
import { MockClient } from './mock.ts';
import { OllamaClient } from './ollama.ts';
import { AiError, type ModelClient } from './types.ts';

export function createModelClient(config: Config): ModelClient {
  switch (config.aiMode) {
    case 'anthropic':
      return new AnthropicClient(config.anthropicApiKey!);
    case 'ollama':
      return new OllamaClient({ url: config.ollamaUrl, numCtx: config.ollamaNumCtx });
    case 'mock':
      return new MockClient({ latencyMs: config.mockLatencyMs, failRate: config.mockFailRate });
    case 'disabled':
      return {
        name: 'disabled',
        complete: () => Promise.reject(new AiError('disabled', 'AI_MODE=disabled')),
      };
  }
}
