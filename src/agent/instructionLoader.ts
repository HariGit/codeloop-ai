import * as fs from 'fs/promises';
import * as path from 'path';
import { LoadedSkill, SalesforceContext, SalesforceContextOptions } from '../types/agentTypes';

/**
 * Loads Salesforce instruction files from .codeloop/ at the workspace root:
 *   .codeloop/instructions/salesforce-instructions.md  (global standards)
 *   .codeloop/agents/<name>.agent.md                   (role definitions)
 *   .codeloop/prompts/<name>.prompt.md                 (reusable prompt templates)
 *   .codeloop/skills/<name>.md                         (best-practice references)
 *
 * Missing files never crash the caller — they load as empty content.
 */

const CODELOOP_DIR = '.codeloop';
const GLOBAL_INSTRUCTIONS_FILE = 'salesforce-instructions.md';

/**
 * Sanitize a user/model-supplied file name: strip directories and disallow
 * path traversal, then ensure the expected suffix.
 */
function normalizeName(name: string, suffix: string): string {
  const base = path.basename(name.trim());
  if (!base || base === '.' || base === '..') {
    return '';
  }
  return base.endsWith(suffix) ? base : `${base}${suffix}`;
}

/** Read a file; return '' when missing or unreadable (never throws). */
async function readIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      // Unexpected error (permissions, encoding): report to console, still don't crash.
      console.warn(`CodeLoop AI: could not read ${filePath}: ${(err as Error).message}`);
    }
    return '';
  }
}

/** Load .codeloop/instructions/salesforce-instructions.md ('' if absent). */
export async function loadGlobalInstructions(workspaceRoot: string): Promise<string> {
  return readIfExists(path.join(workspaceRoot, CODELOOP_DIR, 'instructions', GLOBAL_INSTRUCTIONS_FILE));
}

/** Load .codeloop/agents/<agentName>.agent.md ('' if absent). Suffix optional. */
export async function loadAgentInstruction(workspaceRoot: string, agentName: string): Promise<string> {
  const file = normalizeName(agentName, '.agent.md');
  if (!file) {
    return '';
  }
  return readIfExists(path.join(workspaceRoot, CODELOOP_DIR, 'agents', file));
}

/** Load .codeloop/prompts/<promptName>.prompt.md ('' if absent). Suffix optional. */
export async function loadPromptTemplate(workspaceRoot: string, promptName: string): Promise<string> {
  const file = normalizeName(promptName, '.prompt.md');
  if (!file) {
    return '';
  }
  return readIfExists(path.join(workspaceRoot, CODELOOP_DIR, 'prompts', file));
}

/** Load .codeloop/skills/<name>.md for each name; missing skills are skipped. */
export async function loadSkillFiles(workspaceRoot: string, skillNames: string[]): Promise<LoadedSkill[]> {
  const loaded: LoadedSkill[] = [];
  for (const name of skillNames ?? []) {
    const file = normalizeName(name, '.md');
    if (!file) {
      continue;
    }
    const content = await readIfExists(path.join(workspaceRoot, CODELOOP_DIR, 'skills', file));
    if (content.trim()) {
      loaded.push({ name: file.replace(/\.md$/, ''), content });
    }
  }
  return loaded;
}

/**
 * Load and combine global instructions, the selected agent, prompt template,
 * and skills into one prompt-ready context block.
 */
export async function loadAllSalesforceContext(
  workspaceRoot: string,
  options: SalesforceContextOptions = {}
): Promise<SalesforceContext> {
  const [globalInstructions, agentInstruction, promptTemplate, skills] = await Promise.all([
    loadGlobalInstructions(workspaceRoot),
    options.agentName ? loadAgentInstruction(workspaceRoot, options.agentName) : Promise.resolve(''),
    options.promptName ? loadPromptTemplate(workspaceRoot, options.promptName) : Promise.resolve(''),
    loadSkillFiles(workspaceRoot, options.skillNames ?? [])
  ]);

  const sections: string[] = [];
  if (globalInstructions.trim()) {
    sections.push(`## PROJECT INSTRUCTIONS (.codeloop/instructions)\n\n${globalInstructions.trim()}`);
  }
  if (agentInstruction.trim()) {
    sections.push(`## AGENT ROLE (.codeloop/agents/${options.agentName})\n\n${agentInstruction.trim()}`);
  }
  if (promptTemplate.trim()) {
    sections.push(`## PROMPT TEMPLATE (.codeloop/prompts/${options.promptName})\n\n${promptTemplate.trim()}`);
  }
  for (const skill of skills) {
    sections.push(`## SKILL: ${skill.name} (.codeloop/skills)\n\n${skill.content.trim()}`);
  }

  return {
    globalInstructions,
    agentInstruction,
    promptTemplate,
    skills,
    combined: sections.join('\n\n---\n\n')
  };
}
