import {
  DmlEntry,
  ExceptionEntry,
  LimitMetric,
  LogEvent,
  MethodNode,
  ParsedLog,
  SoqlEntry
} from './logTypes';

const MAX_EVENTS = 500;
const MAX_ENTRIES = 300;

/**
 * Parse a raw Apex debug log into structured data.
 * Handles: CODE_UNIT_STARTED/FINISHED, METHOD_ENTRY/EXIT,
 * SOQL_EXECUTE_BEGIN/END, DML_BEGIN/END, EXCEPTION_THROWN,
 * FATAL_ERROR, LIMIT_USAGE_FOR_NS.
 */
export function parseDebugLog(raw: string): ParsedLog {
  const lines = raw.split('\n');
  const events: LogEvent[] = [];
  const soql: SoqlEntry[] = [];
  const dml: DmlEntry[] = [];
  const exceptions: ExceptionEntry[] = [];
  const limits: LimitMetric[] = [];
  const entryPoints: string[] = [];

  const callTreeRoot: MethodNode = { name: '(execution)', children: [] };
  const stack: MethodNode[] = [callTreeRoot];
  let methodCount = 0;

  const addEvent = (time: string, type: string, detail: string, logLine: number) => {
    if (events.length < MAX_EVENTS) {
      events.push({ time, type, detail: detail.slice(0, 200), logLine });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split('|');
    if (parts.length < 2) {
      continue;
    }
    const time = (parts[0] ?? '').trim().split(' ')[0];
    const type = parts[1]?.trim();
    const logLine = i + 1;

    switch (type) {
      case 'CODE_UNIT_STARTED': {
        const name = (parts[parts.length - 1] ?? '(unknown)').trim();
        entryPoints.push(name);
        addEvent(time, type, name, logLine);
        const node: MethodNode = { name: `[unit] ${name}`, children: [] };
        stack[stack.length - 1].children.push(node);
        stack.push(node);
        break;
      }
      case 'CODE_UNIT_FINISHED': {
        addEvent(time, type, (parts[parts.length - 1] ?? '').trim(), logLine);
        if (stack.length > 1) {
          stack.pop();
        }
        break;
      }
      case 'METHOD_ENTRY': {
        const name = (parts[parts.length - 1] ?? '(unknown)').trim();
        methodCount++;
        addEvent(time, type, name, logLine);
        const node: MethodNode = { name, children: [] };
        stack[stack.length - 1].children.push(node);
        stack.push(node);
        break;
      }
      case 'METHOD_EXIT': {
        if (stack.length > 1) {
          stack.pop();
        }
        break;
      }
      case 'SOQL_EXECUTE_BEGIN': {
        const query = (parts[parts.length - 1] ?? '').trim();
        if (soql.length < MAX_ENTRIES) {
          soql.push({ query: query.slice(0, 300), rows: null, logLine });
        }
        addEvent(time, type, query, logLine);
        break;
      }
      case 'SOQL_EXECUTE_END': {
        const rowsMatch = line.match(/Rows:(\d+)/);
        const last = soql[soql.length - 1];
        if (last && last.rows === null && rowsMatch) {
          last.rows = parseInt(rowsMatch[1], 10);
        }
        break;
      }
      case 'DML_BEGIN': {
        const op = line.match(/Op:(\w+)/)?.[1] ?? '(unknown)';
        const objType = line.match(/Type:([\w__]+)/)?.[1] ?? '(unknown)';
        const rows = line.match(/Rows:(\d+)/)?.[1];
        if (dml.length < MAX_ENTRIES) {
          dml.push({ operation: op, objectType: objType, rows: rows ? parseInt(rows, 10) : null, logLine });
        }
        addEvent(time, type, `${op} ${objType}`, logLine);
        break;
      }
      case 'DML_END':
        break;
      case 'EXCEPTION_THROWN': {
        const detail = (parts[parts.length - 1] ?? '').trim();
        const colon = detail.indexOf(':');
        exceptions.push({
          type: colon > 0 ? detail.slice(0, colon).trim() : detail,
          message: colon > 0 ? detail.slice(colon + 1).trim().slice(0, 300) : '',
          logLine
        });
        addEvent(time, type, detail, logLine);
        break;
      }
      case 'FATAL_ERROR': {
        const detail = parts.slice(2).join('|').trim() || (parts[parts.length - 1] ?? '').trim();
        const colon = detail.indexOf(':');
        exceptions.push({
          type: `FATAL_ERROR${colon > 0 ? ` (${detail.slice(0, colon).trim()})` : ''}`,
          message: (colon > 0 ? detail.slice(colon + 1) : detail).trim().slice(0, 300),
          logLine
        });
        addEvent(time, type, detail, logLine);
        break;
      }
      case 'LIMIT_USAGE_FOR_NS': {
        addEvent(time, type, (parts[2] ?? '').trim(), logLine);
        // Metric lines follow until an empty line or the next piped line.
        for (let j = i + 1; j < lines.length; j++) {
          const metricLine = lines[j];
          if (!metricLine.trim() || metricLine.includes('|')) {
            i = j;
            break;
          }
          const m = metricLine.match(/^\s*(.+?):\s*(\d+)\s+out of\s+(\d+)/);
          if (m) {
            limits.push({ name: m[1].trim(), used: parseInt(m[2], 10), max: parseInt(m[3], 10) });
          }
          i = j;
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    entryPoints,
    events,
    callTreeRoot,
    soql,
    dml,
    exceptions,
    limits,
    totalLines: lines.length,
    methodCount
  };
}
