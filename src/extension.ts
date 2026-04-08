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
import { SshConnectionInfo, TransferResult } from './types';

let runner: RsyncRunner | undefined;
let uploadOnSave: UploadOnSave | undefined;
let statusBar: StatusBar | undefined;

const PASSWORD_KEY_PREFIX = 'rsyncUpload.password.';
/** In-memory cache: host → password (cleared on VS Code restart) */
const passwordCache = new Map<string, string>();

async function loadPassword(secrets: vscode.SecretStorage, host: string): Promise<string | undefined> {
  if (!host) return undefined;
  if (passwordCache.has(host)) return passwordCache.get(host);
  const stored = await secrets.get(PASSWORD_KEY_PREFIX + host);
  if (stored) passwordCache.set(host, stored);
  return stored;
}

/** Write a small askpass helper script that echoes $RSYNC_UPLOAD_PASSWORD */
function createAskpassScript(context: vscode.ExtensionContext): string {
  const dir = context.globalStorageUri.fsPath;
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, 'askpass.sh');
  const content = '#!/bin/sh\nprintf %s "$RSYNC_UPLOAD_PASSWORD"\n';
  fs.writeFileSync(scriptPath, content, { mode: 0o700 });
  // Ensure executable bit is set even if writeFileSync ignored mode
  try { fs.chmodSync(scriptPath, 0o700); } catch { /* ignore */ }
  return scriptPath;
}

/** Detect "auth failed / password required" type errors in rsync stderr */
function isAuthError(error: string | undefined): boolean {
  if (!error) return false;
  // Match all common SSH auth-failure signatures. "Connection closed by ..."
  // is also typically auth — the server hangs up after rejecting the client.
  return /Permission denied|password|ssh_askpass|publickey|authentication|Connection closed by|Too many authentication/i.test(error);
}

/**
 * Run an upload, and if it fails with an auth error, prompt the user for a
 * password and retry once. The password is cached in memory for the session.
 */
async function runWithAuthRetry(
  r: RsyncRunner,
  host: string,
  secrets: vscode.SecretStorage,
  doUpload: () => Promise<TransferResult>
): Promise<TransferResult> {
  // Apply cached password (if any) before the first attempt
  const cached = await loadPassword(secrets, host);
  if (cached) r.setPassword(cached);

  let result = await doUpload();
  if (result.success || result.cancelled || !isAuthError(result.error)) {
    return result;
  }

  // Auth failed — prompt for password
  log(`Auth failed for ${host}, prompting for password...`);
  const password = await vscode.window.showInputBox({
    prompt: `SSH password for ${host}`,
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'Server requires a password — enter it to retry',
  });
  if (!password) return result;

  // Cache in memory + apply to runner
  passwordCache.set(host, password);
  r.setPassword(password);

  // Retry the upload with the password
  const retried = await doUpload();

  // Only offer to persist if the retry actually succeeded
  if (retried.success) {
    vscode.window.showInformationMessage(
      `Password worked for ${host}. Save it across sessions?`,
      'Save in Keychain',
      'Just this session'
    ).then((choice) => {
      if (choice === 'Save in Keychain') {
        secrets.store(PASSWORD_KEY_PREFIX + host, password);
        log(`Password saved persistently for ${host}`);
      }
    });
  }

  return retried;
}

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

  // Create the askpass helper script (used for password auth)
  const askpassScriptPath = createAskpassScript(context);
  log(`Askpass helper: ${askpassScriptPath}`);

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

  // Load saved password (if any) into the in-memory cache
  loadPassword(context.secrets, config.remoteHost).then((pw) => {
    if (pw) {
      runner?.setPassword(pw);
      log(`Loaded saved password for ${config.remoteHost}`);
    }
  });

  vscode.commands.executeCommand('setContext', 'rsyncUpload.isConnected', true);

  const displayHost = sshInfo?.hostAlias || config.remoteHost || 'not configured';

  if (isConfigured) {
    statusBar.setHost(displayHost);
    statusBar.showConnected(displayHost);
    runner = new RsyncRunner(config);
    runner.askpassScriptPath = askpassScriptPath;
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
    runner.askpassScriptPath = askpassScriptPath;
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

            const result = await runWithAuthRetry(
              r,
              config.remoteHost,
              context.secrets,
              () => r.uploadDirect(src, dest, onProgress)
            );
            if (result.success) {
              totalFiles += result.filesTransferred || 1;
              totalBytes += result.totalBytes;
            } else if (result.cancelled) {
              return { success: false, filesTransferred: totalFiles, totalBytes, elapsedMs: Date.now() - startTime, cancelled: true };
            } else {
              lastError = result.error;
              break; // Stop on first non-auth failure
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
        (onProgress) => runWithAuthRetry(
          r,
          config.remoteHost,
          context.secrets,
          () => r.uploadWorkspace(onProgress)
        )
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

  // ── Set password for current host (manual save) ──
  context.subscriptions.push(
    vscode.commands.registerCommand('rsyncUpload.setPassword', async () => {
      if (!config.remoteHost) {
        vscode.window.showErrorMessage('No remote host configured. Set rsyncUpload.remoteHost first.');
        return;
      }
      const password = await vscode.window.showInputBox({
        prompt: `Password for ${config.remoteHost}`,
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'Leave empty to cancel',
      });
      if (!password) return;
      await context.secrets.store(PASSWORD_KEY_PREFIX + config.remoteHost, password);
      passwordCache.set(config.remoteHost, password);
      runner?.setPassword(password);
      vscode.window.showInformationMessage(`Password saved for ${config.remoteHost}.`);
      log(`Password stored for ${config.remoteHost}`);
    })
  );

  // ── Clear saved password for current host ──
  context.subscriptions.push(
    vscode.commands.registerCommand('rsyncUpload.clearPassword', async () => {
      if (!config.remoteHost) return;
      await context.secrets.delete(PASSWORD_KEY_PREFIX + config.remoteHost);
      passwordCache.delete(config.remoteHost);
      runner?.setPassword(undefined);
      vscode.window.showInformationMessage(`Password cleared for ${config.remoteHost}.`);
      log(`Password cleared for ${config.remoteHost}`);
    })
  );

  // Config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('rsyncUpload')) return;
      config = resolveConfig(sshInfo);
      runner?.updateConfig(config);
      // Reload password for current host
      const pw = await loadPassword(context.secrets, config.remoteHost);
      if (pw) runner?.setPassword(pw);
      uploadOnSave?.updateConfig(config);
      if (config.remoteHost && config.remotePath && !runner) {
        runner = new RsyncRunner(config);
        runner.askpassScriptPath = askpassScriptPath;
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
    'rsyncUpload.setPassword',
    'rsyncUpload.clearPassword',
  ]) {
    context.subscriptions.push(vscode.commands.registerCommand(cmd, showError));
  }
}

export function deactivate(): void {
  uploadOnSave?.dispose();
  statusBar?.dispose();
  disposeChannel();
}
