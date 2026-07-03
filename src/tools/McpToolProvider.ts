import { ToolCall, ToolDefinition, ToolProvider, ToolResult } from './ToolProvider';

/** Configuration for a future MCP server connection. */
export interface McpServerConfig {
  name: string;
  /** Transport endpoint (stdio command or HTTP/SSE URL) — wired up later. */
  endpoint: string;
}

/**
 * MCP tool provider — architecture stub.
 * Network MCP is not implemented yet: listTools() reflects only what has
 * been registered (nothing by default), and execute() fails with a clear
 * message. When MCP lands, this class gains a client that connects to the
 * configured servers, lists their tools, and forwards calls — the agent
 * loop and ToolRegistry stay unchanged.
 */
export class McpToolProvider implements ToolProvider {
  private readonly servers: McpServerConfig[];

  constructor(servers: McpServerConfig[] = []) {
    this.servers = servers;
  }

  listTools(): ToolDefinition[] {
    // No live MCP connections yet — no tools to offer.
    return [];
  }

  async execute(toolCall: ToolCall): Promise<ToolResult> {
    if (this.servers.length === 0) {
      return {
        success: false,
        observation: `MCP tool "${toolCall.name}" is not available: no MCP servers are configured.`
      };
    }
    return {
      success: false,
      observation: `MCP tool "${toolCall.name}" is not available yet: MCP support is not implemented (configured servers: ${this.servers.map(s => s.name).join(', ')}).`
    };
  }
}
