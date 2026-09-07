import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const fixtures = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// Execute the real CLI and MCP consumers and searchAll catch path. Replace only expensive
// retrieval/reranking and background side effects; no model downloads, API calls or real alarms.
function runConsumer(consumer, message) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-outage-'));
  fixtures.push(dir);
  for (const repo of ['alpha', 'beta']) fs.writeFileSync(path.join(dir, `${repo}.rvf`), 'fixture');
  const loader = path.join(dir, 'loader.mjs');
  fs.writeFileSync(loader, `
    export async function load(url, context, nextLoad) {
      let source;
      if (url.endsWith('/forge-ask.mjs')) source = ${JSON.stringify(`
        export async function searchKb() { throw new Error(${JSON.stringify(message)}); }
        export async function warmKnowledgeStores() {}
        export async function warmQueryEmbedder() {}
      `)};
      if (url.endsWith('/forge-rerank.mjs')) source = 'export async function rerankPairs(q, hits) { return hits; } export async function cePrefilterScores() { return []; } export async function warmReranker() {}';
      if (url.endsWith('/brain-alarm.mjs')) source = 'export async function reportBrainDown() {} export async function reportBrainUp() {}';
      if (url.endsWith('/telemetry-ping.mjs')) source = 'export function bundleVersion() { return "fixture"; } export function ping() {}';
      if (url.endsWith('/forge-guard-injection.mjs')) source = 'export function guardPassages(hits) { return hits; }';
      if (source !== undefined) return { format: 'module', source, shortCircuit: true };
      return nextLoad(url, context);
    }
  `);
  const args = ['--no-warnings', '--experimental-loader', loader, path.join(ROOT, 'kb', consumer)];
  if (consumer === 'forge-ask-all.mjs') args.push('--dir', dir, '--repos', 'alpha,beta', '--q', 'fixture query');
  const result = spawnSync(process.execPath, args, {
    cwd: dir, encoding: 'utf8', timeout: 15_000,
    env: {
      ...process.env, RUVNET_BRAIN_KB: dir, KB_REPOS: 'alpha,beta',
      RUVNET_BRAIN_STATE_DIR: dir, XDG_CACHE_HOME: dir, RUVNET_BRAIN_METER: '0',
    },
    input: consumer === 'forge-mcp-all.mjs'
      ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_ruvnet', arguments: { query: 'fixture query' } } }) + '\n'
      : '',
  });
  expect(result.error).toBeUndefined();
  if (consumer === 'forge-ask-all.mjs') {
    expect(result.status).toBe(1);
    return { text: result.stderr, dir };
  }
  expect(result.status, result.stderr).toBe(0);
  const response = result.stdout.trim().split('\n').map(JSON.parse).find((item) => item.id === 1);
  expect(response.result.isError).toBe(true);
  return { text: response.result.content[0].text, dir };
}

describe('total search outages diagnose before prescribing repairs (#225)', () => {
  for (const consumer of ['forge-ask-all.mjs', 'forge-mcp-all.mjs']) {
    for (const message of [
      'TypeError: RvfDatabase.open is not a function',
      'Invalid RVF header in alpha.rvf',
      "Cannot find package '@ruvector/rvf' imported from forge-ask.mjs",
    ]) {
      it(`${consumer}: ${message}`, () => {
        const { text, dir } = runConsumer(consumer, message);
        expect(text).toContain('ALL 2 repos failed');
        expect(text).toContain(`ERR: ${message}`);
        expect(text).toContain('Diagnose first:');
        expect(text).toContain(dir);
        expect(text).not.toMatch(/npm\s+(?:i|install)\b|npx\s+github:|most likely fix|needs the fix above/i);
      });
    }
  }
});
