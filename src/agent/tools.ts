import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { ActionResult } from '../types/agentTypes';

const MAX_FILE_CHARS = 50000;
const MAX_CMD_OUTPUT_CHARS = 12000;
const MAX_SEARCH_RESULTS = 25;
const COMMAND_TIMEOUT_MS = 60000;

const SF_BASE = path.join('force-app', 'main', 'default');

/** Noisy folders excluded from every search. */
const SEARCH_EXCLUDE =
  '{**/.sf/**,**/.sfdx/**,**/.git/**,**/node_modules/**,**/out/**,**/dist/**,**/.agent-memory/**}';

/** Salesforce metadata types first, plus common general extensions. */
const SEARCH_INCLUDE = '**/*.{cls,trigger,page,component,xml,js,html,css,apex,cmp,ts,json,md}';

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

// ---------------------------------------------------------------------------
// search_code — Salesforce-aware literal search
// ---------------------------------------------------------------------------

/** Salesforce metadata ranks first so its matches surface before generic files. */
function extensionRank(fileName: string): number {
  if (fileName.endsWith('.cls')) return 0;
  if (fileName.endsWith('.trigger')) return 1;
  if (fileName.endsWith('.page')) return 2;
  if (fileName.endsWith('.component')) return 3;
  if (
    fileName.endsWith('.flow-meta.xml') ||
    fileName.endsWith('.labels-meta.xml') ||
    fileName.endsWith('.object-meta.xml') ||
    fileName.endsWith('.permissionset-meta.xml')
  ) {
    return 4;
  }
  if (fileName.endsWith('.xml')) return 5;
  if (fileName.endsWith('.js')) return 6;
  if (fileName.endsWith('.html')) return 7;
  if (fileName.endsWith('.css')) return 8;
  return 9;
}

/** True when the query looks like an Apex class / component name. */
function isApexIdentifier(query: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{1,79}$/.test(query);
}

/**
 * search_code — allowed automatically.
 * For identifier queries: exact class file, test classes, Visualforce pages
 * using it as controller, matching LWC folder, and matching Flow first —
 * then literal references across the project (Salesforce types prioritized).
 */
export async function searchCode(workspaceRoot: string, query: string): Promise<ActionResult> {
  const q = query.trim();
  if (!q) {
    return { success: false, observation: 'Empty search query.' };
  }

  const results: string[] = [];

  // -- Salesforce shortcuts for identifier-style queries --------------------
  if (isApexIdentifier(q)) {
    const classesRel = `${SF_BASE.split(path.sep).join('/')}/classes`;
    const classesDir = path.join(workspaceRoot, SF_BASE, 'classes');

    // 1. Exact class file first.
    if (await fileExists(path.join(classesDir, `${q}.cls`))) {
      results.push(`[exact class] ${classesRel}/${q}.cls`);
    }

    // 2. Related test classes (<Name>Test, <Name>_Test).
    for (const testName of [`${q}Test.cls`, `${q}_Test.cls`]) {
      if (await fileExists(path.join(classesDir, testName))) {
        results.push(`[test class] ${classesRel}/${testName}`);
      }
    }

    // 3. Visualforce pages using this class as controller.
    const pagesDir = path.join(workspaceRoot, SF_BASE, 'pages');
    const controllerPattern = new RegExp(`controller\\s*=\\s*"${q}"`, 'i');
    for (const page of await listFilesSafe(pagesDir, '.page')) {
      const content = await readSafe(path.join(pagesDir, page));
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (controllerPattern.test(lines[i])) {
          results.push(`[vf page] ${SF_BASE.split(path.sep).join('/')}/pages/${page}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          break;
        }
      }
    }

    // 4. LWC component folder with a matching name.
    const lwcDir = path.join(workspaceRoot, SF_BASE, 'lwc');
    for (const dirName of await listDirsSafe(lwcDir)) {
      if (dirName.toLowerCase() === q.toLowerCase()) {
        results.push(`[lwc component] ${SF_BASE.split(path.sep).join('/')}/lwc/${dirName}/`);
      }
    }

    // 5. Flow metadata with a matching name.
    const flowsDir = path.join(workspaceRoot, SF_BASE, 'flows');
    for (const flowFile of await listFilesSafe(flowsDir, '.flow-meta.xml')) {
      if (flowFile.toLowerCase().startsWith(q.toLowerCase())) {
        results.push(`[flow] ${SF_BASE.split(path.sep).join('/')}/flows/${flowFile}`);
      }
    }
  }

  // -- General literal reference search, Salesforce types first -------------
  const files = await vscode.workspace.findFiles(SEARCH_INCLUDE, SEARCH_EXCLUDE, 3000);
  const sortedPaths = files
    .map(f => f.fsPath)
    .filter(p => path.basename(p) !== 'maxRevision.json') // never return .sf maxRevision.json
    .sort((a, b) => extensionRank(a) - extensionRank(b) || a.localeCompare(b));

  const needle = q.toLowerCase();
  for (const fsPath of sortedPaths) {
    if (results.length >= MAX_SEARCH_RESULTS) {
      break;
    }
    const text = await readSafe(fsPath);
    if (!text) {
      continue;
    }
    const lines = text.split('\n');
    const rel = path.relative(workspaceRoot, fsPath).split(path.sep).join('/');
    for (let i = 0; i < lines.length && results.length < MAX_SEARCH_RESULTS; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        const entry = `${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`;
        // Skip duplicates already reported by the Salesforce shortcuts.
        if (!results.some(r => r.includes(`${rel}:${i + 1}:`))) {
          results.push(entry);
        }
      }
    }
  }

  if (results.length === 0) {
    return { success: true, observation: `No matches found for "${q}".` };
  }
  return {
    success: true,
    observation: `Found ${results.length} result(s) for "${q}" (max ${MAX_SEARCH_RESULTS}):\n${results.join('\n')}`
  };
}

// ---------------------------------------------------------------------------
// write_file / run_command
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// FS helpers (never throw)
// ---------------------------------------------------------------------------

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listFilesSafe(dir: string, suffix: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isFile() && e.name.endsWith(suffix)).map(e => e.name);
  } catch {
    return [];
  }
}

async function listDirsSafe(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

async function readSafe(p: string): Promise<string> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return '';
  }
}

// The Salesforce project scanner lives in salesforceScanner.ts.
