import * as cp from 'child_process';
import { log, logError } from './outputChannel';

// ═══════════════════════════════════════════════════════════════
// Native file / folder pickers that always show LOCAL files,
// regardless of whether VS Code is connected to a remote host.
//
// macOS  → AppleScript (osascript)
// Windows → PowerShell WinForms
// Linux  → zenity (if available), falls back to VS Code's dialog
// ═══════════════════════════════════════════════════════════════

const TIMEOUT_MS = 300000; // 5 min — user may take a while to browse

/** Select one or more files. Returns absolute paths. */
export function pickLocal(): Promise<string[]> {
  switch (process.platform) {
    case 'darwin':
      return pickFilesMac();
    case 'win32':
      return pickFilesWindows();
    default:
      return pickFilesLinux();
  }
}

/** Select a single folder. Returns absolute path or null. */
export function pickLocalFolder(): Promise<string | null> {
  switch (process.platform) {
    case 'darwin':
      return pickFolderMac();
    case 'win32':
      return pickFolderWindows();
    default:
      return pickFolderLinux();
  }
}

// ─── macOS ──────────────────────────────────────────────────────

function pickFilesMac(): Promise<string[]> {
  return new Promise((resolve) => {
    const script = [
      'set chosenItems to choose file with prompt "Select files to upload via Rsync" with multiple selections allowed',
      'set pathList to {}',
      'repeat with f in chosenItems',
      '  set end of pathList to POSIX path of f',
      'end repeat',
      'set AppleScript\'s text item delimiters to "\\n"',
      'return pathList as text',
    ].join('\n');

    cp.exec(
      `osascript -e '${script.replace(/'/g, "'\\''")}'`,
      { timeout: TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          if (err.code === 1) log('File picker cancelled by user');
          else logError(`File picker error: ${err.message}`);
          resolve([]);
          return;
        }
        const paths = stdout.trim().split('\n').filter(Boolean);
        if (paths.length > 0) {
          log(`Selected ${paths.length} item(s): ${paths.join(', ')}`);
        }
        resolve(paths);
      }
    );
  });
}

function pickFolderMac(): Promise<string | null> {
  return new Promise((resolve) => {
    const script = 'POSIX path of (choose folder with prompt "Select folder to upload via Rsync")';
    cp.exec(`osascript -e '${script}'`, { timeout: TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        if (err.code !== 1) logError(`Folder picker error: ${err.message}`);
        resolve(null);
        return;
      }
      const folderPath = stdout.trim();
      if (folderPath) log(`Selected folder: ${folderPath}`);
      resolve(folderPath || null);
    });
  });
}

// ─── Windows ─────────────────────────────────────────────────────

function pickFilesWindows(): Promise<string[]> {
  return new Promise((resolve) => {
    // PowerShell script that shows a multi-select file dialog and prints
    // one absolute path per line on stdout.
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      '$d.Multiselect = $true',
      '$d.Title = "Select files to upload via Rsync"',
      '$d.Filter = "All files (*.*)|*.*"',
      '$d.CheckFileExists = $true',
      'if ($d.ShowDialog() -eq "OK") { $d.FileNames -join "`n" }',
    ].join('; ');

    cp.execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', ps],
      { timeout: TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          logError(`File picker error: ${err.message}`);
          resolve([]);
          return;
        }
        const paths = stdout.trim().split(/\r?\n/).filter(Boolean);
        if (paths.length === 0) {
          log('File picker cancelled by user');
        } else {
          log(`Selected ${paths.length} item(s): ${paths.join(', ')}`);
        }
        resolve(paths);
      }
    );
  });
}

function pickFolderWindows(): Promise<string | null> {
  return new Promise((resolve) => {
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$d.Description = "Select folder to upload via Rsync"',
      '$d.ShowNewFolderButton = $false',
      'if ($d.ShowDialog() -eq "OK") { $d.SelectedPath }',
    ].join('; ');

    cp.execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', ps],
      { timeout: TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          logError(`Folder picker error: ${err.message}`);
          resolve(null);
          return;
        }
        const folderPath = stdout.trim();
        if (folderPath) log(`Selected folder: ${folderPath}`);
        resolve(folderPath || null);
      }
    );
  });
}

// ─── Linux ──────────────────────────────────────────────────────

function pickFilesLinux(): Promise<string[]> {
  return new Promise((resolve) => {
    // Try zenity first (GNOME/standard). Multi-select uses | as separator.
    cp.execFile(
      'zenity',
      ['--file-selection', '--multiple', '--separator=\n', '--title=Select files to upload via Rsync'],
      { timeout: TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            logError('zenity not found. Install zenity or use VS Code settings to configure manually.');
          } else if ((err as { code?: number }).code === 1) {
            log('File picker cancelled by user');
          } else {
            logError(`File picker error: ${err.message}`);
          }
          resolve([]);
          return;
        }
        const paths = stdout.trim().split('\n').filter(Boolean);
        if (paths.length > 0) {
          log(`Selected ${paths.length} item(s): ${paths.join(', ')}`);
        }
        resolve(paths);
      }
    );
  });
}

function pickFolderLinux(): Promise<string | null> {
  return new Promise((resolve) => {
    cp.execFile(
      'zenity',
      ['--file-selection', '--directory', '--title=Select folder to upload via Rsync'],
      { timeout: TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            logError('zenity not found. Install zenity for the folder picker.');
          } else if ((err as { code?: number }).code !== 1) {
            logError(`Folder picker error: ${err.message}`);
          }
          resolve(null);
          return;
        }
        const folderPath = stdout.trim();
        if (folderPath) log(`Selected folder: ${folderPath}`);
        resolve(folderPath || null);
      }
    );
  });
}
