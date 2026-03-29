import * as vscode from 'vscode';

export class StatusBar {
  private item: vscode.StatusBarItem;
  private lastHost = '';

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'rsyncUpload.showLog';
  }

  showConnected(hostAlias: string): void {
    this.item.text = `$(cloud-upload) rsync: ${hostAlias}`;
    this.item.tooltip = `Rsync Upload connected to ${hostAlias}`;
    this.item.show();
  }

  showUploading(fileName: string, percentage: number, totalSize: string, eta: string): void {
    this.item.text = `$(sync~spin) ${fileName} ${percentage}% | ${totalSize} | ETA ${eta}`;
    this.item.tooltip = 'Click to show rsync log';
  }

  showDone(): void {
    this.item.text = `$(check) rsync: done`;
    setTimeout(() => {
      if (this.item.text.includes('done')) {
        this.showConnected(this.lastHost);
      }
    }, 3000);
  }

  showError(): void {
    this.item.text = `$(error) rsync: error`;
    this.item.tooltip = 'Click to show rsync log';
  }

  hide(): void {
    this.item.hide();
  }

  dispose(): void {
    this.item.dispose();
  }

  setHost(host: string): void {
    this.lastHost = host;
  }
}
