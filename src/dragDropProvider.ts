import * as vscode from 'vscode';
import * as path from 'path';
import { RsyncRunner } from './rsyncRunner';
import { RsyncConfig } from './types';
import { ProgressReporter } from './progressReporter';
import { log } from './outputChannel';

class DropTargetItem extends vscode.TreeItem {
  constructor() {
    super('Drop files here to upload via rsync', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('cloud-upload');
    this.description = 'Drag from Finder/Explorer';
  }
}

export class DragDropProvider
  implements vscode.TreeDataProvider<DropTargetItem>, vscode.TreeDragAndDropController<DropTargetItem>
{
  dropMimeTypes = ['text/uri-list'];
  dragMimeTypes: string[] = [];

  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private runner: RsyncRunner,
    private config: RsyncConfig,
    private progressReporter: ProgressReporter
  ) {}

  updateConfig(config: RsyncConfig): void {
    this.config = config;
  }

  getTreeItem(element: DropTargetItem): vscode.TreeItem {
    return element;
  }

  getChildren(): DropTargetItem[] {
    return [new DropTargetItem()];
  }

  async handleDrop(
    _target: DropTargetItem | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const uriList = dataTransfer.get('text/uri-list');
    if (!uriList) return;

    const uriString = await uriList.asString();
    const uris = uriString
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => vscode.Uri.parse(line));

    if (uris.length === 0) return;

    log(`Drag-and-drop: ${uris.length} item(s) received`);

    for (const uri of uris) {
      if (uri.scheme !== 'file') continue;

      const localPath = uri.fsPath;
      const stat = await vscode.workspace.fs.stat(uri);
      const isDirectory = stat.type === vscode.FileType.Directory;

      const fileName = path.basename(localPath);
      const relativePath = path.relative(this.config.localPath, localPath);
      const remoteRelPath = relativePath.startsWith('..')
        ? fileName
        : relativePath;

      if (isDirectory) {
        await this.progressReporter.runWithProgress(
          `Uploading folder: ${fileName}`,
          this.runner,
          (onProgress) => this.runner.uploadFolder(localPath, remoteRelPath, onProgress)
        );
      } else {
        await this.progressReporter.runWithProgress(
          `Uploading: ${fileName}`,
          this.runner,
          (onProgress) => this.runner.uploadFile(localPath, remoteRelPath, onProgress)
        );
      }
    }
  }

  handleDrag(): void {
    // Not needed — we only accept drops
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
