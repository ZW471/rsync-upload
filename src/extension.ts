import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { resolveConfig } from './configManager';
import { RsyncRunner } from './rsyncRunner';
import { pickLocal, pickLocalFolder } from './localFilePicker';
import { ProgressReporter } from './progressReporter';
import { StatusBar } from './statusBar';
import { UploadOnSave } from './uploadOnSave';
import { getOutputChannel, log, logError, dispose as disposeChannel } from './outputChannel';
import { SshConnectionInfo } from './types';

let runner: RsyncRunner | undefined;
let uploadOnSave: UploadOnSave | undefined;
let statusBar: StatusBar | undefined;

export function activate(context: vscode.ExtensionContext): void {
  try {
    doActivate(context);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Rsync Upload] Activation error: ${msg}`);
    try { logError(`Activation error: ${msg}`); } catch { /* ignore */ }
    registerFallbackCommands(context, msg);
  }
}

function doActivate(context: vscode.ExtensionContext): void {
  log('Rsync Upload extension activating...');

  statusBar = new StatusBar();
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });

  // Check rsync
  try {
    cp.execSync('rsync --version', { stdio: 'ignore', timeout: 5000 });
    log('rsync binary found');
  } catch {
    log('rsync not found locally — will check on command invocation');
  }

  // Detect SSH connection
  let sshInfo: SshConnectionInfo | null = null;
  try {
    const { detectSshConnection } = require('./sshConnectionDetector');
    sshInfo = detectSshConnection();
  } catch (err) {
    log(`SSH detection skipped: ${err}`);
  }

  // Resolve config
  let config = resolveConfig(sshInfo);
  const isConfigured = !!(config.remoteHost && config.remotePath);

  vscode.commands.executeCommand('setContext', 'rsyncUpload.isConnected', true);

  const displayHost = sshInfo?.hostAlias || config.remoteHost || 'not configured';

  if (isConfigured) {
    statusBar.setHost(displayHost);
    statusBar.showConnected(displayHost);
    runner = new RsyncRunner(config);
    log(`Configured: ${config.remoteHost}:${config.remotePath}`);
  } else {
    statusBar.hide();
    log('Not configured. Set rsyncUpload.remoteHost and rsyncUpload.remotePath.');
  }

  const progressReporter = new ProgressReporter(statusBar);

  // Upload on save
  if (isConfigured && runner) {
    uploadOnSave = new UploadOnSave(runner, config, statusBar);
    if (config.uploadOnSave) {
      uploadOnSave.enable();
    }
  }
  context.subscriptions.push({ dispose: () => uploadOnSave?.dispose() });

  function getRunner(): RsyncRunner | null {
    if (runner) return runner;
    config = resolveConfig(sshInfo);
    if (!config.remoteHost || !config.remotePath) {
      vscode.window.showErrorMessage(
        'Rsync Upload: Set rsyncUpload.remoteHost and rsyncUpload.remotePath in Settings.',
        'Open Settings'
      ).then((choice) => {
        if (choice === 'Open Settings') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'rsyncUpload');
        }
      });
      return null;
    }
    runner = new RsyncRunner(config);
    statusBar?.setHost(config.remoteHost);
    statusBar?.showConnected(config.remoteHost);
    return runner;
  }

  // ═══════════════════════════════════════════
  // COMMANDS
  // ═══════════════════════════════════════════

  // ── Upload via Rsync (merged file+folder picker) — Cmd+Shift+U ──
  context.subscriptions.push(
    vscode.commands.registerCommand('rsyncUpload.upload', async (destinationUri?: vscode.Uri) => {
      const r = getRunner();
      if (!r) return;

      // Remote destination: right-clicked folder path, or workspace root
      let remoteDest = config.remotePath;
      if (destinationUri) {
        remoteDest = destinationUri.path;
      }

      // Ask: files or folder?
      const mode = await vscode.window.showQuickPick(
        [
          { label: '$(file-add) Files', description: 'Select one or more files to upload', value: 'files' },
          { label: '$(folder-opened) Folder', description: 'Select a folder to upload recursively', value: 'folder' },
        ],
        { placeHolder: 'What do you want to upload?' }
      );
      if (!mode) return;

      let localPaths: string[];
      if (mode.value === 'folder') {
        const folder = await pickLocalFolder();
        localPaths = folder ? [folder] : [];
      } else {
        localPaths = await pickLocal();
      }
      if (localPaths.length === 0) return;

      const label = localPaths.length === 1
        ? path.basename(localPaths[0])
        : `${localPaths.length} items`;

      await progressReporter.runWithProgress(
        `Rsync → ${path.basename(remoteDest)}: ${label}`,
        r,
        async (onProgress) => {
          let totalFiles = 0;
          let totalBytes = 0;
          let lastError: string | undefined;
          const startTime = Date.now();

          for (const localPath of localPaths) {
            const isDir = fs.existsSync(localPath) && fs.statSync(localPath).isDirectory();
            let src = localPath;
            let dest: string;

            if (isDir) {
              src = localPath.endsWith('/') ? localPath : localPath + '/';
              const folderName = path.basename(localPath);
              dest = `${config.remoteHost}:${path.posix.join(remoteDest, folderName)}/`;
            } else {
              dest = `${config.remoteHost}:${remoteDest}/`;
            }

            const result = await r.uploadDirect(src, dest, onProgress);
            if (result.success) {
              totalFiles += result.filesTransferred || 1;
              totalBytes += result.totalBytes;
            } else if (result.cancelled) {
              return { success: false, filesTransferred: totalFiles, totalBytes, elapsedMs: Date.now() - startTime, cancelled: true };
            } else {
              lastError = result.error;
            }
          }

          return {
            success: !lastError,
            filesTransferred: totalFiles,
            totalBytes,
            elapsedMs: Date.now() - startTime,
            error: lastError,
          };
        }
      );
    })
  );

  // ── Upload workspace ──
  context.subscriptions.push(
    vscode.commands.registerCommand('rsyncUpload.uploadWorkspace', async () => {
      const r = getRunner();
      if (!r) return;
      await progressReporter.runWithProgress(
        'Rsync: uploading workspace',
        r,
        (onProgress) => r.uploadWorkspace(onProgress)
      );
    })
  );

  // ── Toggle upload on save ──
  context.subscriptions.push(
    vscode.commands.registerCommand('rsyncUpload.toggleUploadOnSave', () => {
      const newValue = !config.uploadOnSave;
      vscode.workspace.getConfiguration('rsyncUpload')
        .update('uploadOnSave', newValue, vscode.ConfigurationTarget.Workspace);
      config = { ...config, uploadOnSave: newValue };
      if (newValue && runner) {
        if (!uploadOnSave) {
          uploadOnSave = new UploadOnSave(runner, config, statusBar!);
        }
        uploadOnSave.enable();
        vscode.window.showInformationMessage('Rsync Upload: Upload-on-save enabled.');
      } else {
        uploadOnSave?.disable();
        vscode.window.showInformationMessage('Rsync Upload: Upload-on-save disabled.');
      }
    })
  );

  // ── Stop transfer ──
  context.subscriptions.push(
    vscode.commands.registerCommand('rsyncUpload.stopTransfer', () => {
      if (!runner?.isTransferring) {
        vscode.window.showInformationMessage('No active transfer.');
        return;
      }
      runner.cancel();
      vscode.window.showInformationMessage('Transfer stopped. Partial files preserved — re-upload to resume.');
      statusBar?.showConnected(displayHost);
    })
  );

  // ── Stop and delete ──
  context.subscriptions.push(
    vscode.commands.registerCommand('rsyncUpload.stopAndDelete', async () => {
      const r = getRunner();
      if (!r) return;
      const answer = await vscode.window.showWarningMessage(
        'Stop transfer and delete the remote files?', { modal: true }, 'Stop & Delete'
      );
      if (answer !== 'Stop & Delete') return;
      await r.cancelAndDeleteRemote(config.remotePath);
      vscode.window.showInformationMessage('Transfer stopped and remote files deleted.');
      statusBar?.showConnected(displayHost);
    })
  );

  // ── Show log ──
  context.subscriptions.push(
    vscode.commands.registerCommand('rsyncUpload.showLog', () => {
      getOutputChannel().show();
    })
  );

  // Config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('rsyncUpload')) return;
      config = resolveConfig(sshInfo);
      runner?.updateConfig(config);
      uploadOnSave?.updateConfig(config);
      if (config.remoteHost && config.remotePath && !runner) {
        runner = new RsyncRunner(config);
        statusBar?.setHost(config.remoteHost);
        statusBar?.showConnected(config.remoteHost);
      }
      if (config.uploadOnSave && runner) {
        if (!uploadOnSave) uploadOnSave = new UploadOnSave(runner, config, statusBar!);
        uploadOnSave.enable();
      } else {
        uploadOnSave?.disable();
      }
      log('Configuration reloaded');
    })
  );

  log('Rsync Upload extension activated successfully');
}

function registerFallbackCommands(context: vscode.ExtensionContext, errorMsg: string): void {
  const showError = () =>
    vscode.window.showErrorMessage(`Rsync Upload failed to activate: ${errorMsg}`);

  for (const cmd of [
    'rsyncUpload.upload',
    'rsyncUpload.uploadWorkspace',
    'rsyncUpload.toggleUploadOnSave',
    'rsyncUpload.stopTransfer',
    'rsyncUpload.stopAndDelete',
    'rsyncUpload.showLog',
  ]) {
    context.subscriptions.push(vscode.commands.registerCommand(cmd, showError));
  }
}

export function deactivate(): void {
  uploadOnSave?.dispose();
  statusBar?.dispose();
  disposeChannel();
}
