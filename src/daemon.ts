import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { SessionManager } from './core/session.js';
import { createServer } from './server.js';
import type { DaemonMessage, SessionCreateOptions } from './types.js';

const TPORT_DIR = path.join(process.env.HOME ?? '/tmp', '.tport');
const PID_FILE = path.join(TPORT_DIR, 'daemon.pid');
const SOCK_FILE = path.join(TPORT_DIR, 'daemon.sock');
const DEFAULT_PORT = 3010;

export function getDaemonPaths() {
  return { dir: TPORT_DIR, pidFile: PID_FILE, sockFile: SOCK_FILE };
}

export function isDaemonRunning(): boolean {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function sendToDaemon(
  message: DaemonMessage
): Promise<DaemonMessage> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(SOCK_FILE, () => {
      client.write(JSON.stringify(message) + '\n');
    });

    let buffer = '';
    client.on('data', chunk => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx !== -1) {
        const response = JSON.parse(buffer.slice(0, newlineIdx));
        client.end();
        resolve(response);
      }
    });

    client.on('error', reject);
    client.on('timeout', () => {
      client.destroy();
      reject(new Error('Daemon connection timed out'));
    });
    client.setTimeout(5000);
  });
}

export async function startDaemon(port = DEFAULT_PORT): Promise<void> {
  fs.mkdirSync(TPORT_DIR, { recursive: true });

  // Clean up stale socket
  if (fs.existsSync(SOCK_FILE)) {
    fs.unlinkSync(SOCK_FILE);
  }

  const passwordHash = process.env.TPORT_PASSWORD_HASH || undefined;
  const sessionManager = new SessionManager();
  const app = createServer(sessionManager, passwordHash);

  // Start the HTTP + WebSocket server
  const address = await app.listen({ port, host: '0.0.0.0' });
  console.log(`tport web dashboard: ${address}`);

  // Start the Unix socket for CLI communication
  const unixServer = net.createServer(socket => {
    let buffer = '';

    socket.on('data', chunk => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx === -1) return;

      const raw = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);

      let msg: DaemonMessage;
      try {
        msg = JSON.parse(raw);
      } catch {
        socket.write(
          JSON.stringify({ type: 'error', error: 'Invalid JSON' }) + '\n'
        );
        return;
      }

      if (msg.type === 'shutdown') {
        socket.write(JSON.stringify({ type: 'shutdown_ok' }) + '\n');
        socket.end();
        setImmediate(cleanup);
        return;
      }

      const response = handleDaemonMessage(sessionManager, msg);
      socket.write(JSON.stringify(response) + '\n');
    });
  });

  unixServer.listen(SOCK_FILE, () => {
    console.log(`tport daemon listening on ${SOCK_FILE}`);
  });

  // Write PID file
  fs.writeFileSync(PID_FILE, String(process.pid));

  // Graceful shutdown
  const cleanup = () => {
    console.log('tport daemon shutting down...');
    sessionManager.killAll();
    unixServer.close();
    app.close();
    try {
      fs.unlinkSync(PID_FILE);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(SOCK_FILE);
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  // Auto-shutdown when last session ends (if no sessions remain)
  sessionManager.on('session_removed', () => {
    if (sessionManager.size === 0) {
      console.log('All sessions ended. Shutting down daemon.');
      cleanup();
    }
  });
}

function handleDaemonMessage(
  sessionManager: SessionManager,
  msg: DaemonMessage
): DaemonMessage {
  switch (msg.type) {
    case 'create': {
      try {
        const options = msg as unknown as DaemonMessage & SessionCreateOptions;
        const id = sessionManager.create({
          name: options.name as string | undefined,
          command: options.command as string,
          args: options.args as string[] | undefined,
          cwd: options.cwd as string,
          cols: options.cols as number | undefined,
          rows: options.rows as number | undefined,
          env: options.env as Record<string, string> | undefined,
        });
        const info = sessionManager.getInfo(id);
        return { type: 'created', session: info as unknown as DaemonMessage };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { type: 'error', error: `Failed to create session: ${message}` };
      }
    }

    case 'list': {
      const sessions = sessionManager.list();
      return { type: 'sessions', sessions };
    }

    case 'kill': {
      const id = msg.id as string;
      if (!sessionManager.has(id)) {
        return { type: 'error', error: `Session ${id} not found` };
      }
      sessionManager.kill(id);
      return { type: 'killed', id };
    }

    case 'kill_all': {
      sessionManager.killAll();
      return { type: 'killed_all' };
    }

    case 'info': {
      const id = msg.id as string;
      if (!sessionManager.has(id)) {
        return { type: 'error', error: `Session ${id} not found` };
      }
      const info = sessionManager.getInfo(id);
      return { type: 'session', session: info as unknown as DaemonMessage };
    }

    case 'ping': {
      return { type: 'pong' };
    }

    default:
      return { type: 'error', error: `Unknown message type: ${msg.type}` };
  }
}

// Run directly when this file is the entry point
const isMain =
  process.argv[1]?.endsWith('daemon.js') ||
  process.argv[1]?.endsWith('daemon.mjs') ||
  process.argv[1]?.endsWith('daemon.ts');

if (isMain) {
  const port = parseInt(process.env.TPORT_PORT ?? String(DEFAULT_PORT), 10);
  startDaemon(port).catch(err => {
    console.error('Failed to start daemon:', err);
    process.exit(1);
  });
}
