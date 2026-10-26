// The weekly model-catalog-refresh job, proven against the page it actually reads.
// Fixture: the LIVE https://artificialanalysis.ai/agents/coding-agents page and its methodology page, captured
// 2026-10-26 04:58 UTC with curl and stored gzipped byte-for-byte (sha256 of the uncompressed bytes below).
// That page no longer carries `hostModelSlug`, so the pre-fix parser threw "Coding-agent structured records absent"
// and the job exited 1 every Monday although the router's own evidence was fresh.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCodingAgentEvidence } from '../../scripts/model-currency-evidence.mjs';
import { refreshModelCurrency, refreshOutcome } from '../../scripts/model-currency.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'model-currency');
const gunzip = (name) => zlib.gunzipSync(fs.readFileSync(path.join(FIXTURES, name))).toString('utf8');
const LIVE_PAGE = gunzip('aa-coding-agents-2026-10-26.html.gz');
const LIVE_METHODOLOGY = gunzip('aa-coding-agents-methodology-2026-10-26.html.gz');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const source = { url: 'https://artificialanalysis.ai/agents/coding-agents', checkedAt: '2026-10-26T04:58:59.000Z' };

const dirs = [];
const tempDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-currency-live-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('coding-agent parser on the live captured page', () => {
  it('the fixture is the unmodified capture, and the page really dropped hostModelSlug', () => {
    expect(sha(LIVE_PAGE)).toBe('ee9d58d3514d2078e4106503a390a03ff591f3c1ac8ec8bc659c5b10c7dbed75');
    expect(sha(LIVE_METHODOLOGY)).toBe('ed16db550bb8d7f24c573048661cbb9f5ca7a155dda84688303a3c0b645248b0');
    expect(LIVE_PAGE.includes('hostModelSlug')).toBe(false);
  });

  it('returns every complete agent row, keyed by agentName + indexScore', () => {
    const parsed = parseCodingAgentEvidence(LIVE_PAGE, LIVE_METHODOLOGY, source);
    // 24 serialized agent rows; two (Muse Wonder Full, Mirror) publish a null cost and are disclosed as skipped.
    expect(parsed.records).toHaveLength(22);
    expect(parsed.coverage.skippedIncompleteCount).toBe(2);
    expect(parsed.records.length + parsed.coverage.skippedIncompleteCount).toBe(24);
    expect(parsed.source.parser).toBe('aa-coding-agents-flight-v2');
    const sol = parsed.records.find((r) => r.displayModel === 'GPT-6.1 Sol (max)');
    expect(sol).toMatchObject({ harness: 'Codex', provider: 'openai', nativeHost: 'codex', effort: 'max',
      sourceModelSlug: null, sourceReleaseSlug: null, model: null, selectionQualified: false,
      benchmark: { suite: 'artificial-analysis-coding-agent-index', version: '2.0' } });
    expect(sol.codingAgentIndexFraction).toBeCloseTo(0.541279798631476, 12);
    expect(sol.apiBenchmarkCostPerTaskUsd).toBeCloseTo(1.5046389983744, 10);
    expect(sol.components.map((c) => c.suite)).toEqual(['frontiercode-v1.1-main', 'swe-atlas-qna', 'terminal-bench-v4']);
    const native = parsed.records.filter((r) => r.nativeHost);
    expect(native.filter((r) => r.nativeHost === 'codex')).toHaveLength(3);
    expect(native.filter((r) => r.nativeHost === 'claude-code')).toHaveLength(4);
    for (const record of parsed.records) {
      expect(record.codingAgentIndexFraction).toBeGreaterThan(0);
      expect(record.codingAgentIndexFraction).toBeLessThanOrEqual(1);
    }
  });
});

