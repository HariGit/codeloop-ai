/**
 * Shared types for the CodeLoop AI agent.
 */

export type AgentActionType =
  | 'read_file'
  | 'search_code'
  | 'write_file'
  | 'create_file'
  | 'replace_file'
  | 'replace_range'
  | 'apply_patch'
  | 'run_command'
  | 'analyze_debug_log'
  | 'analyze_latest_apex_logs'
  | 'explain_log_flow'
  | 'find_log_exception'
  | 'find_governor_risk'
  | 'final_answer';

/** Actions that modify files; allowed wherever write_file is allowed. */
export const WRITE_ACTIONS: AgentActionType[] = [
  'write_file',
  'create_file',
  'replace_file',
  'replace_range',
  'apply_patch'
];

/** LogLens tools; allowed wherever analyze_debug_log is allowed. */
export const LOG_ACTIONS: AgentActionType[] = [
  'analyze_debug_log',
  'analyze_latest_apex_logs',
  'explain_log_flow',
  'find_log_exception',
  'find_governor_risk'
];

/** Detected task mode; controls which actions are allowed. */
export type TaskMode =
  | 'EXPLAIN_ONLY'
  | 'MODIFY_CODE'
  | 'CREATE_TEST'
  | 'RUN_TESTS'
  | 'DEBUG';

/** JSON action the LLM must return each iteration. */
export interface AgentAction {
  /** Short reasoning about the goal and current state. */
  thought: string;
  /** The chosen action. */
  action: AgentActionType;
  /** Relative file path (read_file / write_file). */
  path?: string;
  /** Search query (search_code). */
  query?: string;
  /** File content to write (write_file). */
  content?: string;
  /** Shell command to run (run_command). */
  command?: string;
  /** First line of the range, 1-based inclusive (replace_range). */
  startLine?: number;
  /** Last line of the range, 1-based inclusive (replace_range). */
  endLine?: number;
  /** Unified diff to apply (apply_patch). */
  patch?: string;
  /** Final answer text (final_answer). */
  answer?: string;
  /** Files used as evidence for the final answer. */
  evidence?: string[];
  /** Generic tool input (new format; top-level fields still supported). */
  input?: Record<string, unknown>;
}

/** Options for an Ollama chat call. */
export interface ChatOptions {
  /** JSON schema for Ollama structured output (format field). */
  format?: object;
  temperature?: number;
}

/** Result of executing one action. */
export interface ActionResult {
  success: boolean;
  /** Observation text fed back to the LLM. */
  observation: string;
}

/** One completed loop iteration, used for history and reflection. */
export interface IterationRecord {
  iteration: number;
  thought: string;
  action: AgentActionType;
  detail: string;
  success: boolean;
  observation: string;
}

/** Chat message in Ollama format. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Ollama /api/chat non-streaming response (relevant fields). */
export interface OllamaChatResponse {
  message?: { role: string; content: string };
  error?: string;
}

/** Supported model backends. Only "ollama" is implemented today. */
export type ModelProviderName = 'ollama' | 'anthropic' | 'openai' | 'vscode-lm';

/** Configurable loop behavior. */
export interface LoopConfig {
  /** Max iterations when the task mode has no specific limit. */
  defaultMaxIterations: number;
  /** Hard ceiling — no mode or setting may exceed this. */
  absoluteMaxIterations: number;
  /** Retries when the model returns invalid JSON. */
  jsonRetries: number;
  /** Retries when a final answer fails validation. */
  answerValidationRetries: number;
  /** Stop after this many consecutive blocked/duplicate/no-op iterations. */
  noProgressLimit: number;
  /** In EXPLAIN_APEX, push for final_answer once enough files are read. */
  autoStopExplainAfterFiles: boolean;
  /** Per-mode iteration limits (fall back to defaultMaxIterations). */
  modeMaxIterations: Record<string, number>;
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  defaultMaxIterations: 8,
  absoluteMaxIterations: 20,
  jsonRetries: 2,
  answerValidationRetries: 2,
  noProgressLimit: 2,
  autoStopExplainAfterFiles: true,
  modeMaxIterations: {
    EXPLAIN_APEX: 4,
    REVIEW_APEX: 6,
    MODIFY_APEX: 8,
    CREATE_TEST: 10,
    FLOW_MIGRATION: 8,
    LWC_WORK: 8,
    INTEGRATION_API: 8,
    DEPLOYMENT_REVIEW: 6,
    DEBUG_LOG_ANALYSIS: 6,
    ARCHITECTURE_OVERVIEW: 8,
    GENERAL_SALESFORCE: 6
  }
};

export interface AgentConfig {
  provider: ModelProviderName;
  /** Endpoint override (used by Ollama; optional for API providers). */
  endpoint?: string;
  model: string;
  /** API key for cloud providers (unused by Ollama). */
  apiKey?: string;
  /** Legacy default max iterations (kept for backward compatibility). */
  maxIterations: number;
  /** Loop behavior; DEFAULT_LOOP_CONFIG is used when absent. */
  loop?: LoopConfig;
}

/** JSON schema for AgentAction — passed to providers that support structured output. */
export const AGENT_ACTION_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string' },
    action: {
      type: 'string',
      enum: [
        'read_file',
        'search_code',
        'write_file',
        'create_file',
        'replace_file',
        'replace_range',
        'apply_patch',
        'run_command',
        'analyze_debug_log',
        'analyze_latest_apex_logs',
        'explain_log_flow',
        'find_log_exception',
        'find_governor_risk',
        'final_answer'
      ]
    },
    path: { type: 'string' },
    query: { type: 'string' },
    content: { type: 'string' },
    command: { type: 'string' },
    startLine: { type: 'integer' },
    endLine: { type: 'integer' },
    patch: { type: 'string' },
    answer: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    input: { type: 'object' }
  },
  required: ['thought', 'action']
} as const;

/** Selection of Salesforce instruction files to load from .codeloop/. */
export interface SalesforceContextOptions {
  /** Agent file name, e.g. "apex-developer" (suffix optional). */
  agentName?: string;
  /** Prompt template name, e.g. "explain-apex-class" (suffix optional). */
  promptName?: string;
  /** Skill file names, e.g. ["apex-testing", "salesforce-security"]. */
  skillNames?: string[];
}

/** One loaded skill file. */
export interface LoadedSkill {
  name: string;
  content: string;
}

/** Combined Salesforce instruction context loaded from .codeloop/. */
export interface SalesforceContext {
  globalInstructions: string;
  agentInstruction: string;
  promptTemplate: string;
  skills: LoadedSkill[];
  /** All sections combined into one prompt-ready text block ('' if nothing found). */
  combined: string;
}
