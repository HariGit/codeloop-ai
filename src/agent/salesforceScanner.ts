import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Salesforce DX metadata scanner.
 * Scans force-app/main/default, counts metadata, detects common Apex
 * patterns, and writes a summary to .agent-memory/project-summary.md
 * (which the agent loop reads before planning).
 */

const SF_BASE = path.join('force-app', 'main', 'default');

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

export interface SalesforceScanResult {
  isSalesforceProject: boolean;
  counts: SalesforceCounts;
  patterns: SalesforcePatterns;
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

  if (isSf) {
    const base = path.join(workspaceRoot, SF_BASE);

    // Apex classes + pattern detection (name suffixes and content markers).
    const classFiles = await listFiles(path.join(base, 'classes'), '.cls');
    counts.apexClasses = classFiles.length;
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
    }

    counts.triggers = (await listFiles(path.join(base, 'triggers'), '.trigger')).length;
    counts.lwcComponents = (await listDirs(path.join(base, 'lwc'))).length;
    counts.flows = (await listFiles(path.join(base, 'flows'), '.flow-meta.xml')).length;
    counts.visualforcePages = (await listFiles(path.join(base, 'pages'), '.page')).length;
    counts.customMetadata = (await listFiles(path.join(base, 'customMetadata'), '.md-meta.xml')).length;
    counts.permissionSets = (await listFiles(path.join(base, 'permissionsets'), '.permissionset-meta.xml')).length;
    counts.objects = (await listDirs(path.join(base, 'objects'))).length;

    // Custom labels live inside one or more *.labels-meta.xml files as <labels> entries.
    const labelFiles = await listFiles(path.join(base, 'labels'), '.labels-meta.xml');
    for (const file of labelFiles) {
      const content = await readSafe(path.join(base, 'labels', file));
      counts.customLabels += (content.match(/<labels>/g) ?? []).length;
    }
  }

  const summaryMarkdown = buildSummary(isSf, counts, patterns);

  // Save to .agent-memory/project-summary.md (created if missing).
  const memoryDir = path.join(workspaceRoot, '.agent-memory');
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(path.join(memoryDir, 'project-summary.md'), summaryMarkdown, 'utf8');

  return { isSalesforceProject: isSf, counts, patterns, summaryMarkdown };
}

function buildSummary(isSf: boolean, counts: SalesforceCounts, patterns: SalesforcePatterns): string {
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
    '',
    '## Architecture patterns detected',
    '',
    patternLine('Selector classes', patterns.selectors),
    patternLine('Service classes', patterns.services),
    patternLine('Handler classes', patterns.handlers),
    patternLine('Domain classes', patterns.domains),
    patternLine('Test classes', patterns.tests),
    patternLine('REST resources (@RestResource)', patterns.restResources),
    patternLine('Batch classes (Database.Batchable)', patterns.batchables),
    patternLine('Queueables', patterns.queueables),
    patternLine('Schedulables', patterns.schedulables)
  );

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
