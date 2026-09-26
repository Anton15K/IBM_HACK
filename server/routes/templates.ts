import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { NodeTemplate } from '../../src/types.js';
import { resolveSession } from '../session.js';
import { mutateProject, isAdmin, requireTeamAccess } from '../db.js';
import { validateTemplateDefaults } from './validate.js';

export async function templatesRoutes(app: FastifyInstance): Promise<void> {
  const db: DatabaseSync = app.db;

  // ------------------------------------------------------------------
  // POST /api/templates — create custom template
  // Access: admin, OR org member with at least one effective editor role.
  // Pure viewers / members with no team role are denied.
  // Built-in templates are readable by anyone but not created via this route.
  // ------------------------------------------------------------------
  app.post('/api/templates', async (req: FastifyRequest, reply: FastifyReply) => {
    const sess = resolveSession(db, req, reply);
    if (!sess) return;

    const admin = isAdmin(db, sess.userId, sess.orgId);

    if (!admin) {
      // Must have at least one effective editor role somewhere in the org
      const projectRow = db.prepare('SELECT data FROM projects WHERE orgId = ?').get(sess.orgId) as
        | { data: string }
        | undefined;
      if (!projectRow) return reply.status(404).send({ error: 'Project not found' });

      const project = JSON.parse(projectRow.data) as { teams: { id: string }[] };
      const hasEditorRole = project.teams.some((t) =>
        requireTeamAccess(db, sess.userId, sess.orgId, t.id, 'edit'),
      );

      if (!hasEditorRole)
        return reply.status(403).send({ error: 'Admin or editor access required to create templates' });
    }

    const body = req.body as Record<string, unknown>;
    const { name, description, defaults } = body ?? {};

    if (typeof name !== 'string' || name.trim().length === 0)
      return reply.status(400).send({ error: 'name is required' });

    // Validate defaults shape
    const defErr = validateTemplateDefaults(defaults);
    if (defErr) return reply.status(400).send({ error: defErr });

    const templateId = randomUUID();

    const { project, revision } = mutateProject(db, sess.orgId, (p) => {
      const newTemplate: NodeTemplate = {
        id: templateId,
        name: name.trim(),
        description: typeof description === 'string' ? description.trim() : '',
        isBuiltIn: false,
        defaults:
          defaults && typeof defaults === 'object' && !Array.isArray(defaults)
            ? (defaults as NodeTemplate['defaults'])
            : {},
      };
      return { ...p, templates: [...p.templates, newTemplate] };
    });

    const created = project.templates.find((t) => t.id === templateId);
    return reply.status(201).send({ ...created, revision });
  });
}
