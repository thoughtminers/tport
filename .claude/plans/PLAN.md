# devpilot - Remote Dev Session Dashboard

## Context

When working with Claude Code (or any terminal tool), you sometimes need to step away and continue later - possibly from your phone. You want to:
1. See what Claude is doing / has done (terminal output)
2. Send messages or approve actions remotely
3. Review file diffs with syntax highlighting
4. Browse project files

**Approach**: Use node-pty to own the PTY directly. No multiplexer needed. devpilot spawns the command, pipes it to your local terminal, and simultaneously broadcasts via WebSocket to a mobile-friendly web dashboard.

## Architecture

```
devpilot daemon (single background process)
    ├── owns all PTY sessions (node-pty)
    ├── runs web server on port 3000
    ├── broadcasts PTY output via WebSocket
    └── serves REST API for diffs/files

devpilot start claude (1st time)
    ├── launches the daemon in background
    ├── creates session #1 in the daemon
    └── attaches local terminal to session #1

devpilot start claude (2nd time)
    ├── connects to existing daemon
    ├── creates session #2 in the daemon
    └── attaches local terminal to session #2

Local terminal:  stdin/stdout ←→ daemon (via unix socket) ←→ PTY
Phone browser:   WebSocket    ←→ daemon ←→ PTY (same sessions)
                 + REST API for diffs/files

When you close your terminal:
    └── daemon + all PTYs + web server keep running
    └── reconnect from phone or `devpilot attach <session>`
```

## Project Structure

```
devpilot/
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE
├── src/
│   ├── cli.ts                 # CLI entry point (commander)
│   ├── daemon.ts              # Daemon process (web server + session manager)
│   ├── server.ts              # Express server + WebSocket + REST API
│   ├── core/
│   │   ├── session.ts         # PTY session manager (node-pty, spawn, attach, detach)
│   │   ├── git.ts             # Git operations (diff, status, log)
│   │   └── files.ts           # File tree & file reading (respects .gitignore)
│   └── types.ts               # TypeScript types
├── public/
│   ├── index.html             # Main dashboard (SPA with tabs)
│   ├── styles.css             # Mobile-first dark theme
│   └── app.js                 # Frontend JS (xterm.js terminal, diff viewer, file browser)
└── bin/
    └── devpilot               # Executable entry point
```

## Implementation Steps

### Step 0: Project setup
- Write README explaining the project, motivation, and why we use node-pty instead of a multiplexer
- Add MIT License
- Init git repo

### Step 1: Project scaffolding
- Init package.json with npm
- Install deps: `commander`, `express`, `ws`, `node-pty`, `diff2html`, `highlight.js`
- Frontend deps (served from CDN or vendored): `xterm`, `xterm-addon-fit`
- Setup tsconfig.json
- Create directory structure

### Step 2: PTY session manager (`src/core/session.ts`)
The heart of devpilot. Manages multiple PTY sessions within a single daemon process.

```typescript
class SessionManager {
  // Stores active sessions: { id, pty, name, cwd, command, createdAt, scrollback[] }
  sessions: Map<string, Session>

  // Spawn a command in a new PTY, returns session ID
  create(name: string, command: string, cwd: string): string

  // Attach local terminal stdin/stdout to a session's PTY
  attach(id: string, stdin: Readable, stdout: Writable): void

  // Detach local terminal (PTY keeps running)
  detach(id: string): void

  // Kill the PTY process and clean up
  kill(id: string): void

  // List all active sessions
  list(): SessionInfo[]

  // Write input to a session's PTY (from web UI)
  write(id: string, data: string): void

  // Subscribe to PTY output (for WebSocket broadcast)
  onData(id: string, callback: (data: string) => void): void
}
```

Key behaviors:
- `pty.onData()` fires for all output → pushed to WebSocket clients + stored in scrollback buffer
- Scrollback buffer keeps last N lines so new web clients see recent history
- When local terminal attaches, stdin pipes to `pty.write()`, `pty.onData()` pipes to stdout
- When local terminal detaches (close/ctrl+c), PTY keeps running in background
- Session persists until explicitly killed or process exits
- Multiple sessions can run simultaneously, each with its own PTY

### Step 3: Daemon process (`src/daemon.ts`)
Single background process that owns everything:
- Starts the web server (Express + WebSocket)
- Initializes the SessionManager
- Listens on a Unix socket for CLI commands (create session, attach, list, kill)
- Stays alive as long as there are active sessions (or until `devpilot stop --all`)

### Step 4: Web server + WebSocket (`src/server.ts`)
- Express server on port 3000, bound to 0.0.0.0
- Serves static files from `public/`
- WebSocket server on same port (upgrade handler)
- WebSocket protocol:
  - Client→Server: `{ type: "input", sessionId: "...", data: "..." }` — send keystrokes to PTY
  - Client→Server: `{ type: "resize", sessionId: "...", cols: N, rows: N }` — resize PTY
  - Client→Server: `{ type: "subscribe", sessionId: "..." }` — subscribe to a session
  - Server→Client: `{ type: "output", sessionId: "...", data: "..." }` — PTY output
  - Server→Client: `{ type: "scrollback", sessionId: "...", data: "..." }` — initial history on connect

