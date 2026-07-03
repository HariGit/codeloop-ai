import { DebugLogAnalysis } from './logTypes';

const MAX_LIST = 20;

/**
 * Builds concise structured reports for the LLM.
 * The model never sees the raw log — only these summaries.
 */

export function buildFullReport(fileLabel: string, a: DebugLogAnalysis): string {
  const lines: string[] = [
    `DEBUG LOG ANALYSIS — ${fileLabel}`,
    `Stats: ${a.stats.totalLines} log lines, ${a.stats.methodCount} method calls, ${a.stats.soqlCount} SOQL, ${a.stats.dmlCount} DML, ${a.stats.exceptionCount} exception(s)`,
    '',
    `ENTRY POINT: ${a.entryPoint}`,
    '',
    'EXECUTION TIMELINE:',
    ...(a.timeline.length ? a.timeline.map(t => `  ${t}`) : ['  (no key events)']),
    '',
    'METHOD CALL TREE:',
    ...(a.callTree.length ? a.callTree.map(t => `  ${t}`) : ['  (no method entries)']),
    '',
    soqlSection(a),
    dmlSection(a),
    exceptionSection(a),
    limitSection(a),
    riskSection(a),
    'RECOMMENDATIONS:',
    ...(a.recommendations.length ? a.recommendations.map(r => `  - ${r}`) : ['  (none)'])
  ];
  return lines.join('\n');
}

export function buildFlowReport(fileLabel: string, a: DebugLogAnalysis): string {
  return [
    `LOG FLOW — ${fileLabel}`,
    `ENTRY POINT: ${a.entryPoint}`,
    '',
    'EXECUTION TIMELINE:',
    ...(a.timeline.length ? a.timeline.map(t => `  ${t}`) : ['  (no key events)']),
    '',
    'METHOD CALL TREE:',
    ...(a.callTree.length ? a.callTree.map(t => `  ${t}`) : ['  (no method entries)'])
  ].join('\n');
}

export function buildExceptionReport(fileLabel: string, a: DebugLogAnalysis): string {
  return [
    `LOG EXCEPTIONS — ${fileLabel}`,
    `ENTRY POINT: ${a.entryPoint}`,
    '',
    exceptionSection(a),
    a.exceptions.length
      ? 'Use read_file on the classes in the call tree above the exception to find the root cause.'
      : 'No exceptions or fatal errors found in this log.'
  ].join('\n');
}

export function buildGovernorReport(fileLabel: string, a: DebugLogAnalysis): string {
  return [
    `GOVERNOR LIMIT ANALYSIS — ${fileLabel}`,
    `Stats: ${a.stats.soqlCount} SOQL, ${a.stats.dmlCount} DML in this transaction`,
    '',
    limitSection(a),
    riskSection(a),
    'RECOMMENDATIONS:',
    ...(a.recommendations.length ? a.recommendations.map(r => `  - ${r}`) : ['  (none)'])
  ].join('\n');
}

// ---------------------------------------------------------------------------

function soqlSection(a: DebugLogAnalysis): string {
  const items = a.soql.slice(0, MAX_LIST).map(s => `  line ${s.logLine}: ${s.query}${s.rows !== null ? ` → ${s.rows} rows` : ''}`);
  const more = a.soql.length > MAX_LIST ? [`  … and ${a.soql.length - MAX_LIST} more`] : [];
  return ['SOQL QUERIES:', ...(items.length ? items : ['  (none)']), ...more, ''].join('\n');
}

function dmlSection(a: DebugLogAnalysis): string {
  const items = a.dml.slice(0, MAX_LIST).map(d => `  line ${d.logLine}: ${d.operation} ${d.objectType}${d.rows !== null ? ` (${d.rows} rows)` : ''}`);
  const more = a.dml.length > MAX_LIST ? [`  … and ${a.dml.length - MAX_LIST} more`] : [];
  return ['DML OPERATIONS:', ...(items.length ? items : ['  (none)']), ...more, ''].join('\n');
}

function exceptionSection(a: DebugLogAnalysis): string {
  const items = a.exceptions.slice(0, MAX_LIST).map(e => `  line ${e.logLine}: ${e.type}${e.message ? ` — ${e.message}` : ''}`);
  return ['EXCEPTIONS:', ...(items.length ? items : ['  (none)']), ''].join('\n');
}

function limitSection(a: DebugLogAnalysis): string {
  const items = a.limits
    .filter(l => l.used > 0)
    .map(l => `  ${l.name}: ${l.used}/${l.max}${l.max > 0 ? ` (${Math.round((l.used / l.max) * 100)}%)` : ''}`);
  return ['GOVERNOR LIMITS (used):', ...(items.length ? items : ['  (no usage recorded)']), ''].join('\n');
}

function riskSection(a: DebugLogAnalysis): string {
  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
  const items = [...a.risks]
    .sort((x, y) => order[x.severity] - order[y.severity])
    .map(r => `  [${r.severity}] ${r.message}`);
  return ['RISK FINDINGS:', ...(items.length ? items : ['  (none)']), ''].join('\n');
}
