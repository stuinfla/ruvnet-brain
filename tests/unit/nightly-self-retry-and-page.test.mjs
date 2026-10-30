// The nightly redesign of 2026-10-30. Owner's Mac, three nights running: the knowledge stage failed with the bare
// "Brain installer --update exited 1" (the real reason, a Codex `plugin list` timeout, was thrown away), nothing retried
// it, and nothing paged after the first night. Each case uses injected runners in a temp HOME; nothing reaches npm, ntfy
// or a real installer.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDeveloperUpdate, runtimeConvergence, outputReason, pageNight, synchronizePlugins, CODEX_COMMAND_TIMEOUT_MS, SCHEDULED_RETRY_DELAY_MS, atomic } from '../../plugin/scripts/developer-update.mjs';

const roots = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nsrp-'))); roots.push(d); return d; };

const CODEX_FAILURE = '  \u001b[33m!\u001b[0m host synchronization is incomplete — the active runtime generation could not be verified (Codex plugin codex-unavailable: spawnSync codex ETIMEDOUT)';
const SCHEDULED = { RUVNET_NIGHTLY: '1', RUVNET_NIGHTLY_IDENTITY: 'com.ruvnet.brain-update' };

/** A temp machine: npm owner, an installed ruvnet-brain (installer + notify.sh) and a KB whose check says UPDATE_AVAILABLE
 * until an --update succeeds. `installerExits` is consumed one per --update. */
function machine({ installerExits, notifyExit = 0, corpusCurrent = false, converges = true } = {}) {
  const home = tmp(), prefix = path.join(home, '.npm-global'), root = path.join(prefix, 'lib/node_modules'), bin = path.join(prefix, 'bin');
  const brainHome = path.join(home, '.cache/ruvnet-brain');
  fs.mkdirSync(path.join(root, 'ruvnet-brain/bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ruvnet-brain/scripts'), { recursive: true });
  atomic(path.join(root, 'ruvnet-brain/package.json'), { name: 'ruvnet-brain', version: '1.0.0' });
  fs.writeFileSync(path.join(root, 'ruvnet-brain/bin/install.mjs'), '');
  fs.writeFileSync(path.join(root, 'ruvnet-brain/scripts/notify.sh'), '');
  fs.mkdirSync(bin, { recursive: true }); fs.writeFileSync(path.join(bin, 'npm'), 'fixture', { mode: 0o755 });
  fs.mkdirSync(path.join(brainHome, 'kb'), { recursive: true }); fs.writeFileSync(path.join(brainHome, 'kb/forge-update.mjs'), '');
  const exits = [...(installerExits || [0])];
  let current = corpusCurrent;
  const converge = (version) => {
    atomic(path.join(brainHome, 'active.json'), { version });
    atomic(path.join(brainHome, 'host-convergence.json'), { desiredVersion: version, hosts: { claude: { state: 'ready', version }, codex: { state: 'ready', version } } });
  };
  converge('0.9.0'); // the machine runs an older runtime than the installed package (1.0.0)
  const calls = [], pages = [];
  const runner = (command, args, options) => {
    if (command === '/bin/sh') { pages.push({ args, topic: options.env.NTFY_TOPIC }); return { exitCode: notifyExit, stdout: '', stderr: '' }; }
    calls.push(args.slice(0, 2).join(' '));
    if (args[0] === 'prefix') return prefix;
    if (args[0] === 'root') return root;
    if (args[0] === 'view') return JSON.stringify({ latest: '1.0.0' });
    if (args[1] === '--check') {
      fs.writeFileSync(args[args.indexOf('--result-file') + 1], JSON.stringify({ kind: 'ruvnet-brain-check-result',
        recordedAt: new Date().toISOString(), currencyVerdict: current ? 'CURRENT' : 'UPDATE_AVAILABLE' }));
      return { exitCode: current ? 0 : 10, stdout: '', stderr: '' };
    }
    if (args[1] === '--update') {
      const exitCode = exits.shift() ?? 0;
      if (exitCode === 0) { current = true; if (converges) converge('1.0.0'); }
      return { exitCode, stdout: exitCode ? `brain dir: x\n${CODEX_FAILURE}\n  Positive confirmation\n  done` : 'ok', stderr: '' };
    }
    throw Error(`unexpected call: ${command} ${args.join(' ')}`);
  };
  return { home, root, bin, brainHome, calls, pages, runner,
    receipt: () => JSON.parse(fs.readFileSync(path.join(brainHome, 'nightly-suite-update.json'), 'utf8')) };
}
const updates = (m) => m.calls.filter((c) => c.endsWith('--update')).length;

