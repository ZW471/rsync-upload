import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Rsync Upload');
  }
  return channel;
}

export function log(message: string): void {
  const ch = getOutputChannel();
  const timestamp = new Date().toISOString().slice(11, 19);
  ch.appendLine(`[${timestamp}] ${message}`);
}

export function logError(message: string): void {
  log(`ERROR: ${message}`);
}

export function dispose(): void {
  channel?.dispose();
  channel = undefined;
}
