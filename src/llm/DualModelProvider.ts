import { ChatMessage, ChatOptions } from '../types/agentTypes';
import { ModelProvider, ProviderError } from './ModelProvider';

/**
 * Multi-model provider: a strong PRIMARY model drives the agent
 * (action decisions, final answers) while a cheap LOCAL model handles
 * light background calls (reflections). If either side fails mid-run,
 * calls fail over to the other, so a dead API key or a stopped Ollama
 * degrades the run instead of killing it.
 */
export class DualModelProvider implements ModelProvider {
  readonly name = 'multi';
  private primaryDown = false;
  private localDown = false;

  constructor(
    private readonly primary: ModelProvider,
    private readonly local: ModelProvider
  ) {}

  getInfo(): string {
    const p = this.primary.getInfo?.() ?? this.primary.name;
    const l = this.local.getInfo?.() ?? this.local.name;
    const pFlag = this.primaryDown ? ' [DOWN — using local]' : '';
    const lFlag = this.localDown ? ' [DOWN — using primary]' : '';
    return `multi | primary: ${p}${pFlag} | local: ${l}${lFlag}`;
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
    const preferLocal = opts?.tier === 'light';
    const first = preferLocal
      ? (this.localDown ? this.primary : this.local)
      : (this.primaryDown ? this.local : this.primary);
    const second = first === this.primary ? this.local : this.primary;

    try {
      return await first.chat(messages, opts);
    } catch (err) {
      if (first === this.primary) {
        this.primaryDown = true;
      } else {
        this.localDown = true;
      }
      const secondDown = second === this.primary ? this.primaryDown : this.localDown;
      if (secondDown) {
        throw err;
      }
      return second.chat(messages, opts);
    }
  }

  async healthCheck(): Promise<void> {
    let primaryError: Error | undefined;
    let localError: Error | undefined;
    try {
      await this.primary.healthCheck();
    } catch (err) {
      this.primaryDown = true;
      primaryError = err as Error;
    }
    try {
      await this.local.healthCheck();
    } catch (err) {
      this.localDown = true;
      localError = err as Error;
    }
    if (primaryError && localError) {
      throw new ProviderError(
        `Both models are unavailable. Primary: ${primaryError.message} | Local: ${localError.message}`
      );
    }
  }
}
