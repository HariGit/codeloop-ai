import * as vscode from 'vscode';
import { runAgentLoop } from './agent/agentLoop';
import { scanSalesforceProject } from './agent/salesforceScanner';
import { AgentConfig, DEFAULT_LOOP_CONFIG, LoopConfig } from './types/agentTypes';

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('CodeLoop AI');

  context.subscriptions.push(
    vscode.commands.registerCommand('codeloop-ai.startAgent', () => startAgent()),
    vscode.commands.registerCommand('codeloop-ai.explainApexClass', () =>
      startStructured('Apex class name', 'e.g. AccountService', name => `Explain Apex class ${name} functionality.`)
    ),
    vscode.commands.registerCommand('codeloop-ai.reviewApexClass', () =>
      startStructured(
        'Apex class name',
        'e.g. AccountService',
        name => `Review Apex class ${name} for Salesforce best practices, bulkification, SOQL/DML risks, security, and improvements.`
      )
    ),
    vscode.commands.registerCommand('codeloop-ai.createApexTest', () =>
      startStructured('Apex class name', 'e.g. AccountService', name => `Create Apex test class for ${name}.`)
    ),
    vscode.commands.registerCommand('codeloop-ai.analyzeFlowMigration', () =>
      startStructured('Flow API name', 'e.g. Account_After_Save', name => `Analyze Flow ${name} and guide whether it should move to Apex.`)
    ),
    vscode.commands.registerCommand('codeloop-ai.architectureOverview', () =>
      startStructured(
        'Scope: object, Apex class, feature, flow, or module name',
        'e.g. Account / AccountService / Knowledge printable view',
        scope => `Provide architecture overview for ${scope}.`
      )
    ),
    vscode.commands.registerCommand('codeloop-ai.analyzeDebugLog', () =>
      startStructured(
        'Debug log file path (relative to the workspace)',
        'e.g. logs/07L5g00000AbCdE.log',
        logPath => `Analyze Apex debug log ${logPath} and identify the root cause.`
      )
    ),
    vscode.commands.registerCommand('codeloop-ai.deploymentReview', () =>
      startStructured(
        'Metadata or release notes',
        'e.g. AccountService, AccountTrigger, Sales permission set',
        input => `Perform Salesforce deployment review for ${input}.`
      )
    ),
    vscode.commands.registerCommand('codeloop-ai.scanSalesforceProject', () => scanProject()),
    output
  );
}

function getConfig(): AgentConfig {
  const cfg = vscode.workspace.getConfiguration('codeloopAi');
  // Backward compatibility: the legacy maxIterations setting seeds the
  // loop default when codeloopAi.loop.defaultMaxIterations is not set.
  const legacyMax = cfg.get<number>('maxIterations', DEFAULT_LOOP_CONFIG.defaultMaxIterations);
  const absoluteMax = Math.max(1, cfg.get<number>('loop.absoluteMaxIterations', DEFAULT_LOOP_CONFIG.absoluteMaxIterations));
  const loop: LoopConfig = {
    defaultMaxIterations: Math.max(1, cfg.get<number>('loop.defaultMaxIterations', legacyMax)),
    absoluteMaxIterations: absoluteMax,
    jsonRetries: Math.max(0, cfg.get<number>('loop.jsonRetries', DEFAULT_LOOP_CONFIG.jsonRetries)),
    answerValidationRetries: Math.max(0, cfg.get<number>('loop.answerValidationRetries', DEFAULT_LOOP_CONFIG.answerValidationRetries)),
    noProgressLimit: Math.max(1, cfg.get<number>('loop.noProgressLimit', DEFAULT_LOOP_CONFIG.noProgressLimit)),
    autoStopExplainAfterFiles: cfg.get<boolean>('loop.autoStopExplainAfterFiles', DEFAULT_LOOP_CONFIG.autoStopExplainAfterFiles),
    modeMaxIterations: {
      ...DEFAULT_LOOP_CONFIG.modeMaxIterations,
      ...cfg.get<Record<string, number>>('loop.modeMaxIterations', {})
    }
  };
  return {
    provider: cfg.get<AgentConfig['provider']>('provider', 'ollama'),
    endpoint: cfg.get<string>('ollamaEndpoint', 'http://localhost:11434/api/chat'),
    model: cfg.get<string>('model', 'qwen3-coder:latest'),
    apiKey: cfg.get<string>('apiKey', '') || undefined,
    numCtx: cfg.get<number>('ollamaNumCtx', 32768),
    maxIterations: Math.min(loop.defaultMaxIterations, absoluteMax),
    loop
  };
}

function getWorkspaceRoot(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage('CodeLoop AI: No workspace folder open. Open a folder first.');
    return undefined;
  }
  return folder.uri.fsPath;
}

/** Free-form goal (CodeLoop AI: Start Agent). */
async function startAgent(): Promise<void> {
  const goal = await vscode.window.showInputBox({
    title: 'CodeLoop AI',
    prompt: 'What is your coding goal?',
    placeHolder: 'e.g. Explain how AccountTriggerHandler works and find related test classes',
    ignoreFocusOut: true
  });
  if (!goal || !goal.trim()) {
    return;
  }
  await runGoal(goal.trim());
}

/** Salesforce commands: ask one input, build a structured goal, run the same loop. */
async function startStructured(
  promptLabel: string,
  placeHolder: string,
  buildGoal: (input: string) => string
): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: 'CodeLoop AI',
    prompt: promptLabel,
    placeHolder,
    ignoreFocusOut: true
  });
  if (!input || !input.trim()) {
    return;
  }
  await runGoal(buildGoal(input.trim()));
}

/** Shared runner: every command funnels into the same agent loop. */
async function runGoal(goal: string): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    return;
  }

  output.show(true);
  output.appendLine(`\n${'='.repeat(60)}`);
  output.appendLine(`Goal: ${goal}`);
  output.appendLine('='.repeat(60));

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'CodeLoop AI', cancellable: true },
      async (progress, token) => {
        await runAgentLoop(goal, root, getConfig(), output, progress, token);
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(`ERROR: ${message}`);
    vscode.window.showErrorMessage(`CodeLoop AI: ${message}`);
  }
}

async function scanProject(): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    return;
  }
  output.show(true);
  output.appendLine('\nScanning Salesforce project...');
  try {
    const result = await scanSalesforceProject(root);
    output.appendLine(result.summaryMarkdown);
    if (!result.isSalesforceProject) {
      vscode.window.showWarningMessage('CodeLoop AI: This does not look like a Salesforce DX project (no sfdx-project.json or force-app/main/default).');
    } else {
      vscode.window.showInformationMessage('CodeLoop AI: Scan saved to .agent-memory/project-summary.md');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`CodeLoop AI scan failed: ${message}`);
  }
}

export function deactivate(): void {
  // Nothing to clean up.
}
