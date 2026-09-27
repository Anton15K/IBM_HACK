import type { FastifyInstance } from 'fastify';
import { resolveSession } from '../session.js';
import { isBobConfigured, DEFAULT_MAX_COST, MAX_ALLOWED_COST } from '../executor.js';

export interface CapabilitiesOptions {
  modelHosts?: string[];
  /** Override for tests (avoids reading ~/.bob/api_key in unit tests) */
  bobConfiguredOverride?: boolean;
  /** Override TEAMWEAVE_WORKSPACE_ROOTS for tests */
  workspaceRootsOverride?: string;
}

export function makeCapabilitiesRoutes(opts: CapabilitiesOptions = {}) {
  return async function capabilitiesRoutes(app: FastifyInstance): Promise<void> {
    app.get('/api/capabilities', async (req, reply) => {
      if (!resolveSession(app.db, req, reply)) return;
      const bobConfigured = opts.bobConfiguredOverride !== undefined
        ? opts.bobConfiguredOverride
        : await isBobConfigured();

      const workspaceRootsEnv = opts.workspaceRootsOverride !== undefined
        ? opts.workspaceRootsOverride
        : (process.env.TEAMWEAVE_WORKSPACE_ROOTS ?? '');

      const workspaceRootsConfigured = workspaceRootsEnv.trim().length > 0;

      return reply.send({
        providers: ['bob', 'mock', 'api'],
        modelHosts: opts.modelHosts ?? ['api.z.ai', 'api.openai.com'],
        apiLimits: { maxOutputTokens: 65536, maxIterations: 32 },
        outputModes: ['report', 'patch'],
        bobConfigured,
        workspaceRootsConfigured,
        maxCost: {
          default: DEFAULT_MAX_COST,
          max: MAX_ALLOWED_COST,
        },
      });
    });
  };
}
