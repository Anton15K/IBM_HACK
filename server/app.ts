import { ModelService, modelConnectionsRoutes } from './models.js';
import { executeTask } from './executor.js';
import { executeApiTask } from './apiExecutor.js';
import { plannerRoutes } from './routes/planner.js';
import { Runtime, type Executor } from './runtime.js';
import { runtimeRoutes } from './routes/runtime.js';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, requireTeamAccess as dbRequireTeamAccess } from './db.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { membersRoutes } from './routes/members.js';
import { projectRoutes } from './routes/project.js';
import { teamsRoutes } from './routes/teams.js';
import { nodesRoutes } from './routes/nodes.js';
import { graphsRoutes } from './routes/graphs.js';
import { templatesRoutes } from './routes/templates.js';
import { makeCapabilitiesRoutes, type CapabilitiesOptions } from './routes/capabilities.js';

// Allowed local frontend origins for state-changing requests
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:7142',
  'http://127.0.0.1:7142',
  ...(process.env.TEAMWEAVE_FRONTEND_ORIGIN ? [new URL(process.env.TEAMWEAVE_FRONTEND_ORIGIN).origin] : []),
]);

declare module 'fastify' {
  interface FastifyInstance {
    db: DatabaseSync;
  }
}

export interface BuildAppOptions {
  dbPath?: string;
  logger?: boolean | object;
  /** Injected for tests to control capabilities response without real env/files */
  capabilitiesOptions?: CapabilitiesOptions;
  executor?: Executor;
  modelOptions?: { fetchFn?: typeof fetch; masterKey?: Buffer; allowedHosts?: string[] };
}

export function buildApp(options: BuildAppOptions = {}): ReturnType<typeof Fastify> {
  const dbPath = options.dbPath ?? (process.env.TEAMWEAVE_DB ?? '.data/teamweave.db');
  const db = openDb(dbPath);

  const app = Fastify({
    logger: options.logger !== undefined ? options.logger : false,
    bodyLimit: 512 * 1024, // 512 KB
  });

  // Decorate with db instance
  app.decorate('db', db);
  const modelService = new ModelService(db, dbPath, options.modelOptions?.masterKey, options.modelOptions?.allowedHosts);
  const runtime = new Runtime(db, options.executor ?? (input => input.node.executor.provider === 'api'
    ? executeApiTask({ input, orgId: input.orgId!, connectionId: input.node.executor.connectionId!, modelService, fetchFn: options.modelOptions?.fetchFn })
    : executeTask(input)));
  app.register(modelConnectionsRoutes, { modelService });
  app.register(plannerRoutes, { modelService, fetchFn: options.modelOptions?.fetchFn });
  app.decorate('runtime', runtime);

  // Close DB on app close
  app.addHook('onClose', async () => {
    await runtime.close();
    db.close();
  });

  // Register cookie plugin
  app.register(cookie);

  // Local backend: validate the actual Host on every request, including reads.
  // Forwarded headers are untrusted; Vite keeps a loopback Host with its own port.
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host;
    const localHost = typeof host === 'string'
      ? /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i.exec(host)
      : null;
    if (!localHost || (localHost[2] !== undefined &&
        (Number(localHost[2]) < 1 || Number(localHost[2]) > 65535))) {
      return reply.status(403).send({ error: 'Forbidden: untrusted host' });
    }

    const origin = req.headers.origin;
    const method = req.method?.toUpperCase();
    const isStateful = method === 'POST' || method === 'PUT' ||
                       method === 'PATCH' || method === 'DELETE';

    if (isStateful && origin !== undefined) {
      if (!ALLOWED_ORIGINS.has(origin)) {
        return reply.status(403).send({ error: 'Forbidden: untrusted origin' });
      }
    }
  });

  // Error handler — translate statusCode attached to errors
  app.setErrorHandler(async (err: Error & { statusCode?: number }, _req, reply) => {
    const statusCode = Number.isInteger(err.statusCode) && err.statusCode! >= 400 && err.statusCode! <= 599
      ? err.statusCode! : 500;
    // Do not expose or log arbitrary exception text: it can contain paths or credentials.
    if (statusCode >= 500) _req.log.error({ statusCode }, 'Request failed');
    const message = statusCode >= 500 ? 'Internal server error' : err.message;
    return reply.status(statusCode).send({ error: message });
  });

  // Register routes
  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(membersRoutes);
  app.register(projectRoutes);
  app.register(teamsRoutes);
  app.register(nodesRoutes);
  app.register(runtimeRoutes);
  app.register(graphsRoutes);
  app.register(templatesRoutes);
  app.register(makeCapabilitiesRoutes({ ...options.capabilitiesOptions, modelHosts: modelService.getAllowedHosts() }));

  return app;
}

// Export access helper for use in later runner routes
export function requireTeamAccess(
  db: DatabaseSync,
  userId: string,
  orgId: string,
  teamId: string,
  required: 'read' | 'edit',
): boolean {
  return dbRequireTeamAccess(db, userId, orgId, teamId, required);
}
