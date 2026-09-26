/**
 * server/models.ts
 *
 * ModelService — manages org-scoped API model connections.
 *
 * Security:
 *  - API keys are stored AES-256-GCM encrypted with a per-installation master key.
 *  - Master key is loaded from a private 0600 file beside the persistent DB,
 *    or generated as a random in-memory key for :memory: databases.
 *  - Credentials are never returned to callers; only {id,label,baseUrl,model}.
 *  - orgId is always server-supplied, never from caller input.
 *  - baseUrl must be HTTPS, allowlisted hostname (no user/pass/query/hash),
 *    443 port only, and hostname must be in the server-configured allowlist.
 *
 * Routes exposed:
 *  GET  /api/model-connections  — authenticated org member → [{id,label,baseUrl,model}]
 *  POST /api/model-connections  — org admin only → 201 {id,label,baseUrl,model}
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { resolveSession } from './session.js';
import { isAdmin } from './db.js';

// Constants

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

const DEFAULT_ALLOWED_HOSTS = 'api.z.ai,api.openai.com,openrouter.ai';

// Master key management

// In-memory master key for :memory: databases; shared across all :memory: instances
// in this process (tests create fresh DBs; unique per test via unique nonce/ciphertext).
let inMemoryMasterKey: Buffer | null = null;

function getInMemoryMasterKey(): Buffer {
  if (!inMemoryMasterKey) {
    inMemoryMasterKey = randomBytes(KEY_BYTES);
  }
  return inMemoryMasterKey;
}

async function loadOrCreateMasterKey(dbPath: string): Promise<Buffer> {
  if (dbPath === ':memory:') return getInMemoryMasterKey();
  const keyPath = join(dirname(dbPath), '.teamweave_model_key');
  try {
    const raw = await readFile(keyPath);
    if (raw.length !== KEY_BYTES) throw new Error('Invalid model master key; restore the existing key');
    return raw;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const key = randomBytes(KEY_BYTES);
  try { await writeFile(keyPath, key, { mode: 0o600, flag: 'wx' }); return key; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const existing = await readFile(keyPath);
    if (existing.length !== KEY_BYTES) throw new Error('Invalid model master key');
    return existing;
  }
}

// Encryption helpers

function encrypt(plaintext: string, masterKey: Buffer): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, masterKey, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: hex(nonce) + ':' + hex(ciphertext) + ':' + hex(tag)
  return nonce.toString('hex') + ':' + ct.toString('hex') + ':' + tag.toString('hex');
}

function decrypt(encoded: string, masterKey: Buffer): string {
  const parts = encoded.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted credential format');
  const [nonceHex, ctHex, tagHex] = parts as [string, string, string];
  const nonce = Buffer.from(nonceHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = createDecipheriv(ALGO, masterKey, nonce);
  decipher.setAuthTag(tag);
  return decipher.update(ct, undefined, 'utf8') + decipher.final('utf8');
}

// Host allowlist validation

function resolveAllowedHosts(injected?: string[]): string[] {
  if (injected) return injected;
  const env = process.env.TEAMWEAVE_MODEL_HOSTS ?? DEFAULT_ALLOWED_HOSTS;
  return env.split(',').map(h => h.trim()).filter(Boolean);
}

/**
 * Validate a model connection base URL.
 * Returns null on success, or an error string.
 */
export function validateBaseUrl(rawUrl: string, allowedHosts?: string[]): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return 'baseUrl must be a valid URL';
  }
  if (parsed.protocol !== 'https:') return 'baseUrl must use HTTPS';
  if (parsed.username || parsed.password) return 'baseUrl must not contain credentials';
  if (parsed.search) return 'baseUrl must not contain a query string';
  if (parsed.hash) return 'baseUrl must not contain a fragment';
  // Port check: must be 443 or default (empty)
  if (parsed.port && parsed.port !== '443') return 'baseUrl must use port 443 (or default HTTPS port)';
  const hosts = resolveAllowedHosts(allowedHosts);
  if (!hosts.includes(parsed.hostname)) return `baseUrl hostname '${parsed.hostname}' is not in the allowed hosts list`;
  return null;
}

// ModelService

export interface ModelConnection {
  id: string;
  orgId: string;
  label: string;
  baseUrl: string;
  model: string;
  encryptedApiKey: string;
}

export interface ModelConnectionDescriptor {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
}

export class ModelService {
  private masterKey: Buffer | null = null;
  private masterKeyPromise: Promise<Buffer> | null = null;

