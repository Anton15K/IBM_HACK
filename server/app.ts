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
  const runtime = new Runtime(db, options.executor);
  app.decorate('runtime', runtime);

  // Close DB on app close
  app.addHook('onClose', async () => {
    await runtime.close();
    db.close();
  });

  // Register cookie plugin
  app.register(cookie);

  // Origin check hook — reject untrusted Origin header on state-changing requests
  app.addHook('onRequest', async (req, reply) => {
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
    const statusCode = err.statusCode ?? 500;
    const message = err.message ?? 'Internal server error';
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
  app.register(makeCapabilitiesRoutes(options.capabilitiesOptions ?? {}));

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