describe('the scheduled night retries a failed knowledge stage once, the same night', () => {
  it('a first --update failure is retried after the delay; the second attempt converges and the night is ok', async () => {
    const m = machine({ installerExits: [1, 0] }), slept = [];
    const receipt = await runDeveloperUpdate({ mode: 'apply', home: m.home, env: { PATH: m.bin, NTFY_TOPIC: '', ...SCHEDULED },
      runner: m.runner, sleep: (ms) => slept.push(ms) });
    expect(updates(m)).toBe(2); // before: 1, and the night failed
    expect(slept).toContain(SCHEDULED_RETRY_DELAY_MS);
    expect(receipt).toMatchObject({ state: 'completed', ok: true, failures: [] });
    expect(receipt.knowledge).toMatchObject({ state: 'updated', attempts: 2,
      firstAttemptError: expect.stringMatching(/exited 1: .*Codex plugin codex-unavailable: spawnSync codex ETIMEDOUT/) });
    expect(m.pages).toEqual([]); // nothing to page: the night ended ok and the one before it is unknown
  });

  it('two failures: one knowledge failure carrying the installer\'s own reason, and the owner is paged through notify.sh', async () => {
    const m = machine({ installerExits: [1, 1] });
    await expect(runDeveloperUpdate({ mode: 'apply', home: m.home, env: { PATH: m.bin, NTFY_TOPIC: 'topic-x', ...SCHEDULED },
      runner: m.runner, sleep: () => {} })).rejects.toThrow(/knowledge: Brain installer --update exited 1: .*ETIMEDOUT/); // before: "exited 1" alone
    const receipt = m.receipt();
    expect(updates(m)).toBe(2);
    expect(receipt.failures).toHaveLength(1);
    expect(receipt.knowledge).toMatchObject({ state: 'failed', attempts: 2 });
    expect(m.pages).toHaveLength(1); // before: no page from the run; the watchdog paged once, then went quiet
    expect(m.pages[0].topic).toBe('topic-x');
    expect(m.pages[0].args[0]).toBe(path.join(m.root, 'ruvnet-brain/scripts/notify.sh'));
    expect(m.pages[0].args[1]).toBe('RuvNet Brain nightly update FAILED');
    expect(m.pages[0].args[2]).toMatch(/ETIMEDOUT/);
    expect(m.pages[0].args[3]).toBe('urgent');
    expect(receipt.page).toMatchObject({ kind: 'failed', state: 'delivered', exitCode: 0 });
    expect(JSON.stringify(receipt)).not.toContain('topic-x'); // the topic is never recorded
  });

  it('a night after a failed one that ends ok says so (recovered); an undelivered page is recorded as such', async () => {
    const m = machine({ installerExits: [0], notifyExit: 1 });
    atomic(path.join(m.brainHome, 'scheduler/last-suite-attempt.json'), { schemaVersion: 1, kind: 'nightly-suite-update', mode: 'apply',
      scheduled: true, schedulerIdentity: SCHEDULED.RUVNET_NIGHTLY_IDENTITY, state: 'completed-with-failures', ok: false, startedAt: new Date(Date.now() - 86_400_000).toISOString() });
    const receipt = await runDeveloperUpdate({ mode: 'apply', home: m.home, env: { PATH: m.bin, NTFY_TOPIC: 'topic-x', ...SCHEDULED }, runner: m.runner, sleep: () => {} });
    expect(receipt.ok).toBe(true);
    expect(m.pages.map((p) => p.args[1])).toEqual(['RuvNet Brain nightly update recovered']);
    expect(m.receipt().page).toMatchObject({ kind: 'recovered', state: 'not-delivered', exitCode: 1 });
  });

  it('a manual (unscheduled) run neither retries nor pages', async () => {
    const m = machine({ installerExits: [1, 0] });
    await expect(runDeveloperUpdate({ mode: 'apply', home: m.home, env: { PATH: m.bin, NTFY_TOPIC: 'topic-x' }, runner: m.runner, sleep: () => {} }))
      .rejects.toThrow(/exited 1/);
    expect(updates(m)).toBe(1);
    expect(m.pages).toEqual([]);
  });
});

