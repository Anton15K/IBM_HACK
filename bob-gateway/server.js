/**
 * Bob Gateway — local bridge between TeamWeave UI and the `bob run` CLI.
 * Plain Node.js ESM, zero npm dependencies.
 *
 * Endpoints:
 *   GET  /health   → { ok, bob, apiKey }
 *   POST /test     → runs a trivial `bob ask` to verify end-to-end
 *   POST /execute  → runs `bob run --mode agent` with the supplied prompt
 *
 * Request body for /execute (matches src/executors/bob.ts):
 *   { prompt, model?, skills?, tools?, maxIterations?, graphContext? }
 *
 * Response for /execute (plain JSON, matches what bob.ts expects):
 *   { summary, results, commands, artifacts }
 *
 * Streaming note: the UI currently calls response.json() so we return
 * plain JSON. Progress is emitted server-side only (logged to stdout).
 */

import http from 'http';
import { execFile, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// ─── Config ────────────────────────────────────────────────────────────────
const PORT = 7142;
const HOST = '127.0.0.1';
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const BOB_BIN = path.join(os.homedir(), '.local', 'bin', 'bob');
const API_KEY_FILE = path.join(os.homedir(), '.bob', 'api_key');

// ─── Helpers ────────────────────────────────────────────────────────────────

function readApiKey() {
  try {
    return fs.readFileSync(API_KEY_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

function bobEnv() {
  const env = { ...process.env };
  const key = readApiKey();
  if (key && !env.BOB_API_KEY) {
    env.BOB_API_KEY = key;
  }
  return env;
}

/**
 * Strip markdown emphasis characters from a string.
 * Removes: **bold**, *italic*, __bold__, _italic_, `code`, leading # headers.
 */
function stripMarkdown(text) {
  return text
    .replace(/^#+\s*/gm, '')          // # headings
    .replace(/\*\*([^*]*)\*\*/g, '$1') // **bold**
    .replace(/__([^_]*)__/g, '$1')     // __bold__
    .replace(/\*([^*]+)\*/g, '$1')     // *italic*
    .replace(/_([^_]+)_/g, '$1')       // _italic_
    .replace(/`([^`]*)`/g, '$1')       // `code`
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim();
}

/**
 * Parse bob's JSON result line into RunOutput.
 * Expected format: { type:"result", status:"success", stats:{...}, last_message:"..." }
 */
function parseBobResult(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON — treat the whole string as the message
    parsed = { last_message: raw, status: 'unknown' };
  }

  const lastMsg = String(parsed.last_message ?? parsed.message ?? '');

  // ── summary ────────────────────────────────────────────────────────────────
  // Find the first substantive paragraph (non-empty after stripping markdown).
  const paragraphs = lastMsg.split(/\n{2,}/);
  let summaryRaw = '';
  for (const para of paragraphs) {
    const stripped = stripMarkdown(para);
    if (stripped.length > 0) {
      summaryRaw = stripped;
      break;
    }
  }
  // If every "paragraph" was inline (no blank lines), fall back to first line.
  if (!summaryRaw) {
    summaryRaw = stripMarkdown(lastMsg.split('\n')[0] || '');
  }
  const summary = (summaryRaw || (parsed.status === 'success' ? 'Bob completed the task.' : 'Bob finished.')).slice(0, 400);

  // ── results ────────────────────────────────────────────────────────────────
  const bulletRe = /^[\s]*[-*•]\s+(.+)$/;
  const numberedRe = /^[\s]*\d+[.)]\s+(.+)$/;
  const results = lastMsg
    .split('\n')
    .filter((l) => bulletRe.test(l) || numberedRe.test(l))
    .map((l) => {
      const m = l.match(bulletRe) || l.match(numberedRe);
      return m ? stripMarkdown(m[1]) : stripMarkdown(l);
    })
    .filter(Boolean)
    .slice(0, 20);

  // Fallback: first sentence of summary if short enough, else []
  let resultsFallback = [];
  if (!results.length) {
    const firstSentence = summary.split(/(?<=[.!?])\s/)[0] || summary;
    if (firstSentence.length < 120) {
      resultsFallback = [firstSentence];
    }
  }

  // ── commands ───────────────────────────────────────────────────────────────
  const commands = [];

  // 1) Fenced code blocks (```bash / ```sh / unlabelled)
  const codeRe = /```(?:bash|sh|shell|zsh)?\n([\s\S]*?)```/g;
  let m;
  while ((m = codeRe.exec(lastMsg)) !== null) {
    m[1].split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => commands.push(l));
  }

  // 2) Inline backtick snippets that follow a command-intent word (colon optional)
  const inlineCmdRe = /(?:run|execute|use|ran|try):?\s+`([^`]+)`/gi;
  while ((m = inlineCmdRe.exec(lastMsg)) !== null) {
    const candidate = m[1].trim();
    if (candidate && !commands.includes(candidate)) commands.push(candidate);
  }

  // 3) Lines starting with $, or known CLI prefixes
  const cliPrefixRe = /^(?:\$\s*|(?:npm|node|git|python3?|cd|yarn|pnpm|npx)\s)\S/;
  lastMsg.split('\n').forEach((l) => {
    const trimmed = l.trim();
    if (cliPrefixRe.test(trimmed)) {
      const cmd = trimmed.replace(/^\$\s*/, '');
      if (!commands.includes(cmd)) commands.push(cmd);
    }
  });

  // ── artifacts ──────────────────────────────────────────────────────────────
  const artifacts = [];
  const EXT = 'md|txt|json|ts|tsx|js|jsx|mjs|cjs|py|java|yaml|yml|toml|sh|css|html|xml|csv|env';

  // 1) Filenames inside backticks
  const btFileRe = new RegExp('`([^`\\s]+\\.(?:' + EXT + '))`', 'gi');
  while ((m = btFileRe.exec(lastMsg)) !== null) {
    const f = m[1].trim();
    if (!artifacts.includes(f)) artifacts.push(f);
  }

  // 2) Filenames after "file/created/wrote/modified" keywords or bare in text
  const kwFileRe = new RegExp('(?:file|created|wrote|modified|saved|updated)\\s+([\\w./\\\\-]+\\.(?:' + EXT + '))', 'gi');
  while ((m = kwFileRe.exec(lastMsg)) !== null) {
    const f = m[1].trim();
    if (!artifacts.includes(f)) artifacts.push(f);
  }

  return {
    summary,
    results: results.length ? results : resultsFallback,
    commands: commands.slice(0, 10),
    artifacts: artifacts.slice(0, 10),
  };
}

/** Read the full request body as a string. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Respond with JSON, adding CORS headers. */
function jsonReply(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(payload);
}

// ─── Bob runner ─────────────────────────────────────────────────────────────

/**
 * Run bob CLI with the given arguments and a prompt written to TASK.md.
 * Returns { stdout, stderr, exitCode }.
 */
function runBob(args, promptText, workDir) {
  return new Promise((resolve, reject) => {
    // Write TASK.md so bob can read it from the workspace
    try {
      fs.writeFileSync(path.join(workDir, 'TASK.md'), promptText, 'utf8');
    } catch (e) {
      return reject(new Error(`Failed to write TASK.md: ${e.message}`));
    }

    const env = bobEnv();
    const proc = spawn(BOB_BIN, args, {
      env,
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Bob timed out after 10 minutes'));
    }, TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code });
    });

    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** Create a temp directory, run fn(dir), then clean up. */
async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-'));
  try {
    return await fn(dir);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handleHealth(req, res) {
  return new Promise((resolve) => {
    execFile(BOB_BIN, ['--version'], { env: bobEnv() }, (err, stdout, stderr) => {
      const version = (stdout || stderr || '').trim() || 'unknown';
      jsonReply(res, 200, {
        ok: !err,
        bob: version,
        apiKey: Boolean(readApiKey() || process.env.BOB_API_KEY),
      });
      resolve();
    });
  });
}

async function handleTest(req, res) {
  console.log('[gateway] /test — running bob ask "Reply with OK"');
  try {
    const result = await withTempDir(async (dir) => {
      const args = [
        'run',
        '--mode', 'ask',
        '--format', 'json',
        '--max-cost', '1',
        '--max-turns', '5',
        '--workspace', dir,
        'Reply with OK',
      ];
      return runBob(args, 'Reply with OK', dir);
    });

    console.log('[gateway] /test stdout:', result.stdout.slice(0, 500));

    // Find last JSON line
    const lines = result.stdout.split('\n').filter(Boolean);
    const lastJson = lines.filter((l) => l.startsWith('{')).pop() || '';

    let parsed = null;
    try { parsed = JSON.parse(lastJson); } catch { /* ignore */ }

    jsonReply(res, 200, {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      bobOutput: result.stdout.slice(0, 1000),
      parsed,
    });
  } catch (e) {
    jsonReply(res, 200, { ok: false, error: e.message });
  }
}

async function handleExecute(req, res) {
  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    return jsonReply(res, 400, { error: 'Invalid JSON body' });
  }

  // The prompt field maps from assembledPrompt (the UI sends it as `prompt`)
  const promptText = String(body.prompt || body.assembledPrompt || '');
  if (!promptText.trim()) {
    return jsonReply(res, 400, { error: 'Missing prompt' });
  }

  const maxIterations = Number(body.maxIterations) || 30;
  const maxCost = 5; // reasonable cap for a single node run

  console.log('[gateway] /execute — prompt length:', promptText.length, 'chars');

  try {
    const output = await withTempDir(async (dir) => {
      // Bob will read the workspace; we write the prompt to TASK.md
      const agentPrompt = 'Read TASK.md in the workspace and complete the task it describes. Report results.';

      const args = [
        'run',
        '--mode', 'agent',
        '--format', 'json',
        '--max-cost', String(maxCost),
        '--max-turns', String(Math.min(maxIterations, 30)),
        '--workspace', dir,
        agentPrompt,
      ];

      console.log('[gateway] spawning:', BOB_BIN, args.join(' '));
      return runBob(args, promptText, dir);
    });

    console.log('[gateway] bob exited with code', output.exitCode);
    if (output.stderr) console.log('[gateway] stderr:', output.stderr.slice(0, 500));

    // Parse the result — find the last JSON line from bob's --format json output
    const lines = output.stdout.split('\n').filter(Boolean);
    const jsonLines = lines.filter((l) => l.startsWith('{'));
    const lastJsonLine = jsonLines.pop() || '';

    let runOutput;
    if (lastJsonLine) {
      runOutput = parseBobResult(lastJsonLine);
    } else if (output.stdout) {
      // No structured JSON — use raw stdout as summary
      runOutput = parseBobResult(output.stdout);
    } else {
      runOutput = {
        summary: output.exitCode === 0 ? 'Bob completed the task.' : `Bob exited with code ${output.exitCode}.`,
        results: [],
        commands: [],
        artifacts: [],
      };
    }

    jsonReply(res, 200, runOutput);
  } catch (e) {
    console.error('[gateway] /execute error:', e.message);
    // Return HTTP 200 with error body so UI's fetch doesn't throw
    jsonReply(res, 200, {
      summary: `Bob Gateway error: ${e.message}`,
      results: [],
      commands: [],
      artifacts: [],
    });
  }
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  try {
    if (method === 'GET' && url === '/health') return await handleHealth(req, res);
    if (method === 'POST' && url === '/test') return await handleTest(req, res);
    if (method === 'POST' && url === '/execute') return await handleExecute(req, res);
    jsonReply(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error('[gateway] unhandled error:', e);
    jsonReply(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[gateway] Bob Gateway listening on http://${HOST}:${PORT}`);
  console.log(`[gateway] Bob binary: ${BOB_BIN}`);
  console.log(`[gateway] API key file: ${API_KEY_FILE} (${readApiKey() ? 'found' : 'not found'})`);
});
