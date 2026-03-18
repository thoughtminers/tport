# tport

Remote dev session dashboard. Monitor and interact with your terminal sessions from your phone.

Start Claude Code (or any terminal command), walk away, and pick it up from your phone — see live terminal output, send input, review diffs, and browse files.

> **Warning:** tport exposes a live terminal session over your local network. Anyone with access to the dashboard can execute commands on your machine. Always set a password and only use on trusted networks. Use at your own risk — the authors are not responsible for any damage or unauthorized access resulting from the use of this tool.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/thoughtminers/tport/main/scripts/install.sh | sh
```

Installs to `~/.tport` and adds it to your PATH. Supports macOS (Apple Silicon) and Linux (x64).

During install you'll be asked to set an optional dashboard password. To change it later:

```sh
tport password            # set or change password
tport password --remove   # remove password (open access)
```

To change the default port, edit `~/.tport/config.json`:

```json
{
  "port": 3010
}
```

### Update

```sh
tport update
```

### Uninstall

```sh
rm -rf ~/.tport
# Remove the PATH line from ~/.zshrc or ~/.bashrc
```

---

## Why?

AI coding tools like Claude Code run long sessions. You step away, come back hours later, and have no idea what happened. Or you're on your phone and want to approve an action, check a diff, or just see if it's still running.

tport wraps your terminal session so you can access it from anywhere on your local network.

## How it works

```
tport start claude

Your terminal works exactly as before.
Meanwhile, a web dashboard is available at http://<your-ip>:3000
Open it on your phone. Same session, live.
```

tport spawns your command inside a PTY (pseudoterminal) using [node-pty](https://github.com/microsoft/node-pty) and pipes it to your local terminal. Simultaneously, a web server broadcasts the terminal output via WebSocket to any connected browser.

### Multiple sessions

```
# Terminal 1
tport start claude          # starts daemon + session #1

# Terminal 2
tport start "npm run dev"   # reuses daemon, creates session #2

# Phone
# Dashboard shows both sessions, switch between them
```

A single background daemon manages all sessions. The web dashboard provides a session switcher to move between them.

### Detach and reattach

Close your terminal — the session keeps running in the background. Come back later:

```
tport list                  # see what's running
tport attach <session>      # reattach to a session
```

## Features

- **Terminal** — live terminal view in your browser (xterm.js), full input support
- **Diffs** — git diff with syntax highlighting, file-by-file view
- **Files** — read-only project file browser
- **Multi-session** — run multiple sessions, switch between them
- **Mobile-first** — designed for phones, works on desktop too
- **Password protection** — optional password to lock down the dashboard
- **No multiplexer** — no tmux, no Zellij, no extra keybindings or UI

## Why not tmux / Zellij / screen?

Terminal multiplexers can do remote sessions, but they come with baggage most developers don't want:

- **Learning curve.** If you were already a tmux/Zellij user, you wouldn't need this tool. Most developers just want their terminal to work — not learn a new one.
- **Extra UI.** Status bars, tab bars, pane borders — multiplexers add visual noise you didn't ask for.
- **Extra dependency.** tmux/Zellij are system-level tools that need to be installed and configured separately. tport is a single `npm install`.

tport gives you the one multiplexer feature you actually need — a session that survives closing your terminal and is accessible remotely — without everything else.

## CLI

```
tport start [command]       # start a session (default: $SHELL)
tport attach <session>      # reattach to a running session
tport list                  # list active sessions
tport stop <session>        # stop a session
tport stop --all            # stop all sessions
tport status                # show dashboard URL and session info
tport password              # set or change the dashboard password
tport password --remove     # remove password protection
tport shutdown              # stop all sessions and shut down the daemon
tport update                # update to the latest version
```

## License

[MIT](LICENSE)
