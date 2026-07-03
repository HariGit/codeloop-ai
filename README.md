# CodeLoop AI

A local recursive coding agent for VS Code, powered by your local Ollama model (`qwen3-coder:latest`). No cloud, no API keys — the agent "learns" through markdown memory files, not model training.

## Agent loop

Goal → Think → Act → Observe → Reflect → Improve Plan → Repeat (max 8 iterations)

## Requirements

- VS Code 1.85+
- Node.js 18+
- [Ollama](https://ollama.com) running locally: `ollama serve`
- The model: `ollama pull qwen3-coder:latest`

## Setup

```bash
npm install
npm run compile
```

Then press `F5` in VS Code to launch the Extension Development Host.

## Usage

1. Open a workspace folder.
2. Run **CodeLoop AI: Start Agent** from the Command Palette (`Ctrl+Shift+P`).
3. Enter a coding goal, e.g. *"Explain how AccountTriggerHandler works and find related test classes."*
4. Watch progress in the **CodeLoop AI** output channel.

For Salesforce projects, run **CodeLoop AI: Scan Salesforce Project** first to build a project summary the agent uses for planning.

## Actions and safety

| Action | Confirmation required |
|---|---|
| `read_file` | No (automatic) |
| `search_code` | No (automatic) |
| `write_file` | Yes — modal dialog before any file change |
| `run_command` | Yes — modal dialog before execution; destructive/remote-install commands are blocked |
| `final_answer` | — |

The agent never deletes files, never runs install scripts from unknown sources, and refuses paths outside the workspace.

## Memory files (`.agent-memory/`)

Created automatically in your workspace:

| File | Purpose |
|---|---|
| `project-rules.md` | Your rules — read before planning. Edit this to steer the agent. |
| `reflections.md` | Reflection saved after every session |
| `failed-attempts.md` | Failed actions, so they aren't repeated |
| `learned-patterns.md` | Reusable lessons |
| `project-summary.md` | Output of the Salesforce scanner |

## Settings

| Setting | Default |
|---|---|
| `codeloopAi.ollamaEndpoint` | `http://localhost:11434/api/chat` |
| `codeloopAi.model` | `qwen3-coder:latest` |
| `codeloopAi.maxIterations` | `8` (capped at 8) |

## Salesforce awareness

The agent follows Trigger → Domain → Service → Selector, keeps SOQL out of loops, uses selector classes, avoids hardcoded emails (Custom Labels), separates request/response DTOs, and checks test classes before changing Apex logic. The scanner covers classes, triggers, lwc, flows, labels, customMetadata, and permissionsets under `force-app/main/default/`.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Cannot reach Ollama" | Start Ollama: `ollama serve` |
| "Model not found" | `ollama pull qwen3-coder:latest` |
| "Model returned invalid JSON repeatedly" | Retry; the agent auto-retries twice per step |
| "No workspace folder open" | Open a folder before starting the agent |