### Step 5: Git operations (`src/core/git.ts`)
Functions:
- `getDiff(cwd: string)` — runs `git diff` + `git diff --cached`, returns raw diff text
- `getStatus(cwd: string)` — runs `git status --porcelain`, returns file list with status
- `getLog(cwd: string, n: number)` — runs `git log --oneline -n`, returns recent commits
- `getDiffStats(cwd: string)` — runs `git diff --stat`, returns summary

### Step 6: File operations (`src/core/files.ts`)
Functions:
- `getFileTree(cwd: string)` — walks directory, respects .gitignore, returns tree structure
- `readFile(cwd: string, path: string)` — reads file content (with path traversal protection)

### Step 7: REST API (in `src/server.ts`)
Endpoints:
- `GET /api/sessions` — returns list of active sessions
- `GET /api/sessions/:id` — returns session details
- `POST /api/sessions/:id/kill` — kill a session
- `GET /api/diff?session=<id>` — returns git diff for session's project (raw + HTML via diff2html)
- `GET /api/status?session=<id>` — returns git status
- `GET /api/log?session=<id>` — returns recent commits
- `GET /api/files?session=<id>` — returns file tree for session's project
- `GET /api/file?session=<id>&path=<path>` — returns file content

### Step 8: Web dashboard (`public/`)
Mobile-first SPA with session awareness:

**Session switcher:**
- Dropdown or sidebar listing all active sessions
- Shows session name, command, project path, created time
- Switch between sessions

**Terminal tab:**
- xterm.js renders the terminal in the browser
- Connects to selected session's PTY via WebSocket
- Receives scrollback history on connect (see recent output)
- Full input support (type commands, approve actions)
- Auto-resize to fit viewport

**Diffs tab:**
- Rendered via diff2html (unified view on mobile, side-by-side on desktop)
- File-by-file collapsible sections
- Refresh button
- Color-coded (green=added, red=removed)
- Scoped to the selected session's project directory

**Files tab:**
- Collapsible tree view
- Click to view file content with syntax highlighting
- Read-only
- Scoped to the selected session's project directory

Design:
- Dark theme
- Bottom tab bar (mobile UX)
- No framework, vanilla JS
- xterm.js for terminal, diff2html for diffs, highlight.js for syntax

### Step 9: CLI (`src/cli.ts`)
Commands:
- `devpilot start [command]` — Start a session. Default command: `claude`
  - If no daemon running: launches daemon in background, then creates session
  - If daemon already running: connects to it, creates new session
  - Attaches local terminal to the new session
  - Prints web URL for phone access
  - On terminal close/detach: daemon + PTY keep running
- `devpilot attach [session]` — Reattach local terminal to a running session
- `devpilot list` — List active sessions with status
- `devpilot stop [session]` — Kill a specific session (daemon stays if other sessions exist)
- `devpilot stop --all` — Kill all sessions and shut down daemon
- `devpilot status` — Show web URL, active sessions, connected clients

### Step 10: Daemonization
- `devpilot start` forks the daemon as a detached child process (`child_process.fork` with `detached: true`)
- Daemon PID stored in `~/.devpilot/daemon.pid`
- CLI communicates with daemon via Unix socket at `~/.devpilot/daemon.sock`
- Daemon auto-shuts down when last session ends (configurable)

## Key Details

### How attach/detach works
- `devpilot start` checks if daemon is running (via PID file + socket)
- If not: forks daemon, waits for socket to be ready
- Sends "create session" command to daemon via Unix socket
- Daemon creates PTY, returns session ID
- CLI enters raw mode, pipes stdin/stdout over the Unix socket to the PTY
- On Ctrl+C or terminal close: CLI disconnects, daemon keeps running
- `devpilot attach <id>` reconnects to an existing session the same way

### Multi-session on the web dashboard
- Session list always visible (sidebar on desktop, dropdown on mobile)
- Each session shows: name, command, project path, status (active/ended), age
- Switching sessions changes the terminal view, diffs, and file browser context
- Multiple browser tabs can connect to different sessions simultaneously

### Security (local network phase)
- Server bound to `0.0.0.0` (accessible on LAN)
- Optional: simple token-based auth (query param or header)
- Path traversal protection on file reads (must be within project dir)

### Mobile UX
- Bottom tab bar with 3 tabs: Terminal | Diffs | Files
- Session switcher at the top
- Touch-friendly buttons and controls
- Viewport meta tag for proper mobile scaling
- xterm.js works on mobile browsers

## Verification

1. `devpilot start` — launches daemon + Claude session, you interact normally in terminal
2. `devpilot start node` in another terminal — creates second session, same daemon
3. `devpilot list` — shows both sessions
4. Open `http://<lan-ip>:3000` on phone — see dashboard with session switcher
5. Switch between sessions — terminal, diffs, files update accordingly
6. Terminal tab — shows live terminal output, can type and send input
7. Diffs tab — shows current git diff with syntax highlighting
8. Files tab — shows project file tree, click files to view content
9. Close terminal on desktop — sessions keep running
10. `devpilot attach <id>` — reattach from a new terminal
11. `devpilot stop <id>` — kills one session
12. `devpilot stop --all` — kills everything cleanly
