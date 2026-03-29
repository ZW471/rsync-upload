export interface SshConnectionInfo {
  hostAlias: string;
  hostName: string;
  user: string;
  port: number;
  identityFile?: string;
  remoteFolderPath: string;
}

export interface RsyncConfig {
  remoteHost: string;
  remotePath: string;
  localPath: string;
  flags: string;
  exclude: string[];
  include: string[];
  sshKeyPath: string;
  sshPort: number;
  rsyncPath: string;
  deleteRemote: boolean;
  dryRun: boolean;
  sshMultiplexing: boolean;
  uploadOnSave: boolean;
  uploadOnSaveDelay: number;
  /** When true, remoteHost is an SSH config alias — skip manual -p/-i flags */
  usingSshAlias: boolean;
}

export interface TransferProgress {
  fileName: string;
  bytesTransferred: number;
  totalBytesTransferred: number;
  percentage: number;
  speed: string;
  speedBytesPerSec: number;
  filesTotal: number;
  filesRemaining: number;
  filesCompleted: number;
  overallPercentage: number;
  elapsedMs: number;
  etaSeconds: number;
}

export interface TransferResult {
  success: boolean;
  filesTransferred: number;
  totalBytes: number;
  elapsedMs: number;
  error?: string;
  cancelled?: boolean;
}
