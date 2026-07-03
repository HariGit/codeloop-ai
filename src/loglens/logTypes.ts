/**
 * Types for Apex debug log parsing and analysis (LogLens).
 */

export interface LogEvent {
  time: string;
  type: string;
  detail: string;
  logLine: number;
}

export interface SoqlEntry {
  query: string;
  rows: number | null;
  logLine: number;
}

export interface DmlEntry {
  operation: string;
  objectType: string;
  rows: number | null;
  logLine: number;
}

export interface ExceptionEntry {
  type: string;
  message: string;
  logLine: number;
}

export interface LimitMetric {
  name: string;
  used: number;
  max: number;
}

export interface MethodNode {
  name: string;
  children: MethodNode[];
}

/** Raw structured extraction from a debug log. */
export interface ParsedLog {
  entryPoints: string[];
  events: LogEvent[];
  callTreeRoot: MethodNode;
  soql: SoqlEntry[];
  dml: DmlEntry[];
  exceptions: ExceptionEntry[];
  limits: LimitMetric[];
  totalLines: number;
  methodCount: number;
}

export interface RiskFinding {
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  message: string;
}

/** Full analysis handed to the LLM (never the raw log). */
export interface DebugLogAnalysis {
  entryPoint: string;
  timeline: string[];
  callTree: string[];
  soql: SoqlEntry[];
  dml: DmlEntry[];
  exceptions: ExceptionEntry[];
  limits: LimitMetric[];
  risks: RiskFinding[];
  recommendations: string[];
  stats: {
    totalLines: number;
    methodCount: number;
    soqlCount: number;
    dmlCount: number;
    exceptionCount: number;
  };
}
