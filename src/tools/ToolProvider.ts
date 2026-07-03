/**
 * Tool abstraction. The agent loop executes tools through this interface;
 * native tools live in NativeToolProvider, and external MCP tools will be
 * added through McpToolProvider without touching the loop.
 */

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  observation: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** True when execution needs explicit user approval (write/run). */
  requiresApproval: boolean;
}

export interface ToolProvider {
  listTools(): ToolDefinition[];
  execute(toolCall: ToolCall): Promise<ToolResult>;
}
