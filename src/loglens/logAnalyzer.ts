import { DebugLogAnalysis, MethodNode, ParsedLog, RiskFinding } from './logTypes';

const MAX_TIMELINE = 40;
const MAX_TREE_LINES = 60;

/** Turn a parsed log into an analysis with risks and recommendations. */
export function analyzeLog(parsed: ParsedLog): DebugLogAnalysis {
  const risks: RiskFinding[] = [];
  const recommendations = new Set<string>();

  // -- Governor limits ------------------------------------------------------
  for (const limit of parsed.limits) {
    if (limit.max <= 0) {
      continue;
    }
    const pct = Math.round((limit.used / limit.max) * 100);
    if (pct >= 90) {
      risks.push({ severity: 'HIGH', message: `${limit.name} at ${pct}% (${limit.used}/${limit.max}) — about to hit the governor limit` });
    } else if (pct >= 70) {
      risks.push({ severity: 'MEDIUM', message: `${limit.name} at ${pct}% (${limit.used}/${limit.max})` });
    } else if (pct >= 50) {
      risks.push({ severity: 'LOW', message: `${limit.name} at ${pct}% (${limit.used}/${limit.max})` });
    }
    if (pct >= 70 && /SOQL quer/i.test(limit.name)) {
      recommendations.add('Reduce SOQL query count: consolidate queries and move them out of loops into selector classes.');
    }
    if (pct >= 70 && /DML/i.test(limit.name)) {
      recommendations.add('Reduce DML statements: collect records in lists and perform one DML per object type.');
    }
    if (pct >= 70 && /CPU/i.test(limit.name)) {
      recommendations.add('Reduce CPU time: check nested loops and heavy processing; consider async (Queueable/Batch).');
    }
  }

  // -- Repeated identical SOQL → likely query in a loop ---------------------
  const queryCounts = new Map<string, number>();
  for (const s of parsed.soql) {
    const key = s.query.replace(/\s+/g, ' ').replace(/'[^']*'/g, "'?'").toLowerCase();
    queryCounts.set(key, (queryCounts.get(key) ?? 0) + 1);
  }
  for (const [query, count] of queryCounts) {
    if (count >= 3) {
      risks.push({ severity: 'HIGH', message: `Same SOQL executed ${count} times — likely SOQL inside a loop: ${query.slice(0, 120)}` });
      recommendations.add('Move repeated SOQL out of the loop: query once before the loop and use a Map for lookups.');
    }
  }

  // -- Repeated DML on the same object → likely DML in a loop ---------------
  const dmlCounts = new Map<string, number>();
  for (const d of parsed.dml) {
    const key = `${d.operation} ${d.objectType}`;
    dmlCounts.set(key, (dmlCounts.get(key) ?? 0) + 1);
  }
  for (const [op, count] of dmlCounts) {
    if (count >= 3) {
      risks.push({ severity: 'HIGH', message: `${op} executed ${count} times — likely DML inside a loop` });
      recommendations.add('Bulkify DML: collect records into a list and perform a single DML operation after the loop.');
    }
  }

  // -- Exceptions ------------------------------------------------------------
  for (const ex of parsed.exceptions.slice(0, 10)) {
    risks.push({ severity: 'HIGH', message: `Exception at log line ${ex.logLine}: ${ex.type}${ex.message ? ` — ${ex.message.slice(0, 120)}` : ''}` });
  }
  if (parsed.exceptions.some(e => /LimitException/i.test(e.type) || /LimitException/i.test(e.message))) {
    recommendations.add('A governor LimitException was thrown — bulkification is required, not optional, for this path.');
  }
  if (parsed.exceptions.some(e => /NullPointer/i.test(e.type))) {
    recommendations.add('Guard against null values before dereferencing (null checks or safe navigation operator ?.).');
  }
  if (parsed.exceptions.length > 0) {
    recommendations.add('Add targeted try/catch with clear error surfacing where the exception originates.');
  }

  // -- Timeline and call tree -------------------------------------------------
  const timeline = parsed.events
    .filter(e => ['CODE_UNIT_STARTED', 'SOQL_EXECUTE_BEGIN', 'DML_BEGIN', 'EXCEPTION_THROWN', 'FATAL_ERROR', 'LIMIT_USAGE_FOR_NS'].includes(e.type))
    .slice(0, MAX_TIMELINE)
    .map(e => `${e.time} ${e.type}: ${e.detail}`);

  const callTree: string[] = [];
  renderTree(parsed.callTreeRoot, 0, callTree);

  return {
    entryPoint: parsed.entryPoints[0] ?? '(no CODE_UNIT_STARTED found)',
    timeline,
    callTree: callTree.slice(0, MAX_TREE_LINES),
    soql: parsed.soql,
    dml: parsed.dml,
    exceptions: parsed.exceptions,
    limits: parsed.limits,
    risks,
    recommendations: [...recommendations],
    stats: {
      totalLines: parsed.totalLines,
      methodCount: parsed.methodCount,
      soqlCount: parsed.soql.length,
      dmlCount: parsed.dml.length,
      exceptionCount: parsed.exceptions.length
    }
  };
}

function renderTree(node: MethodNode, depth: number, out: string[]): void {
  if (out.length >= MAX_TREE_LINES + 20) {
    return;
  }
  if (depth > 0) {
    out.push(`${'  '.repeat(depth - 1)}${node.name}`);
  }
  for (const child of node.children) {
    renderTree(child, depth + 1, out);
  }
}
