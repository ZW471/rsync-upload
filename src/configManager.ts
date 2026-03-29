import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RsyncConfig, SshConnectionInfo } from './types';
import { log } from './outputChannel';

/** Find a default SSH key if none is configured */
function findDefaultSshKey(): string {
  const sshDir = path.join(os.homedir(), '.ssh');
  // Try common key names in order of preference
  for (const name of ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa']) {
    const keyPath = path.join(sshDir, name);
    if (fs.existsSync(keyPath)) {
      log(`Using default SSH key: ${keyPath}`);
      return keyPath;
    }
  }
  return '';
}

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
    // Fall back to default SSH key (~/.ssh/id_rsa, etc.)
    sshKeyPath = findDefaultSshKey();
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