const ANCILLARY = 'coding agents: Coding-agent structured records absent';
describe('weekly job verdict', () => {
  it('only an ancillary scrape failing is partial with exit 0; a core failure stays exit 1', () => {
    const fresh = { action: 'refreshed', inventoryFresh: true, evaluationsFresh: true };
    expect(refreshOutcome({ ...fresh, lastAttempt: { errors: [] } })).toEqual({ status: 'complete', exitCode: 0, warnings: [] });
    expect(refreshOutcome({ ...fresh, lastAttempt: { errors: [ANCILLARY, 'official https://x: HTTP 503', 'coding benchmark https://y: empty or truncated source'] } }))
      .toEqual({ status: 'partial', exitCode: 0, warnings: [ANCILLARY, 'official https://x: HTTP 503', 'coding benchmark https://y: empty or truncated source'] });
    expect(refreshOutcome({ ...fresh, lastAttempt: { errors: [ANCILLARY, 'inventory: HTTP 500'] } })).toMatchObject({ status: 'failed', exitCode: 1, errors: ['inventory: HTTP 500'] });
    expect(refreshOutcome({ ...fresh, lastAttempt: { errors: ['evaluations https://a: AA Intelligence Index version is absent'] } }).exitCode).toBe(1);
    expect(refreshOutcome({ ...fresh, lastAttempt: { errors: ['instruction: effective weekly instruction is empty'] } }).exitCode).toBe(1);
    expect(refreshOutcome({ ...fresh, evaluationsFresh: false, lastAttempt: { errors: [ANCILLARY] } }).exitCode).toBe(1);
    expect(refreshOutcome({ action: 'busy', status: 'stale', reason: 'refresh ownership or transaction guard unavailable' }).exitCode).toBe(1);
  });

  it('the CLI exits 0 with a warning and a job summary when only the coding-agent page breaks, and 1 when inventory breaks', () => {
    const work = tempDir();
    const rows = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'aa-captured-rows.json'), 'utf8'));
    const aaHtml = `<p>Artificial Analysis Intelligence Index v${rows.indexVersion}</p><script>self.__next_f.push(${JSON.stringify([1, `28:${JSON.stringify({ rows: rows.rows })}`])})</script>`;
    const inventory = JSON.stringify({ data: Array.from({ length: 50 }, (_, i) => ({ id: `p/m-${i}`, pricing: { prompt: '0.000001', completion: '0.000002' } })) });
    fs.writeFileSync(path.join(work, 'bodies.json'), JSON.stringify({ aaHtml, inventory, methodology: LIVE_METHODOLOGY }));
    // Replaces global fetch inside the real CLI process: no network, real exit code.
    const preload = path.join(work, 'stub-fetch.mjs');
    fs.writeFileSync(preload, `import fs from 'node:fs';
const b = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(work, 'bodies.json'))}, 'utf8'));
globalThis.fetch = async (url) => {
  if (url.includes('openrouter')) return process.env.STUB_INVENTORY_DOWN ? { ok: false, status: 500, text: async () => '' } : { ok: true, text: async () => b.inventory };
  if (url.includes('coding-agents-benchmarking')) return { ok: true, text: async () => b.methodology };
  if (url.includes('/agents/coding-agents')) return { ok: true, text: async () => '<html>agents moved</html>' };
  return { ok: true, text: async () => b.aaHtml };
};\n`);
    const cli = path.join(ROOT, 'scripts', 'model-currency.mjs');
    const run = (extraEnv) => {
      const routerDir = tempDir(); const captured = path.join(work, `refresh-${dirs.length}.out`);
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, '--refresh', '--router-dir', routerDir],
        { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...extraEnv } });
      fs.writeFileSync(captured, result.stdout);
      // The workflow's summary step: `--summarize <captured stdout> >> $GITHUB_STEP_SUMMARY`.
      const summary = spawnSync(process.execPath, [cli, '--summarize', captured], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
      return { ...result, summary: summary.stdout };
    };
    const partial = run({});
    expect(partial.status, partial.stderr).toBe(0);
    expect(partial.stdout).toMatch(/^::warning title=model-currency partial::coding agents: Coding-agent structured records absent$/m);
    expect(JSON.parse(partial.stdout.split('\n')[0]).outcome).toEqual({ status: 'partial', exitCode: 0, warnings: [ANCILLARY] });
    expect(partial.summary).toContain('### model-currency refresh: partial');
    const down = run({ STUB_INVENTORY_DOWN: '1' });
    expect(down.status).toBe(1);
    expect(JSON.parse(down.stdout.split('\n')[0]).outcome.status).toBe('failed');
    expect(down.summary).toContain('error: inventory: HTTP 500');
    const missing = spawnSync(process.execPath, [cli, '--summarize', path.join(work, 'absent.out')], { cwd: ROOT, encoding: 'utf8' });
    expect(missing.status).toBe(0);
    expect(missing.stdout).toContain('no result');
  });

  it('refreshModelCurrency on the live page records fresh agent evidence and a complete attempt', async () => {
    const inventory = JSON.stringify({ data: Array.from({ length: 50 }, (_, i) => ({ id: `p/m-${i}`, pricing: { prompt: '0.000001', completion: '0.000002' } })) });
    const rows = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'aa-captured-rows.json'), 'utf8'));
    const aaHtml = `<p>Artificial Analysis Intelligence Index v${rows.indexVersion}</p><script>self.__next_f.push(${JSON.stringify([1, `28:${JSON.stringify({ rows: rows.rows })}`])})</script>`;
    const fetchImpl = async (url) => ({ ok: true, text: async () => url.includes('openrouter') ? inventory
      : url.includes('coding-agents-benchmarking') ? LIVE_METHODOLOGY : url.includes('/agents/coding-agents') ? LIVE_PAGE : aaHtml });
    const now = Date.parse('2026-10-26T05:00:00Z');
    const result = await refreshModelCurrency({ routerDir: tempDir(), now, fetchImpl, aaUrls: ['https://artificialanalysis.ai/models/comparisons'] });
    expect(result.lastAttempt).toMatchObject({ status: 'complete', errors: [] });
    expect(refreshOutcome(result)).toEqual({ status: 'complete', exitCode: 0, warnings: [] });
  });
});
