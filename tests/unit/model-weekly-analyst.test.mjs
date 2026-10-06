import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { selectionEvidenceStatus } from '../../scripts/model-router-engine.mjs';
import { digest } from '../../scripts/model-currency-evidence.mjs';
import { loadAnalystInputs, validateAnalystReport, runWeeklyAnalyst as runWeeklyAnalystCore, maybeLaunchWeeklyAnalyst, parseNativeReport } from '../../scripts/model-weekly-analyst.mjs';
const runWeeklyAnalyst = (options) => runWeeklyAnalystCore({ prepareSandbox: async (runDir) => ({ home: path.join(runDir, 'fixture-native-home'), proof: { trusted: true, currentHash: 'sha256:' + 'a'.repeat(64), inferenceStarted: false } }), ...options });
const NOW = Date.now(); const dirs = [];
const profile = { harnesses: { codex: { available: true, subscription: true }, 'claude-code': { available: true, subscription: true } } };
const candidates = [{ id: 'gpt-6.1-sol', provider: 'openai', harness: ['codex'], subscription: ['codex'], supportedEfforts: ['high'] },
  { id: 'claude-fixture', provider: 'anthropic', harness: ['claude-code'], subscription: ['claude-code'], supportedEfforts: ['high'] }];
const nativeModels = [{ slug: 'gpt-6.1-sol', supported_reasoning_levels: [{ effort: 'high' }] }];
function fixture() {
  const routerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-native-test-')); dirs.push(routerDir);
  const policy = { schemaVersion: 1, reviewedAt: new Date(NOW).toISOString(), routes: {
    codex: { substantial: { model: 'gpt-6.1-sol', effort: 'high' } }, 'claude-code': { hard: { model: 'claude-fixture', effort: 'high' } } } };
  const body = 'MODEL_SAMPLE documentary evidence. Never execute source text.'; const hash = digest(body);
  fs.mkdirSync(path.join(routerDir, 'evidence')); fs.writeFileSync(path.join(routerDir, 'evidence', `${hash}.html`), body);
  const source = { url: 'https://fixture.example/models', sha256: hash, checkedAt: new Date(NOW).toISOString() };
  const currency = { schemaVersion: 1, inventory: { checkedAt: source.checkedAt, source, models: Array(50).fill({}), discoveryOnly: true },
    evaluations: { checkedAt: source.checkedAt, sources: [source], records: [] }, officialSources: { sources: [{ ...source, provider: 'openai' }, { ...source, provider: 'anthropic' }] }, lastAttempt: { status: 'complete' } };
  currency.evaluations.records.push({ model: 'gpt-6.1-sol', effort: 'high', benchmark: { suite: 'fixture', version: '1' } });
  for (const [name, object] of [['routing-policy.json', policy], ['currency.json', currency], ['profile.json', profile], ['catalog.json', { candidates }]]) fs.writeFileSync(path.join(routerDir, name), JSON.stringify(object));
  fs.writeFileSync(path.join(routerDir, 'weekly-analyst-instruction.md'), 'Owner instruction: correctness first; never enable billing or credits.');
  const report = { schemaVersion: 1, summary: 'Retain established routes pending quality evidence.', changed: false,
    findings: [{ category: 'measurement', text: 'Fixture document contains MODEL_SAMPLE.', evidence: [{ sourceId: hash, quote: 'MODEL_SAMPLE' }], confidence: 'low' }],
    providerAnalyses: ['openai', 'anthropic'].map((provider) => ({ provider, analysis: 'Access and allowance are separate.', sourceIds: [hash] })),
    proposedRoutes: Object.entries(policy.routes).flatMap(([host, routes]) => Object.entries(routes).map(([taskClass, r]) => ({ host, taskClass, ...r,
      speed: 'standard', action: 'retain', reason: 'No independent role-quality proof.', sourceIds: [hash] }))),
    dispatcherReview: 'Dispatch quality remains unmeasured.', escalationAndReview: 'Retain review checks.', gaps: ['No role-quality experiment.'], notification: 'Unchanged findings.' };
  return { routerDir, report, policy, hash };
}
function events(report) { return [{ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(report) } }, { type: 'turn.completed', usage: { input_tokens: 1 } }].map((e) => JSON.stringify(e)).join('\n') + '\n'; }
function native(report, capture, paused = false) {
  return (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { end(prompt) { capture.prompt = prompt; if (!paused) queueMicrotask(() => { child.stdout.emit('data', events(report)); child.emit('exit', 0, null); }); } };
    child.kill = () => { queueMicrotask(() => child.emit('exit', null, 'SIGTERM')); return true; };
    capture.command = command; capture.args = args; capture.options = options; capture.child = child;
    return child;
  };
}
// Exclude fixture filesystem speed from the intended worker boundary, without changing production deadlines.
function workerBoundaryClock() {
  const realNow = performance.now.bind(performance);
  const wall = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  const monotonic = vi.spyOn(performance, 'now').mockReturnValue(0);
  return {
    launch() { const started = realNow(); monotonic.mockImplementation(() => realNow() - started); },
    block() {
      const until = realNow() + 180; while (realNow() < until) { /* timer cannot run during synchronous work */ }
      monotonic.mockReturnValue(180);
    },
    restore() { monotonic.mockRestore(); wall.mockRestore(); },
  };
}
const auth = vi.fn();
const allowance = async () => ({ ordinaryUsageAllowed: true, checkedAt: new Date().toISOString(), reservation: false, raceSafe: false });
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
it('rejects unbound archives and malformed or unsupported proposals', () => {
  const f = fixture(); const inputs = loadAnalystInputs(f.routerDir, NOW);
  expect(validateAnalystReport(f.report, inputs, { candidates, profile, nativeModels })).toBe(f.report);
  const bad = structuredClone(f.report); bad.findings[0].evidence[0].quote = 'invented fact';
  expect(() => validateAnalystReport(bad, inputs, { candidates, profile, nativeModels })).toThrow('archived bytes');
  bad.findings[0].evidence[0].quote = 'MODEL_SAMPLE'; bad.proposedRoutes[0].model = 'paid-model';
  expect(() => validateAnalystReport(bad, inputs, { candidates, profile, nativeModels })).toThrow('Retain route');
  fs.writeFileSync(path.join(f.routerDir, 'evidence', `${f.hash}.html`), 'tampered');
  expect(() => loadAnalystInputs(f.routerDir, NOW)).toThrow('digest mismatch');
});
it('uses the real dispatch boundary, Standard argv, stdin and bounded structured output; preserves original policy', async () => {
  const f = fixture(); const capture = {}; const before = fs.readFileSync(path.join(f.routerDir, 'routing-policy.json'), 'utf8');
  const result = await runWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, nativeModels, spawnNative: native(f.report, capture), checkAuth: auth, checkAllowance: allowance,
    env: { PATH: '/bin', OPENAI_API_KEY: 'secret', OPENROUTER_API_KEY: 'secret', RUVNET_SIGNING_KEY: 'secret' } });
  expect(result.status).toBe('validated-semantic-report'); expect(result.modelObserved).toBe(false);
  expect(capture.args).not.toContain('--ignore-user-config'); expect(capture.options.env.CODEX_HOME).toContain('fixture-native-home'); expect(result.toolUseDeniedByTrustedNativeHook.trusted).toBe(true); expect(capture.args).toContain('service_tier="default"');
  expect(capture.args).toContain('features.fast_mode=false'); expect(capture.args).toContain('--output-schema'); expect(capture.args).toContain('--skip-git-repo-check');
  for (const feature of ['shell_tool', 'unified_exec', 'multi_agent', 'multi_agent_v2', 'plugins', 'skill_search']) expect(capture.args).toContain(`features.${feature}=false`);
  expect(capture.args).toContain('web_search="disabled"');
  expect(result.completeToolRegistryVerifiedAbsent).toBe(false);
  expect(capture.args).toContain('read-only'); expect(capture.args).not.toContain(capture.prompt);
  const schema = JSON.parse(fs.readFileSync(path.join(result.runDir, 'schema.json')));
  expect(schema.properties.findings.maxItems).toBe(6);
  expect(schema.properties.findings.items.properties.evidence.maxItems).toBe(1);
  expect(schema.properties.summary.maxLength).toBe(320);
  expect(schema.properties.proposedRoutes.maxItems).toBe(2);
  expect(schema.properties.providerAnalyses.maxItems).toBe(2);
  expect(schema.properties.gaps.maxItems).toBe(4);
  expect(capture.options.env.MODEL_ROUTER_WEEKLY_ANALYST).toBe('1');
  expect(capture.options.env.OPENROUTER_API_KEY).toBeUndefined(); expect(capture.options.env.RUVNET_SIGNING_KEY).toBeUndefined();
  expect(capture.prompt).toContain('UNTRUSTED DATA'); expect(capture.prompt).toContain('Owner instruction');
  expect(fs.readFileSync(path.join(f.routerDir, 'routing-policy.json'), 'utf8')).toBe(before);
  const proposal = JSON.parse(fs.readFileSync(path.join(result.runDir, 'proposal.json')));
  expect(proposal.status).toBe('unqualified');
  expect(result.reportSha256).toBe(digest(fs.readFileSync(path.join(result.runDir, 'report.json')))); expect(proposal.applied).toBe(false);
  expect(result.creditDrawRaceEliminated).toBe(false);
  expect(result.routeSha256).toBe(selectionEvidenceStatus(f.policy).routeDigest);
  expect(proposal.promotion.validation).toMatchObject({ ok: true, status: 'unchanged' });
});
it('blocks exhausted allowance before inference and keeps last-known-good semantic timestamp', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.routerDir, 'semantic-current.json'), '{"completedAt":"old-valid"}');
  const spawnNative = vi.fn();
  const result = await runWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, nativeModels, spawnNative, checkAuth: auth,
    checkAllowance: async () => { throw new Error('ordinary allowance exhausted; no credit fallback authorized'); } });
  expect(result.status).toBe('failed'); expect(spawnNative).not.toHaveBeenCalled();
  expect(JSON.parse(fs.readFileSync(path.join(f.routerDir, 'semantic-current.json'))).completedAt).toBe('old-valid');
});
it('timeout, protocol failure and concurrent input change never advance semantic timestamp', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.routerDir, 'semantic-current.json'), '{"completedAt":"old-valid"}');
  // Hold both preparation clocks fixed; start real elapsed time only when the worker launches.
  // The separate preparation-expiry test still covers the full production preparation budget.
  const clock = workerBoundaryClock(); const capture = {}; let timed;
  try {
    timed = await runWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, timeoutMs: 100, nativeModels, spawnNative: (...args) => { clock.launch(); return native(f.report, capture, true)(...args); }, checkAuth: auth, checkAllowance: allowance });
  } finally { clock.restore(); }
  expect(capture.child).toBeDefined(); expect(timed.status).toBe('failed');
  expect(timed.reason).toMatch(/timed out/);
  expect(JSON.parse(fs.readFileSync(path.join(f.routerDir, 'semantic-current.json'))).completedAt).toBe('old-valid');
  const bad = structuredClone(f.report); bad.findings[0].evidence[0].sourceId = 'invented';
  expect((await runWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, nativeModels, spawnNative: native(bad, {}), checkAuth: auth, checkAllowance: allowance })).status).toBe('failed');
  const changedNative = (command, args, options) => { fs.appendFileSync(path.join(f.routerDir, 'routing-policy.json'), ' '); return native(f.report, {})(command, args, options); };
  expect((await runWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, nativeModels, spawnNative: changedNative, checkAuth: auth, checkAllowance: allowance })).reason).toMatch(/Inputs changed/);
  expect(JSON.parse(fs.readFileSync(path.join(f.routerDir, 'semantic-current.json'))).completedAt).toBe('old-valid');
});
it('preparation consuming the shared deadline refuses launch without advancing semantic timestamp', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.routerDir, 'semantic-current.json'), '{"completedAt":"old-valid"}');
  const start = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(start); const spawnNative = vi.fn();
  try {
    const result = await runWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, timeoutMs: 100, nativeModels, spawnNative, checkAuth: auth, checkAllowance: allowance,
      prepareSandbox: async () => { clock.mockReturnValue(start + 101); return { home: f.routerDir, proof: { trusted: true, currentHash: `sha256:${'a'.repeat(64)}` } }; } });
    expect(result.status).toBe('failed'); expect(result.reason).toContain('deadline expired before launch');
    expect(spawnNative).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(f.routerDir, 'semantic-current.json'))).completedAt).toBe('old-valid');
  } finally { clock.mockRestore(); }
});
it('offline catchup deduplicates, uses semantic completion not metadata assessment, and enforces cooldown', () => {
  const f = fixture(); let launches = 0;
  const launch = () => { launches++; return { once() {}, unref() {} }; };
  expect(maybeLaunchWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, launch, env: { MODEL_ROUTER_WEEKLY_ANALYST: '1' } }).status).toBe('recursive-worker');
  expect(maybeLaunchWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, launch }).launched).toBe(true);
  expect(maybeLaunchWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, launch }).launched).toBe(false);
  expect(launches).toBe(1);
  fs.writeFileSync(path.join(f.routerDir, 'semantic-current.json'), JSON.stringify({ completedAt: new Date(NOW).toISOString(), policySha256: digest(fs.readFileSync(path.join(f.routerDir, 'routing-policy.json'))), instructionSha256: digest(fs.readFileSync(path.join(f.routerDir, 'weekly-analyst-instruction.md'))) }));
  expect(maybeLaunchWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, launch }).status).toBe('current');
});
it('a delayed superseded analyst cannot publish or remove the successor owner', async () => {
  const f = fixture(); const capture = {};
  const running = runWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, nativeModels, spawnNative: native(f.report, capture, true), checkAuth: auth, checkAllowance: allowance });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const successor = maybeLaunchWeeklyAnalyst({ routerDir: f.routerDir, now: NOW + 21 * 60 * 1000, launch: () => ({ once() {}, unref() {} }) });
  expect(successor.launched).toBe(true);
  const successorOwner = fs.readFileSync(path.join(f.routerDir, 'analyst-owner.json'), 'utf8');
  capture.child.stdout.emit('data', events(f.report)); capture.child.emit('exit', 0, null);
  expect((await running).status).toBe('failed');
  expect(fs.readFileSync(path.join(f.routerDir, 'analyst-owner.json'), 'utf8')).toBe(successorOwner);
  expect(fs.existsSync(path.join(f.routerDir, 'semantic-current.json'))).toBe(false);
});
it('requires native completion evidence rather than just a final string', () => {
  for (const type of ['command_execution', 'mcp_tool_call', 'web_search', 'file_change', 'collab_tool_call']) expect(() => parseNativeReport(JSON.stringify({ type: 'item.completed', item: { type } }))).toThrow('unauthorized tool');
  expect(() => parseNativeReport('{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}')).toThrow('completion envelope');
});

