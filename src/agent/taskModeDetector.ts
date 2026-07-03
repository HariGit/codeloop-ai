import { AgentActionType } from '../types/agentTypes';

/**
 * Salesforce-aware task mode detection.
 * Maps the user's goal to a mode, a .codeloop agent/prompt/skills selection,
 * and the actions the loop may execute.
 */

export type SalesforceTaskMode =
  | 'EXPLAIN_APEX'
  | 'REVIEW_APEX'
  | 'MODIFY_APEX'
  | 'CREATE_TEST'
  | 'FLOW_MIGRATION'
  | 'LWC_WORK'
  | 'INTEGRATION_API'
  | 'DEPLOYMENT_REVIEW'
  | 'DEBUG_LOG_ANALYSIS'
  | 'ARCHITECTURE_OVERVIEW'
  | 'GENERAL_SALESFORCE';

export interface TaskModeResult {
  mode: SalesforceTaskMode;
  agentName: string;
  promptName: string;
  skillNames: string[];
  allowedActions: AgentActionType[];
}

const READ_ONLY: AgentActionType[] = ['search_code', 'read_file', 'final_answer'];

/** Static mapping per mode (before explicit-request escalation). */
const MODE_MAP: Record<SalesforceTaskMode, Omit<TaskModeResult, 'mode'>> = {
  EXPLAIN_APEX: {
    agentName: 'apex-developer',
    promptName: 'explain-apex-class',
    skillNames: ['apex-trigger-framework'],
    allowedActions: [...READ_ONLY]
  },
  REVIEW_APEX: {
    agentName: 'apex-developer',
    promptName: 'review-apex-code',
    skillNames: ['apex-trigger-framework', 'apex-testing'],
    allowedActions: [...READ_ONLY]
  },
  MODIFY_APEX: {
    agentName: 'apex-developer',
    promptName: 'review-apex-code',
    skillNames: ['apex-trigger-framework', 'apex-testing'],
    allowedActions: ['search_code', 'read_file', 'write_file', 'final_answer']
  },
  CREATE_TEST: {
    agentName: 'salesforce-tester',
    promptName: 'create-apex-test',
    skillNames: ['apex-testing'],
    allowedActions: ['search_code', 'read_file', 'write_file', 'run_command', 'final_answer']
  },
  FLOW_MIGRATION: {
    agentName: 'flow-migration',
    promptName: 'migrate-flow-to-apex',
    skillNames: ['flow-to-apex', 'apex-trigger-framework'],
    allowedActions: [...READ_ONLY]
  },
  LWC_WORK: {
    agentName: 'lwc-developer',
    promptName: 'review-apex-code',
    skillNames: ['lwc-patterns', 'apex-trigger-framework'],
    allowedActions: ['search_code', 'read_file', 'write_file', 'final_answer']
  },
  INTEGRATION_API: {
    agentName: 'integration-api',
    promptName: 'build-rest-api',
    skillNames: ['integration-patterns', 'apex-testing'],
    allowedActions: ['search_code', 'read_file', 'write_file', 'final_answer']
  },
  DEPLOYMENT_REVIEW: {
    agentName: 'salesforce-devops',
    promptName: 'deployment-review',
    skillNames: ['salesforce-security'],
    allowedActions: [...READ_ONLY]
  },
  DEBUG_LOG_ANALYSIS: {
    agentName: 'apex-developer',
    promptName: '',
    skillNames: ['apex-trigger-framework'],
    allowedActions: ['search_code', 'read_file', 'analyze_debug_log', 'final_answer']
  },
  ARCHITECTURE_OVERVIEW: {
    agentName: 'architecture-overview',
    promptName: 'architecture-overview',
    skillNames: ['system-design', 'hld-lld', 'apex-trigger-framework'],
    allowedActions: [...READ_ONLY]
  },
  GENERAL_SALESFORCE: {
    agentName: 'salesforce-architect',
    promptName: '',
    skillNames: ['apex-trigger-framework'],
    allowedActions: [...READ_ONLY]
  }
};

/** Modes that stay read-only unless the user explicitly asks for changes. */
const RESTRICTED_MODES: SalesforceTaskMode[] = [
  'EXPLAIN_APEX',
  'REVIEW_APEX',
  'FLOW_MIGRATION',
  'DEPLOYMENT_REVIEW',
  'DEBUG_LOG_ANALYSIS',
  'ARCHITECTURE_OVERVIEW',
  'GENERAL_SALESFORCE'
];

