import { ChatMessage, ChatOptions, OllamaChatResponse, AgentConfig } from '../types/agentTypes';
import { ModelProvider, ProviderError } from './ModelProvider';

const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434/api/chat';

/**
 * Ollama provider — local /api/chat endpoint, non-streaming.
 * Supports structured output via the "format" field (JSON schema).
 */
export class OllamaProvider implements ModelProvider {
  readonly name = 'ollama';
  private readonly endpoint: string;

  constructor(private readonly config: AgentConfig) {
    this.endpoint = config.endpoint || DEFAULT_OLLAMA_ENDPOINT;
  }

  /** Send chat messages, return the assistant's text content. */
  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          stream: false,
          // Ollama structured output: constrains the model to this JSON schema.
          ...(opts?.format ? { format: opts.format } : {}),
          options: { temperature: opts?.temperature ?? 0.1 }
        })
      });
    } catch {
      throw new ProviderError(
        `Cannot reach Ollama at ${this.endpoint}. Is Ollama running? Try: ollama serve`
      );
    }

    if (response.status === 404) {
      // /api/chat returns 404 when the model is not found.
      throw new ProviderError(
        `Model "${this.config.model}" not found. Try: ollama pull ${this.config.model}`
      );
    }
    if (!response.ok) {
      const body = await safeText(response);
      throw new ProviderError(`Ollama returned HTTP ${response.status}: ${body}`);
    }

    let data: OllamaChatResponse;
    try {
      data = (await response.json()) as OllamaChatResponse;
    } catch {
      throw new ProviderError('Ollama returned a non-JSON response.');
    }

    if (data.error) {
      if (data.error.includes('not found')) {
        throw new ProviderError(
          `Model "${this.config.model}" not found. Try: ollama pull ${this.config.model}`
        );
      }
      throw new ProviderError(`Ollama error: ${data.error}`);
    }

    const content = data.message?.content;
    if (!content) {
      throw new ProviderError('Ollama returned an empty response.');
    }
    return content;
  }

  /** Quick connectivity + model check before starting the loop. */
  async healthCheck(): Promise<void> {
    await this.chat([{ role: 'user', content: 'Reply with the single word: ok' }]);
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '(unreadable body)';
  }
}
