import * as cp from 'child_process';
import { log, logError } from './outputChannel';

/**
 * Opens a native macOS Finder picker that shows LOCAL files.
 * Allows selecting both files AND folders in a single dialog.
 */
export function pickLocal(): Promise<string[]> {
  return new Promise((resolve) => {
    // Use AppleScript with "choose file" which has a proper Open button.
    // The "of type" is omitted to allow all file types.
    // "with multiple selections allowed" lets user cmd+click to select many.
    const script = [
      'set chosenItems to choose file with prompt "Select files or folders to upload via Rsync" with multiple selections allowed',
      'set pathList to {}',
      'repeat with f in chosenItems',
      '  set end of pathList to POSIX path of f',
      'end repeat',
      'set AppleScript\'s text item delimiters to "\\n"',
      'return pathList as text',
    ].join('\n');

    cp.exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 120000 }, (err, stdout) => {
      if (err) {
        // Exit code 1 = user cancelled, that's fine
        if (err.code === 1 || err.killed === false) {
          log('File picker cancelled by user');
          resolve([]);
        } else {
          logError(`File picker error: ${err.message}`);
          resolve([]);
        }
        return;
      }
      const paths = stdout.trim().split('\n').filter(Boolean);
      if (paths.length > 0) {
        log(`Selected ${paths.length} item(s): ${paths.join(', ')}`);
      }
      resolve(paths);
    });
  });
}

/**
 * Opens a native macOS Finder folder picker.
 */
export function pickLocalFolder(): Promise<string | null> {
  return new Promise((resolve) => {
    const script = 'POSIX path of (choose folder with prompt "Select folder to upload via Rsync")';

    cp.exec(`osascript -e '${script}'`, { timeout: 120000 }, (err, stdout) => {
      if (err) {
        if (err.code === 1) {
          resolve(null);
        } else {
          logError(`Folder picker error: ${err.message}`);
          resolve(null);
        }
        return;
      }
      const folderPath = stdout.trim();
      log(`Selected folder: ${folderPath}`);
      resolve(folderPath || null);
    });
  });
}
