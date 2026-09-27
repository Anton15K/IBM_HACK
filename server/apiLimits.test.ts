import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExecutor } from './routes/validate.js';
import { API_MAX_OUTPUT_TOKENS, API_DEFAULT_OUTPUT_TOKENS, API_DEFAULT_TIMEOUT_MS } from './apiExecutor.js';
test('API output validation accepts large outputs and rejects invalid bounds', () => {
 const executor = { provider: 'api', model: 'test', connectionId: 'profile', skills: [], tools: [], maxIterations: 1 };
 for (const maxOutputTokens of [64, 4096, 16384, 32768, 65536]) assert.equal(validateExecutor({ ...executor, maxOutputTokens }), null);
 for (const maxOutputTokens of [63, 65537, 8192.5, Infinity]) assert.match(validateExecutor({ ...executor, maxOutputTokens })!, /maxOutputTokens/);
 assert.equal(API_MAX_OUTPUT_TOKENS, 65536);
 assert.equal(API_DEFAULT_OUTPUT_TOKENS, 1024);
 assert.equal(API_DEFAULT_TIMEOUT_MS, 600000);
});