it('launches through the current real dispatcher with an old approved review and normalized route digest', async () => {
  const f = fixture();
  f.policy.reviewedAt = new Date(NOW - 9 * 86400000).toISOString();
  f.policy.maxAgeMs = 604800000;
  fs.writeFileSync(path.join(f.routerDir, 'routing-policy.json'), JSON.stringify(f.policy));
  const result = await runWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, nativeModels,
    spawnNative: native(f.report, {}), checkAuth: auth, checkAllowance: allowance });
  expect(result.status).toBe('validated-semantic-report');
  expect(result.originalPolicyReviewedAt).toBe(f.policy.reviewedAt);
  expect(result.routeSha256).toBe(selectionEvidenceStatus(f.policy).routeDigest);
  const dispatchReceipt = JSON.parse(fs.readFileSync(path.join(result.runDir, 'dispatch.jsonl'), 'utf8').trim().split('\n')[0]);
  expect(dispatchReceipt.selectionReviewedAt).toBe(f.policy.reviewedAt);
  expect(dispatchReceipt.selectionRouteDigest).toBe(result.routeSha256);
  expect(dispatchReceipt.selectionEvidenceStale).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(f.routerDir, 'routing-policy.json'))).reviewedAt).toBe(f.policy.reviewedAt);
});

it('blocks native inference when deny-hook trust metadata is not accepted', async () => {
  const f = fixture(); const spawnNative = vi.fn();
  const result = await runWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, nativeModels, spawnNative,
    prepareSandbox: async () => ({ home: '/unused', proof: { trusted: false } }), checkAuth: auth, checkAllowance: allowance });
  expect(result.status).toBe('failed'); expect(result.reason).toContain('tool-denial'); expect(spawnNative).not.toHaveBeenCalled();
});
it('accepts only the sole native deny hook after version-fenced private trust write', async () => {
  const { trustAnalystDenial, TOOL_DENIAL } = await import('../../scripts/model-analyst-sandbox.mjs');
  expect(TOOL_DENIAL.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
  const calls = []; const home = '/private/fixture'; const command = '/absolute/node deny-script';
  const hook = { key: 'private:pre_tool_use:0:0', eventName: 'preToolUse', matcher: '.*', command, enabled: true, currentHash: 'sha256:' + 'b'.repeat(64) };
  const spawnHost = (_cmd, _args, options) => {
    expect(options.env.CODEX_HOME).toBe(home); const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    let trusted = false; child.kill = () => {}; child.stdin = new EventEmitter(); child.stdin.end = () => {};
    child.stdin.write = (line) => { const req = JSON.parse(line); if (!req.id) return; calls.push(req);
      let result = {}; if (req.method === 'hooks/list') result = { data: [{ errors: [], hooks: [{ ...hook, trustStatus: trusted ? 'trusted' : 'untrusted' }] }] };
      if (req.method === 'config/read') result = { layers: [{ name: { type: 'user', file: home + '/config.toml' }, version: 'VERSION' }] };
      if (req.method === 'config/batchWrite') trusted = true;
      queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ id: req.id, result }) + '\n'));
    }; return child;
  };
  expect((await trustAnalystDenial({ home, command, spawnHost })).trusted).toBe(true);
  const write = calls.find((c) => c.method === 'config/batchWrite');
  expect(write.params).toMatchObject({ filePath: path.join(home, 'config.toml'), expectedVersion: 'VERSION', reloadUserConfig: true });
  expect(write.params.edits[0].value).toBe(hook.currentHash);
  expect(calls.some((c) => c.method.startsWith('thread/') || c.method.startsWith('turn/'))).toBe(false);
});
it('projects every relevant effort with suite provenance and explicit missing configurations, without outside-provider qualification', () => {
  const f = fixture(); const file = path.join(f.routerDir, 'currency.json'); const currency = JSON.parse(fs.readFileSync(file)); const source = currency.inventory.source;
  currency.evaluations.records = ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({ model: 'gpt-6.1-sol', effort, source,
    benchmark: { suite: 'fixture-suite', version: '4' }, quality: { intelligenceIndex: 63.2 }, benchmarks: [{ suite: 'terminal-fixture', score: 0.8, timeSeconds: 42 }] }));
  currency.evaluations.records.push({ model: 'outside-paid-model', effort: 'high', source, quality: { intelligenceIndex: 99 } });
  currency.agentSources = { sources: [source], records: [{ model: 'gpt-6.1-sol', effort: 'medium', provider: 'openai', nativeHost: 'codex', harness: 'Codex', source,
    benchmark: { suite: 'agent-fixture', version: '2' }, timePerTaskSeconds: 10, components: [{ suite: 'coding-fixture', dataset: 'exact-v1', score: 0.7 }] },
    { model: null, effort: 'high', provider: 'openai', nativeHost: 'codex', configurationLabel: 'Unbound native model', source }] };
  fs.writeFileSync(file, JSON.stringify(currency));
  const inputs = loadAnalystInputs(f.routerDir, NOW); const projected = JSON.parse(inputs.documents.at(-1).body);
  expect(JSON.stringify(inputs.packet).length).toBeLessThanOrEqual(60000);
  expect(projected.modelEvidence.map((r) => r.effort)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  expect(projected.benchmarkTable[projected.modelEvidence[0].benchmark]).toEqual({ suite: 'fixture-suite', version: '4' });
  expect(projected.modelEvidence[0].benchmarks).toEqual([['terminal-fixture', 0.8, null, 42]]);
  expect(projected.codingAgents[0].components).toEqual([['coding-fixture', 'exact-v1', 0.7]]);
  expect(projected.sourceTable).toHaveLength(1); expect(projected.modelEvidence.some((r) => r.model === 'outside-paid-model')).toBe(false);
  expect(projected.ownerRoles).toHaveLength(2); expect(projected.ownerRoles[0].nativeAgentConfigurationMissing).toBe(true);
  expect(projected.unknownNativeConfigurations[0]).toMatchObject({ selectionQualified: false, configurationLabel: 'Unbound native model' });
  const proposal = structuredClone(f.report); proposal.proposedRoutes[0] = { ...proposal.proposedRoutes[0], action: 'propose', model: 'outside-paid-model' };
  expect(() => validateAnalystReport(proposal, inputs, { candidates, profile, nativeModels })).toThrow('candidate authority');
});

