import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * File-based memory under .agent-memory/ in the workspace root.
 * This is the agent's "learning" — no model training involved.
 */

const MEMORY_DIR = '.agent-memory';

export const MEMORY_FILES = {
  reflections: 'reflections.md',
  projectRules: 'project-rules.md',
  failedAttempts: 'failed-attempts.md',
  learnedPatterns: 'learned-patterns.md',
  projectSummary: 'project-summary.md'
} as const;

const DEFAULT_CONTENT: Record<string, string> = {
  [MEMORY_FILES.reflections]: '# Reflections\n\nAgent reflections after each session.\n',
  [MEMORY_FILES.projectRules]: '# Project Rules\n\nAdd project-specific rules here. The agent reads this before planning.\n',
  [MEMORY_FILES.failedAttempts]: '# Failed Attempts\n\nWhat the agent tried that did not work, so it is not repeated.\n',
  [MEMORY_FILES.learnedPatterns]: '# Learned Patterns\n\nReusable patterns discovered while working on this project.\n',
  [MEMORY_FILES.projectSummary]: '# Project Summary\n\nRun "CodeLoop AI: Scan Salesforce Project" to populate this file.\n'
};

export class AgentMemory {
  private readonly dir: string;

  constructor(workspaceRoot: string) {
    this.dir = path.join(workspaceRoot, MEMORY_DIR);
  }

  /** Create .agent-memory and any missing files. Safe to call repeatedly. */
  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    for (const [file, content] of Object.entries(DEFAULT_CONTENT)) {
      const filePath = path.join(this.dir, file);
      try {
        await fs.access(filePath);
      } catch {
        await fs.writeFile(filePath, content, 'utf8');
      }
    }
  }

  /** Read a memory file; returns '' if missing or unreadable. */
  async read(file: string): Promise<string> {
    try {
      return await fs.readFile(path.join(this.dir, file), 'utf8');
    } catch {
      return '';
    }
  }

  /** Append a timestamped markdown section to a memory file. */
  async append(file: string, heading: string, body: string): Promise<void> {
    const stamp = new Date().toISOString();
    const entry = `\n## ${heading} — ${stamp}\n\n${body.trim()}\n`;
    await fs.appendFile(path.join(this.dir, file), entry, 'utf8');
  }

  async saveReflection(goal: string, reflection: string): Promise<void> {
    await this.append(MEMORY_FILES.reflections, `Goal: ${truncate(goal, 80)}`, reflection);
  }

  async saveFailedAttempt(goal: string, detail: string): Promise<void> {
    await this.append(MEMORY_FILES.failedAttempts, `Goal: ${truncate(goal, 80)}`, detail);
  }

  async saveLearnedPattern(pattern: string): Promise<void> {
    await this.append(MEMORY_FILES.learnedPatterns, 'Pattern', pattern);
  }

  /** Overwrite the project summary (used by the Salesforce scanner). */
  async writeProjectSummary(summary: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, MEMORY_FILES.projectSummary), summary, 'utf8');
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}
