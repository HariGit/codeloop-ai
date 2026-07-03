import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Architecture analyzer for ARCHITECTURE_OVERVIEW mode.
 * Scans Salesforce metadata related to a scope (object, class, feature,
 * flow, or module name) and builds a structured component inventory that
 * is injected into the agent's first prompt. The LLM then reads the key
 * files and produces the architecture overview — it never has to guess
 * which components exist.
 */

const SF_BASE = path.join('force-app', 'main', 'default');
const MAX_FILES = 800;
const MAX_LIST = 25;
const MAX_EDGES = 40;

export interface ArchitectureContext {
  scope: string;
  report: string;
  matchedFiles: string[];
}

const STOPWORDS = new Set([
  'provide', 'architecture', 'overview', 'for', 'the', 'and', 'with', 'module',
  'feature', 'of', 'a', 'an', 'system', 'design', 'give', 'me', 'show', 'high',
  'low', 'level', 'detail', 'detailed'
]);

/** Pull the scope out of a goal like "Provide architecture overview for X." */
export function extractScope(goal: string): string {
  const m = goal.match(/\bfor\s+(.+?)\.?\s*$/i);
  const raw = (m ? m[1] : goal).trim();
  const tokens = raw.split(/[^A-Za-z0-9_]+/).filter(t => t.length >= 3 && !STOPWORDS.has(t.toLowerCase()));
  if (tokens.length === 0) {
    return raw.slice(0, 60);
  }
  // The longest identifier-like token is usually the most specific.
  return [...tokens].sort((a, b) => b.length - a.length)[0];
}

interface Matched {
  name: string;
  rel: string;
  kind: string;
  content: string;
}