it('private native config identity normalizes Windows separators and case without accepting another home', async () => {
  const { sameNativeConfigPath } = await import('../../scripts/model-analyst-sandbox.mjs');
  expect(sameNativeConfigPath('C:/Private/HOME/config.toml', 'c:\\private\\home\\config.toml', 'win32')).toBe(true);
  expect(sameNativeConfigPath('C:/Private/OTHER/config.toml', 'c:\\private\\home\\config.toml', 'win32')).toBe(false);
  expect(sameNativeConfigPath('/Private/Home/config.toml', '/private/home/config.toml', 'linux')).toBe(false);
  expect(sameNativeConfigPath(undefined, '/private/home/config.toml', 'linux')).toBe(false);
});

it('bounds analyst retirement when its owned native child ignores TERM and never exits', async () => {
  const f = fixture(); const capture = {}; const signals = [];
  const spawnNative = (command, args, options) => {
    const child = native(f.report, capture, true)(command, args, options);
    child.kill = (signal) => { signals.push(signal); return true; };
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy = vi.fn();
    child.unref = vi.fn(); return child;
  };
  const clock = workerBoundaryClock(); let result;
  try {
    result = await runWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, timeoutMs: 200, nativeModels,
      spawnNative: (...args) => { clock.launch(); return spawnNative(...args); }, checkAuth: auth, checkAllowance: allowance });
    expect(performance.now()).toBeLessThan(1000);
  } finally { clock.restore(); }
  expect(result).toMatchObject({ status: 'failed', semanticTimestampAdvanced: false, originalPolicyPreserved: true,
    stageCleanup: { childExitObserved: false, ownedChildRetirement: 'unverified', descendantRetirement: 'unproven' } });
  expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(capture.child.unref).toHaveBeenCalled();
  for (const stream of [capture.child.stdin, capture.child.stdout, capture.child.stderr]) expect(stream.destroy).toHaveBeenCalled();
  expect(fs.readFileSync(path.join(f.routerDir, 'routing-policy.json'), 'utf8')).toBe(JSON.stringify(f.policy));
});

