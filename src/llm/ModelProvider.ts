import { ChatMessage, ChatOptions } from '../types/agentTypes';

/**
 * Abstraction over LLM backends. The agent loop only talks to this
 * interface — concrete providers (Ollama today; Claude, OpenAI, and the
 * VS Code Language Model API later) live behind it.
 */
export interface ModelProvider {
  /** Provider id, e.g. "ollama". */
  name: string;
  /** Send chat messages, return the assistant's text content. */
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
  /** Quick connectivity + model availability check; throws with a clear message. */
  healthCheck(): Promise<void>;
}

/** Error with a user-friendly message for known provider failures. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}
