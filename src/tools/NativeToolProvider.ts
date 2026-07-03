import { ToolCall, ToolDefinition, ToolProvider, ToolResult } from './ToolProvider';
import { readFile, searchCode, writeFile, runCommand } from '../agent/tools';

/**
 * Native tools — the built-in read/search/write/run implementations.
 * Approval dialogs and command risk assessment live inside the tool
 * implementations (agent/tools.ts); this provider only routes.
 */
export class NativeToolProvider implements ToolProvider {
  constructor(private readonly workspaceRoot: string) {}

  listTools(): ToolDefinition[] {
    return [
      { name: 'read_file', description: 'Read a workspace file (input: path)', requiresApproval: false },
      { name: 'search_code', description: 'Salesforce-aware literal code search (input: query)', requiresApproval: false },
      { name: 'write_file', description: 'Create or overwrite a workspace file (input: path, content, reason)', requiresApproval: true },
      { name: 'run_command', description: 'Run a shell command in the workspace (input: command, reason)', requiresApproval: true }
    ];
  }

  async execute(toolCall: ToolCall): Promise<ToolResult> {
    const input = toolCall.input ?? {};
    const str = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '');

    switch (toolCall.name) {
      case 'read_file': {
        const path = str('path');
        if (!path) {
          return { success: false, observation: 'read_file requires input.path' };
        }
        return readFile(this.workspaceRoot, path);
      }
      case 'search_code': {
        const query = str('query');
        if (!query) {
          return { success: false, observation: 'search_code requires input.query' };
        }
        return searchCode(this.workspaceRoot, query);
      }
      case 'write_file': {
        const path = str('path');
        const content = typeof input.content === 'string' ? (input.content as string) : undefined;
        if (!path || content === undefined) {
          return { success: false, observation: 'write_file requires input.path and input.content' };
        }
        return writeFile(this.workspaceRoot, path, content, str('reason'));
      }
      case 'run_command': {
        const command = str('command');
        if (!command) {
          return { success: false, observation: 'run_command requires input.command' };
        }
        return runCommand(this.workspaceRoot, command, str('reason'));
      }
      default:
        return { success: false, observation: `Unknown native tool: ${toolCall.name}` };
    }
  }
}
