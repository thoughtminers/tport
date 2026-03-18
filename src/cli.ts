import { Command } from 'commander';
import { execSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDaemonPaths, isDaemonRunning, sendToDaemon } from './daemon.js';
import type { DaemonMessage, SessionInfo } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Injected by esbuild at release build time; falls back to package.json
declare const TPORT_VERSION: string;
const VERSION =
  typeof TPORT_VERSION !== 'undefined'
    ? TPORT_VERSION
    : (
        JSON.parse(
          fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')
        ) as { version: string }
      ).version;

function readConfig(): { port?: number; passwordHash?: string } {
  const configDir =
    process.env.TPORT_ROOT ?? path.join(process.env.HOME ?? '', '.tport');
  try {
    return JSON.parse(
      fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8')
    ) as {
      port?: number;
      passwordHash?: string;
    };
  } catch {
    return {};
  }
}

function getConfigPath(): string {
  const configDir =
    process.env.TPORT_ROOT ?? path.join(process.env.HOME ?? '', '.tport');
  return path.join(configDir, 'config.json');
}

function writeConfig(cfg: Record<string, unknown>): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
}

function readPassword(prompt: string): Promise<string> {
  return new Promise(resolve => {
    process.stdout.write(prompt);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    let input = '';
    const onData = (ch: string) => {
      if (ch === '\r' || ch === '\n') {
        process.stdin.removeListener('data', onData);
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdin.pause();
        process.stdout.write('\n');
        resolve(input);
      } else if (ch === '\u007F' || ch === '\b') {
        if (input.length > 0) input = input.slice(0, -1);
      } else if (ch === '\u0003') {
        process.exit(0);
      } else {
        input += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

const config = readConfig();
const DEFAULT_PORT = String(config.port ?? process.env.TPORT_PORT ?? '3010');

function getLocalIp(): string {
  try {
    const result = execSync(
      "ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}'",
      { encoding: 'utf-8' }
    ).trim();
    return result || 'localhost';
  } catch {
    return 'localhost';
  }
}

async function ensureDaemon(port: number): Promise<void> {
  if (isDaemonRunning()) return;

  const { dir } = getDaemonPaths();
  fs.mkdirSync(dir, { recursive: true });

  const daemonScript = process.env.TPORT_ROOT
    ? path.join(process.env.TPORT_ROOT, 'lib', 'daemon.mjs')
    : path.join(__dirname, 'daemon.js');
  const logFile = path.join(dir, 'daemon.log');
  const out = fs.openSync(logFile, 'a');

  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      TPORT_PORT: String(port),
      TPORT_PASSWORD_HASH: config.passwordHash ?? '',
    },
  });

  child.unref();

  // Wait for daemon to be ready
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const resp = await sendToDaemon({ type: 'ping' });
      if (resp.type === 'pong') return;
    } catch {
      // not ready yet
    }
  }

  // If we get here, show the log
  const log = fs.readFileSync(logFile, 'utf-8').trim();
  throw new Error(`Daemon failed to start within 6 seconds.\nLog: ${log}`);
}

const DETACH_COMMAND = '/detach';

