import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { ActionResult } from '../types/agentTypes';

const MAX_FILE_CHARS = 12000;
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
  const files = await vscode.workspace.findFiles(
    '**/*.{ts,js,json,md,cls,trigger,xml,html,css,apex,cmp,page,flow-meta.xml,labels-meta.xml,py,java}',
    '{**/node_modules/**,**/out/**,**/.git/**,**/.agent-memory/**}',
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
        const out = [stdout, stderr].filter(Boolean).join('\n').slice(0, MAX_FILE_CHARS);
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

// ---------------------------------------------------------------------------
// Salesforce project scanner
// ---------------------------------------------------------------------------

const SF_DIRS: Array<{ label: string; rel: string }> = [
  { label: 'Apex Classes', rel: 'force-app/main/default/classes' },
  { label: 'Triggers', rel: 'force-app/main/default/triggers' },
  { label: 'LWC Components', rel: 'force-app/main/default/lwc' },
  { label: 'Flows', rel: 'force-app/main/default/flows' },
  { label: 'Custom Labels', rel: 'force-app/main/default/labels' },
  { label: 'Custom Metadata', rel: 'force-app/main/default/customMetadata' },
  { label: 'Permission Sets', rel: 'force-app/main/default/permissionsets' }
];

/**
 * Scan standard Salesforce DX folders and write a summary to
 * .agent-memory/project-summary.md. Returns the summary text.
 */
export async function scanSalesforceProject(workspaceRoot: string): Promise<string> {
  const lines: string[] = [
    '# Project Summary (Salesforce Scan)',
    '',
    `Scanned: ${new Date().toISOString()}`,
    ''
  ];
  let foundAny = false;

  for (const dir of SF_DIRS) {
    const full = path.join(workspaceRoot, dir.rel);
    let entries: string[];
    try {
      entries = await fs.readdir(full);
    } catch {
      lines.push(`## ${dir.label}`, '', '_Folder not found._', '');
      continue;
    }
    foundAny = true;

    // Classes/triggers: list .cls/.trigger; LWC: list component folders; others: list files.
    const items = entries
      .filter(e => !e.endsWith('-meta.xml') || dir.rel.includes('flows') || dir.rel.includes('labels'))
      .sort();

    // Split Apex classes into test vs non-test for quick orientation.
    if (dir.rel.endsWith('classes')) {
      const cls = items.filter(i => i.endsWith('.cls'));
      const tests = cls.filter(i => /test/i.test(i));
      const nonTests = cls.filter(i => !/test/i.test(i));
      lines.push(`## ${dir.label} (${cls.length} total, ${tests.length} tests)`, '');
      lines.push('### Classes', '', ...nonTests.map(i => `- ${i}`), '');
      lines.push('### Test Classes', '', ...tests.map(i => `- ${i}`), '');
    } else {
      lines.push(`## ${dir.label} (${items.length})`, '', ...items.map(i => `- ${i}`), '');
    }
  }

  if (!foundAny) {
    lines.push('', '_No standard Salesforce DX folders found — this may not be a Salesforce project._');
  }

  const summary = lines.join('\n');
  const memoryDir = path.join(workspaceRoot, '.agent-memory');
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(path.join(memoryDir, 'project-summary.md'), summary, 'utf8');
  return summary;
}