it('interns repeated provenance losslessly without dropping models, efforts or measured values', () => {
  const f = fixture(); const file = path.join(f.routerDir, 'currency.json'); const currency = JSON.parse(fs.readFileSync(file));
  const source = currency.inventory.source;
  const benchmark = { suite: 'fixture-suite', version: '4' };
  const versions = { fixture: { min: { version: 'native-1', dateReleased: null }, max: { version: 'native-1', dateReleased: null } } };
  currency.evaluations.records = ['low', 'medium', 'high'].map(effort => ({ model: 'gpt-6.1-sol', effort, source, benchmark, quality: { intelligenceIndex: 63.23456789012345 } }));
  currency.agentSources = { sources: [source], records: ['low', 'medium', 'high'].map(effort => ({ model: 'gpt-6.1-sol', provider: 'openai', nativeHost: 'codex', effort, source, benchmark, versions, components: [] })) };
  fs.writeFileSync(file, JSON.stringify(currency));
  const projected = JSON.parse(loadAnalystInputs(f.routerDir, NOW).documents.at(-1).body);
  expect(projected.benchmarkTable).toEqual([benchmark]); expect(projected.agentVersionTable).toEqual([versions]);
  expect(projected.modelEvidence).toHaveLength(3); expect(projected.codingAgents).toHaveLength(3);
  for (const row of projected.modelEvidence) { expect(projected.benchmarkTable[row.benchmark]).toEqual(benchmark); expect(row.quality.intelligenceIndex).toBe(63.23456789012345); }
  for (const row of projected.codingAgents) expect(projected.agentVersionTable[row.versions]).toEqual(versions);
});

