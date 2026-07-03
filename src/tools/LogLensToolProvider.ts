import * as fs from 'fs/promises';
import * as path from 'path';
import { ToolCall, ToolDefinition, ToolProvider, ToolResult } from './ToolProvider';
import { parseDebugLog } from '../loglens/debugLogParser';
import { analyzeLog } from '../loglens/logAnalyzer';
import {
  buildFullReport,
  buildFlowReport,
  buildExceptionReport,
  buildGovernorReport
} from '../loglens/logReportBuilder';
import { DebugLogAnalysis } from '../loglens/logTypes';

const MAX_LOG_BYTES = 20 * 1024 * 1024; // 20 MB
const LOG_EXTENSIONS = /\.(log|txt)$/i;
const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist']);
const SCAN_MAX_DEPTH = 5;

/**
 * Apex LogLens tools — the extension parses debug logs and hands the LLM
 * structured analysis. The model never sees the raw log.
 */
export class LogLensToolProvider implements ToolProvider {
  constructor(private readonly workspaceRoot: string) {}

  listTools(): ToolDefinition[] {
    return [
      { name: 'analyze_debug_log', description: 'Full structured analysis of an Apex debug log (input: path)', requiresApproval: false },
      { name: 'analyze_latest_apex_logs', description: 'Find and analyze the most recent .log file in the workspace', requiresApproval: false },
      { name: 'explain_log_flow', description: 'Entry point, timeline, and method call tree of a debug log (input: path)', requiresApproval: false },
      { name: 'find_log_exception', description: 'Exceptions and fatal errors in a debug log (input: path)', requiresApproval: false },
      { name: 'find_governor_risk', description: 'Governor limit usage and risk findings in a debug log (input: path)', requiresApproval: false }
    ];
  }

  async execute(toolCall: ToolCall): Promise<ToolResult> {
    const input = toolCall.input ?? {};
    const relPath = typeof input.path === 'string' ? (input.path as string) : '';

    if (toolCall.name === 'analyze_latest_apex_logs') {
      return this.analyzeLatest();
    }
    if (!relPath) {
      return { success: false, observation: `${toolCall.name} requires input.path (the debug log file path).` };
    }

    const loaded = await this.loadAnalysis(relPath);
    if ('error' in loaded) {
      return { success: false, observation: loaded.error };
    }
    const { analysis, label } = loaded;

    switch (toolCall.name) {
      case 'analyze_debug_log':
        return { success: true, observation: buildFullReport(label, analysis) };
      case 'explain_log_flow':
        return { success: true, observation: buildFlowReport(label, analysis) };
      case 'find_log_exception':
        return { success: true, observation: buildExceptionReport(label, analysis) };
      case 'find_governor_risk':
        return { success: true, observation: buildGovernorReport(label, analysis) };
      default:
        return { success: false, observation: `Unknown LogLens tool: ${toolCall.name}` };
    }
  }

  /** Load, parse, and analyze a log file (workspace-contained, .log/.txt only). */
  private async loadAnalysis(
    relPath: string
  ): Promise<{ analysis: DebugLogAnalysis; label: string } | { error: string }> {
    if (!LOG_EXTENSIONS.test(relPath)) {
      return { error: `Not a log file: "${relPath}". Provide a .log (or .txt) Apex debug log.` };
    }
    const full = path.resolve(this.workspaceRoot, relPath);
    const rootWithSep = this.workspaceRoot.endsWith(path.sep) ? this.workspaceRoot : this.workspaceRoot + path.sep;
    if (full !== this.workspaceRoot && !full.startsWith(rootWithSep)) {
      return { error: `Path "${relPath}" is outside the workspace. Copy the log into the workspace first.` };
    }

    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      return { error: `Log file not found: ${relPath}` };
    }
    if (stat.size > MAX_LOG_BYTES) {
      return { error: `Log file too large (${Math.round(stat.size / 1024 / 1024)} MB, max 20 MB): ${relPath}` };
    }

    const raw = await fs.readFile(full, 'utf8');
    const analysis = analyzeLog(parseDebugLog(raw));
    return { analysis, label: relPath.split(path.sep).join('/') };
  }

  /** Find the newest .log file in the workspace and run the full analysis. */
  private async analyzeLatest(): Promise<ToolResult> {
    const found: Array<{ p: string; mtime: number }> = [];
    await this.walk(this.workspaceRoot, 0, found);
    if (found.length === 0) {
      return {
        success: false,
        observation: 'No .log files found in the workspace. Download a debug log (e.g. sf apex log get) into the workspace, or pass a path to analyze_debug_log.'
      };
    }
    found.sort((a, b) => b.mtime - a.mtime);
    const latest = found[0];
    const rel = path.relative(this.workspaceRoot, latest.p);
    const loaded = await this.loadAnalysis(rel);
    if ('error' in loaded) {
      return { success: false, observation: loaded.error };
    }
    const header = `Found ${found.length} log file(s); analyzing the most recent: ${rel.split(path.sep).join('/')}\n\n`;
    return { success: true, observation: header + buildFullReport(loaded.label, loaded.analysis) };
  }

  private async walk(dir: string, depth: number, found: Array<{ p: string; mtime: number }>): Promise<void> {
    if (depth > SCAN_MAX_DEPTH || found.length > 500) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SCAN_SKIP_DIRS.has(e.name)) {
          await this.walk(p, depth + 1, found);
        }
      } else if (e.isFile() && /\.log$/i.test(e.name)) {
        try {
          const stat = await fs.stat(p);
          found.push({ p, mtime: stat.mtimeMs });
        } catch {
          // Skip unreadable files.
        }
      }
    }
  }
}
