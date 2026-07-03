# CodeLoop AI

A Salesforce-aware recursive coding agent for VS Code. Runs fully local by default with your own Ollama model (`qwen3-coder:latest`) — no cloud, no API keys, no data leaving your machine. Optionally switch to Claude (Anthropic), OpenAI, or VS Code's built-in Language Model API (Copilot). The agent "learns" through markdown memory files — not model training.

## How it works

```
Goal → Think → Act → Observe → Reflect → Improve Plan → Repeat (max 8 iterations)
```

Every run: the goal is classified into a task mode → Salesforce instructions are loaded from `.codeloop/` → the model picks one JSON action per iteration → results feed back as observations → a structured reflection is saved to memory.

## Requirements

- VS Code 1.85+
- Node.js 18+
- [Ollama](https://ollama.com) running locally: `ollama serve`
- The model: `ollama pull qwen3-coder:latest`

## Install

```bash
git clone https://github.com/HariGit/codeloop-ai.git
cd codeloop-ai
npm install
npm run compile
```

Run in dev mode with `F5`, or install permanently:

```bash
npm install -g @vscode/vsce
vsce package
code --install-extension codeloop-ai-0.1.0.vsix
```

## Commands

| Command | Input | What it does |
|---|---|---|
| **CodeLoop AI: Start Agent** | free-form goal | Runs the agent with automatic mode detection |
| **CodeLoop AI: Explain Apex Class** | class name | Read-only explanation with a fixed 12-section format |
| **CodeLoop AI: Review Apex Class** | class name | Best-practices / bulkification / security review (read-only) |
| **CodeLoop AI: Create Apex Test Class** | class name | Writes a test class (with your approval) |
| **CodeLoop AI: Analyze Flow Migration** | Flow API name | Analysis + migration plan mapped to the trigger framework |
| **CodeLoop AI: Deployment Review** | metadata / release notes | Risk assessment with validate/deploy commands |
| **CodeLoop AI: Scan Salesforce Project** | — | Scans metadata, saves `.agent-memory/project-summary.md` |

Output appears in **View → Output → CodeLoop AI**.

## Task modes

The goal is classified before the loop starts. Each mode selects an agent role, prompt template, skills, and an action allowlist:

| Mode | Trigger keywords | Actions allowed |
|---|---|---|
| EXPLAIN_APEX | explain, guide, understand, functionality | read-only |
| REVIEW_APEX | review, best practices, governor limits, bulkify | read-only |
| MODIFY_APEX | fix, update, refactor, change, implement | + write |
| CREATE_TEST | test class, coverage, unit test | + write + run |
| FLOW_MIGRATION | flow to apex, migrate/convert/analyze flow | read-only |
| LWC_WORK | lwc, component, wire, apex call | + write |
| INTEGRATION_API | rest api, endpoint, dto, integration | + write |
| DEPLOYMENT_REVIEW | deployment, package.xml, release | read-only |
| GENERAL_SALESFORCE | (default) | read-only |

Read-only modes gain `write_file`/`run_command` only when the goal explicitly asks (e.g. "review the class **and fix the code**"). Actions outside the allowlist are blocked and the model is told to choose a valid one.

## Salesforce instruction system (`.codeloop/`)

Copilot-style custom instructions, loaded automatically per task mode and injected into the system prompt:

```
.codeloop/
  instructions/salesforce-instructions.md   ← global standards (always loaded)
  agents/*.agent.md                         ← 8 role definitions (architect, apex,
                                              lwc, flow-migration, integration,
                                              tester, devops, security)
  prompts/*.prompt.md                       ← 6 reusable prompt templates
  skills/*.md                               ← 6 best-practice references
```

Edit these files to change how the agent works — no code changes needed. Missing files are skipped silently.

## Built-in Salesforce standards

Trigger → Domain → Service → Selector pattern; SOQL/DML outside loops; selector classes for SOQL; bulkified logic; no hardcoded emails/ids/URLs (Custom Labels / Custom Metadata); separate request/response DTOs; test classes checked before Apex changes; clear LWC error handling; full Flow analysis before migration.

## Actions and safety

| Action | Approval |
|---|---|
| `read_file` | automatic |
| `search_code` | automatic |
| `write_file` | dialog: file path, reason, change type, content preview → Approve/Reject |
| `run_command` | dialog: command, reason, risk level (LOW/MEDIUM/HIGH) → Approve/Reject |
| `final_answer` | validated (see below) |

**Always blocked, never executed:** `rm -rf`, `del /s`, `format`, `mkfs`, `git reset --hard`, `git clean -f`, remote scripts piped to shell, `npm install` from URLs/tarballs.

**Always HIGH risk (approval required):** `sfdx force:source:deploy`, `sf project deploy`, org data changes, `npm install`, `git push`.

Every approve/reject/block decision is logged to `.agent-memory/action-history.md`.

## Anti-hallucination guards

- **Final answer validation** — answers claiming *created/updated/modified/wrote* require a successful `write_file` this session; *ran/executed/tested/deployed* require a successful `run_command`. Violations are rejected and the model must answer from observed files only.
- **Evidence files** — final answers list the files actually read, validated against session history.
- **Goal anchoring** — the goal is repeated in every observation to prevent scope drift.
- **Duplicate guard** — repeated identical reads/searches replay the earlier result instead of wasting iterations.
- **Structured output** — Ollama's JSON-schema `format` constrains action responses; invalid JSON is retried and logged.

## Salesforce-aware search

`search_code` understands identifiers: searching `AccountService` returns the exact class file, `AccountServiceTest`/`AccountService_Test`, Visualforce pages with `controller="AccountService"`, a matching LWC folder, and matching Flows — before literal references ranked by metadata type (.cls → .trigger → .page → meta-XML → js/html/css). Noise (`.sf`, `.git`, `node_modules`, `out`, `dist`, `.agent-memory`, `maxRevision.json`) is excluded. Max 25 clean `path:line: text` results.

## Project scanner

**Scan Salesforce Project** detects a DX project (`sfdx-project.json` / `force-app/main/default`), counts classes, triggers, LWC, flows, pages, labels, custom metadata, permission sets, and objects, and detects patterns: Selector/Service/Handler/Domain/Test classes, `@RestResource`, `Database.Batchable`, `Queueable`, `Schedulable`. The summary feeds the agent's planning.

## Memory (`.agent-memory/`)

| File | Purpose |
|---|---|
| `project-rules.md` | Your rules — read before every plan. Edit to steer the agent. |
| `project-summary.md` | Scanner output — read before every plan |
| `learned-patterns.md` | Reusable lessons — read before every plan |
| `salesforce-decisions.md` | Architecture decisions — read before every plan for consistency |
| `reflections.md` | Structured post-task reflection: goal, mode, files read, actions, result, what worked/failed, learning |
| `failed-attempts.md` | Failures incl. invalid JSON and blocked actions |
| `action-history.md` | Audit trail of approved/rejected/blocked actions |

All entries are size-capped and secret-redacted (tokens, passwords, API keys never reach memory files).

## Model providers

Ollama (local) is the default. Switch with `codeloopAi.provider`:

| Provider | Setting requirements |
|---|---|
| `ollama` (default) | Ollama running locally; `codeloopAi.model` = e.g. `qwen3-coder:latest` |
| `anthropic` | `codeloopAi.anthropicApiKey`; `codeloopAi.model` = e.g. `claude-sonnet-4-5` |
| `openai` | `codeloopAi.openAiApiKey`; `codeloopAi.model` = e.g. `gpt-4o` |
| `vscode-lm` | VS Code 1.90+ with GitHub Copilot installed and signed in; `codeloopAi.model` = model family, e.g. `gpt-4o` |

All providers normalize responses to the same format, so the agent loop, safety guards, and memory behave identically regardless of backend. If a provider is not configured, the agent stops with a clear message telling you which setting to fix.

## Settings

| Setting | Default |
|---|---|
| `codeloopAi.provider` | `ollama` |
| `codeloopAi.model` | `qwen3-coder:latest` |
| `codeloopAi.ollamaEndpoint` | `http://localhost:11434/api/chat` |
| `codeloopAi.anthropicApiKey` | (empty — required for provider `anthropic`) |
| `codeloopAi.openAiApiKey` | (empty — required for provider `openai`) |
| `codeloopAi.apiKey` | (empty — fallback if a provider-specific key is unset) |
| `codeloopAi.maxIterations` | `8` (hard cap 8) |

## Typical workflow

1. Open your Salesforce DX project in VS Code (Ollama running).
2. Run **Scan Salesforce Project** once.
3. Optionally add rules to `.agent-memory/project-rules.md` and adjust `.codeloop/` instructions.
4. Use the specific commands (**Explain Apex Class**, **Review Apex Class**, ...) or **Start Agent** for anything else.
5. Approve or reject any file writes / commands the agent requests.
6. Check `.agent-memory/` — the agent gets better as reflections, patterns, and decisions accumulate.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Cannot reach Ollama" | Start Ollama: `ollama serve` |
| "Model not found" | `ollama pull qwen3-coder:latest` |
| "Model returned invalid JSON repeatedly" | Retry; the agent auto-retries and logs to failed-attempts.md |
| "No workspace folder open" | Open a folder before starting |
| Command not in palette | Reload the window after installing the VSIX |
| Answer rejected warnings in output | Working as intended — the model claimed work it didn't do |

## Project structure

```
src/
  extension.ts               VS Code commands and activation
  agent/
    agentLoop.ts             Recursive loop, guards, validation, reflection
    taskModeDetector.ts      Goal → mode + allowlist mapping
    instructionLoader.ts     Loads .codeloop instructions
    responseTemplates.ts     Mode-specific final answer formats
    salesforceScanner.ts     DX metadata scanner
    ollamaClient.ts          Ollama /api/chat client (structured output)
    prompts.ts               System/observation/reflection prompts
    tools.ts                 read/search/write/run + risk assessment
    memory.ts                .agent-memory file management
  types/agentTypes.ts        Shared types
.codeloop/                   Salesforce instructions, agents, prompts, skills
```

## License

MIT
