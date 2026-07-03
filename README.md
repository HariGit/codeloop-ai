# CodeLoop AI

A Salesforce-aware recursive coding agent for VS Code. Runs fully local by default with your own Ollama model (`qwen3-coder:latest`) — no cloud, no API keys, no data leaving your machine. Optionally switch to Claude (Anthropic), OpenAI, or VS Code's built-in Language Model API (Copilot). The agent "learns" through markdown memory files — not model training.

## How it works

```
Goal → Think → Act → Observe → Reflect → Improve Plan → Repeat (per-mode iteration limit)
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
| **CodeLoop AI: Architecture Overview** | object / class / feature / flow / module | 18-section architecture document with Mermaid diagrams |
| **CodeLoop AI: Analyze Apex Debug Log** | log file path | LogLens analysis: root cause, exceptions, governor risks |
| **CodeLoop AI: Deployment Review** | metadata / release notes | Risk assessment with validate/deploy commands |
| **CodeLoop AI: Scan Salesforce Project** | — | Deep metadata scan saved to `.agent-memory/project-summary.md` |

Output appears in **View → Output → CodeLoop AI**.

## Task modes

The goal is classified before the loop starts. Each mode selects an agent role, prompt template, skills, an action allowlist, and an iteration limit:

| Mode | Trigger keywords | Actions allowed | Max iterations |
|---|---|---|---|
| EXPLAIN_APEX | explain, guide, understand, functionality | read-only | 4 |
| REVIEW_APEX | review, best practices, governor limits, bulkify | read-only | 6 |
| MODIFY_APEX | fix, update, refactor, change, implement | + editing | 8 |
| CREATE_TEST | test class, coverage, unit test | + editing + run | 10 |
| FLOW_MIGRATION | flow to apex, migrate/convert/analyze flow | read-only | 8 |
| LWC_WORK | lwc, component, wire, apex call | + editing | 8 |
| INTEGRATION_API | rest api, endpoint, dto, integration | + editing | 8 |
| DEPLOYMENT_REVIEW | deployment, package.xml, release | read-only | 6 |
| DEBUG_LOG_ANALYSIS | debug log, apex log, log analysis | read-only + log tools | 6 |
| ARCHITECTURE_OVERVIEW | architecture, system design, HLD, LLD | read-only | 8 |
| GENERAL_SALESFORCE | (default) | read-only | 6 |

Read-only modes gain editing/run access only when the goal explicitly asks (e.g. "review the class **and fix the code**"). Actions outside the allowlist are blocked and the model is told to choose a valid one. All limits are configurable (`codeloopAi.loop.*`), capped by `absoluteMaxIterations` (default 20).

## Salesforce instruction system (`.codeloop/`)

Copilot-style custom instructions, loaded automatically per task mode and injected into the system prompt:

```
.codeloop/
  instructions/salesforce-instructions.md   ← global standards (always loaded)
  agents/*.agent.md                         ← 9 role definitions (architect, apex, lwc,
                                              flow-migration, integration, tester,
                                              devops, security, architecture-overview)
  prompts/*.prompt.md                       ← 7 reusable prompt templates
  skills/*.md                               ← 8 best-practice references (incl.
                                              system-design and hld-lld)
```

Copy this folder into each Salesforce project you analyze. Edit the files to change how the agent works — no code changes needed. Missing files are skipped silently.

## Built-in Salesforce standards

Trigger → Domain → Service → Selector pattern; SOQL/DML outside loops; selector classes for SOQL; bulkified logic; no hardcoded emails/ids/URLs (Custom Labels / Custom Metadata); separate request/response DTOs; test classes checked before Apex changes; clear LWC error handling; full Flow analysis before migration.

## Tools and safety

| Tool | Approval |
|---|---|
| `read_file` | automatic (sensitive paths blocked: .env, keys, .git, .sf, credential filenames) |
| `search_code` | automatic (Salesforce-aware, noise excluded, max 25 results) |
| `create_file` | dialog with preview — new files only, fails if the file exists |
| `replace_range` | dialog with BEFORE/AFTER preview of the exact lines |
| `apply_patch` | dialog with the unified diff |
| `replace_file` / `write_file` | dialog flagged FULL OVERWRITE (HIGH risk) |
| `run_command` | dialog with command, reason, risk level (LOW/MEDIUM/HIGH) |
| LogLens tools | automatic (read-only log analysis) |

The model is instructed to prefer `replace_range`/`apply_patch` over full overwrites for existing files.

**Always blocked, never executed:** `rm -rf`, `del /s`, `format`, `mkfs`, `git reset --hard`, `git clean -f`, remote scripts piped to shell, `npm install` from URLs/tarballs.

**Always HIGH risk (approval required):** `sfdx force:source:deploy`, `sf project deploy`, org data changes, `npm install`, `git push`.

Every approve/reject/block decision is logged to `.agent-memory/action-history.md`.

## Anti-hallucination guards

- **Final answer validation** — claims of *created/updated/modified/wrote* require a successful edit this session; *ran/executed/tested/deployed* require a successful run_command. Violations are rejected.
- **Evidence files** — final answers list the files actually read, validated against session history.
- **Goal anchoring + session recap** — every observation repeats the goal and lists the actions already completed.
- **Duplicate guard** — repeated identical reads/searches replay the earlier result.
- **No-progress stop** — consecutive blocked/duplicate iterations end the run early.
- **Forced wrap-up** — if iterations run out, one extra call demands a final answer from gathered context; you never get nothing.
- **Structured output** — Ollama's JSON-schema `format` constrains action responses.

## Apex LogLens (debug log analysis)

The extension — not the LLM — parses Apex debug logs (`CODE_UNIT`, `METHOD_ENTRY/EXIT`, `SOQL`, `DML`, `EXCEPTION_THROWN`, `FATAL_ERROR`, `LIMIT_USAGE_FOR_NS`) and hands the model structured reports: entry point, execution timeline, method call tree, SOQL/DML lists, exceptions, governor limit usage, risk findings (repeated-SOQL/DML loop patterns, limits near thresholds), and recommendations.

Tools: `analyze_debug_log`, `analyze_latest_apex_logs`, `explain_log_flow`, `find_log_exception`, `find_governor_risk`. The final answer ends with Root Cause → Recommended Fix → Evidence Files.

## Architecture Overview

**CodeLoop AI: Architecture Overview** pre-scans the metadata around your scope (classes, triggers, selectors/services/handlers/domains, LWC, Visualforce, flows, objects, custom metadata, labels, REST resources) and injects a component inventory with dependency hints into the prompt. The model reads the key files and produces an 18-section document: Executive Summary through Recommended Target Architecture, ending with Mermaid flowchart and sequence diagrams and Evidence Files. Strictly read-only.

## Salesforce-aware search

`search_code` understands identifiers: searching `AccountService` returns the exact class file, `AccountServiceTest`/`AccountService_Test`, Visualforce pages with `controller="AccountService"`, a matching LWC folder, and matching Flows — before literal references ranked by metadata type. Noise (`.sf`, `.git`, `node_modules`, `out`, `dist`, `.agent-memory`, `maxRevision.json`) is excluded.

## Project scanner

**Scan Salesforce Project** counts all metadata types and produces: object summaries (fields/record types/validation rules), trigger summaries (object + events), flow summaries (object/type/status), an Apex risk scan (SOQL/DML in loops, hardcoded emails/URLs/Ids — top 50 warnings), and test-coverage mapping (classes missing `<Name>Test`). The summary feeds the agent's planning.

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

### Connecting to Claude (Anthropic)

1. Create an API key at [console.anthropic.com](https://console.anthropic.com) (API Keys → Create Key; billing required — pay-per-use, separate from a Claude.ai subscription).
2. In VS Code settings (`Ctrl+,` → search "codeloop") or settings.json:

```json
"codeloopAi.provider": "anthropic",
"codeloopAi.anthropicApiKey": "sk-ant-your-key-here",
"codeloopAi.model": "claude-sonnet-4-5"
```

3. Run any CodeLoop command — everything works the same, only the model changes. A wrong key shows "Anthropic API key rejected (401)"; a missing key names the exact setting to fix.

Trade-offs: Claude follows the JSON action format and section templates far better than small local models (fewer retries, better answers), but your code leaves the machine and each run costs tokens. Switch back anytime with `"codeloopAi.provider": "ollama"`. Treat the API key like a password — it lives in your user settings; never commit it.

OpenAI works the same way with `codeloopAi.openAiApiKey` and e.g. `"codeloopAi.model": "gpt-4o"`; the VS Code LM provider needs no key, just VS Code 1.90+ with Copilot signed in.

## Settings

| Setting | Default |
|---|---|
| `codeloopAi.provider` | `ollama` |
| `codeloopAi.model` | `qwen3-coder:latest` |
| `codeloopAi.ollamaEndpoint` | `http://localhost:11434/api/chat` |
| `codeloopAi.anthropicApiKey` / `openAiApiKey` / `apiKey` | (empty) |
| `codeloopAi.loop.defaultMaxIterations` | `8` |
| `codeloopAi.loop.absoluteMaxIterations` | `20` (hard ceiling) |
| `codeloopAi.loop.modeMaxIterations` | per-mode table above |
| `codeloopAi.loop.jsonRetries` / `answerValidationRetries` | `2` |
| `codeloopAi.loop.noProgressLimit` | `2` |
| `codeloopAi.loop.autoStopExplainAfterFiles` | `true` |

## Typical workflow

1. Open your Salesforce DX project in VS Code (Ollama running).
2. Copy `.codeloop/` into the project and run **Scan Salesforce Project** once.
3. Optionally add rules to `.agent-memory/project-rules.md`.
4. Use the specific commands, or **Start Agent** for anything else.
5. Approve or reject any file edits / commands the agent requests.
6. The agent improves as reflections, patterns, and decisions accumulate in `.agent-memory/`.

## Debugging the extension

- **Output channel** (View → Output → CodeLoop AI): mode, iterations, thoughts, actions, observations, blocked/rejected events, errors.
- **`.agent-memory/failed-attempts.md`** and **`action-history.md`** in the analyzed project explain odd agent behavior.
- **Breakpoints**: open this repo, F5 launches an Extension Development Host with the debugger attached to the TypeScript sources.
- **`npm test`**: 23 fast unit tests for detector/validation/parsing/risk/redaction logic.
- **Isolate Ollama**: `curl http://localhost:11434/api/chat -d '{"model":"qwen3-coder:latest","messages":[{"role":"user","content":"hi"}],"stream":false}'`.

## Testing

```bash
npm test
```

Compiles and runs 23 dependency-free unit tests (`src/test/runTests.ts`). The `vscode` API is stubbed, so tests run in plain Node.

## Packaging

```bash
npm run compile
vsce package
```

`.vscodeignore` keeps the package lean: sources, source maps, `node_modules`, tests, and local memory are excluded; compiled `out/`, `package.json`, `README.md`, and the `.codeloop/` templates are included.

## Architecture

```
src/
  extension.ts                  Entry point: commands, settings → AgentConfig/LoopConfig
  agent/                        THE AGENT
    agentLoop.ts                Core loop: Think→Act→Observe→Reflect; mode/duplicate/
                                no-progress guards, explain auto-stop, final answer
                                validation, forced wrap-up, evidence filtering
    taskModeDetector.ts         Goal → 11 task modes + agent/prompt/skills + allowlist
    instructionLoader.ts        Loads .codeloop/ instructions (safe, traversal-blocked)
    architectureAnalyzer.ts     Pre-scan component inventory for ARCHITECTURE_OVERVIEW
    prompts.ts                  System/mode/observation/rejection/reflection prompts
    responseTemplates.ts        Fixed final-answer formats per mode
    tools.ts                    Tool implementations: read (sensitive-path block),
                                search (SF-aware), create/replace/range/patch edits
                                with approval previews, run_command risk levels
    salesforceScanner.ts        DX scanner: counts, patterns, summaries, risk scan,
                                test mapping
    memory.ts                   .agent-memory files, structured reflections, redaction
  loglens/                      APEX LOGLENS
    logTypes.ts                 Parsed log / analysis types
    debugLogParser.ts           Raw log → structured events/SOQL/DML/exceptions/limits
    logAnalyzer.ts              Call tree, timeline, risk findings, recommendations
    logReportBuilder.ts         Concise reports for the LLM (raw log never sent)
  llm/                          MODEL PROVIDERS (swap via codeloopAi.provider)
    ModelProvider.ts            Interface: name, chat(), healthCheck()
    ProviderFactory.ts          Setting → concrete provider
    OllamaProvider.ts           Local Ollama (default, structured output)
    AnthropicProvider.ts        Claude Messages API
    OpenAIProvider.ts           OpenAI Chat Completions
    VsCodeLanguageModelProvider.ts  vscode.lm / Copilot models
  tools/                        TOOL ABSTRACTION (MCP-ready)
    ToolProvider.ts             ToolCall / ToolResult / ToolProvider interfaces
    ToolRegistry.ts             Registration, discovery, allowlist enforcement
    NativeToolProvider.ts       Routes the 8 built-in tools
    LogLensToolProvider.ts      Routes the 5 debug-log tools
    McpToolProvider.ts          MCP stub — external tools plug in here later
  types/agentTypes.ts           Shared types, action JSON schema, LoopConfig
  test/runTests.ts              Unit tests (npm test)
.codeloop/                      Salesforce instructions: 1 global + 9 agents +
                                7 prompts + 8 skills (editable, no code changes)
.agent-memory/                  Runtime memory in each analyzed project (see Memory)
```

Runtime flow for one command:

```
Command → goal → task mode (allowlist + iteration limit)
        → .codeloop context (+ architecture inventory when relevant) → system prompt
        → LOOP: model returns one JSON action
                → guards (mode / duplicate / no-progress / explain auto-stop)
                → ToolRegistry → native / LogLens tools (approvals + safety blocks)
                → observation (+ session recap + goal anchor) back to model
        → final_answer validated against actual actions → evidence listed
        → memory updated: reflection, decisions, failures, action history
```

Extension seams: a new model provider is one file in `src/llm/` plus a factory case; new tools register in `ToolRegistry`; new agent behavior is a markdown edit in `.codeloop/`.

## License

MIT
