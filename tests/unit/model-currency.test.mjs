import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArtificialAnalysis, parseCodingAgentEvidence, currencyStatus, WEEK_MS } from '../../scripts/model-currency-evidence.mjs';
import { refreshModelCurrency, maybeLaunchCurrencyRefresh, readCurrencyStatus } from '../../scripts/model-currency.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/model-currency/aa-captured-rows.json', import.meta.url)));
const makeHtml = (rows) => `<p>Artificial Analysis Intelligence Index v${fixture.indexVersion}</p><script>self.__next_f.push(${JSON.stringify([1, `28:${JSON.stringify({ rows })}`])})</script>`;
const html = makeHtml(fixture.rows);
const NOW = Date.parse('2026-10-04T15:00:00Z');
const source = { url: fixture.sourceUrl, checkedAt: new Date(NOW).toISOString() };
const bindings = { 'gpt-6-1-sol': { model: 'gpt-6.1-sol', evidence: 'native launch receipt', checkedAt: source.checkedAt } };
const dirs = [];
const dir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-currency-test-')); dirs.push(d); return d; };
const inventory = JSON.stringify({ data: Array.from({ length: 50 }, (_, i) => ({ id: `provider/model-${i}`, pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['reasoning'] })) });
const agentFixture = JSON.parse(fs.readFileSync(new URL('../fixtures/model-currency/aa-captured-agent-rows.json', import.meta.url)));
const agentHtml = `<script>self.__next_f.push(${JSON.stringify([1, `42:${JSON.stringify({ rows: agentFixture.rows })}\n`])})</script>`;
const agentMethodology = 'Coding Agent Index v1.5 methodology';
const goodFetch = async (url) => ({ ok: true, text: async () => url.includes('openrouter') ? inventory
  : url.includes('coding-agents-benchmarking') ? agentMethodology : url.includes('/agents/coding-agents') ? agentHtml : html });
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('independent currency evidence', () => {
  it('parses captured measured effort rows without making unbound identities eligible', () => {
    const result = parseArtificialAnalysis(html, { ...source, identityBindings: bindings });
    expect(result.records).toHaveLength(2);
    expect(result.records.map((r) => r.effort)).toEqual(['max', 'high']);
    expect(result.records[0].model).toBe('gpt-6.1-sol');
    expect(result.records[0].benchmark.version).toBe('4.3.2'); // sync-version-ignore: the literal is the captured evidence fixture version under parser test
    expect(result.records[0].benchmarks.find((b) => b.suite === 'terminalbench-4-0').timeSeconds).toBeGreaterThan(0);
    expect(parseArtificialAnalysis(html, source).records.every((r) => r.model === null)).toBe(true);
  });
  it('fails changed HTML, estimated-only scores, and invalid identity evidence', () => {
    expect(() => parseArtificialAnalysis('<html>200 OK</html>', source)).toThrow(/version/);
    expect(() => parseArtificialAnalysis(html.replaceAll('intelligenceIndexEvaluations', 'unknown'), source)).toThrow(/matrix/);
    expect(() => parseArtificialAnalysis(makeHtml(fixture.rows.map((r) => ({ ...r, intelligenceIndexIsEstimated: true }))), source)).toThrow(/matrix/);
    expect(() => parseArtificialAnalysis(html, { ...source, identityBindings: { 'gpt-6-1-sol': { model: 'fake' } } })).toThrow(/identity binding/);
  });
  it('collects all sources, stores bytes, stamps weekly evidence, and never certifies selection', async () => {
    const routerDir = dir();
    const result = await refreshModelCurrency({ routerDir, now: NOW, fetchImpl: goodFetch, identityBindings: bindings, aaUrls: [source.url] });
    expect(result.status).toBe('current');
    expect(result.selectionQualified).toBe(false);
    expect(fs.readdirSync(path.join(routerDir, 'evidence'))).toHaveLength(4);
    expect(readCurrencyStatus({ routerDir, now: NOW + WEEK_MS }).status).toBe('stale');
    expect(readCurrencyStatus({ routerDir, now: NOW - 1 }).status).toBe('stale');
  });
  it('failed refresh keeps all prior verified records/timestamps and records explicit stale failure', async () => {
    const routerDir = dir();
    await refreshModelCurrency({ routerDir, now: NOW, fetchImpl: goodFetch, aaUrls: [source.url] });
    const before = JSON.parse(fs.readFileSync(path.join(routerDir, 'currency.json')));
    const result = await refreshModelCurrency({ routerDir, now: NOW + 1, fetchImpl: async () => { throw new Error('network down'); }, aaUrls: [source.url] });
    const after = JSON.parse(fs.readFileSync(path.join(routerDir, 'currency.json')));
    expect(after.inventory).toEqual(before.inventory); expect(after.evaluations).toEqual(before.evaluations);
    expect(result.status).toBe('stale'); expect(result.lastAttempt.status).toBe('failed');
  });
  it('partial page refresh cannot certify an incomplete effort matrix as fresh', async () => {
    const routerDir = dir();
    await refreshModelCurrency({ routerDir, now: NOW, fetchImpl: goodFetch, aaUrls: [source.url] });
    const before = JSON.parse(fs.readFileSync(path.join(routerDir, 'currency.json')));
    const result = await refreshModelCurrency({ routerDir, now: NOW + 1, fetchImpl: async (url) => url.endsWith('/broken') ? { ok: true, text: async () => '<html>not benchmarks</html>' } : goodFetch(url), aaUrls: [source.url, 'https://artificialanalysis.ai/broken'] });
    const after = JSON.parse(fs.readFileSync(path.join(routerDir, 'currency.json')));
    expect(after.evaluations).toEqual(before.evaluations);
    expect(result.status).toBe('stale'); expect(result.lastAttempt.status).toBe('partial');
  });
  it('prompt path deduplicates concurrent catchup and never calls network', () => {
    const routerDir = dir(); let launched = 0;
    const launch = () => { launched++; return { once() {}, unref() {} }; };
    expect(maybeLaunchCurrencyRefresh({ routerDir, now: NOW, launch }).launched).toBe(true);
    expect(maybeLaunchCurrencyRefresh({ routerDir, now: NOW, launch }).deferred).toBe('refresh already running');
    expect(launched).toBe(1);
    expect(currencyStatus(null, NOW).status).toBe('stale');
  });
  it('failed refresh cooldown avoids a request on every prompt', async () => {
    const routerDir = dir();
    await refreshModelCurrency({ routerDir, now: NOW, fetchImpl: async () => { throw new Error('down'); }, aaUrls: [] });
    expect(maybeLaunchCurrencyRefresh({ routerDir, now: NOW + 1000, launch: () => { throw new Error('must not launch'); } }).deferred).toBe('retry cooldown');
  });
  it('a delayed expired worker cannot commit or remove a successor claim', async () => {
    const routerDir = dir(); const oldResolvers = []; const nextResolvers = [];
    const paused = (resolvers) => (url) => new Promise((resolve) => resolvers.push(() => resolve(goodFetch(url))));
    const old = refreshModelCurrency({ routerDir, now: NOW, fetchImpl: paused(oldResolvers), aaUrls: [source.url] });
    const oldOutcome = old.catch((error) => error);
    const successor = refreshModelCurrency({ routerDir, now: NOW + 11 * 60 * 1000, fetchImpl: paused(nextResolvers), aaUrls: [source.url] });
    const ownerPath = path.join(routerDir, 'currency-refresh-owner.json');
    const successorToken = JSON.parse(fs.readFileSync(ownerPath)).token;
    for (const resolve of oldResolvers) resolve();
    expect((await oldOutcome).message).toMatch(/superseded/);
    expect(JSON.parse(fs.readFileSync(ownerPath)).token).toBe(successorToken);
    expect(fs.existsSync(path.join(routerDir, 'currency.json'))).toBe(false);
    for (const resolve of nextResolvers) resolve();
    expect((await successor).status).toBe('current');
    expect(fs.existsSync(ownerPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(routerDir, 'currency.json'))).inventory.checkedAt).toBe(new Date(NOW + 11 * 60 * 1000).toISOString());
  });
  it('an expired detached child error cannot remove a new prompt claim', () => {
    const routerDir = dir(); const errorHandlers = [];
    const launch = () => ({ once(event, handler) { errorHandlers.push(handler); }, unref() {} });
    expect(maybeLaunchCurrencyRefresh({ routerDir, now: NOW, launch }).launched).toBe(true);
    expect(maybeLaunchCurrencyRefresh({ routerDir, now: NOW + 11 * 60 * 1000, launch }).launched).toBe(true);
    const ownerPath = path.join(routerDir, 'currency-refresh-owner.json');
    const token = JSON.parse(fs.readFileSync(ownerPath)).token;
    errorHandlers[0]();
    expect(JSON.parse(fs.readFileSync(ownerPath)).token).toBe(token);
  });
  it('an orphaned transaction guard fails closed without speculatively deleting it', () => {
    const routerDir = dir(); const guard = path.join(routerDir, 'currency-mutation.lock');
    fs.mkdirSync(guard); fs.utimesSync(guard, 1, 1);
    expect(maybeLaunchCurrencyRefresh({ routerDir, now: NOW, launch: () => { throw new Error('must not launch'); } }).launched).toBe(false);
    expect(fs.existsSync(guard)).toBe(true);
  });

  it('writes durable dated assessment/proposal/instruction and preserves policy bytes and explicit instruction override', async () => {
    const routerDir = dir(); const policyBytes = '{"schemaVersion":1,"routes":{}}\n';
    fs.writeFileSync(path.join(routerDir, 'routing-policy.json'), policyBytes);
    fs.writeFileSync(path.join(routerDir, 'weekly-analyst-instruction.md'), 'User supplemental instruction.');
    await refreshModelCurrency({ routerDir, now: NOW, fetchImpl: goodFetch, identityBindings: bindings, aaUrls: [source.url] });
    const record = JSON.parse(fs.readFileSync(path.join(routerDir, 'currency.json')));
    const report = JSON.parse(fs.readFileSync(record.assessment.reportPath));
    const proposal = JSON.parse(fs.readFileSync(record.assessment.proposalPath));
    expect(report.analystExecuted).toBe(false); expect(proposal.applied).toBe(false);
    expect(report.instructionSource).toBe('effective-per-user-file');
    expect(fs.readFileSync(path.join(path.dirname(record.assessment.reportPath), 'instruction.md'), 'utf8')).toBe('User supplemental instruction.');
    expect(record.assessment.instructionSha256).toBe(report.instructionSha256);
    expect(fs.readFileSync(path.join(path.dirname(record.assessment.reportPath), 'prior-policy.json'), 'utf8')).toBe(policyBytes);
    expect(fs.readFileSync(path.join(routerDir, 'routing-policy.json'), 'utf8')).toBe(policyBytes);
    expect(fs.readFileSync(path.join(routerDir, 'weekly-analyst-instruction.md'), 'utf8')).toBe('User supplemental instruction.');
    await refreshModelCurrency({ routerDir, now: NOW + 1, fetchImpl: goodFetch, identityBindings: bindings, aaUrls: [source.url] });
    expect(fs.readdirSync(path.join(routerDir, 'assessments'))).toHaveLength(2);
    expect(fs.existsSync(record.assessment.reportPath)).toBe(true);
  });

  it('bounds effective instruction reads and reports an oversized file without replacing it', async () => {
    const routerDir = dir(); const target = path.join(routerDir, 'weekly-analyst-instruction.md');
    fs.writeFileSync(target, 'x'.repeat(128 * 1024 + 1));
    const result = await refreshModelCurrency({ routerDir, now: NOW, fetchImpl: goodFetch, aaUrls: [source.url] });
    expect(result.status).toBe('stale');
    expect(result.errors.join(' ')).toMatch(/instruction.*128 KiB/);
    expect(fs.statSync(target).size).toBe(128 * 1024 + 1);
    expect(result.assessment.instructionSource).toBe('fallback-after-read-error');
  });

  it('captures agent workload records separately with exact effort, versions and mixed harness boundaries', () => {
    const parsed = parseCodingAgentEvidence(agentHtml, agentMethodology, { ...source, identityBindings: bindings });
    const sol = parsed.records.find((r) => r.harness === 'Codex');
    expect(sol.model).toBe('gpt-6.1-sol'); expect(sol.effort).toBe('high');
    expect(sol.benchmark).toEqual({ suite: 'artificial-analysis-coding-agent-index', version: '1.5' });
    expect(sol.codingAgentIndexFraction).toBeCloseTo(0.6014923716179784);
    expect(sol.versions['terminal-bench-v4'].min.version).toBe('0.154.0'); // sync-version-ignore: the literal is the captured evidence fixture version under parser test
    expect(sol.components.find((c) => c.suite === 'terminal-bench-v4').score).toBe(0.5);
    const mixed = parsed.records.find((r) => r.harness.includes('Devin'));
    expect(mixed.nativeHost).toBeNull(); expect(mixed.model).toBeNull(); expect(mixed.effort).toBeNull();
    expect(parsed.selectionQualified).toBe(false);
    expect(() => parseCodingAgentEvidence('<html>200 OK</html>', agentMethodology, source)).toThrow(/records absent/);
    expect(() => parseCodingAgentEvidence(agentHtml, '', source)).toThrow(/version absent/);
  });
  it('preserves prior agent records when source or methodology collection fails, with explicit stale diagnostics', async () => {
    const routerDir = dir();
    await refreshModelCurrency({ routerDir, now: NOW, fetchImpl: goodFetch, aaUrls: [source.url] });
    const before = JSON.parse(fs.readFileSync(path.join(routerDir, 'currency.json'))).agentSources;
    const result = await refreshModelCurrency({ routerDir, now: NOW + 1, aaUrls: [source.url],
      fetchImpl: async (url) => url.includes('coding-agents-benchmarking') ? { ok: true, text: async () => '' } : goodFetch(url) });
    const after = JSON.parse(fs.readFileSync(path.join(routerDir, 'currency.json'))).agentSources;
    expect(after).toEqual(before); expect(result.status).toBe('stale');
    expect(result.errors.join(' ')).toMatch(/coding agents.*version absent/);
  });

  it('rejects empty additional benchmark archives and preserves the previous verified agent section', async () => {
    const routerDir = dir();
    await refreshModelCurrency({ routerDir, now: NOW, fetchImpl: goodFetch, aaUrls: [source.url] });
    const before = JSON.parse(fs.readFileSync(path.join(routerDir, 'currency.json'))).agentSources;
    const result = await refreshModelCurrency({ routerDir, now: NOW + 1, aaUrls: [source.url],
      fetchImpl: async (url) => url === 'https://vulcanbench.com/' ? { ok: true, text: async () => '' } : goodFetch(url) });
    expect(result.status).toBe('stale');
    expect(result.errors.join(' ')).toMatch(/vulcanbench.*empty or truncated/);
    expect(JSON.parse(fs.readFileSync(path.join(routerDir, 'currency.json'))).agentSources).toEqual(before);
  });

});
