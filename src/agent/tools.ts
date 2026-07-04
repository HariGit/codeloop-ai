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
const RANGE_PREVIEW_LINES = 20;

const SF_BASE = path.join('force-app', 'main', 'default');

/** Noisy folders excluded from every search. */
const SEARCH_EXCLUDE =
  '{**/.sf/**,**/.sfdx/**,**/.git/**,**/node_modules/**,**/out/**,**/dist/**,**/.agent-memory/**,**/staticresources/**}';

/** Files larger than this are skipped by search (minified bundles etc.). */
const SEARCH_MAX_FILE_BYTES = 256 * 1024;
/** How many files search reads concurrently. */
const SEARCH_CONCURRENCY = 24;

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

// ---------------------------------------------------------------------------
// read_file safety — sensitive files can never be read (or edited)
// ---------------------------------------------------------------------------

/** Salesforce/code sources exempt from the credentials-keyword filename check
 *  (e.g. AuthTokenService.cls must stay readable for reviews). */
const SOURCE_EXT = /\.(cls|trigger|page|component)$/i;

const PROTECTED_DIRS = ['.sf', '.sfdx', '.git', 'node_modules'];

/** Check whether a path may be read. Blocked paths never expose contents. */
export function isBlockedReadPath(relPath: string): { blocked: boolean; reason: string } {
  const norm = relPath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const base = norm.split('/').pop() ?? '';

  // .env and .env.* anywhere
  if (base === '.env' || base.startsWith('.env.')) {
    return { blocked: true, reason: 'environment file (.env)' };
  }
  // Key material anywhere
  if (/\.(pem|key|p12|jks|pfx)$/.test(base)) {
    return { blocked: true, reason: 'private key / certificate file' };
  }
  // Protected folders anywhere in the path
  for (const dir of PROTECTED_DIRS) {
    if (norm === dir || norm.startsWith(`${dir}/`) || norm.includes(`/${dir}/`)) {
      return { blocked: true, reason: `protected folder (${dir})` };
    }
  }
  // Credential-suggesting filenames (source code files exempt)
  if (!SOURCE_EXT.test(base) && /(password|secret|token|credential)/.test(base)) {
    return { blocked: true, reason: 'filename suggests credentials' };
  }
  return { blocked: false, reason: '' };
}