async function attachToSession(sessionId: string, port = 3010): Promise<void> {
  const { WebSocket } = await import('ws');

  const tokenParam = config.passwordHash
    ? `?token=${encodeURIComponent(config.passwordHash)}`
    : '';
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${tokenParam}`);

  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      // Subscribe to session
      ws.send(JSON.stringify({ type: 'subscribe', sessionId }));

      // Enter raw mode so keystrokes go straight to the PTY
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();

      // Buffer for detecting detach command
      let inputBuffer = '';
      let buffering = false;

      const sendTopty = (data: string) => {
        ws.send(JSON.stringify({ type: 'input', sessionId, data }));
      };

      const flushBuffer = () => {
        if (inputBuffer) {
          sendTopty(inputBuffer);
          inputBuffer = '';
        }
        buffering = false;
      };

      // Forward local input to PTY, intercepting detach command
      process.stdin.on('data', (data: Buffer) => {
        const str = data.toString();

        for (const char of str) {
          if (char === '/' && !buffering) {
            buffering = true;
            inputBuffer = '/';
            continue;
          }

          if (buffering) {
            // Enter pressed — check if buffer is the detach command
            if (char === '\r' || char === '\n') {
              if (inputBuffer === DETACH_COMMAND) {
                console.log('\nDetached. Session continues in background.');
                console.log(`Reattach with: tport attach ${sessionId}`);
                cleanup();
                resolve();
                return;
              }
              // Not detach — flush buffer + enter to PTY
              inputBuffer += char;
              flushBuffer();
              continue;
            }

            inputBuffer += char;

            // Check if buffer still matches detach command prefix
            if (!DETACH_COMMAND.startsWith(inputBuffer)) {
              flushBuffer();
            }
            continue;
          }

          // Normal mode — send directly
          sendTopty(char);
        }
      });

      // Send terminal size
      const sendResize = () => {
        ws.send(
          JSON.stringify({
            type: 'resize',
            sessionId,
            cols: process.stdout.columns,
            rows: process.stdout.rows,
          })
        );
      };
      sendResize();
      process.stdout.on('resize', sendResize);
    });

    ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      switch (msg.type) {
        case 'scrollback':
        case 'output':
          process.stdout.write(msg.data);
          break;
        case 'session_ended':
          console.log('\nSession ended.');
          cleanup();
          resolve();
          break;
        case 'error':
          console.error('\nError:', msg.error);
          break;
      }
    });

    ws.on('close', () => {
      cleanup();
      resolve();
    });

    ws.on('error', err => {
      cleanup();
      reject(err);
    });

    const cleanup = () => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      ws.close();
    };
  });
}

const program = new Command();

program
  .name('tport')
  .description('Remote dev session dashboard')
  .version(VERSION);

program
  .command('password')
  .description('Set or remove the dashboard password')
  .argument('[password]', 'Password to set (omit for interactive prompt)')
  .option('--remove', 'Remove the current password')
  .action(
    async (passwordArg: string | undefined, opts: { remove?: boolean }) => {
      if (isDaemonRunning()) {
        const response = await sendToDaemon({ type: 'list' });
        const sessions = (response.sessions ?? []) as unknown as SessionInfo[];
        if (sessions.length > 0) {
          console.error(
            `There are ${sessions.length} active session(s). Run "tport stop --all" first so the new password takes effect.`
          );
          process.exit(1);
        }
      }

      const cfg = readConfig();

      if (opts.remove) {
        delete cfg.passwordHash;
        writeConfig(cfg);
        console.log('Password removed. Dashboard is now open.');
        if (isDaemonRunning()) {
          console.log(
            'Restart the daemon for this to take effect: tport shutdown && tport start'
          );
        }
        return;
      }

      let password: string;
      if (passwordArg) {
        password = passwordArg;
      } else {
        password = await readPassword('New password: ');
        if (!password) {
          console.error('Password cannot be empty. Use --remove to clear it.');
          process.exit(1);
        }
        const confirm = await readPassword('Confirm password: ');
        if (password !== confirm) {
          console.error('Passwords do not match.');
          process.exit(1);
        }
      }

      const hash = createHash('sha256').update(password).digest('hex');
      (cfg as Record<string, unknown>).passwordHash = hash;
      writeConfig(cfg as Record<string, unknown>);
      console.log('Password set.');
      if (isDaemonRunning()) {
        console.log(
          'Restart the daemon for this to take effect: tport shutdown && tport start'
        );
      }
    }
  );

program
  .command('start')
  .description('Start a new session')
  .argument('[command]', 'Command to run', process.env.SHELL ?? 'bash')
  .option('-n, --name <name>', 'Session name')
  .option('-p, --port <port>', 'Web server port', DEFAULT_PORT)
  .action(async (command: string, opts: { name?: string; port: string }) => {
    const port = parseInt(opts.port, 10);

    await ensureDaemon(port);

    const ip = getLocalIp();
    console.log(`Dashboard: http://${ip}:${port}`);

    // Resolve command to full path before sending to daemon
    let resolvedCommand = command;
    if (!command.startsWith('/')) {
      try {
        resolvedCommand = execSync(`which ${command}`, {
          encoding: 'utf-8',
        }).trim();
      } catch {
        console.error(`Command not found: ${command}`);
        process.exit(1);
      }
    }

    const response = (await sendToDaemon({
      type: 'create',
      name: opts.name,
      command: resolvedCommand,
      args: [],
      cwd: process.cwd(),
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
      env: process.env,
    })) as DaemonMessage & { session?: SessionInfo };

    if (response.type === 'error') {
      console.error('Failed to create session:', response.error);
      process.exit(1);
    }

    const session = response.session as unknown as SessionInfo;
    console.log(`Session ${session.id} (${session.name}) started.`);
    console.log('Attaching... (session persists if you disconnect)\n');

    await attachToSession(session.id, port);
  });

program
  .command('attach')
  .description('Attach to a running session')
  .argument('<session>', 'Session ID')
  .option('-p, --port <port>', 'Web server port', DEFAULT_PORT)
  .action(async (sessionId: string, opts: { port: string }) => {
    if (!isDaemonRunning()) {
      console.error('No daemon running. Start a session first.');
      process.exit(1);
    }

    await attachToSession(sessionId, parseInt(opts.port, 10));
  });

program
  .command('list')
  .description('List active sessions')
  .action(async () => {
    if (!isDaemonRunning()) {
      console.log('No daemon running.');
      return;
    }

    const response = await sendToDaemon({ type: 'list' });
    const sessions = (response.sessions ?? []) as unknown as SessionInfo[];

    if (sessions.length === 0) {
      console.log('No active sessions.');
      return;
    }

    console.log('Active sessions:\n');
    for (const s of sessions) {
      const age = Math.round(
        (Date.now() - new Date(s.createdAt).getTime()) / 1000
      );
      console.log(
        `  ${s.id}  ${s.name}  ${s.command}  ${s.cwd}  (${age}s ago)`
      );
    }
  });

