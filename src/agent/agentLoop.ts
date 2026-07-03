import * as vscode from 'vscode';
import { ModelProvider } from '../llm/ModelProvider';
import { createModelProvider } from '../llm/ProviderFactory';
import { AgentMemory, MEMORY_FILES } from './memory';
import { ToolRegistry } from '../tools/ToolRegistry';
import { NativeToolProvider } from '../tools/NativeToolProvider';
import { McpToolProvider } from '../tools/McpToolProvider';
import { ToolCall } from '../tools/ToolProvider';
import { detectSalesforceTaskMode, TaskModeResult } from './taskModeDetector';
import { loadAllSalesforceContext } from './instructionLoader';
import {
  buildSystemPrompt,
  buildModeSection,
  buildInitialPrompt,
  buildObservationPrompt,
  buildRejectedAnswerPrompt,
  buildReflectionPrompt,
  INVALID_JSON_PROMPT
} from './prompts';
import {
  AgentAction,
  AgentConfig,
  ActionResult,
  ChatMessage,
  IterationRecord,
  AGENT_ACTION_SCHEMA
} from '../types/agentTypes';

const JSON_RETRIES = 2;
const ANSWER_VALIDATION_RETRIES = 2;

/**
 * Validate a final answer against the session history.
 * Returns claim words that have no matching successful action ([] = valid).
 * created/updated/modified/wrote/saved require a successful write_file;
 * ran/executed/tested/deployed require a successful run_command.
 */
export function validateFinalAnswer(answer: string, hadWrite: boolean, hadRun: boolean): string[] {
  const violations: string[] = [];
  const writeClaims = answer.match(/\b(created|updated|modified|wrote|saved)\b/gi) ?? [];
  const runClaims = answer.match(/\b(ran|executed|tested|deployed)\b/gi) ?? [];
  if (writeClaims.length > 0 && !hadWrite) {
    violations.push(...new Set(writeClaims.map(w => w.toLowerCase())));
  }
  if (runClaims.length > 0 && !hadRun) {
    violations.push(...new Set(runClaims.map(w => w.toLowerCase())));
  }
  return violations;
}

/**
 * Core recursive loop:
 * Goal → Think → Act → Observe → Reflect → Improve Plan → Repeat (max N iterations).
 */
