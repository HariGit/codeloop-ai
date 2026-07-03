import { ChatMessage, OllamaChatResponse, AgentConfig } from '../types/agentTypes';

/** Error with a user-friendly message for known Ollama failures. */
export class OllamaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OllamaError';
  }
}

/**
 * Minimal client for the local Ollama /api/chat endpoint.
 * Uses non-streaming responses to keep JSON parsing simple.
 */
export class OllamaClient {
  constructor(private readonly config: AgentConfig) {}

  /** Send chat messages, return the assistant's text content. */
  async chat(messages: ChatMessage[]): Promise<string> {
    let response: Response;
    try {
      response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          stream: false,
          options: { temperature: 0.2 }
        })
      });
    } catch {
      throw new OllamaError(
        `Cannot reach Ollama at ${this.config.endpoint}. Is Ollama running? Try: ollama serve`
      );
    }

    if (response.status === 404) {
      // /api/chat returns 404 when the model is not found.
      throw new OllamaError(
        `Model "${this.config.model}" not found. Try: ollama pull ${this.config.model}`
      );
    }
    if (!response.ok) {
      const body = await safeText(response);
      throw new OllamaError(`Ollama returned HTTP ${response.status}: ${body}`);
    }

    let data: OllamaChatResponse;
    try {
      data = (await response.json()) as OllamaChatResponse;
    } catch {
      throw new OllamaError('Ollama returned a non-JSON response.');
    }

    if (data.error) {
      if (data.error.includes('not found')) {
        throw new OllamaError(
          `Model "${this.config.model}" not found. Try: ollama pull ${this.config.model}`
        );
      }
      throw new OllamaError(`Ollama error: ${data.error}`);
    }

    const content = data.message?.content;
    if (!content) {
      throw new OllamaError('Ollama returned an empty response.');
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
