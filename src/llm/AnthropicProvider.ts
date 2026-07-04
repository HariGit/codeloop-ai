import * as vscode from 'vscode';
import { ChatMessage, ChatOptions, AgentConfig } from '../types/agentTypes';
import { ModelProvider, ProviderError } from './ModelProvider';

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 4096;

/**
 * Anthropic (Claude) provider.
 * Reads the API key from the codeloopAi.anthropicApiKey setting
 * (falls back to codeloopAi.apiKey). Normalizes the Messages API
 * response into the plain string the agent loop expects.
 */
export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';

  constructor(private readonly config: AgentConfig) {}

  getInfo(): string {
    return `${this.config.model} @ api.anthropic.com`;
  }

  private getApiKey(): string {
    let key = '';
    try {
      key = vscode.workspace.getConfiguration('codeloopAi').get<string>('anthropicApiKey', '');
    } catch {
      // Settings unavailable (e.g. tests) — fall through to config.
    }
    return key || this.config.apiKey || '';
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new ProviderError(
        'Anthropic provider is not configured. Set "codeloopAi.anthropicApiKey" in VS Code settings (and "codeloopAi.model" to e.g. "claude-sonnet-4-5").'
      );
    }

    // Anthropic takes system text as a top-level field, not a message role.
    let system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    if (opts?.format) {
      system += '\n\nRespond with a single JSON object only. No markdown, no code fences.';
    }
    const turns = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }));

    let response: Response;
    try {
      response = await fetch(ANTHROPIC_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: MAX_TOKENS,
          temperature: opts?.temperature ?? 0.1,
          ...(system ? { system } : {}),
          messages: turns
        })
      });
    } catch {
      throw new ProviderError('Cannot reach the Anthropic API. Check your network connection.');
    }

    if (response.status === 401) {
      throw new ProviderError('Anthropic API key rejected (401). Check "codeloopAi.anthropicApiKey".');
    }
    if (response.status === 404) {
      throw new ProviderError(`Anthropic model "${this.config.model}" not found (404). Check "codeloopAi.model".`);
    }
    if (!response.ok) {
      throw new ProviderError(`Anthropic API returned HTTP ${response.status}: ${await safeText(response)}`);
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
      error?: { message?: string };
    };
    if (data.error?.message) {
      throw new ProviderError(`Anthropic error: ${data.error.message}`);
    }
    // Normalize: concatenate all text blocks into one string.
    const text = (data.content ?? [])
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('');
    if (!text) {
      throw new ProviderError('Anthropic returned an empty response.');
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