export async function runAgentLoop(
  goal: string,
  workspaceRoot: string,
  config: AgentConfig,
  output: vscode.OutputChannel,
  progress: vscode.Progress<{ message?: string }>,
  token: vscode.CancellationToken
): Promise<void> {
  const client = createModelProvider(config);
  const memory = new AgentMemory(workspaceRoot);
  await memory.init();

  // Tool registry: native tools now; MCP tools plug in here later.
  const registry = new ToolRegistry();
  registry.registerProvider(new NativeToolProvider(workspaceRoot));
  registry.registerProvider(new McpToolProvider());

  progress.report({ message: `Checking model provider (${client.name})...` });
  await client.healthCheck(); // Throws OllamaError with a clear message if not available.

  // 1. Detect the Salesforce task mode from the goal.
  const modeResult: TaskModeResult = detectSalesforceTaskMode(goal);
  output.appendLine(`Task mode: ${modeResult.mode}`);
  output.appendLine(`  agent: ${modeResult.agentName || '(none)'} | prompt: ${modeResult.promptName || '(none)'} | skills: ${modeResult.skillNames.join(', ') || '(none)'}`);
  output.appendLine(`  allowed actions: ${modeResult.allowedActions.join(', ')}`);

  // 2. Load .codeloop instructions for the detected mode (missing files load as '').
  progress.report({ message: 'Loading Salesforce instructions...' });
  const sfContext = await loadAllSalesforceContext(workspaceRoot, {
    agentName: modeResult.agentName,
    promptName: modeResult.promptName,
    skillNames: modeResult.skillNames
  });
  output.appendLine(
    sfContext.combined
      ? `Loaded .codeloop context (${sfContext.combined.length} chars, ${sfContext.skills.length} skill file(s)).`
      : 'No .codeloop instruction files found — using base prompt only.'
  );

  // Memory-informed planning: rules, summary, patterns, and past Salesforce
  // decisions are all read before the first step.
  const [rules, summary, patterns, decisions] = await Promise.all([
    memory.read(MEMORY_FILES.projectRules),
    memory.read(MEMORY_FILES.projectSummary),
    memory.read(MEMORY_FILES.learnedPatterns),
    memory.read(MEMORY_FILES.salesforceDecisions)
  ]);

  // 3. System prompt = base rules + loaded Salesforce context.
  const modeSection = buildModeSection(modeResult.mode, modeResult.allowedActions);
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(sfContext.combined) },
    // Recent decisions only (tail) to keep the prompt concise.
    { role: 'user', content: buildInitialPrompt(goal, modeSection, rules, summary, patterns, decisions.slice(-2000)) }
  ];

  const history: IterationRecord[] = [];
  const seenActions = new Map<string, string>(); // signature → previous observation
  let hadSuccessfulWrite = false;
  let hadSuccessfulRun = false;
  let answerRejections = 0;
  let finalAnswer: string | undefined;
  let finalEvidence: string[] = [];

  for (let i = 1; i <= config.maxIterations; i++) {
    if (token.isCancellationRequested) {
      output.appendLine('\nCancelled by user.');
      break;
    }

    progress.report({ message: `Iteration ${i}/${config.maxIterations}: thinking...` });
    output.appendLine(`\n--- Iteration ${i}/${config.maxIterations} ---`);

    // THINK: get a JSON action from the model (structured output + retries).
    const action = await getAction(client, messages, output, memory, goal, i);
    if (!action) {
      await memory.saveFailedAttempt(goal, `Iteration ${i}: model kept returning invalid JSON. Aborted.`);
      throw new Error('Model returned invalid JSON repeatedly. Try again or check the model.');
    }

    output.appendLine(`Thought: ${action.thought}`);
    output.appendLine(`Action: ${action.action}${describeAction(action)}`);
    messages.push({ role: 'assistant', content: JSON.stringify(action) });

    // FINISH? Validate the answer against what actually happened.
    if (action.action === 'final_answer') {
      const answerText = (action.answer ?? '').trim();
      // Empty answers are rejected — the model must actually answer.
      if (!answerText && answerRejections < ANSWER_VALIDATION_RETRIES) {
        answerRejections++;
        output.appendLine('Final answer REJECTED (empty answer text). Asking for a complete answer...');
        messages.push({
          role: 'user',
          content:
            'Your final_answer had no "answer" text. Respond again with a final_answer JSON whose "answer" field contains the complete answer, based only on the files you actually read in this session (see ACTIONS COMPLETED SO FAR above — you already read the target class).'
        });
        continue;
      }
      const answer = answerText || '(no answer text provided)';
      const violations = validateFinalAnswer(answer, hadSuccessfulWrite, hadSuccessfulRun);
      if (violations.length > 0 && answerRejections < ANSWER_VALIDATION_RETRIES) {
        answerRejections++;
        output.appendLine(
          `Final answer REJECTED (claims without matching action: ${violations.join(', ')}). Asking for a corrected answer...`
        );
        await memory.saveFailedAttempt(
          goal,
          `Iteration ${i}: final answer claimed "${violations.join(', ')}" with no successful write_file/run_command. Rejected.`
        );
        messages.push({ role: 'user', content: buildRejectedAnswerPrompt(violations) });
        continue;
      }
      if (violations.length > 0) {
        output.appendLine(`WARNING: answer still contains unverified claims (${violations.join(', ')}). Verify manually.`);
      }
      finalAnswer = answer;
      finalEvidence = filterEvidence(action.evidence, history);
      break;
    }

    // 4. MODE GUARD: block actions outside the mode's allowlist.
    if (!modeResult.allowedActions.includes(action.action)) {
      const observation = `Action "${action.action}" was BLOCKED due to task mode ${modeResult.mode}. Allowed actions: ${modeResult.allowedActions.join(', ')}. Choose a valid action and stay on the original goal.`;
      output.appendLine(`Blocked: ${action.action} (mode ${modeResult.mode})`);
      await memory.saveFailedAttempt(goal, `Iteration ${i}: action "${action.action}" blocked in ${modeResult.mode} mode.`);
      messages.push({ role: 'user', content: buildObservationPrompt(goal, i, config.maxIterations, observation) });
      continue;
    }

    // DUPLICATE GUARD: don't re-run an identical action; replay the earlier result.
    const signature = `${action.action}|${action.path ?? ''}|${action.query ?? ''}|${action.command ?? ''}`;
    const previous = seenActions.get(signature);
    if (previous && (action.action === 'read_file' || action.action === 'search_code')) {
      const observation = `You already performed this exact action earlier. Previous result:\n${previous}`;
      output.appendLine('Duplicate action — replayed earlier observation.');
      messages.push({ role: 'user', content: buildObservationPrompt(goal, i, config.maxIterations, observation) });
      continue;
    }

    // ACT + OBSERVE (through the tool registry; allowlist enforced again as a safety net)
    progress.report({ message: `Iteration ${i}: ${action.action}...` });
    const result = await registry.execute(toToolCall(action), modeResult.allowedActions);
    output.appendLine(`Observation (${result.success ? 'ok' : 'FAILED'}): ${truncate(result.observation, 500)}`);
    seenActions.set(signature, result.observation);

    if (result.success && action.action === 'write_file') {
      hadSuccessfulWrite = true;
    }
    if (result.success && action.action === 'run_command') {
      hadSuccessfulRun = true;
    }

    history.push({
      iteration: i,
      thought: action.thought,
      action: action.action,
      detail: describeAction(action),
      success: result.success,
      observation: truncate(result.observation, 300)
    });

    if (!result.success) {
      await memory.saveFailedAttempt(
        goal,
        `Iteration ${i}: ${action.action}${describeAction(action)} → ${truncate(result.observation, 300)}`
      );
    }

    // REFLECT + IMPROVE PLAN: feed the observation back, with a session recap
    // so the model does not forget files it already read.
    const recap = history.map(h => `${h.action}${h.detail} [${h.success ? 'ok' : 'fail'}]`).join('; ');
    messages.push({
      role: 'user',
      content: buildObservationPrompt(
        goal,
        i,
        config.maxIterations,
        `${result.observation}\n\nACTIONS COMPLETED SO FAR: ${recap}`
      )
    });
  }

  // Wrap up.
  if (finalAnswer) {
    output.appendLine(`\n=== FINAL ANSWER ===\n${finalAnswer}`);
    if (finalEvidence.length > 0) {
      output.appendLine(`\nEvidence files:\n${finalEvidence.map(e => `- ${e}`).join('\n')}`);
    }
    vscode.window.showInformationMessage('CodeLoop AI: Done. See "CodeLoop AI" output for the answer.');
  } else if (!token.isCancellationRequested) {
    output.appendLine(`\nReached max iterations (${config.maxIterations}) without a final answer.`);
    vscode.window.showWarningMessage('CodeLoop AI: Reached max iterations without finishing.');
  }

  // Structured reflection → reflections.md; decisions → salesforce-decisions.md.
  progress.report({ message: 'Saving reflection...' });
  const filesRead = history
    .filter(h => h.success && h.action === 'read_file')
    .map(h => h.detail.replace(/[()]/g, '').trim());
  const actionsTaken = history.map(h => `${h.action}${h.detail} [${h.success ? 'ok' : 'fail'}]`);
  const finalResult = finalAnswer ?? (token.isCancellationRequested ? 'Cancelled by user.' : 'No final answer (max iterations reached).');

  // Ask the model for the three labeled reflection lines; degrade gracefully.
  let whatWorked = '(not captured)';
  let whatFailed = '(not captured)';
  let reusableLearning = '';
  try {
    const historyText = history.length
      ? history.map(h => `${h.iteration}. [${h.success ? 'ok' : 'fail'}] ${h.action}${h.detail} → ${h.observation}`).join('\n')
      : '(no actions executed)';
    const reflection = await client.chat(
      [
        { role: 'system', content: 'You are a concise engineering coach.' },
        {
          role: 'user',
          content: buildReflectionPrompt(goal, historyText + (finalAnswer ? `\nFinal answer: ${truncate(finalAnswer, 300)}` : ''))
        }
      ],
      { temperature: 0.3 }
    );
    whatWorked = extractLabeled(reflection, 'What worked') ?? whatWorked;
    whatFailed = extractLabeled(reflection, 'What failed') ?? whatFailed;
    reusableLearning = extractLabeled(reflection, 'Reusable learning') ?? '';
  } catch {
    output.appendLine('Could not generate a reflection (Ollama call failed). Saving facts only.');
  }

  await memory.saveStructuredReflection({
    goal,
    mode: modeResult.mode,
    filesRead,
    actionsTaken,
    finalResult,
    whatWorked,
    whatFailed,
    reusableLearning: reusableLearning || '(none)'
  });
  output.appendLine('\nReflection saved to .agent-memory/reflections.md');

  if (reusableLearning && history.some(h => h.success)) {
    await memory.saveLearnedPattern(reusableLearning);
  }

  // Salesforce architecture decisions get their own memory file.
  if (finalAnswer && isArchitectureDecision(modeResult.mode, finalAnswer)) {
    await memory.saveSalesforceDecision(goal, modeResult.mode, finalAnswer);
    output.appendLine('Decision saved to .agent-memory/salesforce-decisions.md');
  }
}

