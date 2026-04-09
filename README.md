# Rsync Upload

A VS Code extension that replaces the painfully slow built-in SSH file upload with **rsync** — fast, compressed, and resumable.

> **Client-side only.** This extension runs entirely on your local machine. Nothing needs to be installed on the remote server — it just needs `rsync` and `sshd`, which are available on virtually all Linux/Unix servers by default.

## Platform Support

| Client (local) | File picker | Rsync requirement |
|---|---|---|
| **macOS** | Native Finder (AppleScript) | Pre-installed (`openrsync`) |
| **Windows 10/11** | Native Explorer (PowerShell WinForms) | Install via [cwRsync](https://itefix.net/cwrsync), Git Bash, or WSL |
| **Linux** | Native (zenity) | `sudo apt install rsync zenity` |

The extension auto-detects your OS and uses the right native file dialog and helper script automatically.

| Server (remote) |
|---|
| Any Linux/Unix with rsync + SSH — nothing to install on the remote side |

## Features

- **Fast uploads via rsync** — compression (`-z`), delta transfers, and parallel I/O blow away VS Code's built-in copy
- **Resume interrupted transfers** — `--partial` flag preserves partial files; re-uploading picks up where it left off
- **Auto-detect SSH connection** — reads your `~/.ssh/config` and VS Code Remote SSH session to configure host, port, user, and key automatically
- **Progress bar** — real-time notification showing file name, percentage, total size, speed, and ETA
- **Upload on save** — optionally auto-upload files whenever you save
- **Stop transfer** — cancel mid-transfer and keep partial files for resume, or stop and delete remote files
- **Right-click to upload** — upload from Explorer context menu, editor context menu, or editor title bar
- **Keyboard shortcut** — `Cmd+Shift+U` to upload instantly

## Installation

Download the `.vsix` from [Releases](https://github.com/ZW471/rsync-upload/releases) and install:

```bash
code --install-extension rsync-upload-0.10.0.vsix
```

Or install from within VS Code: `Cmd+Shift+P` > `Extensions: Install from VSIX...`

## Quick Start

1. Connect to a remote server via VS Code Remote SSH
2. The extension auto-detects your SSH host, port, and remote path from `~/.ssh/config`
3. Press `Cmd+Shift+U` or right-click in the Explorer > **Upload via Rsync...**
4. Choose **Files** or **Folder** in the quick pick
5. Select local files/folder in the native Finder dialog
6. Watch the progress bar as rsync transfers your files

## Commands

| Command | Shortcut | Description |
|---|---|---|
| Upload via Rsync... | `Cmd+Shift+U` | Pick local files or folder to upload |
| Upload Workspace via Rsync | — | Upload the entire workspace |
| Toggle Upload on Save | — | Enable/disable auto-upload on file save |
| Stop Transfer (Keep Partial) | `Cmd+Shift+Escape` | Cancel transfer, keep partial for resume |
| Stop Transfer & Delete Remote Files | — | Cancel and remove uploaded files from server |
| Show Rsync Log | — | Open the output log for debugging |

## Settings

Search `rsyncUpload` in VS Code Settings, or add to `settings.json`:

| Setting | Default | Description |
|---|---|---|
| `rsyncUpload.autoDetect` | `true` | Auto-detect host/port/path from Remote SSH. Disable for manual config only. |
| `rsyncUpload.remoteHost` | `""` | SSH host, e.g. `user@hostname` (auto-detected if empty) |
| `rsyncUpload.remotePath` | `""` | Remote absolute path (auto-detected if empty) |
| `rsyncUpload.sshPort` | `22` | SSH port (auto-detected from `~/.ssh/config`) |
| `rsyncUpload.sshKeyPath` | `""` | Path to SSH private key (falls back to `~/.ssh/id_rsa`) |
| `rsyncUpload.flags` | `"-avz --partial --progress"` | Rsync flags |
| `rsyncUpload.exclude` | `[".git", "node_modules", ...]` | Exclude patterns for rsync |
| `rsyncUpload.include` | `[]` | Include patterns for rsync |
| `rsyncUpload.uploadOnSave` | `false` | Auto-upload on file save |
| `rsyncUpload.uploadOnSaveDelay` | `500` | Debounce delay (ms) for upload on save |
| `rsyncUpload.delete` | `false` | Use `--delete` to remove remote files not present locally |
| `rsyncUpload.dryRun` | `false` | Preview transfers without uploading |
| `rsyncUpload.rsyncPath` | `"rsync"` | Path to rsync binary |

## How It Works

The extension runs **locally** on your Mac (`extensionKind: ["ui"]`). When you trigger an upload:

1. It detects your Remote SSH connection from VS Code's workspace URI
2. Resolves host, port, user, and identity file from `~/.ssh/config`
3. Opens a native macOS Finder dialog for you to pick local files
4. Spawns `rsync -avz --partial --progress -e "ssh -p PORT -i KEY" <source> <user@host:path>`
5. Parses rsync's stdout in real-time to drive the progress bar

Since rsync uses `--partial`, interrupted transfers leave partial files on the server. Re-running the upload automatically resumes from where it left off.

## Password Authentication

The extension prefers SSH key authentication. If your server requires a **password**, the extension will detect the auth failure on the first try and **prompt you for the password on the fly** — no setup or external tools required.

How it works:
1. Extension attempts the upload (using your SSH keys / agent)
2. If the server rejects key auth, an input box pops up asking for the password
3. The password is passed to OpenSSH via the built-in `SSH_ASKPASS` mechanism — no third-party libraries
4. The extension then offers to either remember it for the session only, or save it persistently in macOS Keychain (via VS Code's SecretStorage)
5. Subsequent uploads to the same host reuse the cached password

To clear a saved password: `Cmd+Shift+P` > **Rsync Upload: Clear Saved Password for Current Host**.

> No `sshpass` or any other external tool is required. The extension uses only built-in `ssh` and `rsync`.

## Requirements

- **Client OS:** macOS, Windows 10/11, or Linux
- **rsync** in PATH:
  - macOS: pre-installed (`openrsync`)
  - Windows: install [cwRsync](https://itefix.net/cwrsync), Git Bash rsync, or use WSL
  - Linux: `sudo apt install rsync` (or your distro's package manager)
- **OpenSSH 8.4+** in PATH (needed for `SSH_ASKPASS_REQUIRE=force`):
  - macOS: pre-installed
  - Windows 10 (1809+) / 11: pre-installed under `C:\Windows\System32\OpenSSH\`
  - Linux: `sudo apt install openssh-client`
- **VS Code Remote SSH** extension (for auto-detection; or configure host manually)
- On Linux, `zenity` is used for the native file picker: `sudo apt install zenity`

## License

MIT
