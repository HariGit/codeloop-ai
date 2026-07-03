import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { ActionResult } from '../types/agentTypes';

const MAX_FILE_CHARS = 50000;
const MAX_CMD_OUTPUT_CHARS = 12000;
const MAX_SEARCH_RESULTS = 25;
const COMMAND_TIMEOUT_MS = 60000;
const PREVIEW_CHARS = 400;

const SF_BASE = path.join('force-app', 'main', 'default');

/** Noisy folders excluded from every search. */
const SEARCH_EXCLUDE =
  '{**/.sf/**,**/.sfdx/**,**/.git/**,**/node_modules/**,**/out/**,**/dist/**,**/.agent-memory/**}';

/** Salesforce metadata types first, plus common general extensions. */
const SEARCH_INCLUDE = '**/*.{cls,trigger,page,component,xml,js,html,css,apex,cmp,ts,json,md}';

// ---------------------------------------------------------------------------
// Command risk assessment
// ---------------------------------------------------------------------------

export interface CommandRisk {
  level: 'LOW' | 'MEDIUM' | 'HIGH';
  blocked: boolean;
  note: string;
}

/** Always blocked — never executed, regardless of approval. */
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; note: string }> = [
  { pattern: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, note: 'recursive force delete (rm -rf)' },
  { pattern: /\bdel\s+\/s\b/i, note: 'recursive delete (del /s)' },
  { pattern: /^\s*format\b|\bformat\s+[a-z]:/i, note: 'disk format' },
  { pattern: /\bmkfs\b/i, note: 'filesystem format' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, note: 'git reset --hard discards uncommitted work' },
  { pattern: /\bgit\s+clean\b[^&|;]*-[a-z]*f/i, note: 'git clean -f deletes untracked files' },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/i, note: 'remote script piped to shell' },
  { pattern: /\biwr\b[^|]*\|\s*iex\b/i, note: 'remote script piped to shell' },
  { pattern: /\bnpm\s+install\b[^\n]*(https?:\/\/|git\+|git:\/\/|\.tgz)/i, note: 'npm install from unknown remote source' }
];

/** High risk — approval dialog highlights these; Salesforce deploys always land here. */
const HIGH_RISK_PATTERNS: Array<{ pattern: RegExp; note: string }> = [
  { pattern: /\bsfdx\s+force:source:deploy\b/i, note: 'Salesforce deployment — verify target org' },
  { pattern: /\bsfdx\s+force:mdapi:deploy\b/i, note: 'Salesforce deployment — verify target org' },
  { pattern: /\bsf\s+project\s+deploy\b/i, note: 'Salesforce deployment — verify target org' },
  { pattern: /\bsf\s+org\s+(delete|create)\b/i, note: 'org lifecycle command' },
  { pattern: /\bsf\s+data\s+(delete|update|create|import)\b/i, note: 'modifies org data' },
  { pattern: /\bnpm\s+install\b/i, note: 'installs packages' },
  { pattern: /\bgit\s+push\b/i, note: 'pushes to remote' }
];

const LOW_RISK_PATTERN =
  /^\s*(ls|dir|cat|type|head|tail|grep|findstr|pwd|echo|git\s+(status|log|diff|branch|show)|sf\s+org\s+list|sf\s+org\s+display|sfdx\s+force:org:list)\b/i;

/** Classify a command: blocked / HIGH / MEDIUM / LOW. */
export function assessCommandRisk(command: string): CommandRisk {
  for (const b of BLOCKED_PATTERNS) {
    if (b.pattern.test(command)) {
      return { level: 'HIGH', blocked: true, note: b.note };
    }
  }
  for (const h of HIGH_RISK_PATTERNS) {
    if (h.pattern.test(command)) {
      return { level: 'HIGH', blocked: false, note: h.note };
    }
  }
  if (LOW_RISK_PATTERN.test(command)) {
    return { level: 'LOW', blocked: false, note: 'read-only command' };
  }
  return { level: 'MEDIUM', blocked: false, note: '' };
}