/** Modes/answers that represent Salesforce architecture decisions. */
const ARCHITECTURE_MODES = ['FLOW_MIGRATION', 'DEPLOYMENT_REVIEW', 'INTEGRATION_API'];

export function isArchitectureDecision(mode: string, answer: string): boolean {
  if (ARCHITECTURE_MODES.includes(mode)) {
    return true;
  }
  return /\b(architecture|trigger framework|selector layer|service layer|domain layer|recommended apex design|migrate to apex|dto)\b/i.test(answer);
}

/** Pull "Label: text" out of the model's reflection; undefined when absent. */
export function extractLabeled(text: string, label: string): string | undefined {
  const match = text.match(new RegExp(`${label}\\s*:\\s*(.+)`, 'i'));
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : undefined;
}

/** Keep only evidence entries matching files the agent actually read or searched. */
function filterEvidence(evidence: string[] | undefined, history: IterationRecord[]): string[] {
  if (!evidence || evidence.length === 0) {
    return [];
  }
  const observedFiles = history
    .filter(h => h.success && h.action === 'read_file')
    .map(h => h.detail.replace(/[()\s]/g, ''));
  return evidence.filter(e => observedFiles.some(f => f.includes(e) || e.includes(f)));
}

/** Ask the model for the next action; structured output + retry when JSON is invalid. */
async function getAction(
  client: ModelProvider,
  messages: ChatMessage[],
  output: vscode.OutputChannel,
  memory: AgentMemory,
  goal: string,
  iteration: number
): Promise<AgentAction | undefined> {
  for (let attempt = 0; attempt <= JSON_RETRIES; attempt++) {
    const raw = await client.chat(messages, { format: AGENT_ACTION_SCHEMA, temperature: 0.1 });
    const action = parseAction(raw);
    if (action) {
      return action;
    }
    output.appendLine(`Invalid JSON from model (attempt ${attempt + 1}/${JSON_RETRIES + 1}). Retrying...`);
    await memory.saveFailedAttempt(
      goal,
      `Iteration ${iteration}: invalid JSON from model (attempt ${attempt + 1}): ${raw.slice(0, 200)}`
    );
    messages.push({ role: 'assistant', content: raw });
    messages.push({ role: 'user', content: INVALID_JSON_PROMPT });
  }
  return undefined;
}