program
  .command('stop')
  .description('Stop a session or all sessions')
  .argument('[session]', 'Session ID (omit for --all)')
  .option('-a, --all', 'Stop all sessions and shut down daemon')
  .action(async (sessionId?: string, opts?: { all?: boolean }) => {
    if (!isDaemonRunning()) {
      console.log('No daemon running.');
      return;
    }

    if (opts?.all) {
      await sendToDaemon({ type: 'kill_all' });
      console.log('All sessions stopped. Daemon shutting down.');
    } else if (sessionId) {
      const response = await sendToDaemon({ type: 'kill', id: sessionId });
      if (response.type === 'error') {
        console.error(response.error);
        process.exit(1);
      }
      console.log(`Session ${sessionId} stopped.`);
    } else {
      console.error('Provide a session ID or use --all.');
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show daemon and session status')
  .option('-p, --port <port>', 'Web server port', DEFAULT_PORT)
  .action(async (opts: { port: string }) => {
    if (!isDaemonRunning()) {
      console.log('No daemon running.');
      return;
    }

    const ip = getLocalIp();
    console.log(`Dashboard: http://${ip}:${opts.port}`);

    const response = await sendToDaemon({ type: 'list' });
    const sessions = (response.sessions ?? []) as unknown as SessionInfo[];
    console.log(`Sessions: ${sessions.length}`);

    for (const s of sessions) {
      console.log(`  ${s.id}  ${s.name}  ${s.command}  ${s.cwd}`);
    }
  });

program
  .command('shutdown')
  .description('Stop all sessions and shut down the daemon')
  .action(async () => {
    if (!isDaemonRunning()) {
      console.log('No daemon running.');
      return;
    }
    await sendToDaemon({ type: 'shutdown' });
    console.log('Daemon shut down.');
  });

program
  .command('update')
  .description('Update tport to the latest version (standalone installs only)')
  .option('--check', 'Check for updates without installing')
  .action(async (opts: { check?: boolean }) => {
    const root = process.env.TPORT_ROOT;
    if (!root) {
      console.error('update: only supported for standalone installs.');
      console.error('If installed via npm, use: npm update -g tport');
      process.exit(1);
    }

    const { version: currentVersion } = JSON.parse(
      fs.readFileSync(path.join(root, 'version.json'), 'utf-8')
    ) as { version: string };

    const resp = await fetch(
      'https://api.github.com/repos/thoughtminers/tport/releases/latest',
      { headers: { 'User-Agent': 'tport' } }
    );
    if (!resp.ok) {
      console.error(`Failed to fetch release info: HTTP ${resp.status}`);
      process.exit(1);
    }

    const release = (await resp.json()) as {
      tag_name: string;
      assets: { name: string; browser_download_url: string }[];
    };
    const latestVersion = release.tag_name.replace(/^v/, '');

    if (currentVersion === latestVersion) {
      console.log(`Already up to date (v${currentVersion})`);
      return;
    }

    console.log(`Update available: v${currentVersion} → v${latestVersion}`);
    if (opts.check) return;

    const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const tarName = `tport-${latestVersion}-${platform}-${arch}.tar.gz`;
    const sha256Name = `${tarName}.sha256`;

    const tarAsset = release.assets.find(a => a.name === tarName);
    const sha256Asset = release.assets.find(a => a.name === sha256Name);
    if (!tarAsset || !sha256Asset) {
      console.error(`No release asset found for ${platform}-${arch}`);
      process.exit(1);
    }

    const tmpDir = fs.mkdtempSync(
      path.join(path.dirname(root), '.tport-update-')
    );
    try {
      const tarPath = path.join(tmpDir, tarName);
      console.log(`Downloading ${tarName}...`);

      const tarResp = await fetch(tarAsset.browser_download_url);
      if (!tarResp.ok)
        throw new Error(`Download failed: HTTP ${tarResp.status}`);
      fs.writeFileSync(tarPath, Buffer.from(await tarResp.arrayBuffer()));

      // Verify SHA256
      const sha256Resp = await fetch(sha256Asset.browser_download_url);
      const expectedHash = (await sha256Resp.text()).trim().split(/\s/)[0];
      const { createHash } = await import('node:crypto');
      const actualHash = createHash('sha256')
        .update(fs.readFileSync(tarPath))
        .digest('hex');
      if (actualHash !== expectedHash) {
        console.error('Checksum mismatch — aborting update.');
        process.exit(1);
      }

      // Extract
      const extractDir = path.join(tmpDir, 'extracted');
      fs.mkdirSync(extractDir);
      execSync(`tar -xzf "${tarPath}" -C "${extractDir}"`);
      const extracted = fs.readdirSync(extractDir)[0];
      const newRoot = path.join(extractDir, extracted);

      // Atomic swap
      const backup = `${root}-backup`;
      fs.renameSync(root, backup);
      try {
        fs.renameSync(newRoot, root);
      } catch (err) {
        fs.renameSync(backup, root); // roll back
        throw err;
      }

      // Preserve user config across the swap
      const savedConfig = path.join(backup, 'config.json');
      if (fs.existsSync(savedConfig)) {
        fs.copyFileSync(savedConfig, path.join(root, 'config.json'));
      }

      fs.rmSync(backup, { recursive: true, force: true });

      console.log(`Updated to v${latestVersion}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

program.parse();
