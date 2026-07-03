import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * File-based memory under .agent-memory/ in the workspace root.
 * This is the agent's "learning" — no model training involved.
 * Entries are kept concise and secrets are redacted before saving.
 */

const MEMORY_DIR = '.agent-memory';
const MAX_ENTRY_CHARS = 2500;

export const MEMORY_FILES = {
  reflections: 'reflections.md',
  projectRules: 'project-rules.md',
  failedAttempts: 'failed-attempts.md',
  learnedPatterns: 'learned-patterns.md',
  projectSummary: 'project-summary.md',
  actionHistory: 'action-history.md',
  salesforceDecisions: 'salesforce-decisions.md'
} as const;

const DEFAULT_CONTENT: Record<string, string> = {
  [MEMORY_FILES.reflections]: '# Reflections\n\nStructured reflections after each agent task.\n',
  [MEMORY_FILES.projectRules]: '# Project Rules\n\nAdd project-specific rules here. The agent reads this before planning.\n',
  [MEMORY_FILES.failedAttempts]: '# Failed Attempts\n\nWhat the agent tried that did not work (including invalid JSON and blocked actions).\n',
  [MEMORY_FILES.learnedPatterns]: '# Learned Patterns\n\nReusable patterns discovered while working on this project.\n',
  [MEMORY_FILES.projectSummary]: '# Project Summary\n\nRun "CodeLoop AI: Scan Salesforce Project" to populate this file.\n',
  [MEMORY_FILES.actionHistory]: '# Action History\n\nApproved, rejected, and blocked agent actions.\n',
  [MEMORY_FILES.salesforceDecisions]: '# Salesforce Decisions\n\nArchitecture and design decisions made during agent tasks.\n'
};

/** Redact anything that looks like a secret before it reaches memory files. */
const SECRET_ASSIGNMENT = /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization|credential)s?\s*[:=]\s*['"]?[^\s'"]{4,}/gi;
const KNOWN_TOKEN_SHAPES = /\b(gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9\-._~+/]{16,}=*)\b/g;

export function redactSecrets(text: string): string {
  return text
    .replace(SECRET_ASSIGNMENT, match => `${match.split(/[:=]/)[0].trim()}: [REDACTED]`)
    .replace(KNOWN_TOKEN_SHAPES, '[REDACTED]');
}

/** Structured reflection saved after every task. */
export interface ReflectionEntry {
  goal: string;
  mode: string;
  filesRead: string[];
  actionsTaken: string[];
  finalResult: string;
  whatWorked: string;
  whatFailed: string;
  reusableLearning: string;
}

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

  /** Append a timestamped markdown section (redacted and size-capped). */
  async append(file: string, heading: string, body: string): Promise<void> {
    const stamp = new Date().toISOString();
    const safeBody = redactSecrets(truncate(body.trim(), MAX_ENTRY_CHARS));
    const safeHeading = redactSecrets(truncate(heading, 120));
    const entry = `\n## ${safeHeading} — ${stamp}\n\n${safeBody}\n`;
    await fs.appendFile(path.join(this.dir, file), entry, 'utf8');
  }

  /** Save the structured post-task reflection. */
  async saveStructuredReflection(entry: ReflectionEntry): Promise<void> {
    const body = [
      `- Task mode: ${entry.mode}`,
      `- Files read: ${entry.filesRead.length ? entry.filesRead.join(', ') : 'none'}`,
      `- Actions taken: ${entry.actionsTaken.length ? entry.actionsTaken.join('; ') : 'none'}`,
      `- Final result: ${truncate(entry.finalResult, 400)}`,
      `- What worked: ${truncate(entry.whatWorked, 300)}`,
      `- What failed: ${truncate(entry.whatFailed, 300)}`,
      `- Reusable learning: ${truncate(entry.reusableLearning, 300)}`
    ].join('\n');
    await this.append(MEMORY_FILES.reflections, `Goal: ${truncate(entry.goal, 80)}`, body);
  }

  /** Save a Salesforce architecture/design decision. */
  async saveSalesforceDecision(goal: string, mode: string, decision: string): Promise<void> {
    const body = [`- Task mode: ${mode}`, `- Decision: ${truncate(decision, 800)}`].join('\n');
    await this.append(MEMORY_FILES.salesforceDecisions, `Goal: ${truncate(goal, 80)}`, body);
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