/** read_file — allowed automatically, except for sensitive paths. */
export async function readFile(workspaceRoot: string, relPath: string): Promise<ActionResult> {
  const check = isBlockedReadPath(relPath);
  if (check.blocked) {
    await logAction(workspaceRoot, 'read_file', relPath, 'BLOCKED', check.reason);
    return {
      success: false,
      observation: `Read BLOCKED for "${relPath}" (${check.reason}). This file may contain secrets and can never be read by the agent. Do not try again.`
    };
  }
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

/** Convert an LWC kebab-case tag (c-la-home) to its folder name (laHome). */
export function lwcTagToCamel(tag: string): string | undefined {
  const m = tag.trim().match(/^c-([a-z0-9]+(?:-[a-z0-9]+)*)$/i);
  if (!m) {
    return undefined;
  }
  return m[1].toLowerCase().replace(/-([a-z0-9])/g, (_s, ch: string) => ch.toUpperCase());
}

/**
 * search_code — allowed automatically.
 * For identifier queries: exact class file, test classes, Visualforce pages
 * using it as controller, matching LWC folder, and matching Flow first —
 * then literal references across the project (Salesforce types prioritized).
 */
export async function searchCode(workspaceRoot: string, query: string): Promise<ActionResult> {
  let q = query.trim();
  if (!q) {
    return { success: false, observation: 'Empty search query.' };
  }

  // LWC tags like "c-la-case-creation-flow" live on disk as camelCase
  // folders (laCaseCreationFlow) — translate before searching.
  let interpretedNote = '';
  const camel = lwcTagToCamel(q);
  if (camel) {
    interpretedNote = `Interpreted LWC tag "${q}" as component "${camel}".\n`;
    q = camel;
  }

  const results: string[] = [];

  // -- Salesforce shortcuts for identifier-style queries --------------------
  if (isApexIdentifier(q)) {
    const sfBaseRel = SF_BASE.split(path.sep).join('/');
    const classesDir = path.join(workspaceRoot, SF_BASE, 'classes');

    // 1. Exact class file first.
    if (await fileExists(path.join(classesDir, `${q}.cls`))) {
      results.push(`[exact class] ${sfBaseRel}/classes/${q}.cls`);
    }

    // 2. Related test classes (<Name>Test, <Name>_Test).
    for (const testName of [`${q}Test.cls`, `${q}_Test.cls`]) {
      if (await fileExists(path.join(classesDir, testName))) {
        results.push(`[test class] ${sfBaseRel}/classes/${testName}`);
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
          results.push(`[vf page] ${sfBaseRel}/pages/${page}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          break;
        }
      }
    }

    // 4. LWC component folder with a matching name (bundle files listed).
    const lwcDir = path.join(workspaceRoot, SF_BASE, 'lwc');
    for (const dirName of await listDirsSafe(lwcDir)) {
      if (dirName.toLowerCase() === q.toLowerCase()) {
        const bundle = (await listFilesSafe(path.join(lwcDir, dirName), '')).join(', ');
        results.push(`[lwc component] ${sfBaseRel}/lwc/${dirName}/${bundle ? ` (files: ${bundle})` : ''}`);
      }
    }

    // 5. Flow metadata with a matching name.
    const flowsDir = path.join(workspaceRoot, SF_BASE, 'flows');
    for (const flowFile of await listFilesSafe(flowsDir, '.flow-meta.xml')) {
      if (flowFile.toLowerCase().startsWith(q.toLowerCase())) {
        results.push(`[flow] ${sfBaseRel}/flows/${flowFile}`);
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
  const started = Date.now();
  // Read in parallel batches; skip oversized files (minified bundles).
  for (let b = 0; b < sortedPaths.length && results.length < MAX_SEARCH_RESULTS; b += SEARCH_CONCURRENCY) {
    const batch = sortedPaths.slice(b, b + SEARCH_CONCURRENCY);
    const texts = await Promise.all(
      batch.map(async fsPath => {
        try {
          const stat = await fs.stat(fsPath);
          if (stat.size > SEARCH_MAX_FILE_BYTES) {
            return { fsPath, text: '' };
          }
        } catch {
          return { fsPath, text: '' };
        }
        return { fsPath, text: await readSafe(fsPath) };
      })
    );
    for (const { fsPath, text } of texts) {
      if (!text || results.length >= MAX_SEARCH_RESULTS) {
        continue;
      }
      if (!text.toLowerCase().includes(needle)) {
        continue; // fast reject before line splitting
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
  }
  const elapsedNote = ` [searched ${Math.min(sortedPaths.length, 3000)} files in ${((Date.now() - started) / 1000).toFixed(1)}s]`;

  if (results.length === 0) {
    return { success: true, observation: `${interpretedNote}No matches found for "${q}".${elapsedNote}` };
  }
  return {
    success: true,
    observation: `${interpretedNote}Found ${results.length} result(s) for "${q}" (max ${MAX_SEARCH_RESULTS}):\n${results.join('\n')}${elapsedNote}`
  };
}

// ---------------------------------------------------------------------------
// File editing tools — create_file / replace_file / replace_range / apply_patch
// All require user approval; sensitive paths are blocked for editing too.
// ---------------------------------------------------------------------------

async function askApproval(message: string, detail: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, 'Approve', 'Reject');
  return choice === 'Approve';
}

/** Shared pre-checks for all editing tools. Returns the full path or a failure. */
async function editPrecheck(
  workspaceRoot: string,
  tool: string,
  relPath: string
): Promise<{ full?: string; fail?: ActionResult }> {
  const check = isBlockedReadPath(relPath);
  if (check.blocked) {
    await logAction(workspaceRoot, tool, relPath, 'BLOCKED', check.reason);
    return {
      fail: {
        success: false,
        observation: `Edit BLOCKED for "${relPath}" (${check.reason}). This file can never be modified by the agent.`
      }
    };
  }
  try {
    return { full: resolveSafe(workspaceRoot, relPath) };
  } catch (err) {
    return { fail: { success: false, observation: (err as Error).message } };
  }
}

/** create_file — creates a NEW file only; fails if the file exists. */
export async function createFile(
  workspaceRoot: string,
  relPath: string,
  content: string,
  reason = ''
): Promise<ActionResult> {
  const pre = await editPrecheck(workspaceRoot, 'create_file', relPath);
  if (pre.fail) return pre.fail;
  const full = pre.full!;

  if (await fileExists(full)) {
    return {
      success: false,
      observation: `create_file failed: "${relPath}" already exists. Use replace_range or apply_patch to modify it.`
    };
  }

  const preview = content.slice(0, PREVIEW_CHARS) + (content.length > PREVIEW_CHARS ? '\n…(truncated)' : '');
  const detail = [
    `File: ${relPath}`,
    `Reason: ${reason || '(no reason provided)'}`,
    `Change: create NEW file (${content.length} chars)`,
    '',
    'Preview:',
    preview
  ].join('\n');

  if (!(await askApproval('CodeLoop AI wants to create a new file. Approve?', detail))) {
    await logAction(workspaceRoot, 'create_file', relPath, 'REJECTED', reason);
    return { success: false, observation: `User rejected creating ${relPath}.` };
  }

  try {
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
    await logAction(workspaceRoot, 'create_file', relPath, 'APPROVED', `created ${content.length} chars`);
    return { success: true, observation: `Created ${relPath} (${content.length} chars).` };
  } catch (err) {
    return { success: false, observation: `Failed to create ${relPath}: ${(err as Error).message}` };
  }
}

/** replace_file — full overwrite; HIGH risk approval. Creates the file if missing (legacy behavior). */
export async function replaceFile(
  workspaceRoot: string,
  relPath: string,
  content: string,
  reason = ''
): Promise<ActionResult> {
  const pre = await editPrecheck(workspaceRoot, 'replace_file', relPath);
  if (pre.fail) return pre.fail;
  const full = pre.full!;

  const exists = await fileExists(full);
  const oldSize = exists ? (await readSafe(full)).length : 0;
  const preview = content.slice(0, PREVIEW_CHARS) + (content.length > PREVIEW_CHARS ? '\n…(truncated)' : '');
  const detail = [
    `File: ${relPath}`,
    `Reason: ${reason || '(no reason provided)'}`,
    `Change: ${exists ? `FULL OVERWRITE (HIGH risk) — replaces ${oldSize} chars with ${content.length} chars` : `create new file (${content.length} chars)`}`,
    exists ? 'Consider replace_range or apply_patch for targeted edits.' : '',
    '',
    'Preview of new content:',
    preview
  ].filter(Boolean).join('\n');

  if (!(await askApproval(`CodeLoop AI wants to ${exists ? 'OVERWRITE a full file (HIGH risk)' : 'create a file'}. Approve?`, detail))) {
    await logAction(workspaceRoot, 'replace_file', relPath, 'REJECTED', reason);
    return { success: false, observation: `User rejected overwriting ${relPath}.` };
  }

  try {
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
    await logAction(workspaceRoot, 'replace_file', relPath, 'APPROVED', `wrote ${content.length} chars (was ${oldSize})`);
    return { success: true, observation: `Wrote ${content.length} chars to ${relPath}.` };
  } catch (err) {
    return { success: false, observation: `Failed to write ${relPath}: ${(err as Error).message}` };
  }
}

/** write_file — legacy alias, maps to replace_file. */
export async function writeFile(
  workspaceRoot: string,
  relPath: string,
  content: string,
  reason = ''
): Promise<ActionResult> {
  return replaceFile(workspaceRoot, relPath, content, reason);
}

/** replace_range — replaces lines startLine..endLine (1-based, inclusive) with new content. */
export async function replaceRange(
  workspaceRoot: string,
  relPath: string,
  startLine: number,
  endLine: number,
  newContent: string,
  reason = ''
): Promise<ActionResult> {
  const pre = await editPrecheck(workspaceRoot, 'replace_range', relPath);
  if (pre.fail) return pre.fail;
  const full = pre.full!;

  if (!(await fileExists(full))) {
    return { success: false, observation: `replace_range failed: "${relPath}" does not exist. Use create_file for new files.` };
  }
  const original = await readSafe(full);
  const lines = original.split('\n');
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length) {
    return {
      success: false,
      observation: `replace_range failed: invalid range ${startLine}-${endLine} (file has ${lines.length} lines).`
    };
  }

  const before = lines.slice(startLine - 1, endLine);
  const afterLines = newContent.split('\n');
  const clip = (arr: string[]) =>
    arr.slice(0, RANGE_PREVIEW_LINES).join('\n') + (arr.length > RANGE_PREVIEW_LINES ? `\n…(${arr.length - RANGE_PREVIEW_LINES} more lines)` : '');

  const detail = [
    `File: ${relPath}`,
    `Reason: ${reason || '(no reason provided)'}`,
    `Change: replace lines ${startLine}-${endLine} (${before.length} line(s) → ${afterLines.length} line(s))`,
    '',
    'BEFORE:',
    clip(before),
    '',
    'AFTER:',
    clip(afterLines)
  ].join('\n');

  if (!(await askApproval('CodeLoop AI wants to edit a line range. Approve?', detail))) {
    await logAction(workspaceRoot, 'replace_range', `${relPath}:${startLine}-${endLine}`, 'REJECTED', reason);
    return { success: false, observation: `User rejected editing ${relPath} lines ${startLine}-${endLine}.` };
  }

  try {
    const updated = [...lines.slice(0, startLine - 1), ...afterLines, ...lines.slice(endLine)].join('\n');
    await fs.writeFile(full, updated, 'utf8');
    await logAction(workspaceRoot, 'replace_range', `${relPath}:${startLine}-${endLine}`, 'APPROVED', `${before.length} → ${afterLines.length} lines`);
    return {
      success: true,
      observation: `Replaced lines ${startLine}-${endLine} in ${relPath} (file was ${lines.length} lines, now ${lines.length - before.length + afterLines.length}).`
    };
  } catch (err) {
    return { success: false, observation: `Failed to edit ${relPath}: ${(err as Error).message}` };
  }
}

/** Apply a unified diff to text. Strict context matching; clear errors. */
export function applyUnifiedPatch(original: string, patch: string): { ok: boolean; result?: string; error?: string } {
  const origLines = original.split('\n');
  const patchLines = patch.split('\n');
  const out: string[] = [];
  let origIdx = 0;
  let i = 0;
  let sawHunk = false;

  while (i < patchLines.length) {
    const line = patchLines[i];
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('index ')) {
      i++;
      continue;
    }
    const m = line.match(/^@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@@/);
    if (!m) {
      i++;
      continue;
    }
    sawHunk = true;
    const hunkStart = parseInt(m[1], 10) - 1; // 0-based index of first old line
    if (hunkStart < origIdx) {
      return { ok: false, error: 'overlapping or out-of-order hunks' };
    }
    while (origIdx < hunkStart) {
      if (origIdx >= origLines.length) {
        return { ok: false, error: `hunk starts beyond end of file (line ${hunkStart + 1}, file has ${origLines.length} lines)` };
      }
      out.push(origLines[origIdx++]);
    }
    // Consume exactly the line counts the hunk header declares.
    let oldRemaining = m[2] !== undefined ? parseInt(m[2], 10) : 1;
    let newRemaining = m[4] !== undefined ? parseInt(m[4], 10) : 1;
    i++;
    while (i < patchLines.length && (oldRemaining > 0 || newRemaining > 0)) {
      const pl = patchLines[i];
      if (pl.startsWith('-')) {
        if (origLines[origIdx] !== pl.slice(1)) {
          return { ok: false, error: `context mismatch at line ${origIdx + 1}: patch expects "${(pl.slice(1)).slice(0, 80)}" but file has "${(origLines[origIdx] ?? '(end of file)').slice(0, 80)}"` };
        }
        origIdx++;
        oldRemaining--;
      } else if (pl.startsWith('+')) {
        out.push(pl.slice(1));
        newRemaining--;
      } else if (pl.startsWith('\\')) {
        // "\ No newline at end of file" — ignore.
      } else {
        // Context line (leading space; empty line = empty context line).
        const ctx = pl.startsWith(' ') ? pl.slice(1) : pl;
        if (origLines[origIdx] !== ctx) {
          return { ok: false, error: `context mismatch at line ${origIdx + 1}: patch expects "${ctx.slice(0, 80)}" but file has "${(origLines[origIdx] ?? '(end of file)').slice(0, 80)}"` };
        }
        out.push(origLines[origIdx++]);
        oldRemaining--;
        newRemaining--;
      }
      i++;
    }
  }

  if (!sawHunk) {
    return { ok: false, error: 'no @@ hunks found — provide a unified diff' };
  }
  while (origIdx < origLines.length) {
    out.push(origLines[origIdx++]);
  }
  return { ok: true, result: out.join('\n') };
}

/** apply_patch — applies a unified diff to an existing file. */
export async function applyPatch(
  workspaceRoot: string,
  relPath: string,
  patch: string,
  reason = ''
): Promise<ActionResult> {
  const pre = await editPrecheck(workspaceRoot, 'apply_patch', relPath);
  if (pre.fail) return pre.fail;
  const full = pre.full!;

  if (!(await fileExists(full))) {
    return { success: false, observation: `apply_patch failed: "${relPath}" does not exist. Use create_file for new files.` };
  }
  const original = await readSafe(full);
  const applied = applyUnifiedPatch(original, patch);
  if (!applied.ok) {
    return { success: false, observation: `apply_patch failed for ${relPath}: ${applied.error}` };
  }

  const patchPreview = patch.slice(0, 1200) + (patch.length > 1200 ? '\n…(truncated)' : '');
  const detail = [
    `File: ${relPath}`,
    `Reason: ${reason || '(no reason provided)'}`,
    `Change: apply unified diff (${original.length} chars → ${applied.result!.length} chars)`,
    '',
    'Patch:',
    patchPreview
  ].join('\n');

  if (!(await askApproval('CodeLoop AI wants to apply a patch. Approve?', detail))) {
    await logAction(workspaceRoot, 'apply_patch', relPath, 'REJECTED', reason);
    return { success: false, observation: `User rejected patching ${relPath}.` };
  }

  try {
    await fs.writeFile(full, applied.result!, 'utf8');
    await logAction(workspaceRoot, 'apply_patch', relPath, 'APPROVED', `${original.length} → ${applied.result!.length} chars`);
    return { success: true, observation: `Applied patch to ${relPath} (${original.length} → ${applied.result!.length} chars).` };
  } catch (err) {
    return { success: false, observation: `Failed to patch ${relPath}: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// run_command — approval with command, reason, and risk level
// ---------------------------------------------------------------------------

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

  if (!(await askApproval(`CodeLoop AI wants to run a ${risk.level} risk command. Approve?`, detail))) {
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