/** Parse model output into an AgentAction. Tolerates code fences and surrounding text. */
export function parseAction(raw: string): AgentAction | undefined {
  let text = raw.trim();
  // Strip markdown code fences if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    text = fence[1].trim();
  }
  // Fall back to the first {...} block.
  if (!text.startsWith('{')) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) {
      return undefined;
    }
    text = text.slice(start, end + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const a = parsed as Partial<AgentAction>;
  const validActions = ['read_file', 'search_code', 'write_file', 'run_command', 'final_answer'];
  if (!a.action || !validActions.includes(a.action)) {
    return undefined;
  }

  // Backward compatibility: accept parameters at top level (old format)
  // or inside "input" (new format), hoisting input values when needed.
  const input =
    typeof a.input === 'object' && a.input !== null && !Array.isArray(a.input)
      ? (a.input as Record<string, unknown>)
      : undefined;
  const pick = (top: unknown, key: string): string | undefined => {
    if (typeof top === 'string') return top;
    const v = input?.[key];
    return typeof v === 'string' ? v : undefined;
  };
  const path = pick(a.path, 'path');
  const query = pick(a.query, 'query');
  const content = pick(a.content, 'content');
  const command = pick(a.command, 'command');

  // Validate required fields per action.
  if (a.action === 'read_file' && !path) return undefined;
  if (a.action === 'search_code' && !query) return undefined;
  if (a.action === 'write_file' && (!path || content === undefined)) return undefined;
  if (a.action === 'run_command' && !command) return undefined;

  return {
    thought: typeof a.thought === 'string' ? a.thought : '(no thought provided)',
    action: a.action,
    path,
    query,
    content,
    command,
    answer: a.answer,
    evidence: Array.isArray(a.evidence) ? a.evidence.filter((e): e is string => typeof e === 'string') : undefined,
    input
  };
}

/** Map an AgentAction (old top-level fields or new input object) to a ToolCall. */
export function toToolCall(action: AgentAction): ToolCall {
  const input: Record<string, unknown> = { ...(action.input ?? {}) };
  if (action.path !== undefined) input.path = action.path;
  if (action.query !== undefined) input.query = action.query;
  if (action.content !== undefined) input.content = action.content;
  if (action.command !== undefined) input.command = action.command;
  // The model's thought doubles as the approval-dialog reason.
  input.reason = action.thought;
  return { name: action.action, input };
}

function describeAction(action: AgentAction): string {
  if (action.path) return ` (${action.path})`;
  if (action.query) return ` ("${action.query}")`;
  if (action.command) return ` (${action.command})`;
  return '';
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}
