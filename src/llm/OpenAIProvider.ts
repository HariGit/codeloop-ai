import * as vscode from 'vscode';
import { ChatMessage, ChatOptions, AgentConfig } from '../types/agentTypes';
import { ModelProvider, ProviderError } from './ModelProvider';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * OpenAI provider.
 * Reads the API key from the codeloopAi.openAiApiKey setting
 * (falls back to codeloopAi.apiKey). Normalizes the Chat Completions
 * response into the plain string the agent loop expects.
 */
export class OpenAIProvider implements ModelProvider {
  readonly name = 'openai';
  private readonly baseUrl: string;

  constructor(private readonly config: AgentConfig) {
    this.baseUrl = (config.openAiBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  getInfo(): string {
    return `${this.config.model} @ ${this.baseUrl}`;
  }

  /** json_object response_format is OpenAI-specific; skip it for other hosts. */
  private supportsJsonFormat(): boolean {
    return this.baseUrl.includes('api.openai.com');
  }

  private getApiKey(): string {
    let key = '';
    try {
      key = vscode.workspace.getConfiguration('codeloopAi').get<string>('openAiApiKey', '');
    } catch {
      // Settings unavailable (e.g. tests) — fall through to config.
    }
    return key || this.config.apiKey || '';
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new ProviderError(
        'OpenAI provider is not configured. Set "codeloopAi.openAiApiKey" in VS Code settings (and "codeloopAi.model" to e.g. "gpt-4o").'
      );
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          temperature: opts?.temperature ?? 0.1,
          // Our prompts always mention JSON, which json_object mode requires.
          ...(opts?.format && this.supportsJsonFormat() ? { response_format: { type: 'json_object' } } : {}),
          // User-supplied provider-specific fields (may override the above).
          ...(this.config.openAiExtraBody ?? {})
        })
      });
    } catch {
      throw new ProviderError(`Cannot reach ${this.baseUrl}. Check your network connection and "codeloopAi.openAiBaseUrl".`);
    }

    if (response.status === 401) {
      throw new ProviderError('OpenAI API key rejected (401). Check "codeloopAi.openAiApiKey".');
    }
    if (response.status === 404) {
      throw new ProviderError(`OpenAI model "${this.config.model}" not found (404). Check "codeloopAi.model".`);
    }
    if (!response.ok) {
      throw new ProviderError(`OpenAI API returned HTTP ${response.status}: ${await safeText(response)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (data.error?.message) {
      throw new ProviderError(`OpenAI error: ${data.error.message}`);
    }
    // Normalize: first choice's message content.
    const text = data.choices?.[0]?.message?.content ?? '';
    if (!text) {
      throw new ProviderError('OpenAI returned an empty response.');
    }
    return text;
  }

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