/** Keyword rules, checked in order — first match wins. */
const MODE_RULES: Array<{ mode: SalesforceTaskMode; pattern: RegExp }> = [
  // Architecture first — "explain the architecture" must not become EXPLAIN_APEX.
  { mode: 'ARCHITECTURE_OVERVIEW', pattern: /\barchitecture\b|\bsystem\s+design\b|\bhigh\s+level\s+design\b|\blow\s+level\s+design\b|\bhld\b|\blld\b/i },
  // Debug logs first — "analyze debug log" must not be swallowed by other verbs.
  { mode: 'DEBUG_LOG_ANALYSIS', pattern: /\b(debug|apex)\s+logs?\b|\blog\s+analysis\b|\bloglens\b|\banalyz\w*\b[^.]*\blogs?\b|\blogs?\b[^.]*\b(exception|governor|root\s+cause)\b/i },
  // Specific intents first, so "migrate flow" is not swallowed by "modify".
  { mode: 'FLOW_MIGRATION', pattern: /\bflow\s+to\s+apex\b|\bmigrate\b[^.]*\bflow\b|\bconvert\b[^.]*\bflow\b|\bflow\s+(migration|analysis)\b|\banalyz(e|es|ing)\b[^.]*\bflow\b|\bflow\b[^.]*\b(move|migrate)\b[^.]*\bapex\b/i },
  { mode: 'CREATE_TEST', pattern: /\btest\s+class(es)?\b|\b(test\s+)?coverage\b|\bunit\s+tests?\b|\b(create|write|add|generate|build)\b[^.]*\btests?\b/i },
  { mode: 'DEPLOYMENT_REVIEW', pattern: /\bdeploy(ment|ing)?\b|\bpackage\.xml\b|\brelease\b|\bvalidat(e|ion)\b[^.]*\b(org|deployment|sandbox|production)\b/i },
  // Explain/review before LWC/integration so "explain this lwc" stays read-only.
  { mode: 'EXPLAIN_APEX', pattern: /\b(explain|guide|understand|walk\s*through|describe)\b|\bfunctionality\b|\bhow\b[^.]*\b(class|trigger|component|code)\b[^.]*\bworks?\b|\bhow\s+(does|do|this)\b/i },
  { mode: 'REVIEW_APEX', pattern: /\b(code\s+)?review\b|\bbest\s+practices?\b|\bgovernor\s+limits?\b|\bbulkif(y|ied|ication)\b/i },
  { mode: 'LWC_WORK', pattern: /\blwc\b|\blightning\s+web\s+component\b|\bcomponent\b|\b@?wire\b|\bapex\s+call\b|\b(html|js)\s+file\b/i },
  { mode: 'INTEGRATION_API', pattern: /\brest\s+api\b|\bendpoint\b|\bdto\b|\brequest\b[^.]*\bresponse\b|\bintegration\b|\bcallout\b|\bwebservice\b/i },
  { mode: 'MODIFY_APEX', pattern: /\b(fix|update|refactor|change|implement|modify|rename|optimize)\b/i }
];

/** True when the goal explicitly asks for file changes. */
function explicitlyWantsWrite(goal: string): boolean {
  return /\b(create|write|modify|update|fix|change|implement|refactor|generate|add|save)\b[^.]*\b(file|class|trigger|component|code|method|field|label)\b/i.test(goal);
}

/** True when the goal explicitly asks to run something. */
function explicitlyWantsRun(goal: string): boolean {
  return /\b(run|execute)\b[^.]*\b(test|command|script|deploy|validation)\b|\bdeploy\s+(it|now|this|to)\b/i.test(goal);
}

/**
 * Detect the Salesforce task mode for a goal.
 * Restricted modes stay read-only unless the goal explicitly asks for
 * write/run; then the matching action is added.
 */
export function detectSalesforceTaskMode(goal: string): TaskModeResult {
  const g = goal.trim();
  let mode: SalesforceTaskMode = 'GENERAL_SALESFORCE';
  for (const rule of MODE_RULES) {
    if (rule.pattern.test(g)) {
      mode = rule.mode;
      break;
    }
  }

  const mapping = MODE_MAP[mode];
  const allowedActions = [...mapping.allowedActions];

  // Explicit-request escalation for restricted (read-only) modes.
  if (RESTRICTED_MODES.includes(mode)) {
    if (explicitlyWantsWrite(g) && !allowedActions.includes('write_file')) {
      allowedActions.push('write_file');
    }
    if (explicitlyWantsRun(g) && !allowedActions.includes('run_command')) {
      allowedActions.push('run_command');
    }
  }

  return {
    mode,
    agentName: mapping.agentName,
    promptName: mapping.promptName,
    skillNames: [...mapping.skillNames],
    allowedActions
  };
}
