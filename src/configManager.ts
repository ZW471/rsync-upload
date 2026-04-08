import * as vscode from 'vscode';
import { RsyncConfig, SshConnectionInfo } from './types';
import { log } from './outputChannel';

export function resolveConfig(sshInfo: SshConnectionInfo | null): RsyncConfig {
  const cfg = vscode.workspace.getConfiguration('rsyncUpload');

  const autoDetect = cfg.get<boolean>('autoDetect', true);
  const explicitHost = cfg.get<string>('remoteHost', '');
  const explicitPath = cfg.get<string>('remotePath', '');
  const explicitPort = cfg.get<number>('sshPort', 22);
  const explicitKey = cfg.get<string>('sshKeyPath', '');

  let remoteHost: string;
  let remotePath: string;
  let sshPort: number;
  let sshKeyPath: string;

  // Use auto-detected SSH info only if autoDetect is enabled
  const effectiveSshInfo = autoDetect ? sshInfo : null;

  if (explicitHost) {
    remoteHost = explicitHost;
  } else if (effectiveSshInfo) {
    remoteHost = `${effectiveSshInfo.user}@${effectiveSshInfo.hostName}`;
  } else {
    remoteHost = '';
  }

  if (explicitPath) {
    remotePath = explicitPath;
  } else if (effectiveSshInfo) {
    remotePath = effectiveSshInfo.remoteFolderPath;
  } else {
    remotePath = '';
  }

  if (explicitPort !== 22) {
    sshPort = explicitPort;
  } else if (effectiveSshInfo) {
    sshPort = effectiveSshInfo.port;
  } else {
    sshPort = 22;
  }

  if (explicitKey) {
    sshKeyPath = explicitKey;
  } else if (effectiveSshInfo?.identityFile) {
    sshKeyPath = effectiveSshInfo.identityFile;
  } else {
    // No explicit key — leave empty so SSH tries all default keys in ~/.ssh/
    // (id_rsa, id_ed25519, etc.) just like `ssh hostname` does from a terminal.
    sshKeyPath = '';
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  const localPathSetting = cfg.get<string>('localPath', '${workspaceFolder}');
  const localPath = localPathSetting.replace('${workspaceFolder}', workspaceFolder);

  const config: RsyncConfig = {
    remoteHost,
    remotePath,
    localPath,
    flags: cfg.get<string>('flags', '-avz --partial --progress'),
    exclude: cfg.get<string[]>('exclude', ['.git', 'node_modules', '__pycache__', '.venv', '*.pyc']),
    include: cfg.get<string[]>('include', []),
    sshKeyPath,
    sshPort,
    rsyncPath: cfg.get<string>('rsyncPath', 'rsync'),
    deleteRemote: cfg.get<boolean>('delete', false),
    dryRun: cfg.get<boolean>('dryRun', false),
    sshMultiplexing: cfg.get<boolean>('sshMultiplexing', true),
    uploadOnSave: cfg.get<boolean>('uploadOnSave', false),
    uploadOnSaveDelay: cfg.get<number>('uploadOnSaveDelay', 500),
    usingSshAlias: false,
  };

  log(`Resolved config: host=${config.remoteHost}, path=${config.remotePath}, port=${config.sshPort}, key=${config.sshKeyPath || '(none)'}, autoDetect=${autoDetect}`);
  return config;
}
