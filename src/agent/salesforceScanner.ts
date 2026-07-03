import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Salesforce DX metadata scanner.
 * Counts metadata, detects Apex patterns, summarizes objects/triggers/
 * flows, runs a heuristic Apex risk scan, maps classes to test classes,
 * and writes everything to .agent-memory/project-summary.md (read by the
 * agent loop before planning).
 */

const SF_BASE = path.join('force-app', 'main', 'default');
const MAX_WARNINGS = 50;
const MAX_LIST = 50;

export interface SalesforceCounts {
  apexClasses: number;
  triggers: number;
  lwcComponents: number;
  flows: number;
  visualforcePages: number;
  customLabels: number;
  customMetadata: number;
  permissionSets: number;
  objects: number;
}

export interface SalesforcePatterns {
  selectors: string[];
  services: string[];
  handlers: string[];
  domains: string[];
  tests: string[];
  restResources: string[];
  batchables: string[];
  queueables: string[];
  schedulables: string[];
}

export interface ObjectSummary {
  apiName: string;
  fieldCount: number;
  recordTypeCount: number;
  validationRuleCount: number;
}

export interface TriggerSummary {
  name: string;
  objectName: string;
  events: string;
}

export interface FlowSummary {
  apiName: string;
  triggerObject: string;
  processType: string;
  status: string;
}

export interface TestMapping {
  testedCount: number;
  missingTests: string[];
}

export interface SalesforceScanResult {
  isSalesforceProject: boolean;
  counts: SalesforceCounts;
  patterns: SalesforcePatterns;
  objectSummaries: ObjectSummary[];
  triggerSummaries: TriggerSummary[];
  flowSummaries: FlowSummary[];
  warnings: string[];
  testMapping: TestMapping;
  summaryMarkdown: string;
}

/** True when sfdx-project.json or force-app/main/default exists. */
export async function isSalesforceDxProject(workspaceRoot: string): Promise<boolean> {
  return (
    (await exists(path.join(workspaceRoot, 'sfdx-project.json'))) ||
    (await exists(path.join(workspaceRoot, SF_BASE)))
  );
}

