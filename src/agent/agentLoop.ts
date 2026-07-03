import * as vscode from 'vscode';
import { OllamaClient, AGENT_ACTION_SCHEMA } from './ollamaClient';
import { AgentMemory, MEMORY_FILES } from './memory';
import { readFile, searchCode, writeFile, runCommand } from './tools';
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
  IterationRecord
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
  const client = new OllamaClient(config);
  const memory = new AgentMemory(workspaceRoot);
  await memory.init();

  progress.report({ message: 'Checking Ollama...' });
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

  // Memory-informed planning: read rules/summary/patterns before the first step.
  const [rules, summary, patterns] = await Promise.all([
    memory.read(MEMORY_FILES.projectRules),
    memory.read(MEMORY_FILES.projectSummary),
    memory.read(MEMORY_FILES.learnedPatterns)
  ]);

  // 3. System prompt = base rules + loaded Salesforce context.
  const modeSection = buildModeSection(modeResult.mode, modeResult.allowedActions);
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(sfContext.combined) },
    { role: 'user', content: buildInitialPrompt(goal, modeSection, rules, summary, patterns) }
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
    const action = await getAction(client, messages, output);
    if (!action) {
      await memory.saveFailedAttempt(goal, `Iteration ${i}: model kept returning invalid JSON. Aborted.`);
      throw new Error('Model returned invalid JSON repeatedly. Try again or check the model.');
    }

    output.appendLine(`Thought: ${action.thought}`);
    output.appendLine(`Action: ${action.action}${describeAction(action)}`);
    messages.push({ role: 'assistant', content: JSON.stringify(action) });

    // FINISH? Validate the answer against what actually happened.
    if (action.action === 'final_answer') {
      const answer = action.answer || '(no answer text provided)';
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

    // ACT + OBSERVE
    progress.report({ message: `Iteration ${i}: ${action.action}...` });
    const result = await executeAction(action, workspaceRoot);
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

    // REFLECT + IMPROVE PLAN: feed the observation back for the next step.
    messages.push({ role: 'user', content: buildObservationPrompt(goal, i, config.maxIterations, result.observation) });
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

  // Session reflection → .agent-memory/reflections.md (and patterns if any).
  try {
    progress.report({ message: 'Saving reflection...' });
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
    await memory.saveReflection(goal, reflection);
    output.appendLine('\nReflection saved to .agent-memory/reflections.md');

    // Heuristic: reflections often contain a reusable lesson — store it as a pattern too.
    const lesson = reflection.split('\n').filter(l => l.trim()).pop();
    if (lesson && history.some(h => h.success)) {
      await memory.saveLearnedPattern(lesson.trim());
    }
  } catch {
    output.appendLine('Could not generate a reflection (Ollama call failed). Continuing.');
  }
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
  client: OllamaClient,
  messages: ChatMessage[],
  output: vscode.OutputChannel
): Promise<AgentAction | undefined> {
  for (let attempt = 0; attempt <= JSON_RETRIES; attempt++) {
    const raw = await client.chat(messages, { format: AGENT_ACTION_SCHEMA, temperature: 0.1 });
    const action = parseAction(raw);
    if (action) {
      return action;
    }
    output.appendLine(`Invalid JSON from model (attempt ${attempt + 1}/${JSON_RETRIES + 1}). Retrying...`);
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
  // Validate required fields per action.
  if (a.action === 'read_file' && !a.path) return undefined;
  if (a.action === 'search_code' && !a.query) return undefined;
  if (a.action === 'write_file' && (!a.path || typeof a.content !== 'string')) return undefined;
  if (a.action === 'run_command' && !a.command) return undefined;

  return {
    thought: typeof a.thought === 'string' ? a.thought : '(no thought provided)',
    action: a.action,
    path: a.path,
    query: a.query,
    content: a.content,
    command: a.command,
    answer: a.answer,
    evidence: Array.isArray(a.evidence) ? a.evidence.filter((e): e is string => typeof e === 'string') : undefined
  };
}

/** Route an action to the matching tool (safety rules live in tools.ts). */
async function executeAction(action: AgentAction, workspaceRoot: string): Promise<ActionResult> {
  switch (action.action) {
    case 'read_file':
      return readFile(workspaceRoot, action.path!);
    case 'search_code':
      return searchCode(workspaceRoot, action.query!);
    case 'write_file':
      return writeFile(workspaceRoot, action.path!, action.content!);
    case 'run_command':
      return runCommand(workspaceRoot, action.command!);
    default:
      return { success: false, observation: `Unknown action: ${action.action}` };
  }
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
