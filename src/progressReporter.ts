import * as vscode from 'vscode';
import * as path from 'path';
import { RsyncRunner, formatBytes, formatDuration } from './rsyncRunner';
import { TransferProgress, TransferResult } from './types';
import { StatusBar } from './statusBar';

export class ProgressReporter {
  private lastUpdate = 0;
  private throttleMs = 100;

  constructor(private statusBar: StatusBar) {}

  async runWithProgress(
    title: string,
    runner: RsyncRunner,
    transferFn: (onProgress: (p: TransferProgress) => void) => Promise<TransferResult>
  ): Promise<TransferResult> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: true,
      },
      async (progress, token) => {
        token.onCancellationRequested(() => {
          runner.cancel();
        });

        // Show initial state immediately so the notification appears
        progress.report({ increment: 0, message: 'Connecting...' });

        let lastPercentage = 0;

        const onProgress = (p: TransferProgress) => {
          const now = Date.now();
          if (now - this.lastUpdate < this.throttleMs) return;
          this.lastUpdate = now;

          const increment = p.overallPercentage - lastPercentage;
          lastPercentage = p.overallPercentage;

          const fileName = p.fileName ? path.basename(p.fileName) : 'uploading';
          const totalSize = formatBytes(p.totalBytesTransferred);
          const eta = p.etaSeconds > 0 ? formatDuration(p.etaSeconds) : '--:--';
          const speed = p.speed || '-- B/s';
          const fileCount = p.filesTotal > 1
            ? ` [${p.filesCompleted}/${p.filesTotal} files]`
            : '';

          progress.report({
            increment: Math.max(increment, 0),
            message: `${fileName} — ${p.overallPercentage}% | ${totalSize} | ${speed} | ETA ${eta}${fileCount}`,
          });

          this.statusBar.showUploading(fileName, p.overallPercentage, totalSize, eta);
        };

        const result = await transferFn(onProgress);

        if (result.success) {
          const totalSize = formatBytes(result.totalBytes);
          const elapsed = formatDuration(result.elapsedMs / 1000);
          this.statusBar.showDone();

          // Show a persistent info message so the user always sees the result
          vscode.window.showInformationMessage(
            `Rsync: ${result.filesTransferred} file(s) uploaded, ${totalSize} in ${elapsed}`
          );
        } else if (result.cancelled) {
          const totalSize = formatBytes(result.totalBytes);
          vscode.window.showWarningMessage(
            `Rsync transfer cancelled (${totalSize} sent). Partial file preserved — re-upload to resume.`
          );
        } else {
          this.statusBar.showError();
          // Show short message in notification with button to see full details
          const errorFirstLine = (result.error || 'Unknown error').split('\n')[0];
          vscode.window.showErrorMessage(
            `Rsync upload failed: ${errorFirstLine}`,
            'Show Log'
          ).then((choice) => {
            if (choice === 'Show Log') {
              vscode.commands.executeCommand('rsyncUpload.showLog');
            }
          });
        }

        return result;
      }
    );
  }
}
