import * as vscode from 'vscode';
import * as path from 'path';
import { RsyncRunner, formatBytes } from './rsyncRunner';
import { RsyncConfig } from './types';
import { log } from './outputChannel';
import { StatusBar } from './statusBar';

export class UploadOnSave {
  private disposable: vscode.Disposable | null = null;
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private runner: RsyncRunner,
    private config: RsyncConfig,
    private statusBar: StatusBar
  ) {}

  enable(): void {
    if (this.disposable) return;

    this.disposable = vscode.workspace.onDidSaveTextDocument((doc) => {
      this.handleSave(doc);
    });

    log('Upload-on-save enabled');
  }

  disable(): void {
    this.disposable?.dispose();
    this.disposable = null;
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    log('Upload-on-save disabled');
  }

  updateConfig(config: RsyncConfig): void {
    this.config = config;
  }

  dispose(): void {
    this.disable();
  }

  private handleSave(doc: vscode.TextDocument): void {
    const filePath = doc.uri.fsPath;

    if (!filePath.startsWith(this.config.localPath)) {
      return;
    }

    const relativePath = path.relative(this.config.localPath, filePath);
    for (const pattern of this.config.exclude) {
      if (this.matchesExclude(relativePath, pattern)) {
        return;
      }
    }

    const existing = this.debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    this.debounceTimers.set(
      filePath,
      setTimeout(() => {
        this.debounceTimers.delete(filePath);
        this.doUpload(filePath, relativePath);
      }, this.config.uploadOnSaveDelay)
    );
  }

  private async doUpload(filePath: string, relativePath: string): Promise<void> {
    log(`Upload-on-save: ${relativePath}`);
    const fileName = path.basename(relativePath);
    this.statusBar.showUploading(fileName, 0, '0 B', '--:--');

    const result = await this.runner.uploadFile(filePath, relativePath);

    if (result.success) {
      this.statusBar.showDone();
    } else if (!result.cancelled) {
      this.statusBar.showError();
      vscode.window.showErrorMessage(`Rsync save-upload failed: ${result.error}`);
    }
  }

  private matchesExclude(relativePath: string, pattern: string): boolean {
    if (pattern.startsWith('*.')) {
      const ext = pattern.slice(1);
      return relativePath.endsWith(ext);
    }
    const segments = relativePath.split(path.sep);
    return segments.some((seg) => seg === pattern);
  }
}
