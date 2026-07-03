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
  "answer": "final answer text (for final_answer)"
}

Rules:
- Choose exactly ONE action per response.
- Read related files BEFORE writing or making large changes.
- write_file must contain the COMPLETE file content, not a diff.
- Never suggest deleting files. Never expose secrets, tokens, or credentials.
- Never run install scripts from unknown sources.
- Use final_answer when the goal is complete or cannot be completed; explain clearly in "answer".

Salesforce rules (apply when the workspace is a Salesforce project):
- Follow Trigger → Domain → Service → Selector pattern.
- Keep SOQL outside loops; use selector classes for SOQL.
- Do not hardcode emails; use Custom Labels.
- Keep request and response DTOs separate for integration APIs.
- Check related test classes before changing Apex service or trigger logic.
- For LWC, handle Apex errors clearly.
- For Flow-to-Apex migration, analyze existing Flow, Trigger, Handler, Selector, and Email logic first.`;

/** First user message: goal plus memory context. */
export function buildInitialPrompt(goal: string, projectRules: string, projectSummary: string, learnedPatterns: string): string {
  const sections = [`GOAL:\n${goal}`];
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

/** Observation message after executing an action. */
export function buildObservationPrompt(iteration: number, maxIterations: number, observation: string): string {
  return `OBSERVATION (iteration ${iteration}/${maxIterations}):\n${observation}\n\nReflect on this result, improve your plan if needed, and respond with your next action as JSON. If the goal is complete, use final_answer.`;
}

/** Ask the model for a one-paragraph reflection after the loop ends. */
export function buildReflectionPrompt(goal: string, historySummary: string): string {
  return `The agent session has ended.\n\nGOAL: ${goal}\n\nHISTORY:\n${historySummary}\n\nWrite a short reflection (3-5 sentences, plain text, no JSON): what worked, what failed, and one reusable lesson for this project.`;
}

/** Nudge the model when it returns invalid JSON. */
export const INVALID_JSON_PROMPT =
  'Your last response was not valid JSON. Respond again with ONLY a single JSON object matching the schema. No markdown, no code fences.';