/** Scan metadata related to the scope and build the inventory report. */
export async function analyzeArchitecture(workspaceRoot: string, goal: string): Promise<ArchitectureContext> {
  const base = path.join(workspaceRoot, SF_BASE);
  if (!(await exists(base))) {
    return { scope: '', report: '', matchedFiles: [] };
  }

  const scope = extractScope(goal);
  const tokens = goal
    .split(/[^A-Za-z0-9_]+/)
    .filter(t => t.length >= 4 && !STOPWORDS.has(t.toLowerCase()))
    .map(t => t.toLowerCase());
  const matchesScope = (name: string, content: string): boolean => {
    const nameLc = name.toLowerCase();
    if (tokens.some(t => nameLc.includes(t))) {
      return true;
    }
    const contentLc = content.toLowerCase();
    return contentLc.includes(scope.toLowerCase());
  };

  const matched: Matched[] = [];
  let filesScanned = 0;

  // -- Apex classes ----------------------------------------------------------
  const classesDir = path.join(base, 'classes');
  const classNames: string[] = [];
  for (const file of await listFiles(classesDir, '.cls')) {
    if (filesScanned++ > MAX_FILES) break;
    const name = path.basename(file, '.cls');
    classNames.push(name);
    const content = await readSafe(path.join(classesDir, file));
    if (matchesScope(name, content)) {
      matched.push({ name, rel: `force-app/main/default/classes/${file}`, kind: classify(name, content), content });
    }
  }

  // -- Triggers ---------------------------------------------------------------
  const triggersDir = path.join(base, 'triggers');
  for (const file of await listFiles(triggersDir, '.trigger')) {
    const name = path.basename(file, '.trigger');
    const content = await readSafe(path.join(triggersDir, file));
    if (matchesScope(name, content)) {
      const obj = content.match(/\btrigger\s+\w+\s+on\s+(\w+)/i)?.[1] ?? '?';
      matched.push({ name: `${name} (on ${obj})`, rel: `force-app/main/default/triggers/${file}`, kind: 'trigger', content });
    }
  }

  // -- Visualforce pages -------------------------------------------------------
  const pagesDir = path.join(base, 'pages');
  for (const file of await listFiles(pagesDir, '.page')) {
    const name = path.basename(file, '.page');
    const content = await readSafe(path.join(pagesDir, file));
    const controller = content.match(/controller\s*=\s*"(\w+)"/i)?.[1];
    if (matchesScope(name, content) || (controller && matched.some(m => m.name === controller))) {
      matched.push({ name: `${name}${controller ? ` (controller: ${controller})` : ''}`, rel: `force-app/main/default/pages/${file}`, kind: 'vf-page', content });
    }
  }

  // -- LWC components -----------------------------------------------------------
  const lwcDir = path.join(base, 'lwc');
  for (const dir of await listDirs(lwcDir)) {
    let content = '';
    for (const f of await listFiles(path.join(lwcDir, dir), '.js')) {
      content += await readSafe(path.join(lwcDir, dir, f));
    }
    if (matchesScope(dir, content)) {
      matched.push({ name: dir, rel: `force-app/main/default/lwc/${dir}/`, kind: 'lwc', content });
    }
  }

  // -- Flows ---------------------------------------------------------------------
  const flowsDir = path.join(base, 'flows');
  for (const file of await listFiles(flowsDir, '.flow-meta.xml')) {
    const name = file.replace('.flow-meta.xml', '');
    const content = await readSafe(path.join(flowsDir, file));
    if (matchesScope(name, content)) {
      const obj = content.match(/<object>(\w+)<\/object>/)?.[1] ?? '';
      matched.push({ name: `${name}${obj ? ` (object: ${obj})` : ''}`, rel: `force-app/main/default/flows/${file}`, kind: 'flow', content: '' });
    }
  }

  // -- Custom metadata -------------------------------------------------------------
  const cmdDir = path.join(base, 'customMetadata');
  const customMetadata: string[] = [];
  for (const file of await listFiles(cmdDir, '.md-meta.xml')) {
    const name = file.replace('.md-meta.xml', '');
    if (tokens.some(t => name.toLowerCase().includes(t)) || matched.some(m => m.content.includes(name.split('.')[0]))) {
      customMetadata.push(name);
    }
  }

  // -- Derived facts from matched Apex ----------------------------------------------
  const apexMatched = matched.filter(m => ['selector', 'service', 'handler', 'domain', 'controller', 'class', 'rest-resource', 'test'].includes(m.kind));
  const objectsUsed = new Set<string>();
  const labelsUsed = new Set<string>();
  const edges: string[] = [];
  for (const m of apexMatched) {
    for (const fm of m.content.matchAll(/\bFROM\s+([A-Za-z0-9_]+)\b/gi)) {
      objectsUsed.add(fm[1]);
    }
    for (const lm of m.content.matchAll(/\bLabel\.([A-Za-z0-9_]+)/g)) {
      labelsUsed.add(lm[1]);
    }
    for (const other of matched) {
      const otherBase = other.name.split(' ')[0];
      if (other !== m && otherBase.length > 3 && m.content.includes(otherBase) && edges.length < MAX_EDGES) {
        edges.push(`${m.name.split(' ')[0]} → ${otherBase}`);
      }
    }
  }

  // -- Report -----------------------------------------------------------------------
  const byKind = (kind: string) => matched.filter(m => m.kind === kind).map(m => `  - ${m.name} (${m.rel})`);
  const section = (title: string, items: string[]) =>
    [`${title}:`, ...(items.length ? items.slice(0, MAX_LIST) : ['  (none found)']), ...(items.length > MAX_LIST ? [`  … and ${items.length - MAX_LIST} more`] : [])];

  const entryPoints = [
    ...byKind('trigger'),
    ...byKind('vf-page'),
    ...byKind('lwc'),
    ...byKind('rest-resource'),
    ...byKind('flow')
  ];

  const lines = [
    `ARCHITECTURE INVENTORY (pre-scanned by the extension) — scope: "${scope}"`,
    `Matched ${matched.length} component(s). Read the key files below before answering.`,
    '',
    ...section('ENTRY POINTS (triggers / pages / LWC / REST / flows)', entryPoints),
    '',
    ...section('SELECTORS', byKind('selector')),
    ...section('SERVICES', byKind('service')),
    ...section('HANDLERS / DOMAINS', [...byKind('handler'), ...byKind('domain')]),
    ...section('CONTROLLERS / OTHER CLASSES', [...byKind('controller'), ...byKind('class')]),
    ...section('TEST CLASSES', byKind('test')),
    '',
    ...section('DEPENDENCY HINTS (A references B)', edges.map(e => `  - ${e}`)),
    ...section('SALESFORCE OBJECTS QUERIED', [...objectsUsed].map(o => `  - ${o}`)),
    ...section('CUSTOM LABELS REFERENCED', [...labelsUsed].map(l => `  - ${l}`)),
    ...section('CUSTOM METADATA', customMetadata.map(c => `  - ${c}`)),
    '',
    'SUGGESTED READS: start with the entry points, then the main service/controller class, then its selector.'
  ];

  return {
    scope,
    report: matched.length > 0 ? lines.join('\n') : `ARCHITECTURE INVENTORY: no components matched scope "${scope}". Use search_code to locate the feature first.`,
    matchedFiles: matched.map(m => m.rel)
  };
}

function classify(name: string, content: string): string {
  if (/@RestResource\b/i.test(content)) return 'rest-resource';
  if (/Test$/i.test(name) || /_Test$/i.test(name) || /@isTest\b/i.test(content)) return 'test';
  if (/Selector$/i.test(name)) return 'selector';
  if (/Service$/i.test(name)) return 'service';
  if (/Handler$/i.test(name)) return 'handler';
  if (/Domain$/i.test(name)) return 'domain';
  if (/Controller$/i.test(name)) return 'controller';
  return 'class';
}

// -- FS helpers (never throw) -------------------------------------------------

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(dir: string, suffix: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isFile() && e.name.endsWith(suffix)).map(e => e.name);
  } catch {
    return [];
  }
}

async function listDirs(dir: string): Promise<string[]> {
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
