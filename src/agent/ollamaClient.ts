import { ChatMessage, ChatOptions, OllamaChatResponse, AgentConfig } from '../types/agentTypes';

/** JSON schema for AgentAction — used with Ollama structured output. */
export const AGENT_ACTION_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string' },
    action: {
      type: 'string',
      enum: ['read_file', 'search_code', 'write_file', 'run_command', 'final_answer']
    },
    path: { type: 'string' },
    query: { type: 'string' },
    content: { type: 'string' },
    command: { type: 'string' },
    answer: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } }
  },
  required: ['thought', 'action']
} as const;

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
  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
    let response: Response;
    try {
      response = await fetch(this.config.endpoint, {
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
