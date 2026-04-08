import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RsyncConfig, TransferProgress, TransferResult } from './types';
import { log, logError } from './outputChannel';

type ProgressCallback = (progress: TransferProgress) => void;

function parseSpeed(speedStr: string): number {
  const m = speedStr.match(/([\d.]+)\s*([A-Za-z]+)\/s/);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const multipliers: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return val * (multipliers[unit] || 1);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 0) return '--:--';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export class RsyncRunner {
  private currentProcess: cp.ChildProcess | null = null;
  private queue: Array<{ args: string[]; resolve: (r: TransferResult) => void; onProgress?: ProgressCallback }> = [];
  private running = false;

  constructor(private config: RsyncConfig) {}

  updateConfig(config: RsyncConfig): void {
    this.config = config;
  }

  async uploadFile(localFilePath: string, remoteRelativePath: string, onProgress?: ProgressCallback): Promise<TransferResult> {
    const remoteDest = `${this.config.remoteHost}:${path.posix.join(this.config.remotePath, path.posix.dirname(remoteRelativePath))}/`;
    const args = this.buildArgs(localFilePath, remoteDest);
    return this.enqueue(args, onProgress);
  }

  async uploadFolder(localFolderPath: string, remoteRelativePath: string, onProgress?: ProgressCallback): Promise<TransferResult> {
    const src = localFolderPath.endsWith('/') ? localFolderPath : localFolderPath + '/';
    const remoteDest = `${this.config.remoteHost}:${path.posix.join(this.config.remotePath, remoteRelativePath)}/`;
    const args = this.buildArgs(src, remoteDest);
    return this.enqueue(args, onProgress);
  }

  async uploadWorkspace(onProgress?: ProgressCallback): Promise<TransferResult> {
    const src = this.config.localPath.endsWith('/') ? this.config.localPath : this.config.localPath + '/';
    const remoteDest = `${this.config.remoteHost}:${this.config.remotePath}/`;
    const args = this.buildArgs(src, remoteDest);
    return this.enqueue(args, onProgress);
  }

  async uploadDirect(source: string, destination: string, onProgress?: ProgressCallback): Promise<TransferResult> {
    const args = this.buildArgs(source, destination);
    return this.enqueue(args, onProgress);
  }

  cancel(): void {
    if (this.currentProcess) {
      log('Cancelling current transfer (partial file preserved for resume)');
      this.currentProcess.kill('SIGTERM');
      this.currentProcess = null;
    }
    this.queue.length = 0;
  }

  async cancelAndDeleteRemote(remotePath: string): Promise<void> {
    this.cancel();
    log(`Deleting remote path: ${remotePath}`);

    const args = [
      '-p', String(this.config.sshPort),
    ];
    if (this.config.sshKeyPath) {
      args.push('-i', this.config.sshKeyPath);
    }
    args.push(
      this.config.remoteHost,
      `rm -rf "${remotePath}"`,
    );

    return new Promise((resolve) => {
      const proc = cp.spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.on('close', (code) => {
        if (code === 0) {
          log(`Remote path deleted: ${remotePath}`);
        } else {
          logError(`Failed to delete remote path (exit code ${code})`);
        }
        resolve();
      });
      proc.on('error', (err) => {
        logError(`Failed to run ssh for deletion: ${err.message}`);
        resolve();
      });
    });
  }

  get isTransferring(): boolean {
    return this.running;
  }

  private buildArgs(source: string, destination: string): string[] {
    const args: string[] = [];
    const flags = this.config.flags.split(/\s+/).filter(Boolean);
    args.push(...flags);

    const sshCmd = this.buildSshCommand();
    args.push('-e', sshCmd);

    for (const pattern of this.config.include) {
      args.push('--include', pattern);
    }
    for (const pattern of this.config.exclude) {
      args.push('--exclude', pattern);
    }

    if (this.config.deleteRemote) {
      args.push('--delete');
    }
    if (this.config.dryRun) {
      args.push('--dry-run');
    }

    args.push(source, destination);
    return args;
  }

  private buildSshCommand(): string {
    const parts = ['ssh'];

    parts.push(`-p ${this.config.sshPort}`);

    // Fail fast on unreachable hosts instead of hanging for the default 75s
    parts.push('-o ConnectTimeout=10');

    // Auto-accept new host keys (no interactive prompt for unknown hosts)
    parts.push('-o StrictHostKeyChecking=accept-new');

    if (this.config.password && this.askpassScriptPath) {
      // Password mode — skip key auth entirely so we don't waste time trying
      // every key in ~/.ssh/ over a slow link before falling back to password.
      parts.push('-o PreferredAuthentications=password,keyboard-interactive');
      parts.push('-o PubkeyAuthentication=no');
      parts.push('-o NumberOfPasswordPrompts=1');
    } else if (this.config.sshKeyPath) {
      // Key mode — only try the configured key, no others
      parts.push(`-i ${this.config.sshKeyPath}`);
      parts.push('-o IdentitiesOnly=yes');
    }

    return parts.join(' ');
  }

  /** Path to the askpass helper script — set by extension at activation */
  askpassScriptPath = '';

  /** Update the password without rebuilding the whole config */
  setPassword(password: string | undefined): void {
    this.config = { ...this.config, password };
  }

  private enqueue(args: string[], onProgress?: ProgressCallback): Promise<TransferResult> {
    return new Promise((resolve) => {
      this.queue.push({ args, resolve, onProgress });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.running || this.queue.length === 0) {
      return;
    }

    this.running = true;
    const item = this.queue.shift()!;

    try {
      const result = await this.spawn(item.args, item.onProgress);
      item.resolve(result);
    } catch (err) {
      item.resolve({ success: false, filesTransferred: 0, totalBytes: 0, elapsedMs: 0, error: String(err) });
    }

    this.running = false;
    this.processQueue();
  }

  private spawn(args: string[], onProgress?: ProgressCallback): Promise<TransferResult> {
    return new Promise((resolve) => {
      const cmdLine = `${this.config.rsyncPath} ${args.join(' ')}`;
      log(`Executing: ${cmdLine}`);

      const childEnv: NodeJS.ProcessEnv = { ...process.env };

      if (this.config.password && this.askpassScriptPath) {
        // SSH will run our helper script when it needs a password.
        // The script reads RSYNC_UPLOAD_PASSWORD from its environment.
        childEnv.SSH_ASKPASS = this.askpassScriptPath;
        childEnv.SSH_ASKPASS_REQUIRE = 'force'; // OpenSSH 8.4+
        childEnv.DISPLAY = childEnv.DISPLAY || ':0';
        childEnv.RSYNC_UPLOAD_PASSWORD = this.config.password;
      } else {
        // No password mode — disable askpass entirely so SSH fails cleanly
        // with an "auth required" error rather than hanging on a GUI prompt.
        childEnv.SSH_ASKPASS_REQUIRE = 'never';
        childEnv.DISPLAY = '';
      }

      const proc = cp.spawn(this.config.rsyncPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv,
        // Detach so SSH thinks it's not attached to a TTY (forces askpass path)
        detached: !!this.config.password,
      });
      this.currentProcess = proc;

      let stderr = '';
      let filesTransferred = 0;
      let totalBytesTransferred = 0;
      let currentFileName = '';
      let totalSentBytes = 0;
      const startTime = Date.now();

      // Fire an initial progress event so the notification shows immediately
      onProgress?.({
        fileName: 'Starting...',
        bytesTransferred: 0,
        totalBytesTransferred: 0,
        percentage: 0,
        speed: '0 B/s',
        speedBytesPerSec: 0,
        filesTotal: 0,
        filesRemaining: 0,
        filesCompleted: 0,
        overallPercentage: 0,
        elapsedMs: 0,
        etaSeconds: 0,
      });

      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        log(`[rsync stdout] ${text.trim()}`);

        const lines = text.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // Parse "sent N bytes" summary line for final total
          const sentMatch = trimmed.match(/^sent\s+([\d,]+)\s+bytes/);
          if (sentMatch) {
            totalSentBytes = parseInt(sentMatch[1].replace(/,/g, ''), 10);
            continue;
          }

          // Skip non-file lines
          if (trimmed.match(/^(total|receiving|building|Transfer|sent |created )/i)) {
            continue;
          }

          // Capture file name: any line that is NOT a progress line (no leading whitespace + digits)
          if (!trimmed.match(/^\s*[\d,]+\s+\d+%/)) {
            // It's a file name line
            currentFileName = trimmed;
            continue;
          }

          // Parse progress line - multiple formats:
          // openrsync (macOS):  5242880 100%   37.51MB/s   00:00:00 (xfer#1, to-check=0/1)
          // GNU rsync 3.x:     5,242,880 100%   37.51MB/s    0:00:00 (xfr#1, to-chk=0/1)
          // Partial progress:   1,048,576  20%    5.00MB/s    0:00:03
          const progressMatch = trimmed.match(
            /^\s*([\d,]+)\s+(\d+)%\s+([\d.]+[A-Za-z]+\/s)\s+[\d:]+\s*(?:\((?:xfr|xfer)#(\d+),\s*(?:to-chk|to-check)=(\d+)\/(\d+)\))?/
          );
          if (progressMatch) {
            const bytesTransferred = parseInt(progressMatch[1].replace(/,/g, ''), 10);
            const percentage = parseInt(progressMatch[2], 10);
            const speed = progressMatch[3];
            const speedBytesPerSec = parseSpeed(speed);
            const xfrNum = progressMatch[4] ? parseInt(progressMatch[4], 10) : 0;
            const filesRemaining = progressMatch[5] ? parseInt(progressMatch[5], 10) : 0;
            const filesTotal = progressMatch[6] ? parseInt(progressMatch[6], 10) : 1;

            if (percentage === 100 && xfrNum > 0) {
              // File completed — only count once per xfer number
              if (xfrNum > filesTransferred) {
                totalBytesTransferred += bytesTransferred;
                filesTransferred = xfrNum;
              }
            }

            const currentTotalBytes = totalBytesTransferred + (percentage < 100 ? bytesTransferred : 0);
            const filesCompleted = filesTotal - filesRemaining;
            const overallPercentage = filesTotal > 0
              ? Math.round((filesCompleted / filesTotal) * 100)
              : percentage;

            const elapsedMs = Date.now() - startTime;
            let etaSeconds = 0;
            if (overallPercentage > 0 && overallPercentage < 100) {
              const elapsedSec = elapsedMs / 1000;
              etaSeconds = Math.round((elapsedSec / overallPercentage) * (100 - overallPercentage));
            } else if (speedBytesPerSec > 0 && filesRemaining > 0 && filesCompleted > 0) {
              const avgFileSize = currentTotalBytes / filesCompleted;
              etaSeconds = Math.round((avgFileSize * filesRemaining) / speedBytesPerSec);
            }

            onProgress?.({
              fileName: currentFileName,
              bytesTransferred,
              totalBytesTransferred: currentTotalBytes,
              percentage,
              speed,
              speedBytesPerSec,
              filesTotal,
              filesRemaining,
              filesCompleted,
              overallPercentage,
              elapsedMs,
              etaSeconds,
            });
          }
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
        const text = data.toString().trim();
        if (text) {
          logError(text);
        }
      });

      proc.on('close', (code) => {
        this.currentProcess = null;
        const elapsedMs = Date.now() - startTime;
        const finalBytes = totalSentBytes || totalBytesTransferred;

        if (code === 0) {
          log(`Transfer complete: ${filesTransferred} file(s), ${formatBytes(finalBytes)} in ${formatDuration(elapsedMs / 1000)}`);
          resolve({ success: true, filesTransferred, totalBytes: finalBytes, elapsedMs });
        } else if (code === 20) {
          log('Transfer cancelled by user');
          resolve({ success: false, filesTransferred, totalBytes: finalBytes, elapsedMs, cancelled: true });
        } else if (code === 255) {
          const stderrMsg = stderr.trim();
          const msg = `SSH connection failed (exit 255).\nCommand: ${cmdLine}\nSSH error: ${stderrMsg || '(no stderr output)'}`;
          logError(msg);
          resolve({ success: false, filesTransferred: 0, totalBytes: 0, elapsedMs, error: msg });
        } else {
          const msg = `rsync exited with code ${code}.\nCommand: ${cmdLine}\nError: ${stderr.trim() || '(no stderr output)'}`;
          logError(msg);
          resolve({ success: false, filesTransferred: 0, totalBytes: 0, elapsedMs, error: msg });
        }
      });

      proc.on('error', (err) => {
        this.currentProcess = null;
        const msg = `Failed to spawn rsync: ${err.message}`;
        logError(msg);
        resolve({ success: false, filesTransferred: 0, totalBytes: 0, elapsedMs: 0, error: msg });
      });
    });
  }
}
