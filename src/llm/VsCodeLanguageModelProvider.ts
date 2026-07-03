import * as vscode from 'vscode';
import { ChatMessage, ChatOptions, AgentConfig } from '../types/agentTypes';
import { ModelProvider, ProviderError } from './ModelProvider';

/**
 * VS Code Language Model API provider (Copilot models).
 * Requires VS Code 1.90+ with a Language Model extension (e.g. GitHub
 * Copilot) installed and authorized. Streams the response and normalizes
 * it into the plain string the agent loop expects.
 *
 * Note: the LM API types are newer than this extension's minimum engine,
 * so the API is accessed defensively via a narrow local type.
 */
interface VsCodeLmApi {
  selectChatModels(selector?: { family?: string; id?: string }): Promise<VsCodeLmModel[]>;
}
interface VsCodeLmModel {
  id: string;
  family: string;
  sendRequest(
    messages: unknown[],
    options: object,
    token: vscode.CancellationToken
  ): Promise<{ text: AsyncIterable<string> }>;
}

export class VsCodeLanguageModelProvider implements ModelProvider {
  readonly name = 'vscode-lm';

  constructor(private readonly config: AgentConfig) {}

  private getLmApi(): VsCodeLmApi {
    const lm = (vscode as unknown as { lm?: VsCodeLmApi }).lm;
    if (!lm || typeof lm.selectChatModels !== 'function') {
      throw new ProviderError(
        'VS Code Language Model API is not available. It requires VS Code 1.90+ with a language model extension (e.g. GitHub Copilot) installed and signed in.'
      );
    }
    return lm;
  }

  private async selectModel(): Promise<VsCodeLmModel> {
    const lm = this.getLmApi();
    // Try the configured model as a family first (e.g. "gpt-4o"), then anything.
    let models: VsCodeLmModel[] = [];
    if (this.config.model) {
      models = await lm.selectChatModels({ family: this.config.model });
    }
    if (models.length === 0) {
      models = await lm.selectChatModels();
    }
    if (models.length === 0) {
      throw new ProviderError(
        'No VS Code language models available. Install/sign in to GitHub Copilot, or check "codeloopAi.model" (model family, e.g. "gpt-4o").'
      );
    }
    return models[0];
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
    const model = await this.selectModel();

    // The LM API has User/Assistant roles; fold system text into the first user turn.
    const lmMessageCtor = (vscode as unknown as {
      LanguageModelChatMessage?: { User(content: string): unknown; Assistant(content: string): unknown };
    }).LanguageModelChatMessage;
    if (!lmMessageCtor) {
      throw new ProviderError('VS Code Language Model message API is not available in this VS Code version.');
    }

    const systemText = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const formatNote = opts?.format
      ? '\n\nRespond with a single JSON object only. No markdown, no code fences.'
      : '';
    const lmMessages: unknown[] = [];
    let systemInjected = false;
    for (const m of messages) {
      if (m.role === 'system') {
        continue;
      }
      if (m.role === 'assistant') {
        lmMessages.push(lmMessageCtor.Assistant(m.content));
      } else {
        const prefix = !systemInjected && systemText ? `${systemText}${formatNote}\n\n---\n\n` : '';
        lmMessages.push(lmMessageCtor.User(prefix + m.content));
        systemInjected = true;
      }
    }

    let text = '';
    try {
      const response = await model.sendRequest(lmMessages, {}, new vscode.CancellationTokenSource().token);
      for await (const fragment of response.text) {
        text += fragment;
      }
    } catch (err) {
      throw new ProviderError(`VS Code language model request failed: ${(err as Error).message}`);
    }

    if (!text) {
      throw new ProviderError('VS Code language model returned an empty response.');
    }
    return text;
  }

  async healthCheck(): Promise<void> {
    // Selecting a model verifies API availability and Copilot access
    // without spending tokens.
    await this.selectModel();
  }
}
