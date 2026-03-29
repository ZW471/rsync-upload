import * as vscode from 'vscode';
import { SshConnectionInfo } from './types';
import { parseSshConfig } from './sshConfigParser';
import { log } from './outputChannel';

export function detectSshConnection(): SshConnectionInfo | null {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    log('No workspace folder found');
    return null;
  }

  const uri = workspaceFolder.uri;
  log(`Workspace URI: scheme=${uri.scheme}, authority=${uri.authority}, path=${uri.path}`);

  if (uri.scheme !== 'vscode-remote') {
    log(`Workspace scheme is "${uri.scheme}", not remote SSH`);
    return null;
  }

  const authority = uri.authority;
  let hostAlias: string | null = null;

  // Format 1: ssh-remote+<hostAlias>
  if (authority.startsWith('ssh-remote+')) {
    hostAlias = authority.replace('ssh-remote+', '');
  }

  // The host alias itself might be hex-encoded JSON.
  // e.g. ssh-remote+7b22686f73744e616d65223a2253617069656e74227d
  // where the hex decodes to {"hostName":"Sapient"}
  const candidate = hostAlias || authority;
  if (/^[0-9a-f]+$/i.test(candidate) && candidate.length > 10) {
    try {
      const decoded = Buffer.from(candidate, 'hex').toString('utf-8');
      log(`Decoded hex authority: ${decoded}`);
      const parsed = JSON.parse(decoded);
      hostAlias = parsed.hostName || parsed.host || null;
    } catch {
      log(`Could not decode hex authority: ${candidate}`);
    }
  }

  if (!hostAlias) {
    log(`Could not extract host alias from authority: "${authority}"`);
    return null;
  }

  log(`Detected Remote SSH connection: host alias "${hostAlias}"`);

  const sshConfig = parseSshConfig(hostAlias);
  const remoteFolderPath = uri.path || '/';

  const info: SshConnectionInfo = {
    hostAlias,
    hostName: sshConfig.hostName,
    user: sshConfig.user,
    port: sshConfig.port,
    identityFile: sshConfig.identityFile,
    remoteFolderPath,
  };

  log(`Resolved: ${info.user}@${info.hostName}:${info.port} → ${info.remoteFolderPath}`);
  return info;
}