describe('a CURRENT corpus is not a converged machine', () => {
  it('runtime behind the installed package: the installer runs (a corpus no-op) and the runtime is confirmed', async () => {
    const m = machine({ corpusCurrent: true });
    const receipt = await runDeveloperUpdate({ mode: 'apply', home: m.home, env: { PATH: m.bin, NTFY_TOPIC: '', ...SCHEDULED }, runner: m.runner, sleep: () => {} });
    expect(updates(m)).toBe(1); // before: 0 — "current", runtime left on 0.9.0
    expect(receipt.knowledge).toMatchObject({ state: 'runtime-converged', runtime: { converged: true, installed: '1.0.0', active: '1.0.0' } });
  });

  it('an installer that exits 0 without converging the runtime is a failure, not a quiet success', async () => {
    const m = machine({ corpusCurrent: true, converges: false });
    await expect(runDeveloperUpdate({ mode: 'apply', home: m.home, env: { PATH: m.bin, NTFY_TOPIC: '' }, runner: m.runner, sleep: () => {} }))
      .rejects.toThrow(/knowledge: runtime did not converge: runtime 0\.9\.0 is behind the installed package 1\.0\.0/);
  });

  it('the SessionStart self-heal (--knowledge-only) reports a runtime behind but leaves the installer to the nightly', async () => {
    const m = machine({ corpusCurrent: true });
    const receipt = await runDeveloperUpdate({ mode: 'apply', home: m.home, env: { PATH: m.bin }, runner: m.runner, sleep: () => {}, knowledgeOnly: true });
    expect(updates(m)).toBe(0);
    expect(receipt.knowledge).toMatchObject({ state: 'current', runtime: { converged: false }, deferred: expect.any(String) });
  });

  it('a linked source checkout is never "converged to" (its version may be ahead of any release)', () => {
    const m = machine({ corpusCurrent: true });
    const linked = path.join(m.root, 'ruvnet-brain');
    fs.renameSync(linked, `${linked}-src`); fs.symlinkSync(`${linked}-src`, linked);
    expect(runtimeConvergence({ root: m.root, brainHome: m.brainHome })).toMatchObject({ converged: true, reason: 'ruvnet-brain is a linked source checkout' });
    // ...but a host recorded failed is still not converged (review 2026-10-30: the link must not hide a Codex failure).
    atomic(path.join(m.brainHome, 'host-convergence.json'), { desiredVersion: '0.9.0', hosts: { codex: { state: 'failed', error: 'ETIMEDOUT' } } });
    expect(runtimeConvergence({ root: m.root, brainHome: m.brainHome })).toMatchObject({ converged: false, reason: 'host codex failed (ETIMEDOUT)' });
  });

  it('a converged machine with a CURRENT corpus runs no installer; a failed host in the receipt is not converged', async () => {
    const m = machine({ corpusCurrent: true });
    atomic(path.join(m.brainHome, 'active.json'), { version: '1.0.0' });
    atomic(path.join(m.brainHome, 'host-convergence.json'), { desiredVersion: '1.0.0', hosts: { claude: { state: 'ready', version: '1.0.0' } } });
    const receipt = await runDeveloperUpdate({ mode: 'apply', home: m.home, env: { PATH: m.bin }, runner: m.runner, sleep: () => {} });
    expect(updates(m)).toBe(0);
    expect(receipt.knowledge.state).toBe('current');
    atomic(path.join(m.brainHome, 'host-convergence.json'), { desiredVersion: '1.0.0', hosts: { codex: { state: 'failed', error: 'ETIMEDOUT' } } });
    expect(runtimeConvergence({ root: m.root, brainHome: m.brainHome })).toMatchObject({ converged: false, reason: 'host codex failed (ETIMEDOUT)' });
  });
});

describe('the coordinator gives Codex the catalog-refresh limit', () => {
  it('codex plugin commands get CODEX_COMMAND_TIMEOUT_MS, not 30 s (a cold catalog fetch measured 38-40 s)', async () => {
    const home = tmp(), seen = [];
    const run = (command, args, options = {}) => { seen.push([args.slice(0, 3).join(' '), options.timeout]); return args.includes('list') ? '{"marketplaces":[]}' : ''; };
    await synchronizePlugins(run, true, [], { home, prefix: home, scope: 'ruvnet', locate: (name) => (name === 'codex' ? '/fixture/codex' : null) });
    expect(CODEX_COMMAND_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
    expect(seen).toEqual([['plugin marketplace list', CODEX_COMMAND_TIMEOUT_MS], ['plugin --help', CODEX_COMMAND_TIMEOUT_MS]]); // before: 30000
  });
});

describe('pageNight and outputReason', () => {
  it('no topic anywhere is paging off, recorded and not attempted', () => {
    const home = tmp();
    let called = false;
    const result = pageNight({ runId: 'r', startedAt: 'now' }, 'failed', { root: home, brainHome: home, env: {}, platform: 'darwin',
      runner: () => { called = true; return { exitCode: 0 }; } });
    expect(result.state).toBe('unavailable'); // no notify.sh in this root
    fs.mkdirSync(path.join(home, 'ruvnet-brain/scripts'), { recursive: true });
    fs.writeFileSync(path.join(home, 'ruvnet-brain/scripts/notify.sh'), '');
    expect(pageNight({}, 'failed', { root: home, brainHome: home, env: {}, platform: 'darwin', runner: () => { called = true; return { exitCode: 0 }; } }).state).toBe('off');
    fs.writeFileSync(path.join(home, 'ntfy-topic'), 'from-file\n');
    expect(pageNight({}, 'failed', { root: home, brainHome: home, env: {}, platform: 'darwin', runner: (c, a, o) => { called = o.env.NTFY_TOPIC; return { exitCode: 0 }; } }).state).toBe('delivered');
    expect(called).toBe('from-file');
  });

  it('outputReason keeps the failing line, strips colour, and stays short', () => {
    expect(outputReason({ stdout: `a\n${CODEX_FAILURE}\nb\nc`, stderr: '' })).toMatch(/^! host synchronization is incomplete .*ETIMEDOUT\)$/);
    expect(outputReason({ stdout: 'one\ntwo\nthree\nfour', stderr: '' })).toBe('two | three | four');
    expect(outputReason({ stdout: 'x'.repeat(5000) }).length).toBeLessThanOrEqual(600);
    expect(outputReason('text')).toBe('');
  });
});
