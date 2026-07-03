import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { ActionResult } from '../types/agentTypes';

const MAX_FILE_CHARS = 50000;
const MAX_CMD_OUTPUT_CHARS = 12000;
const MAX_SEARCH_RESULTS = 30;
const COMMAND_TIMEOUT_MS = 60000;

const DANGEROUS_COMMAND = /\b(rm\s+-rf|rmdir|del\s+\/|format\s|mkfs|curl[^|]*\|\s*(ba)?sh|wget[^|]*\|\s*(ba)?sh|iwr[^|]*\|\s*iex)\b/i;

/** Resolve a relative path and refuse anything outside the workspace. */
function resolveSafe(workspaceRoot: string, relPath: string): string {
  const full = path.resolve(workspaceRoot, relPath);
  const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep;
  if (full !== workspaceRoot && !full.startsWith(rootWithSep)) {
    throw new Error(`Path "${relPath}" is outside the workspace. Refusing.`);
  }
  return full;
}

/** read_file — allowed automatically. */
export async function readFile(workspaceRoot: string, relPath: string): Promise<ActionResult> {
  try {
    const full = resolveSafe(workspaceRoot, relPath);
    const content = await fs.readFile(full, 'utf8');
    const truncated = content.length > MAX_FILE_CHARS;
    return {
      success: true,
      observation:
        `Content of ${relPath}${truncated ? ` (first ${MAX_FILE_CHARS} chars)` : ''}:\n` +
        content.slice(0, MAX_FILE_CHARS)
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { success: false, observation: `File not found: ${relPath}` };
    }
    return { success: false, observation: `Could not read ${relPath}: ${(err as Error).message}` };
  }
}

/** search_code — allowed automatically. Simple text search across workspace files. */
export async function searchCode(workspaceRoot: string, query: string): Promise<ActionResult> {
  if (!query.trim()) {
    return { success: false, observation: 'Empty search query.' };
  }
  // Salesforce sources (.cls, .trigger, .page, .component, .xml incl. flow/labels
  // meta files, .js, .html, .css) plus common general extensions.
  const files = await vscode.workspace.findFiles(
    '**/*.{cls,trigger,page,component,xml,js,html,css,apex,cmp,ts,json,md,py,java}',
    '{**/.sf/**,**/.sfdx/**,**/node_modules/**,**/out/**,**/.git/**,**/.agent-memory/**}',
    2000
  );
  const needle = query.toLowerCase();
  const hits: string[] = [];

  for (const file of files) {
    if (hits.length >= MAX_SEARCH_RESULTS) {
      break;
    }
    try {
      const text = await fs.readFile(file.fsPath, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_RESULTS; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          const rel = path.relative(workspaceRoot, file.fsPath);
          hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
      }
    } catch {
      // Skip unreadable/binary files.
    }
  }

  if (hits.length === 0) {
    return { success: true, observation: `No matches found for "${query}".` };
  }
  return {
    success: true,
    observation: `Found ${hits.length} match(es) for "${query}":\n${hits.join('\n')}`
  };
}

/** write_file — requires user confirmation. */
export async function writeFile(workspaceRoot: string, relPath: string, content: string): Promise<ActionResult> {
  let full: string;
  try {
    full = resolveSafe(workspaceRoot, relPath);
  } catch (err) {
    return { success: false, observation: (err as Error).message };
  }

  let exists = true;
  try {
    await fs.access(full);
  } catch {
    exists = false;
  }

  const choice = await vscode.window.showWarningMessage(
    `CodeLoop AI wants to ${exists ? 'OVERWRITE' : 'create'} "${relPath}" (${content.length} chars). Allow?`,
    { modal: true },
    'Allow',
    'Deny'
  );
  if (choice !== 'Allow') {
    return { success: false, observation: `User denied writing to ${relPath}.` };
  }

  try {
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
    return { success: true, observation: `Wrote ${content.length} chars to ${relPath}.` };
  } catch (err) {
    return { success: false, observation: `Failed to write ${relPath}: ${(err as Error).message}` };
  }
}

/** run_command — requires user confirmation; blocks obviously dangerous commands. */
export async function runCommand(workspaceRoot: string, command: string): Promise<ActionResult> {
  if (!command.trim()) {
    return { success: false, observation: 'Empty command.' };
  }
  if (DANGEROUS_COMMAND.test(command)) {
    return {
      success: false,
      observation: `Command blocked by safety rules (destructive or remote-install pattern): ${command}`
    };
  }

  const choice = await vscode.window.showWarningMessage(
    `CodeLoop AI wants to run: ${command}`,
    { modal: true },
    'Allow',
    'Deny'
  );
  if (choice !== 'Allow') {
    return { success: false, observation: 'User denied running the command.' };
  }

  return new Promise<ActionResult>(resolve => {
    exec(
      command,
      { cwd: workspaceRoot, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const out = [stdout, stderr].filter(Boolean).join('\n').slice(0, MAX_CMD_OUTPUT_CHARS);
        if (error) {
          resolve({
            success: false,
            observation: `Command failed (${error.message}):\n${out || '(no output)'}`
          });
        } else {
          resolve({ success: true, observation: `Command succeeded:\n${out || '(no output)'}` });
        }
      }
    );
  });
}

// The Salesforce project scanner lives in salesforceScanner.ts.
