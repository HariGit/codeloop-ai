import { AgentConfig } from '../types/agentTypes';
import { ModelProvider, ProviderError } from './ModelProvider';
import { OllamaProvider } from './OllamaProvider';

/**
 * Create the model provider for the current configuration.
 * Only Ollama is implemented today; the others are reserved and fail
 * with a clear message until their providers land.
 */
export function createModelProvider(config: AgentConfig): ModelProvider {
  switch (config.provider) {
    case 'ollama':
      return new OllamaProvider(config);
    case 'anthropic':
    case 'openai':
    case 'vscode-lm':
      throw new ProviderError(
        `Provider "${config.provider}" is not implemented yet. Set "codeloopAi.provider" to "ollama".`
      );
    default:
      // Unknown value in settings — fall back to Ollama so the agent still works.
      return new OllamaProvider(config);
  }
}
