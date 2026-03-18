import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFileTree, readFileContent } from './core/files.js';
import {
  commitStaged,
  getDiff,
  getDiffStats,
  getLog,
  getStagedDiff,
  getStatus,
  getUnstagedDiff,
  getUntrackedFiles,
  isGitRepo,
  stageFile,
  unstageFile,
} from './core/git.js';
import type { SessionManager } from './core/session.js';
import type { WsClientMessage } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = process.env.TPORT_ROOT
  ? path.join(process.env.TPORT_ROOT, 'lib', 'public')
  : path.join(__dirname, '..', 'public');

export function createServer(
  sessionManager: SessionManager,
  passwordHash?: string
) {
  const app = Fastify({ logger: false });

  // Static files
  app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/',
  });

  // Auth hook — skip if no password configured
  if (passwordHash) {
    app.addHook('onRequest', async (request, reply) => {
      // Allow static files (served by @fastify/static)
      if (!request.url.startsWith('/api/') && !request.url.startsWith('/ws')) {
        return;
      }

      // WebSocket auth is handled via query param in the WS route
      if (request.url.startsWith('/ws')) {
        return;
      }

      const token = request.headers['x-tport-auth'] as string | undefined;
      if (token !== passwordHash) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
    });
  }

  // WebSocket plugin + route
  app.register(fastifyWebsocket);

  app.register(async function wsRoutes(fastify) {
    fastify.get('/ws', { websocket: true }, (socket, _req) => {
      // Auth check for WebSocket
      if (passwordHash) {
        const url = new URL(_req.url ?? '', `http://${_req.headers.host}`);
        const token = url.searchParams.get('token');
        if (token !== passwordHash) {
          socket.send(JSON.stringify({ type: 'error', error: 'Unauthorized' }));
          socket.close();
          return;
        }
      }
      let subscribedSessionId: string | null = null;
      let unsubscribe: (() => void) | null = null;

      socket.on('message', (raw: Buffer) => {
        let msg: WsClientMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          socket.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
          return;
        }

        switch (msg.type) {
          case 'subscribe': {
            if (unsubscribe) {
              unsubscribe();
              unsubscribe = null;
            }

            const sessionId = msg.sessionId;
            if (!sessionId || !sessionManager.has(sessionId)) {
              socket.send(
                JSON.stringify({
                  type: 'error',
                  error: `Session ${sessionId} not found`,
                })
              );
              return;
            }

            subscribedSessionId = sessionId;

            const scrollback = sessionManager.getScrollback(sessionId);
            if (scrollback) {
              socket.send(
                JSON.stringify({
                  type: 'scrollback',
                  sessionId,
                  data: scrollback,
                })
              );
            }

            unsubscribe = sessionManager.onData(sessionId, data => {
              socket.send(JSON.stringify({ type: 'output', sessionId, data }));
            });

            sessionManager.onExit(sessionId, () => {
              socket.send(JSON.stringify({ type: 'session_ended', sessionId }));
            });

            break;
          }

          case 'input': {
            const sid = msg.sessionId ?? subscribedSessionId;
            if (sid && sessionManager.has(sid)) {
              sessionManager.write(sid, msg.data ?? '');
            }
            break;
          }

          case 'resize': {
            const sid = msg.sessionId ?? subscribedSessionId;
            if (sid && sessionManager.has(sid) && msg.cols && msg.rows) {
              sessionManager.resize(sid, msg.cols, msg.rows);
            }
            break;
          }
        }
      });

      socket.on('close', () => {
        if (unsubscribe) {
          unsubscribe();
        }
      });
    });
  });

  // Helper to get session cwd
  function getSessionCwd(sessionId: string | undefined): string | null {
    if (!sessionId) return null;
    if (!sessionManager.has(sessionId)) return null;
    return sessionManager.getInfo(sessionId).cwd;
  }

  // ── Session API ──

  app.get('/api/sessions', async () => {
    return sessionManager.list();
  });

  app.get<{ Params: { id: string } }>(
    '/api/sessions/:id',
    async (request, reply) => {
      const { id } = request.params;
      if (!sessionManager.has(id)) {
        return reply.code(404).send({ error: `Session ${id} not found` });
      }
      return sessionManager.getInfo(id);
    }
  );

  app.post<{ Params: { id: string } }>(
    '/api/sessions/:id/kill',
    async (request, reply) => {
      const { id } = request.params;
      if (!sessionManager.has(id)) {
        return reply.code(404).send({ error: `Session ${id} not found` });
      }
      sessionManager.kill(id);
      return { ok: true };
    }
  );

  // ── Git API ──

  app.get<{ Querystring: { session: string } }>(
    '/api/diff',
    async (request, reply) => {
      const cwd = getSessionCwd(request.query.session);
      if (!cwd) return reply.code(400).send({ error: 'Invalid session' });
      if (!isGitRepo(cwd))
        return reply.code(400).send({ error: 'Not a git repo' });
      return {
        diff: getDiff(cwd),
        staged: getStagedDiff(cwd),
        unstaged: getUnstagedDiff(cwd),
        untracked: getUntrackedFiles(cwd),
        stats: getDiffStats(cwd),
      };
    }
  );

  app.get<{ Querystring: { session: string } }>(
    '/api/status',
    async (request, reply) => {
      const cwd = getSessionCwd(request.query.session);
      if (!cwd) return reply.code(400).send({ error: 'Invalid session' });
      if (!isGitRepo(cwd))
        return reply.code(400).send({ error: 'Not a git repo' });
      return { files: getStatus(cwd) };
    }
  );

  app.get<{ Querystring: { session: string; n?: string } }>(
    '/api/log',
    async (request, reply) => {
      const cwd = getSessionCwd(request.query.session);
      if (!cwd) return reply.code(400).send({ error: 'Invalid session' });
      if (!isGitRepo(cwd))
        return reply.code(400).send({ error: 'Not a git repo' });
      const n = parseInt(request.query.n ?? '20', 10);
      return { commits: getLog(cwd, n) };
    }
  );

  app.post<{ Body: { session: string; file: string } }>(
    '/api/stage',
    async (request, reply) => {
      const cwd = getSessionCwd(request.body.session);
      if (!cwd) return reply.code(400).send({ error: 'Invalid session' });
      if (!isGitRepo(cwd))
        return reply.code(400).send({ error: 'Not a git repo' });
      try {
        stageFile(cwd, request.body.file);
        return { ok: true };
      } catch (e) {
        return reply.code(500).send({ error: String(e) });
      }
    }
  );

  app.post<{ Body: { session: string; file: string } }>(
    '/api/unstage',
    async (request, reply) => {
      const cwd = getSessionCwd(request.body.session);
      if (!cwd) return reply.code(400).send({ error: 'Invalid session' });
      if (!isGitRepo(cwd))
        return reply.code(400).send({ error: 'Not a git repo' });
      try {
        unstageFile(cwd, request.body.file);
        return { ok: true };
      } catch (e) {
        return reply.code(500).send({ error: String(e) });
      }
    }
  );

  app.post<{ Body: { session: string; message: string } }>(
    '/api/commit',
    async (request, reply) => {
      const cwd = getSessionCwd(request.body.session);
      if (!cwd) return reply.code(400).send({ error: 'Invalid session' });
      if (!isGitRepo(cwd))
        return reply.code(400).send({ error: 'Not a git repo' });
      if (!request.body.message?.trim())
        return reply.code(400).send({ error: 'Message required' });
      try {
        const output = commitStaged(cwd, request.body.message);
        return { ok: true, output };
      } catch (e) {
        return reply.code(500).send({ error: String(e) });
      }
    }
  );

  // ── Files API ──

  app.get<{ Querystring: { session: string } }>(
    '/api/files',
    async (request, reply) => {
      const cwd = getSessionCwd(request.query.session);
      if (!cwd) return reply.code(400).send({ error: 'Invalid session' });
      return { tree: getFileTree(cwd) };
    }
  );

  app.get<{ Querystring: { session: string; path: string } }>(
    '/api/file',
    async (request, reply) => {
      const cwd = getSessionCwd(request.query.session);
      if (!cwd) return reply.code(400).send({ error: 'Invalid session' });
      const filePath = request.query.path;
      if (!filePath) return reply.code(400).send({ error: 'Missing path' });
      const result = readFileContent(cwd, filePath);
      if (result.error) return reply.code(400).send({ error: result.error });
      return { content: result.content, path: filePath };
    }
  );

  return app;
}
