import * as vscode from 'vscode';
import { ChatMessage, ChatOptions, AgentConfig } from '../types/agentTypes';
import { ModelProvider, ProviderError } from './ModelProvider';

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

/**
 * OpenAI provider.
 * Reads the API key from the codeloopAi.openAiApiKey setting
 * (falls back to codeloopAi.apiKey). Normalizes the Chat Completions
 * response into the plain string the agent loop expects.
 */
export class OpenAIProvider implements ModelProvider {
  readonly name = 'openai';

  constructor(private readonly config: AgentConfig) {}

  getInfo(): string {
    return `${this.config.model} @ api.openai.com`;
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
      response = await fetch(OPENAI_ENDPOINT, {
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
          ...(opts?.format ? { response_format: { type: 'json_object' } } : {})
        })
      });
    } catch {
      throw new ProviderError('Cannot reach the OpenAI API. Check your network connection.');
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
