/**
 * Shared types for the CodeLoop AI agent.
 */

export type AgentActionType =
  | 'read_file'
  | 'search_code'
  | 'write_file'
  | 'run_command'
  | 'final_answer';

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
  /** Final answer text (final_answer). */
  answer?: string;
  /** Files used as evidence for the final answer. */
  evidence?: string[];
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

export interface AgentConfig {
  endpoint: string;
  model: string;
  maxIterations: number;
}

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