// ---------------------------------------------------------------------------
// Action history log (.agent-memory/action-history.md)
// ---------------------------------------------------------------------------

async function logAction(
  workspaceRoot: string,
  tool: string,
  target: string,
  decision: 'APPROVED' | 'REJECTED' | 'BLOCKED',
  extra = ''
): Promise<void> {
  try {
    const dir = path.join(workspaceRoot, '.agent-memory');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'action-history.md');
    if (!(await fileExists(file))) {
      await fs.writeFile(file, '# Action History\n\nApproved, rejected, and blocked agent actions.\n\n', 'utf8');
    }
    const cleanTarget = target.replace(/\s+/g, ' ').slice(0, 160);
    const line = `- ${new Date().toISOString()} | ${tool} | ${cleanTarget} | ${decision}${extra ? ` | ${extra}` : ''}\n`;
    await fs.appendFile(file, line, 'utf8');
  } catch {
    // Logging must never break the tool itself.
  }
}

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

// write_file — approval with path, reason, and preview

export async function writeFile(
  workspaceRoot: string,
  relPath: string,
  content: string,
  reason = ''
): Promise<ActionResult> {
  let full: string;
  try {
    full = resolveSafe(workspaceRoot, relPath);
  } catch (err) {
    return { success: false, observation: (err as Error).message };
  }

  const exists = await fileExists(full);
  const preview = content.slice(0, PREVIEW_CHARS) + (content.length > PREVIEW_CHARS ? '\n…(truncated)' : '');
  const detail = [
    `File: ${relPath}`,
    `Reason: ${reason || '(no reason provided)'}`,
    `Change: ${exists ? 'OVERWRITE existing file' : 'create new file'} (${content.length} chars)`,
    '',
    'Preview:',
    preview
  ].join('\n');

  const choice = await vscode.window.showWarningMessage(
    `CodeLoop AI wants to ${exists ? 'overwrite' : 'create'} a file. Approve?`,
    { modal: true, detail },
    'Approve',
    'Reject'
  );
  if (choice !== 'Approve') {
    await logAction(workspaceRoot, 'write_file', relPath, 'REJECTED', reason);
    return { success: false, observation: `User rejected writing to ${relPath}.` };
  }

  try {
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
    await logAction(workspaceRoot, 'write_file', relPath, 'APPROVED', `wrote ${content.length} chars`);
    return { success: true, observation: `Wrote ${content.length} chars to ${relPath}.` };
  } catch (err) {
    return { success: false, observation: `Failed to write ${relPath}: ${(err as Error).message}` };
  }
}

// run_command — approval with command, reason, and risk level

export async function runCommand(
  workspaceRoot: string,
  command: string,
  reason = ''
): Promise<ActionResult> {
  if (!command.trim()) {
    return { success: false, observation: 'Empty command.' };
  }

  const risk = assessCommandRisk(command);
  if (risk.blocked) {
    await logAction(workspaceRoot, 'run_command', command, 'BLOCKED', risk.note);
    return {
      success: false,
      observation: `Command BLOCKED by safety rules (${risk.note}): ${command}. This command can never be executed by the agent.`
    };
  }

  const detail = [
    `Command: ${command}`,
    `Reason: ${reason || '(no reason provided)'}`,
    `Risk level: ${risk.level}${risk.note ? ` — ${risk.note}` : ''}`
  ].join('\n');

  const choice = await vscode.window.showWarningMessage(
    `CodeLoop AI wants to run a ${risk.level} risk command. Approve?`,
    { modal: true, detail },
    'Approve',
    'Reject'
  );
  if (choice !== 'Approve') {
    await logAction(workspaceRoot, 'run_command', command, 'REJECTED', reason);
    return { success: false, observation: 'User rejected running the command.' };
  }
  await logAction(workspaceRoot, 'run_command', command, 'APPROVED', `risk ${risk.level}`);

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
