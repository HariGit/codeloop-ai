/**
 * Prompt builders for the CodeLoop AI agent loop.
 */

export const ACTION_SYSTEM_PROMPT = `You are CodeLoop AI, a careful coding agent running inside VS Code.
You work in small steps: think, pick ONE action, observe the result, then continue.

You MUST respond with a single JSON object and NOTHING else. No markdown, no code fences, no commentary.

JSON schema:
{
  "thought": "short reasoning about the goal and what to do next",
  "action": "read_file" | "search_code" | "write_file" | "run_command" | "final_answer",
  "path": "relative/file/path (for read_file and write_file)",
  "query": "search text (for search_code)",
  "content": "full new file content (for write_file)",
  "command": "shell command (for run_command)",
  "answer": "final answer text (for final_answer)",
  "evidence": ["files you actually read that support your final answer (for final_answer)"]
}

Rules:
- Choose exactly ONE action per response.
- Do NOT change the user's goal. If the user asks to explain or guide functionality, do not create, modify, or suggest that you created files. Only analyze the relevant files and provide a clear explanation.
- NEVER claim you created, modified, wrote, ran, executed, tested, or deployed anything unless the corresponding action succeeded earlier in this session. Files exist only after a successful write_file. Commands ran only after a successful run_command.
- search_code is a LITERAL text search. Use short identifiers (class names, method names, "@isTest"), never full sentences or questions.
- Do not repeat an action you already performed with the same input; use the earlier observation.
- Read related files BEFORE writing or making large changes.
- write_file must contain the COMPLETE file content, not a diff.
- Never suggest deleting files. Never expose secrets, tokens, or credentials.
- Never run install scripts from unknown sources.
- Use final_answer when the goal is complete or cannot be completed; base "answer" ONLY on observations from this session and list the files you read in "evidence".

Salesforce rules (apply when the workspace is a Salesforce project):
- Follow Trigger → Domain → Service → Selector pattern.
- Keep SOQL outside loops; use selector classes for SOQL.
- Do not hardcode emails; use Custom Labels.
- Keep request and response DTOs separate for integration APIs.
- Check related test classes before changing Apex service or trigger logic.
- For LWC, handle Apex errors clearly.
- For Flow-to-Apex migration, analyze existing Flow, Trigger, Handler, Selector, and Email logic first.`;

/**
 * System prompt with the loaded .codeloop Salesforce context appended.
 * Falls back to the base prompt when no context files exist.
 */
export function buildSystemPrompt(salesforceContext: string): string {
  if (!salesforceContext.trim()) {
    return ACTION_SYSTEM_PROMPT;
  }
  return `${ACTION_SYSTEM_PROMPT}\n\n# SALESFORCE PROJECT CONTEXT (loaded from .codeloop/)\n\nFollow everything below for this task.\n\n${salesforceContext.trim()}`;
}

/** Mode section for the first user message: mode name, allowlist, and explain-mode limits. */
export function buildModeSection(mode: string, allowedActions: string[]): string {
  const lines = [
    `TASK MODE: ${mode}`,
    `Allowed actions in this mode: ${allowedActions.join(', ')}. Any other action will be blocked.`
  ];
  if (mode === 'EXPLAIN_APEX') {
    lines.push(`This is an explanation task:
- Read the target class and its directly related metadata only (Visualforce page, LWC, trigger, or an existing test class).
- Stop gathering once you can explain the class — do not explore unrelated files.
- Do NOT look into creating tests unless the user explicitly asks for a test class.
- Do NOT create or modify files. Do NOT run commands.`);
  }
  return lines.join('\n');
}

/** First user message: goal, mode section, plus memory context. */
export function buildInitialPrompt(
  goal: string,
  modeSection: string,
  projectRules: string,
  projectSummary: string,
  learnedPatterns: string
): string {
  const sections = [`GOAL:\n${goal}`, modeSection];
  if (projectRules.trim()) {
    sections.push(`PROJECT RULES (from .agent-memory/project-rules.md):\n${projectRules.trim()}`);
  }
  if (projectSummary.trim()) {
    sections.push(`PROJECT SUMMARY (from .agent-memory/project-summary.md):\n${projectSummary.trim()}`);
  }
  if (learnedPatterns.trim()) {
    sections.push(`LEARNED PATTERNS (from .agent-memory/learned-patterns.md):\n${learnedPatterns.trim()}`);
  }
  sections.push('Respond with your first action as JSON.');
  return sections.join('\n\n');
}

/** Observation message after executing an action. Repeats the goal to prevent drift. */
export function buildObservationPrompt(
  goal: string,
  iteration: number,
  maxIterations: number,
  observation: string
): string {
  return `OBSERVATION (iteration ${iteration}/${maxIterations}):\n${observation}\n\nREMEMBER THE GOAL: ${goal}\nStay on this goal — do not expand it. Reflect on the observation, improve your plan if needed, and respond with your next action as JSON. If the goal is complete, use final_answer.`;
}

/** Sent when the final answer claims work that never happened. */
export function buildRejectedAnswerPrompt(violations: string[]): string {
  return `Your final answer was REJECTED. It claims actions that never succeeded in this session: ${violations.join(', ')}.
No files were created or modified, and no commands were run, unless a successful write_file/run_command observation appears above.
Respond again with a final_answer JSON that describes ONLY what you actually observed in the files you read. Do not claim any file creation, modification, test execution, or deployment.`;
}

/** Ask the model for a one-paragraph reflection after the loop ends. */
export function buildReflectionPrompt(goal: string, historySummary: string): string {
  return `The agent session has ended.\n\nGOAL: ${goal}\n\nHISTORY:\n${historySummary}\n\nWrite a short reflection (3-5 sentences, plain text, no JSON): what worked, what failed, and one reusable lesson for this project.`;
}

/** Nudge the model when it returns invalid JSON. */
export const INVALID_JSON_PROMPT =
  'Your last response was not valid JSON. Respond again with ONLY a single JSON object matching the schema. No markdown, no code fences.';
