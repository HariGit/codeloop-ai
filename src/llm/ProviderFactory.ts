import { AgentConfig } from '../types/agentTypes';
import { ModelProvider } from './ModelProvider';
import { OllamaProvider } from './OllamaProvider';
import { AnthropicProvider } from './AnthropicProvider';
import { OpenAIProvider } from './OpenAIProvider';
import { VsCodeLanguageModelProvider } from './VsCodeLanguageModelProvider';

/**
 * Create the model provider for the current configuration.
 * Ollama (local) is the default. Cloud providers require their API key
 * settings; vscode-lm requires the VS Code Language Model API.
 */
export function createModelProvider(config: AgentConfig): ModelProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'openai':
      return new OpenAIProvider(config);
    case 'vscode-lm':
      return new VsCodeLanguageModelProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    default:
      // Unknown value in settings — fall back to Ollama so the agent still works.
      return new OllamaProvider(config);
  }
}
