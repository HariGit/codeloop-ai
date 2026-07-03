import { ToolCall, ToolDefinition, ToolProvider, ToolResult } from './ToolProvider';

/**
 * Central tool registry. Providers register their tools; the agent loop
 * executes everything through here. The registry enforces the task-mode
 * allowlist before any provider runs — unsafe/no-op cases return a failed
 * ToolResult instead of throwing, so the loop can feed them back to the
 * model as observations.
 *
 * Deeper safety (dangerous-command blocklist, user approval dialogs)
 * remains inside the native tool implementations.
 */
export class ToolRegistry {
  private readonly providers: ToolProvider[] = [];

  registerProvider(provider: ToolProvider): void {
    this.providers.push(provider);
  }

  /** All tools across all registered providers. */
  listTools(): ToolDefinition[] {
    return this.providers.flatMap(p => p.listTools());
  }

  /** Find the provider that owns a tool (first match wins). */
  private findProvider(name: string): ToolProvider | undefined {
    return this.providers.find(p => p.listTools().some(t => t.name === name));
  }

  /**
   * Execute a tool call.
   * @param allowedActions task-mode allowlist; calls outside it are blocked.
   */
  async execute(toolCall: ToolCall, allowedActions?: string[]): Promise<ToolResult> {
    if (allowedActions && !allowedActions.includes(toolCall.name)) {
      return {
        success: false,
        observation: `Tool "${toolCall.name}" is BLOCKED by the current task mode. Allowed: ${allowedActions.join(', ')}.`
      };
    }
    const provider = this.findProvider(toolCall.name);
    if (!provider) {
      return {
        success: false,
        observation: `Unknown tool: "${toolCall.name}". Available tools: ${this.listTools().map(t => t.name).join(', ')}.`
      };
    }
    try {
      return await provider.execute(toolCall);
    } catch (err) {
      return { success: false, observation: `Tool "${toolCall.name}" failed: ${(err as Error).message}` };
    }
  }
}