/** Scan the project and write .agent-memory/project-summary.md. */
export async function scanSalesforceProject(workspaceRoot: string): Promise<SalesforceScanResult> {
  const isSf = await isSalesforceDxProject(workspaceRoot);

  const counts: SalesforceCounts = {
    apexClasses: 0,
    triggers: 0,
    lwcComponents: 0,
    flows: 0,
    visualforcePages: 0,
    customLabels: 0,
    customMetadata: 0,
    permissionSets: 0,
    objects: 0
  };
  const patterns: SalesforcePatterns = {
    selectors: [],
    services: [],
    handlers: [],
    domains: [],
    tests: [],
    restResources: [],
    batchables: [],
    queueables: [],
    schedulables: []
  };
  const objectSummaries: ObjectSummary[] = [];
  const triggerSummaries: TriggerSummary[] = [];
  const flowSummaries: FlowSummary[] = [];
  const warnings: string[] = [];
  let extraWarnings = 0;
  const testMapping: TestMapping = { testedCount: 0, missingTests: [] };

  if (isSf) {
    const base = path.join(workspaceRoot, SF_BASE);

    // -- Apex classes: patterns + risk scan + test mapping -------------------
    const classFiles = await listFiles(path.join(base, 'classes'), '.cls');
    counts.apexClasses = classFiles.length;
    const classNames = new Set(classFiles.map(f => path.basename(f, '.cls')));

    for (const file of classFiles) {
      const name = path.basename(file, '.cls');
      if (/Selector$/i.test(name)) patterns.selectors.push(name);
      if (/Service$/i.test(name)) patterns.services.push(name);
      if (/Handler$/i.test(name)) patterns.handlers.push(name);
      if (/Domain$/i.test(name)) patterns.domains.push(name);
      if (/Test$/i.test(name)) patterns.tests.push(name);

      const content = await readSafe(path.join(base, 'classes', file));
      if (/@RestResource\b/i.test(content)) patterns.restResources.push(name);
      if (/Database\.Batchable\b/i.test(content)) patterns.batchables.push(name);
      if (/\bimplements\b[^{]*\bQueueable\b/i.test(content)) patterns.queueables.push(name);
      if (/\bimplements\b[^{]*\bSchedulable\b/i.test(content)) patterns.schedulables.push(name);

      const isTestClass = /Test$/i.test(name) || /_Test$/i.test(name) || /@isTest\b/i.test(content);
      if (!isTestClass) {
        // 4. Apex risk scan (heuristic; test classes skipped).
        const overflow = scanApexRisks(`classes/${file}`, content, warnings);
        extraWarnings += overflow;
        // 5. Test mapping.
        if (classNames.has(`${name}Test`) || classNames.has(`${name}_Test`)) {
          testMapping.testedCount++;
        } else {
          testMapping.missingTests.push(name);
        }
      }
    }

    // -- Triggers: name, object, events --------------------------------------
    const triggerFiles = await listFiles(path.join(base, 'triggers'), '.trigger');
    counts.triggers = triggerFiles.length;
    for (const file of triggerFiles) {
      const content = await readSafe(path.join(base, 'triggers', file));
      const m = content.match(/\btrigger\s+(\w+)\s+on\s+(\w+)\s*\(([^)]*)\)/i);
      triggerSummaries.push({
        name: path.basename(file, '.trigger'),
        objectName: m ? m[2] : '(unparsed)',
        events: m ? m[3].replace(/\s+/g, ' ').trim() : '(unparsed)'
      });
      const overflow = scanApexRisks(`triggers/${file}`, content, warnings);
      extraWarnings += overflow;
    }

    // -- Flows: API name, trigger object, process type, status ---------------
    const flowFiles = await listFiles(path.join(base, 'flows'), '.flow-meta.xml');
    counts.flows = flowFiles.length;
    for (const file of flowFiles) {
      const content = await readSafe(path.join(base, 'flows', file));
      flowSummaries.push({
        apiName: file.replace('.flow-meta.xml', ''),
        triggerObject: xmlTag(content, 'object') ?? '(none)',
        processType: xmlTag(content, 'processType') ?? '(unknown)',
        status: xmlTag(content, 'status') ?? '(unknown)'
      });
    }

    // -- Objects: fields, record types, validation rules ---------------------
    const objectDirs = await listDirs(path.join(base, 'objects'));
    counts.objects = objectDirs.length;
    for (const objName of objectDirs) {
      const objDir = path.join(base, 'objects', objName);
      objectSummaries.push({
        apiName: objName,
        fieldCount: (await listFiles(path.join(objDir, 'fields'), '.field-meta.xml')).length,
        recordTypeCount: (await listFiles(path.join(objDir, 'recordTypes'), '.recordType-meta.xml')).length,
        validationRuleCount: (await listFiles(path.join(objDir, 'validationRules'), '.validationRule-meta.xml')).length
      });
    }

    // -- Remaining counts -----------------------------------------------------
    counts.lwcComponents = (await listDirs(path.join(base, 'lwc'))).length;
    counts.visualforcePages = (await listFiles(path.join(base, 'pages'), '.page')).length;
    counts.customMetadata = (await listFiles(path.join(base, 'customMetadata'), '.md-meta.xml')).length;
    counts.permissionSets = (await listFiles(path.join(base, 'permissionsets'), '.permissionset-meta.xml')).length;
    const labelFiles = await listFiles(path.join(base, 'labels'), '.labels-meta.xml');
    for (const file of labelFiles) {
      const content = await readSafe(path.join(base, 'labels', file));
      counts.customLabels += (content.match(/<labels>/g) ?? []).length;
    }
  }

  const summaryMarkdown = buildSummary(
    isSf, counts, patterns, objectSummaries, triggerSummaries, flowSummaries, warnings, extraWarnings, testMapping
  );

  // Save to .agent-memory/project-summary.md (created if missing).
  const memoryDir = path.join(workspaceRoot, '.agent-memory');
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(path.join(memoryDir, 'project-summary.md'), summaryMarkdown, 'utf8');

  return {
    isSalesforceProject: isSf,
    counts,
    patterns,
    objectSummaries,
    triggerSummaries,
    flowSummaries,
    warnings,
    testMapping,
    summaryMarkdown
  };
}

// ---------------------------------------------------------------------------
// Apex risk scan (heuristic)
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /['"][\w.+-]+@[\w-]+\.[a-z]{2,}['"]/i;
const URL_PATTERN = /['"]https?:\/\//i;
// 15/18-char Salesforce Id literals: alphanumeric with both digits and letters.
const ID_CANDIDATE = /['"]([0-9A-Za-z]{15}|[0-9A-Za-z]{18})['"]/;
function looksLikeSalesforceId(line: string): boolean {
  const m = line.match(ID_CANDIDATE);
  if (!m) {
    return false;
  }
  return /[0-9]/.test(m[1]) && /[a-zA-Z]/.test(m[1]);
}
const DML_PATTERN = /^\s*(insert|update|delete|upsert|undelete)\s+\w|(?:\bDatabase\.(insert|update|delete|upsert)\s*\()/i;

/** Scan one Apex file for risks; append to warnings (capped). Returns overflow count. */
function scanApexRisks(relFile: string, content: string, warnings: string[]): number {
  const lines = content.split('\n');
  let braceDepth = 0;
  const loopEntryDepths: number[] = [];
  let overflow = 0;

  const add = (line: number, tag: string, snippet: string) => {
    if (warnings.length >= MAX_WARNINGS) {
      overflow++;
      return;
    }
    warnings.push(`${relFile}:${line}: [${tag}] ${snippet.trim().slice(0, 120)}`);
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) {
      continue;
    }

    const isLoopStart = /\b(for|while|do)\s*[({]/.test(line);
    if (isLoopStart) {
      loopEntryDepths.push(braceDepth);
    }
    for (const ch of raw) {
      if (ch === '{') {
        braceDepth++;
      } else if (ch === '}') {
        braceDepth--;
        while (loopEntryDepths.length > 0 && braceDepth <= loopEntryDepths[loopEntryDepths.length - 1]) {
          loopEntryDepths.pop();
        }
      }
    }
    const inLoopBody = loopEntryDepths.length > 0 && !isLoopStart;

    // SOQL-for loops (for (X x : [SELECT ...])) are fine; only flag inside bodies.
    if (inLoopBody && /\[\s*SELECT\b/i.test(line)) {
      add(i + 1, 'SOQL_IN_LOOP', raw);
    }
    if (inLoopBody && DML_PATTERN.test(raw)) {
      add(i + 1, 'DML_IN_LOOP', raw);
    }
    if (EMAIL_PATTERN.test(line)) {
      add(i + 1, 'HARDCODED_EMAIL', raw);
    }
    if (URL_PATTERN.test(line)) {
      add(i + 1, 'HARDCODED_URL', raw);
    }
    if (looksLikeSalesforceId(line)) {
      add(i + 1, 'HARDCODED_ID', raw);
    }
  }
  return overflow;
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(
  isSf: boolean,
  counts: SalesforceCounts,
  patterns: SalesforcePatterns,
  objectSummaries: ObjectSummary[],
  triggerSummaries: TriggerSummary[],
  flowSummaries: FlowSummary[],
  warnings: string[],
  extraWarnings: number,
  testMapping: TestMapping
): string {
  const lines: string[] = [
    '# Project Summary (Salesforce Scan)',
    '',
    `Scanned: ${new Date().toISOString()}`,
    ''
  ];

  if (!isSf) {
    lines.push('_Not a Salesforce DX project (no sfdx-project.json or force-app/main/default found)._');
    return lines.join('\n');
  }

  lines.push(
    '## Metadata counts',
    '',
    `- Apex classes: ${counts.apexClasses}`,
    `- Apex triggers: ${counts.triggers}`,
    `- LWC components: ${counts.lwcComponents}`,
    `- Flows: ${counts.flows}`,
    `- Visualforce pages: ${counts.visualforcePages}`,
    `- Custom Labels: ${counts.customLabels}`,
    `- Custom Metadata records: ${counts.customMetadata}`,
    `- Permission Sets: ${counts.permissionSets}`,
    `- Objects: ${counts.objects}`,
    ''
  );

  lines.push('## Architecture patterns detected', '');
  lines.push(
    patternLine('Selector classes', patterns.selectors),
    patternLine('Service classes', patterns.services),
    patternLine('Handler classes', patterns.handlers),
    patternLine('Domain classes', patterns.domains),
    patternLine('Test classes', patterns.tests),
    patternLine('REST resources (@RestResource)', patterns.restResources),
    patternLine('Batch classes (Database.Batchable)', patterns.batchables),
    patternLine('Queueables', patterns.queueables),
    patternLine('Schedulables', patterns.schedulables),
    ''
  );

  lines.push('## Objects', '');
  if (objectSummaries.length === 0) {
    lines.push('_None found._');
  } else {
    for (const o of objectSummaries.slice(0, MAX_LIST)) {
      lines.push(`- ${o.apiName}: ${o.fieldCount} fields, ${o.recordTypeCount} record types, ${o.validationRuleCount} validation rules`);
    }
    if (objectSummaries.length > MAX_LIST) {
      lines.push(`- … and ${objectSummaries.length - MAX_LIST} more objects`);
    }
  }
  lines.push('');

  lines.push('## Triggers', '');
  if (triggerSummaries.length === 0) {
    lines.push('_None found._');
  } else {
    for (const t of triggerSummaries.slice(0, MAX_LIST)) {
      lines.push(`- ${t.name} on ${t.objectName} (${t.events})`);
    }
  }
  lines.push('');

  lines.push('## Flows', '');
  if (flowSummaries.length === 0) {
    lines.push('_None found._');
  } else {
    for (const f of flowSummaries.slice(0, MAX_LIST)) {
      lines.push(`- ${f.apiName}: object=${f.triggerObject}, type=${f.processType}, status=${f.status}`);
    }
    if (flowSummaries.length > MAX_LIST) {
      lines.push(`- … and ${flowSummaries.length - MAX_LIST} more flows`);
    }
  }
  lines.push('');

  lines.push(`## Apex risk warnings (top ${MAX_WARNINGS})`, '');
  if (warnings.length === 0) {
    lines.push('_No risks detected by the heuristic scan._');
  } else {
    lines.push(...warnings.map(w => `- ${w}`));
    if (extraWarnings > 0) {
      lines.push(`- … and ${extraWarnings} more warnings (truncated)`);
    }
  }
  lines.push('');

  lines.push('## Test coverage mapping', '');
  lines.push(`- Classes with a matching test class: ${testMapping.testedCount}`);
  lines.push(`- Classes MISSING a test class: ${testMapping.missingTests.length}`);
  if (testMapping.missingTests.length > 0) {
    const shown = testMapping.missingTests.slice(0, MAX_LIST);
    lines.push(`  ${shown.join(', ')}${testMapping.missingTests.length > MAX_LIST ? ` … and ${testMapping.missingTests.length - MAX_LIST} more` : ''}`);
  }

  return lines.join('\n');
}

function patternLine(label: string, names: string[]): string {
  if (names.length === 0) {
    return `- ${label}: none found`;
  }
  const shown = names.slice(0, 30).join(', ');
  const more = names.length > 30 ? ` … and ${names.length - 30} more` : '';
  return `- ${label} (${names.length}): ${shown}${more}`;
}

/** First occurrence of <tag>value</tag> in XML ('' treated as missing). */
function xmlTag(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
  return m?.[1]?.trim() || undefined;
}

// ---------------------------------------------------------------------------
// FS helpers (never throw — missing folders return empty results)
// ---------------------------------------------------------------------------

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
