import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import SSHConfig from 'ssh-config';
import { log, logError } from './outputChannel';

export interface SshHostConfig {
  hostName: string;
  user: string;
  port: number;
  identityFile?: string;
}

export function parseSshConfig(hostAlias: string): SshHostConfig {
  const configPath = path.join(os.homedir(), '.ssh', 'config');
  const defaults: SshHostConfig = {
    hostName: hostAlias,
    user: os.userInfo().username,
    port: 22,
  };

  if (!fs.existsSync(configPath)) {
    log(`No SSH config found at ${configPath}, using defaults`);
    return defaults;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = SSHConfig.parse(raw);
    const resolved = config.compute(hostAlias);

    const result: SshHostConfig = {
      hostName: (resolved.HostName as string) || hostAlias,
      user: (resolved.User as string) || defaults.user,
      port: resolved.Port ? parseInt(String(resolved.Port), 10) : 22,
    };

    const identityFile = resolved.IdentityFile;
    if (identityFile) {
      const keyPath = Array.isArray(identityFile) ? identityFile[0] : identityFile;
      if (typeof keyPath === 'string') {
        result.identityFile = keyPath.replace(/^~/, os.homedir());
      }
    }

    log(`SSH config for "${hostAlias}": ${result.user}@${result.hostName}:${result.port}`);
    if (result.identityFile) {
      log(`  IdentityFile: ${result.identityFile}`);
    }

    return result;
  } catch (err) {
    logError(`Failed to parse SSH config: ${err}`);
    return defaults;
  }
}
