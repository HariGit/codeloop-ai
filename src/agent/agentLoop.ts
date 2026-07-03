import * as vscode from 'vscode';
import { OllamaClient } from './ollamaClient';
import { AgentMemory, MEMORY_FILES } from './memory';
import { readFile, searchCode, writeFile, runCommand } from './tools';
import {
  ACTION_SYSTEM_PROMPT,
  buildInitialPrompt,
  buildObservationPrompt,
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

  // Memory-informed planning: read rules/summary/patterns before the first step.
  const [rules, summary, patterns] = await Promise.all([
    memory.read(MEMORY_FILES.projectRules),
    memory.read(MEMORY_FILES.projectSummary),
    memory.read(MEMORY_FILES.learnedPatterns)
  ]);

  const messages: ChatMessage[] = [
    { role: 'system', content: ACTION_SYSTEM_PROMPT },
    { role: 'user', content: buildInitialPrompt(goal, rules, summary, patterns) }
  ];

  const history: IterationRecord[] = [];
  let finalAnswer: string | undefined;

  for (let i = 1; i <= config.maxIterations; i++) {
    if (token.isCancellationRequested) {
      output.appendLine('\nCancelled by user.');
      break;
    }

    progress.report({ message: `Iteration ${i}/${config.maxIterations}: thinking...` });
    output.appendLine(`\n--- Iteration ${i}/${config.maxIterations} ---`);

    // THINK: get a JSON action from the model (with retries on invalid JSON).
    const action = await getAction(client, messages, output);
    if (!action) {
      await memory.saveFailedAttempt(goal, `Iteration ${i}: model kept returning invalid JSON. Aborted.`);
      throw new Error('Model returned invalid JSON repeatedly. Try again or check the model.');
    }

    output.appendLine(`Thought: ${action.thought}`);
    output.appendLine(`Action: ${action.action}${describeAction(action)}`);

    // FINISH?
    if (action.action === 'final_answer') {
      finalAnswer = action.answer || '(no answer text provided)';
      break;
    }

    // ACT + OBSERVE
    progress.report({ message: `Iteration ${i}: ${action.action}...` });
    const result = await executeAction(action, workspaceRoot);
    output.appendLine(`Observation (${result.success ? 'ok' : 'FAILED'}): ${truncate(result.observation, 500)}`);

    history.push({
      iteration: i,
      thought: action.thought,
      action: action.action,
      detail: describeAction(action),
      success: result.success,
      observation: truncate(result.observation, 300)
    });

    if (!result.success) {
      await memory.saveFailedAttempt(goal, `Iteration ${i}: ${action.action}${describeAction(action)} → ${truncate(result.observation, 300)}`);
    }

    // REFLECT + IMPROVE PLAN: feed the observation back for the next step.
    messages.push({ role: 'assistant', content: JSON.stringify(action) });
    messages.push({ role: 'user', content: buildObservationPrompt(i, config.maxIterations, result.observation) });
  }

  // Wrap up.
  if (finalAnswer) {
    output.appendLine(`\n=== FINAL ANSWER ===\n${finalAnswer}`);
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
    const reflection = await client.chat([
      { role: 'system', content: 'You are a concise engineering coach.' },
      { role: 'user', content: buildReflectionPrompt(goal, historyText + (finalAnswer ? `\nFinal answer: ${truncate(finalAnswer, 300)}` : '')) }
    ]);
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

/** Ask the model for the next action; retry when JSON is invalid. */
async function getAction(
  client: OllamaClient,
  messages: ChatMessage[],
  output: vscode.OutputChannel
): Promise<AgentAction | undefined> {
  for (let attempt = 0; attempt <= JSON_RETRIES; attempt++) {
    const raw = await client.chat(messages);
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
    answer: a.answer
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