  constructor(
    private db: DatabaseSync,
    private dbPath: string,
    private injectedMasterKey?: Buffer,
    private injectedAllowedHosts?: string[],
  ) {
    // Idempotent schema creation
    db.exec(`CREATE TABLE IF NOT EXISTS model_connections (
      id TEXT PRIMARY KEY,
      orgId TEXT NOT NULL,
      label TEXT NOT NULL,
      baseUrl TEXT NOT NULL,
      model TEXT NOT NULL,
      encryptedApiKey TEXT NOT NULL
    )`);
  }

  private async getMasterKey(): Promise<Buffer> {
    if (this.injectedMasterKey) return this.injectedMasterKey;
    if (this.masterKey) return this.masterKey;
    if (!this.masterKeyPromise) {
      this.masterKeyPromise = loadOrCreateMasterKey(this.dbPath).then(k => {
        this.masterKey = k;
        return k;
      });
    }
    return this.masterKeyPromise;
  }

  async create(orgId: string, label: string, baseUrl: string, model: string, apiKey: string): Promise<ModelConnectionDescriptor> {
    const masterKey = await this.getMasterKey();
    const id = randomBytes(16).toString('hex');
    const encryptedApiKey = encrypt(apiKey, masterKey);
    this.db.prepare(
      'INSERT INTO model_connections(id,orgId,label,baseUrl,model,encryptedApiKey) VALUES(?,?,?,?,?,?)'
    ).run(id, orgId, label, baseUrl.trim(), model.trim(), encryptedApiKey);
    return { id, label: label.trim(), baseUrl: baseUrl.trim(), model: model.trim() };
  }

  list(orgId: string): ModelConnectionDescriptor[] {
    const rows = this.db.prepare(
      'SELECT id,label,baseUrl,model FROM model_connections WHERE orgId=? ORDER BY rowid'
    ).all(orgId) as unknown as ModelConnectionDescriptor[];
    return rows;
  }

  async getApiKey(id: string, orgId: string): Promise<{ baseUrl: string; model: string; apiKey: string } | null> {
    const row = this.db.prepare(
      'SELECT baseUrl,model,encryptedApiKey FROM model_connections WHERE id=? AND orgId=?'
    ).get(id, orgId) as { baseUrl: string; model: string; encryptedApiKey: string } | undefined;
    if (!row) return null;
    if (validateBaseUrl(row.baseUrl, this.getAllowedHosts())) throw new Error('Model host is no longer allowed');
    const masterKey = await this.getMasterKey();
    const apiKey = decrypt(row.encryptedApiKey, masterKey);
    return { baseUrl: row.baseUrl, model: row.model, apiKey };
  }

  getAllowedHosts(): string[] {
    return resolveAllowedHosts(this.injectedAllowedHosts);
  }
}

// Route plugin

export interface ModelRoutesOptions {
  modelService: ModelService;
  allowedHosts?: string[];
}

export async function modelConnectionsRoutes(
  app: FastifyInstance,
  opts: ModelRoutesOptions,
): Promise<void> {
  const { modelService } = opts;

  // GET /api/model-connections — authenticated org member
  app.get('/api/model-connections', async (req, reply) => {
    const sess = resolveSession(app.db, req, reply);
    if (!sess) return;
    const connections = modelService.list(sess.orgId);
    return reply.send({ connections });
  });

  // POST /api/model-connections — org admin only
  app.post('/api/model-connections', async (req, reply) => {
    const sess = resolveSession(app.db, req, reply);
    if (!sess) return;
    if (!isAdmin(app.db, sess.userId, sess.orgId))
      return reply.status(403).send({ error: 'Admin access required' });

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))
      return reply.status(400).send({ error: 'Request body must be a JSON object' });

    const body = req.body as Record<string, unknown>;
    const { label, baseUrl, model, apiKey } = body;

    if (typeof label !== 'string' || label.trim().length === 0 || label.trim().length > 120)
      return reply.status(400).send({ error: 'label must be a non-empty string (max 120 chars)' });
    if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0)
      return reply.status(400).send({ error: 'baseUrl must be a non-empty string' });
    if (typeof model !== 'string' || model.trim().length === 0 || model.trim().length > 120)
      return reply.status(400).send({ error: 'model must be a non-empty string (max 120 chars)' });
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0 || apiKey.trim().length > 512)
      return reply.status(400).send({ error: 'apiKey must be a non-empty string (max 512 chars)' });

    const urlErr = validateBaseUrl(baseUrl, modelService.getAllowedHosts());
    if (urlErr) return reply.status(400).send({ error: urlErr });

    const descriptor = await modelService.create(sess.orgId, label.trim(), baseUrl.trim(), model.trim(), apiKey.trim());
    return reply.status(201).send(descriptor);
  });
}
