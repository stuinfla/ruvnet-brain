import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runHostMatrixAsync } from '../../scripts/host-install-matrix.mjs';
import { candidateRetrievalFixture } from '../fixtures/candidate-retrieval-fixture.mjs';
import { groundedToolResult } from '../../kb/grounded-response.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
async function run({ fail = '', legacyCount = 1, actualRpc = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-retrieval-'));
  roots.push(temp);
  const fixture = candidateRetrievalFixture({ legacyCount });
  const requests = [];
  const result = await runHostMatrixAsync({ packageRoot: '/fixture/package', version: '9.9.9', temp,
    locate: (name) => `/tools/${name}`, retrieval: fixture,
    runCommand: async (_cmd, _args, { env }) => {
      fs.mkdirSync(env.RUVNET_BRAIN_KB, { recursive: true });
      fs.writeFileSync(path.join(env.RUVNET_BRAIN_KB, 'fixture-plan.json'), JSON.stringify(fixture.plan));
      env.CANARY_TRACE = path.join(temp, 'trace.jsonl');
      env.CANARY_FAIL = fail;
      for (const [store, passage] of Object.entries(fixture.passages)) {
        fs.writeFileSync(path.join(env.RUVNET_BRAIN_KB, `${store}.passages.jsonl`), JSON.stringify(passage) + '\n');
      }
      return ok('smoke');
    },
    resolveMcpServer: ({ home }) => actualRpc ? path.resolve('tests/fixtures/candidate-canary-mcp.mjs') : path.join(home, 'installed.mjs'),
    verifyGrounding: async (output) => ({ grounded: !(actualRpc && fail === 'grounding' && output !== 'smoke'), receipt: { path: 'fixture' } }),
    runMcpSearch: actualRpc ? undefined : async ({ query, k, env }) => {
      if (!query) return ok('smoke');
      requests.push({ k, kb: env.RUVNET_BRAIN_KB });
      const c = fixture.plan.cases.find((row) => row.query === query);
      if (fail === 'unknown') throw new Error('fixture search failed');
      if (fail === 'citation' && c.cohort === 'delta') fs.writeFileSync(path.join(env.RUVNET_BRAIN_KB, `${c.expected.repo}.passages.jsonl`), '{}\n');
      const missing = (fail === 'delta-miss' && c.cohort === 'delta')
        || (fail === 'one-legacy-miss' && c.expected.repo === 'old-00');
      const body = missing ? 'no matches' : `#1 repo=${c.expected.repo}\npath: ${c.expected.path}\n`;
      return { ...ok(body), mcpResult: groundedToolResult({ body, query, k,
        results: missing ? [] : [{ repo: c.expected.repo, path: c.expected.path,
          text: fixture.passages[c.expected.repo].text }] }) };
    },
  });
  return { result, requests, trace: actualRpc ? fs.readFileSync(path.join(temp, 'trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [] };
}
describe('sealed candidate canaries reuse the installed staged contexts', () => {
  it.each(['grounding', 'error'])('closes all real host sessions after %s rejection', async (fail) => {
    const { result, trace } = await run({ actualRpc: true, fail });
    expect(result.verdict).toBe('FAIL');
    expect(trace.filter(({ event }) => event === 'initialize')).toHaveLength(3);
    expect(trace.filter(({ event }) => event === 'closed')).toHaveLength(3);
    for (const pid of new Set(trace.map(({ pid }) => pid))) expect(() => process.kill(pid, 0)).toThrow();
    if (fail === 'error') expect(Object.values(result.fixtures).every(({ retrieval }) => retrieval.metrics.unknown === 2)).toBe(true);
  });
  it('sends k5 smoke and k10 sealed cases through the real stdio MCP adapter', async () => {
    const { result, trace } = await run({ actualRpc: true });
    expect(result.verdict).toBe('PASS');
    expect(trace.filter(({ k }) => k === 5)).toHaveLength(3);
    expect(trace.filter(({ k }) => k === 10)).toHaveLength(6);
    expect(new Set(trace.map(({ kb }) => kb)).size).toBe(3);
    expect(trace.filter(({ event }) => event === 'initialize')).toHaveLength(3);
    expect(trace.filter(({ event }) => event === 'closed')).toHaveLength(3);
    expect(new Set(trace.map(({ pid }) => pid)).size).toBe(3);
  });
  it('runs the exact plan at k10 in all existing host contexts', async () => {
    const { result, requests } = await run();
    expect(result.verdict).toBe('PASS');
    expect(requests).toHaveLength(6);
    expect(new Set(requests.map(({ kb }) => kb)).size).toBe(3);
    expect(requests.every(({ k }) => k === 10)).toBe(true);
    for (const fixture of Object.values(result.fixtures)) expect(fixture.retrieval.metrics).toMatchObject({ recallAt10: 1, deltaCitationRate: 1, unknown: 0, skipped: 0 });
  });
  it.each(['unknown', 'citation', 'delta-miss'])('keeps %s evidence red', async (fail) => {
    const { result } = await run({ fail });
    expect(result.verdict).toBe('FAIL');
    expect(Object.values(result.fixtures).every(({ status, retrieval }) => status === 'FAIL' && retrieval)).toBe(true);
  });
  it('accepts exactly .98 recall and rejects below .98 without changing the denominator', async () => {
    const accepted = await run({ legacyCount: 49, fail: 'one-legacy-miss' });
    expect(accepted.result.verdict).toBe('PASS');
    expect(accepted.result.fixtures.claude.retrieval.metrics.recallAt10).toBe(.98);
    expect((await run({ legacyCount: 48, fail: 'one-legacy-miss' })).result.verdict).toBe('FAIL');
  });
});
