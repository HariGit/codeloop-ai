import { ToolCall, ToolDefinition, ToolProvider, ToolResult } from './ToolProvider';
import {
  readFile,
  searchCode,
  writeFile,
  createFile,
  replaceFile,
  replaceRange,
  applyPatch,
  runCommand
} from '../agent/tools';

/**
 * Native tools — the built-in read/search/edit/run implementations.
 * Approval dialogs and command risk assessment live inside the tool
 * implementations (agent/tools.ts); this provider only routes.
 */
export class NativeToolProvider implements ToolProvider {
  constructor(private readonly workspaceRoot: string) {}

  listTools(): ToolDefinition[] {
    return [
      { name: 'read_file', description: 'Read a workspace file (input: path)', requiresApproval: false },
      { name: 'search_code', description: 'Salesforce-aware literal code search (input: query)', requiresApproval: false },
      { name: 'create_file', description: 'Create a NEW file; fails if it exists (input: path, content, reason)', requiresApproval: true },
      { name: 'replace_file', description: 'Overwrite a full file — HIGH risk (input: path, content, reason)', requiresApproval: true },
      { name: 'replace_range', description: 'Replace lines startLine-endLine with new content (input: path, startLine, endLine, content, reason)', requiresApproval: true },
      { name: 'apply_patch', description: 'Apply a unified diff to an existing file (input: path, patch, reason)', requiresApproval: true },
      { name: 'write_file', description: 'Legacy alias of replace_file (input: path, content, reason)', requiresApproval: true },
      { name: 'run_command', description: 'Run a shell command in the workspace (input: command, reason)', requiresApproval: true }
    ];
  }

  async execute(toolCall: ToolCall): Promise<ToolResult> {
    const input = toolCall.input ?? {};
    const str = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '');
    const num = (key: string): number | undefined => (typeof input[key] === 'number' ? (input[key] as number) : undefined);

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
      case 'create_file': {
        const path = str('path');
        const content = typeof input.content === 'string' ? (input.content as string) : undefined;
        if (!path || content === undefined) {
          return { success: false, observation: 'create_file requires input.path and input.content' };
        }
        return createFile(this.workspaceRoot, path, content, str('reason'));
      }
      case 'replace_file':
      case 'write_file': {
        const path = str('path');
        const content = typeof input.content === 'string' ? (input.content as string) : undefined;
        if (!path || content === undefined) {
          return { success: false, observation: `${toolCall.name} requires input.path and input.content` };
        }
        return toolCall.name === 'write_file'
          ? writeFile(this.workspaceRoot, path, content, str('reason'))
          : replaceFile(this.workspaceRoot, path, content, str('reason'));
      }
      case 'replace_range': {
        const path = str('path');
        const content = typeof input.content === 'string' ? (input.content as string) : undefined;
        const startLine = num('startLine');
        const endLine = num('endLine');
        if (!path || content === undefined || startLine === undefined || endLine === undefined) {
          return { success: false, observation: 'replace_range requires input.path, input.startLine, input.endLine, and input.content' };
        }
        return replaceRange(this.workspaceRoot, path, startLine, endLine, content, str('reason'));
      }
      case 'apply_patch': {
        const path = str('path');
        const patch = str('patch');
        if (!path || !patch) {
          return { success: false, observation: 'apply_patch requires input.path and input.patch (unified diff)' };
        }
        return applyPatch(this.workspaceRoot, path, patch, str('reason'));
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