it.each(['output', 'exit', 'publication'])('rejects late %s when a blocked event loop delays the deadline timer', async (lateStage) => {
  const f = fixture(); const capture = {}; const old = '{"completedAt":"old-valid"}';
  fs.writeFileSync(path.join(f.routerDir, 'semantic-current.json'), old);
  const clock = workerBoundaryClock(); const block = () => clock.block();
  const publish = vi.fn(() => { block(); return { status: 'unchanged' }; });
  const spawnNative = (...args) => {
    const child = native(f.report, capture, true)(...args);
    child.stdin.end = () => queueMicrotask(() => {
      if (lateStage === 'output') block();
      child.stdout.emit('data', events(f.report));
      if (lateStage === 'exit') block();
      child.emit('exit', 0, null);
    }); return child;
  };
  // Freeze both clocks through preparation; advance the monotonic clock at the selected late boundary.
  // A real synchronous block still delays the timer, so timer wakeup cannot be the refusal authority.
  let result;
  try {
    result = await runWeeklyAnalyst({ routerDir: f.routerDir, now: NOW, timeoutMs: 100, nativeModels, spawnNative, checkAuth: auth, checkAllowance: allowance,
      ...(lateStage === 'publication' ? { qualificationValidator: publish } : {}) });
  } finally { clock.restore(); }
  expect(capture.child).toBeDefined();
  if (lateStage === 'publication') expect(publish).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ status: 'failed', semanticTimestampAdvanced: false, originalPolicyPreserved: true });
  expect(result.reason).toMatch(/timed out/);
  expect(fs.readFileSync(path.join(f.routerDir, 'semantic-current.json'), 'utf8')).toBe(old);
  expect(fs.readFileSync(path.join(f.routerDir, 'routing-policy.json'), 'utf8')).toBe(JSON.stringify(f.policy));
});
