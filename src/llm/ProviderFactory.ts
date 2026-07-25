import { AgentConfig } from '../types/agentTypes';
import { ModelProvider } from './ModelProvider';
import { OllamaProvider } from './OllamaProvider';
import { AnthropicProvider } from './AnthropicProvider';
import { OpenAIProvider } from './OpenAIProvider';
import { VsCodeLanguageModelProvider } from './VsCodeLanguageModelProvider';
import { DualModelProvider } from './DualModelProvider';

/**
 * Create the model provider for the current configuration.
 * mono: one provider (Ollama default). multi: primary + local slots
 * wrapped in DualModelProvider with automatic failover.
 */
export function createModelProvider(config: AgentConfig): ModelProvider {
  if (config.modelMode === 'multi' && config.primary && config.local) {
    const primary = createSingleProvider({ ...config, provider: config.primary.provider, model: config.primary.model });
    const local = createSingleProvider({ ...config, provider: config.local.provider, model: config.local.model });
    return new DualModelProvider(primary, local);
  }
  return createSingleProvider(config);
}

function createSingleProvider(config: AgentConfig): ModelProvider {
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
