import * as vscode from 'vscode';
import { runAgentLoop } from './agent/agentLoop';
import { scanSalesforceProject } from './agent/tools';
import { AgentConfig } from './types/agentTypes';

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('CodeLoop AI');

  context.subscriptions.push(
    vscode.commands.registerCommand('codeloop-ai.startAgent', () => startAgent()),
    vscode.commands.registerCommand('codeloop-ai.scanSalesforceProject', () => scanProject()),
    output
  );
}

function getConfig(): AgentConfig {
  const cfg = vscode.workspace.getConfiguration('codeloopAi');
  return {
    endpoint: cfg.get<string>('ollamaEndpoint', 'http://localhost:11434/api/chat'),
    model: cfg.get<string>('model', 'qwen3-coder:latest'),
    maxIterations: Math.max(1, Math.min(cfg.get<number>('maxIterations', 8), 8))
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

async function startAgent(): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    return;
  }

  const goal = await vscode.window.showInputBox({
    title: 'CodeLoop AI',
    prompt: 'What is your coding goal?',
    placeHolder: 'e.g. Explain how AccountTriggerHandler works and find related test classes',
    ignoreFocusOut: true
  });
  if (!goal || !goal.trim()) {
    return;
  }

  output.show(true);
  output.appendLine(`\n${'='.repeat(60)}`);
  output.appendLine(`Goal: ${goal.trim()}`);
  output.appendLine('='.repeat(60));

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'CodeLoop AI', cancellable: true },
      async (progress, token) => {
        await runAgentLoop(goal.trim(), root, getConfig(), output, progress, token);
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
    const summary = await scanSalesforceProject(root);
    output.appendLine(summary);
    vscode.window.showInformationMessage('CodeLoop AI: Scan saved to .agent-memory/project-summary.md');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`CodeLoop AI scan failed: ${message}`);
  }
}

export function deactivate(): void {
  // Nothing to clean up.
}
