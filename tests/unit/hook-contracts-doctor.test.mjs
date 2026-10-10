/**
 * --doctor must say ONE thing, and that thing must be true.
 *
 * Two defects, both observed on a real run:
 *   1. It printed "✓ Healthy." from a narrow reading and "✗ FAILING" from a wide one, in the same
 *      output, and exited 0. A reader stops at the first verdict, so the tool told people they were
 *      healthy while its own exit-code logic had already decided otherwise.
 *   2. It called the SessionStart restore and the Stop continuation gate "retired Brain lifecycle
 *      hooks" — the two handlers the policy itself requires — because it assumed the permitted
 *      number was zero instead of asking hook-contracts.json.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { classifyCodexLifecycle, codexLifecycleGuidance, locateRuflo } from '../../bin/install.mjs';
import { continuityRegistrations } from '../../plugin/scripts/continuity-hook-policy.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const INSTALL = fs.readFileSync(path.join(ROOT, 'bin/install.mjs'), 'utf8');
const CONTRACTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/hooks/hook-contracts.json'), 'utf8'));
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PLUGIN_ID = /const CODEX_PLUGIN_ID = '([^']+)'/.exec(INSTALL)?.[1];

const listed = (hooks) => ({ ok: true, value: { data: [{ hooks }] } });
const plugin = { available: true, installed: true, enabled: true };
const wrapper = (id, extra = '') =>
  `node ~/.cache/ruvnet-brain/codex-hook.mjs 9000 ${id}${extra ? ` ${extra}` : ''}`;

describe('--doctor derives its hook judgments from the contracts', () => {
  it('reads the same plugin id the classifier uses', () => {
    expect(PLUGIN_ID, 'CODEX_PLUGIN_ID moved; this fixture is no longer testing the real filter').toBeTruthy();
  });

  it('calls a REGISTERED continuity hook registered, never retired', () => {
    const hooks = continuityRegistrations('codex').map((spec) => ({
      pluginId: PLUGIN_ID,
      event: spec.event,
      command: wrapper(spec.id, spec.event === 'SessionEnd' || spec.event === 'UserPromptSubmit' ? spec.event : ''),
    }));
    const status = classifyCodexLifecycle(plugin, listed(hooks));
    expect(status.state).toBe('continuity-registered');
    const guidance = codexLifecycleGuidance(status);
    expect(guidance.healthy).toBe(true);
    expect(guidance.summary).not.toMatch(/retired/i);
    expect(guidance.summary).toContain(String(hooks.length));
    // The doctor must not claim Codex capture is broader than what was measured. "Capture" (the
    // session-snapshot continuity handler) is unchanged by the 2026-09-12 PreToolUse/PostToolUse
    // measurement below — it still fires at SessionEnd only.
    expect(guidance.detail).toContain('SessionEnd only');
    // 2026-09-12: re-measured with prompts that actually invoke a tool (the 2026-09-11 entry used
    // "reply OK", which never did) — PreToolUse/PostToolUse now fire for a real write and a real
    // MCP call too, on top of the original three lifecycle events.
    expect(CONTRACTS._codexCapture.fired).toEqual([
      'SessionStart', 'UserPromptSubmit', 'SessionEnd',
      'PreToolUse (apply_patch write; tool_input.command carried the raw patch)',
      'PostToolUse (apply_patch write; tool_response = "Exit code: 0 … Success. Updated the following files: A <path>")',
      'PreToolUse (MCP search_ruvnet; tool_name mcp__ruvnet_brain__search_ruvnet, tool_input.query preserved verbatim)',
      'PostToolUse (MCP search_ruvnet; tool_response.content[0].text carried the "Searched N RuvNet repos" banner)',
    ]);
    expect(Object.keys(CONTRACTS._codexCapture.notObserved).sort()).toEqual(['PreCompact', 'Stop']);
  });

  // 4.5 (review-4.3.39 #7): Codex lists an untrusted/modified hook but does not run it. Measured on the
  // owner's machine 2026-10-01 via the same hooks/list the doctor calls: SessionEnd `modified` after 4.4.0.
  const registered = (overrides = {}) => continuityRegistrations('codex').map((spec) => ({
    pluginId: PLUGIN_ID, event: spec.event, enabled: true, trustStatus: 'trusted',
    command: wrapper(spec.id, spec.event === 'SessionEnd' || spec.event === 'UserPromptSubmit' ? spec.event : ''),
    ...(overrides[spec.event] || {}),
  }));
  it('reports a registered hook Codex will not run (modified / untrusted) as PENDING TRUST, with the exact fix', () => {
    const hooks = registered();
    // An event may declare several handlers. Hold back exactly one at each boundary;
    // the remaining trusted handlers must not be counted as pending merely by event.
    const end = hooks.find((hook) => hook.event === 'SessionEnd');
    const start = hooks.find((hook) => hook.event === 'SessionStart');
    expect(end).toBeTruthy();
    expect(start).toBeTruthy();
    end.trustStatus = 'modified';
    start.trustStatus = 'untrusted';
    const status = classifyCodexLifecycle(plugin, listed(hooks));
    expect(status.state).toBe('pending-trust');
    expect(status.pending.map((h) => h.event).sort()).toEqual(['SessionEnd', 'SessionStart']);
    expect(status.pending.map((h) => h.command).sort()).toEqual([end.command, start.command].sort());
    const guidance = codexLifecycleGuidance(status);
    expect(guidance.healthy).toBe(false);
    expect(guidance.intentional).toBe(false);
    expect(guidance.summary).toMatch(/NOT running 2 Brain hooks/);
    expect(guidance.summary).toMatch(/SessionEnd \(modified\)/);
    expect(guidance.action).toMatch(/Trust all and continue/);
    expect(guidance.action).toMatch(/\/hooks/);
  });
  it('all trusted stays continuity-registered; a hook the USER disabled is their choice, not pending', () => {
    expect(classifyCodexLifecycle(plugin, listed(registered())).state).toBe('continuity-registered');
    expect(classifyCodexLifecycle(plugin, listed(registered({ Stop: { trustStatus: 'modified', enabled: false } }))).state)
      .toBe('continuity-registered');
  });

  it('still calls a genuinely stale Brain hook stale', () => {
    const status = classifyCodexLifecycle(plugin, listed([
      { pluginId: PLUGIN_ID, event: 'PreToolUse', command: wrapper('ground-ruvnet') },
    ]));
    expect(status.state).toBe('unexpected-runtime-hooks');
    const guidance = codexLifecycleGuidance(status);
    expect(guidance.healthy).toBe(false);
    expect(guidance.summary).toMatch(/retired/i);
  });

  it('ignores hooks that are not ours, and reports none of ours as inactive-by-design', () => {
    const status = classifyCodexLifecycle(plugin, listed([
      { pluginId: 'someone-else@theirs', event: 'Stop', command: 'node theirs.mjs' },
    ]));
    expect(status.state).toBe('inactive-by-design');
    expect(codexLifecycleGuidance(status).healthy).toBe(true);
  });

  it('surfaces a runtime error as missing-runtime-hooks rather than as health', () => {
    const status = classifyCodexLifecycle(plugin, { ok: true, value: { data: [{ hooks: [], errors: ['boom'] }] } });
    expect(status.state).toBe('missing-runtime-hooks');
    expect(codexLifecycleGuidance(status).healthy).toBe(false);
  });
});

describe('--doctor emits exactly one verdict', () => {
  // BEHAVIOUR, not source strings (review S5). A fixture brain with a structural Knowledge ✗ (no signature
  // record) is run through the REAL installer twice: as text and as --json. Before the fix the text verdict
  // counted only footprint lines (it could print "Not green" and then "✓ Healthy." with exit 0) while --json
  // printed only the confirmation and exited on its own rule. Now both must report the SAME failing lines,
  // and the exit code must be that verdict's.
  //
  // CI Linux (run 36915686695, ruflo installed globally) then failed it: text said `ruflo` was failing,
  // --json said it was fine. Not two verdicts but two DIFFERENT INPUTS: the doctor's "read-only" Ruflo probe
  // ran `ruflo status memory` in the user's directory, which (measured, ruflo 3.49.0) writes .swarm/,
  // .claude-flow/ and ruvector.db there. Run 1 saw an uninitialized directory ("not initialized" → read as
  // degraded learning); run 2 saw the directory run 1 had initialized ("[STOPPED]" → direct mode, healthy).
  // macOS passed only because ruflo was not on the fixture PATH. So the test now runs BOTH outputs, in BOTH
  // orders, with a stub ruflo that behaves like the real one (including that write) and with none at all.
  const STUB_RUFLO = `const fs = require('node:fs'); const path = require('node:path');
const a = process.argv.slice(2).join(' '); const cwd = process.cwd();
const initialized = fs.existsSync(path.join(cwd, '.claude-flow'));
const plant = () => { for (const d of ['.claude-flow', '.swarm']) fs.mkdirSync(path.join(cwd, d), { recursive: true }); fs.writeFileSync(path.join(cwd, 'ruvector.db'), ''); };
if (a === 'status') { console.log(initialized ? 'RuFlo V3 [STOPPED]\\n[INFO]   Swarm not running\\n| Backend | none |\\n| Entries | 0 |' : '[ERROR] RuFlo is not initialized in this directory\\n[INFO] Run "ruflo init" to initialize'); process.exit(initialized ? 0 : 1); }
if (a === 'status memory') { plant(); console.log('| Backend | sqlite |\\n| Total Entries | 0 |'); process.exit(0); }
if (a === 'hooks metrics --v3-dashboard') { fs.mkdirSync(path.join(cwd, '.claude-flow'), { recursive: true }); console.log('| Total Patterns | 0 |\\n| Total Routes | 0 |\\n| Total Executed | 0 |'); process.exit(0); }
process.exit(0);
`;
  const doctorTwice = ({ ruflo, order }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-one-verdict-'));
    try {
      const kb = path.join(home, '.cache', 'ruvnet-brain', 'kb');
      fs.mkdirSync(kb, { recursive: true });
      fs.writeFileSync(path.join(kb, 'forge-mcp-all.mjs'), '// fixture: never executed\n');
      fs.writeFileSync(path.join(kb, 'SOURCE.json'), JSON.stringify({ builtUtc: new Date().toISOString(), releaseTag: `v${VERSION}` }));
      fs.writeFileSync(path.join(kb, 'COVERAGE.json'), '{"rows":[]}');
      // A record that does not match the live bytes: a provable, structural Knowledge ✗ (a missing one only advises).
      fs.writeFileSync(path.join(home, '.cache', 'ruvnet-brain', 'knowledge-signature.json'), JSON.stringify({ schemaVersion: 1,
        kind: 'ruvnet-brain-knowledge-signature', verifiedAt: new Date().toISOString(), bundleSha256: 'a'.repeat(64), coverageSha256: 'b'.repeat(64) }));
      const project = path.join(home, 'project'); // where the user runs --doctor: never written by it
      fs.mkdirSync(project);
      const stubBin = path.join(home, 'stub-bin');
      fs.mkdirSync(stubBin);
      // node's OWN directory is deliberately NOT on PATH: on CI `npm i -g ruflo` installs ruflo right beside
      // node (setup-node's prefix bin), so including it made "ruflo absent" false there (run 36919727923).
      // node is reached through this link instead; ruflo is present only as the stub, when asked for.
      fs.symlinkSync(process.execPath, path.join(stubBin, 'node'));
      if (ruflo) fs.writeFileSync(path.join(stubBin, 'ruflo'), `#!${process.execPath}\n${STUB_RUFLO}`, { mode: 0o755 });
      const emptyGit = path.join(home, 'empty-gitconfig');
      fs.writeFileSync(emptyGit, '');
      const env = { PATH: [stubBin, '/usr/bin', '/bin'].join(path.delimiter), HOME: home,
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'), npm_config_cache: path.join(home, '.npm'),
        RUVNET_BRAIN_TEST: '1', RUVNET_BRAIN_TEST_NPM_LATEST: VERSION, RUVNET_NO_TELEMETRY: '1', RUFLO_DAEMON_AUTOSTART: '0',
        GIT_CONFIG_GLOBAL: emptyGit, GIT_CONFIG_NOSYSTEM: '1' };
      const run = (args) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install.mjs'), ...args],
        { cwd: project, env, encoding: 'utf8', timeout: 120_000 });
      const runText = () => { const raw = run(['--doctor']); return { ...raw, stdout: String(raw.stdout).replace(/\u001b\[[0-9;]*m/g, '') }; }; // eslint-disable-line no-control-regex
      let text; let json;
      if (order === 'text-first') { text = runText(); json = run(['--doctor', '--json']); } else { json = run(['--doctor', '--json']); text = runText(); }
      return { text, json, projectEntries: fs.readdirSync(project).sort(), located: locateRuflo({ env, home }), stubBin };
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  };
  for (const ruflo of [true, false]) {
    for (const order of ['text-first', 'json-first']) {
      it(`text, --json and the exit code agree on a Knowledge ✗ machine (ruflo ${ruflo ? 'on PATH' : 'absent'}, ${order})`, () => {
        const { text, json, projectEntries, located, stubBin } = doctorTwice({ ruflo, order });
        // GUARD on the premise, with the doctor's OWN locator in the very environment the doctor ran in: if this
        // machine leaks a ruflo by any route the locator uses, this fails here, loudly, instead of a later
        // assertion claiming the product is wrong.
        expect(located, `ruflo ${ruflo ? 'stub not found' : 'leaked into the "absent" fixture'}: ${JSON.stringify(located)}`)
          .toEqual(ruflo ? { cli: path.join(stubBin, 'ruflo'), configured: false } : { cli: null, configured: false });
        const verdictLines = text.stdout.split('\n').filter((l) => /✓ Healthy\.|✗ FAILING/.test(l));
        expect(verdictLines, text.stdout.slice(-3000)).toHaveLength(1);
        expect(verdictLines[0]).toMatch(/✗ FAILING — /);
        expect(text.stdout).not.toMatch(/✓ Healthy\./);
        expect(text.stdout).toMatch(/✗ Knowledge .*signature record does not match the live COVERAGE\.json/);
        const textFailing = verdictLines[0].replace(/^.*✗ FAILING — /, '').replace(/:.*$/, '').split(', ');
        const verdict = JSON.parse(json.stdout); // stdout is ONLY the verdict object; narration went to stderr
        expect(verdict).toMatchObject({ kind: 'ruvnet-brain-doctor', ok: false, exitCode: 1 });
        expect(verdict.failing).toContain('knowledge');
        expect([...verdict.failing].sort()).toEqual([...textFailing].sort());
        // The Ruflo line itself is the same in both outputs: present (and not failing) only when ruflo is.
        // The confirmation-block line (label padded to 10), not the narration's "! Ruflo not found" sentence.
        const rufloText = text.stdout.split('\n').find((l) => /^\s+[✓✗!○] Ruflo {6}\S/.test(l)) || null;
        const rufloJson = verdict.lines.find((l) => l.id === 'ruflo') || null;
        expect(Boolean(rufloText)).toBe(Boolean(rufloJson));
        expect(Boolean(rufloJson)).toBe(ruflo);
        if (rufloJson) expect(rufloJson.state).not.toBe('fail'); // an uninitialized directory is not degraded learning
        expect(projectEntries, 'the doctor wrote into the user\'s directory').toEqual([]);
        expect(text.status).toBe(1);
        expect(json.status).toBe(verdict.exitCode);
      }, 300_000);
    }
  }

  it('keeps the narrow install reading from calling itself a verdict', () => {
    // Two lines both labelled "verdict" that answer different questions can disagree in public.
    expect(INSTALL).not.toMatch(/'verdict: Healthy/);
    expect(INSTALL).toMatch(/install reading: present and reachable/);
  });

  it('names the real cause of a smoke failure instead of guessing a reassuring one', () => {
    expect(INSTALL, 'the unconditional "first-run model download" excuse is back')
      .not.toMatch(/no answer came back \(first-run model download/);
    // The classifier moved to scripts/installed-brain-health.mjs: assert its BEHAVIOUR, not where the text lives.
    const HEALTH = fs.readFileSync(path.join(ROOT, 'scripts', 'installed-brain-health.mjs'), 'utf8');
    expect(INSTALL, 'the doctor no longer routes its smoke failure through the classifier').toMatch(/classifySmokeFailure/);
    for (const cause of [
      'could not launch the reader',
      'timed out after',
      'was killed by',
      'exited 0 after',
    ]) expect(HEALTH, `smoke failure cause "${cause}" is not reported`).toContain(cause);
  });
});

// 4.5.1 ruling through the REAL doctor, text and --json: a missing record advises (exit 0), a record that does not
// match the live bytes gates (exit 1), and the three outputs agree in every case.
describe('signature provenance: missing advises, mismatching gates (4.5.1)', () => {
  for (const [label, mutate, expected] of [
    ['valid record', () => {}, { exit: 0, state: 'ok' }],
    ['missing record', (b) => fs.rmSync(path.join(b.brainHome, 'knowledge-signature.json')), { exit: 0, state: 'warn' }],
    ['record not matching the live bytes', (b) => {
      const f = path.join(b.brainHome, 'knowledge-signature.json');
      fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), coverageSha256: 'e'.repeat(64) }));
    }, { exit: 1, state: 'fail' }],
  ]) {
    it(`${label}: text, --json and the exit code agree`, async () => {
      const { completeBrain } = await import('../helpers/doctor-brain-fixture.mjs');
      const b = completeBrain({ modelsReady: true });
      try {
        mutate(b);
        const text = b.doctor();
        const jsonRun = b.doctor(['--json']);
        const verdict = JSON.parse(jsonRun.stdout);
        expect(verdict.lines.find((l) => l.id === 'knowledge').state, text.text.slice(-1500)).toBe(expected.state);
        expect([text.status, jsonRun.status, verdict.exitCode]).toEqual([expected.exit, expected.exit, expected.exit]);
        const mark = { ok: '✓', warn: '!', fail: '✗' }[expected.state];
        expect(text.text).toMatch(new RegExp(`^\\s+${mark} Knowledge `, 'm'));
        expect(text.text).toMatch(expected.exit ? /✗ FAILING — knowledge/ : /✓ Healthy\./);
      } finally { b.cleanup(); }
    }, 120_000);
  }

  // 4.5.2: the REAL doctor runs the release-coverage check (validateCoverageDirectory). A projection on disk that
  // fails it is ✗ even with a matching record; a directory without one gets the narrower wording, not a failure.
  it('real doctor: a broken release projection is ✗; no projection → "install record matches COVERAGE.json"', async () => {
    const { completeBrain } = await import('../helpers/doctor-brain-fixture.mjs');
    const b = completeBrain({ modelsReady: true });
    try {
      const k = () => JSON.parse(b.doctor(['--json']).stdout).lines.find((l) => l.id === 'knowledge');
      expect(k()).toMatchObject({ state: 'ok', detail: expect.stringMatching(/install record matches COVERAGE\.json/) });
      fs.writeFileSync(path.join(b.kbDir, 'CORPUS-COVERAGE.json'), '{"kind":"not-a-corpus-coverage"}');
      const text = b.doctor();
      expect(k()).toMatchObject({ state: 'fail', fix: 'npx ruvnet-brain@latest --update', detail: expect.stringMatching(/fail the release-coverage check/) });
      expect(text.status).toBe(1);
      expect(text.text).toMatch(/✗ Knowledge .*fail the release-coverage check/);
    } finally { b.cleanup(); }
  }, 120_000);

  // The release's install-verification lane installs a local sealed artifact without verifying it (so no
  // record), and a customer KB advanced by the AUTOMATIC updater never passes through install.mjs: both must
  // still pass `--doctor --hooks` (what scripts/publication-receipt.mjs requires: exit 0), with the ! line.
  for (const [label, extra] of [
    ['a --local --no-verify style install (no record)', () => {}],
    ['a legacy install the auto-updater advanced (no record, refresh receipts present)', async (b) => {
      // The automatic updater's own receipt, written by the real refresh-run writer, for the live bytes.
      const { acquireRefreshLock, openRefreshReceipt, recordRefreshPhase, settleRefreshRun, REQUIRED_REFRESH_PHASES } = await import('../../kb/refresh-run.mjs');
      const lock = acquireRefreshLock({ kbDir: b.kbDir, brainHome: b.brainHome, action: 'update' });
      const handle = openRefreshReceipt({ brainHome: b.brainHome, lock, action: 'update' });
      const evidence = { 'coverage-generation': { coverageSha256: b.coverageSha256() }, 'bundle-assembly': { bundleSha256: 'd'.repeat(64) }, update: { terminalVerdict: 'applied' } };
      for (const phase of REQUIRED_REFRESH_PHASES) recordRefreshPhase(handle, phase, 'PASS', evidence[phase] || null);
      settleRefreshRun({ handle, lock, status: 'SUCCEEDED' });
      expect(fs.readdirSync(path.join(b.brainHome, 'refresh-runs')).length).toBe(1);
    }],
  ]) {
    it(`${label}: --doctor --hooks exits 0 with the advisory Knowledge line`, async () => {
      const { completeBrain } = await import('../helpers/doctor-brain-fixture.mjs');
      const b = completeBrain({ modelsReady: true });
      try {
        fs.rmSync(path.join(b.brainHome, 'knowledge-signature.json'));
        await extra(b);
        const r = b.doctor(['--hooks']);
        expect(r.status, r.text.slice(-2000)).toBe(0);
        expect(r.text).toMatch(/^\s+! Knowledge .*installed or updated without a recorded signature verification/m);
      } finally { b.cleanup(); }
    }, 120_000);
  }
});

// An interrupted --move-brain can leave the ONLY copy of the Brain at <home>.old-<pid> with nothing at the
// Brain's own path. The doctor must not just say "not installed, run the installer" (a fresh install over it
// would make a second, public-only Brain): it names the leftover and the exact `mv` back, in text and JSON.
describe('the doctor names an interrupted move\'s set-aside Brain', () => {
  it('Brain missing + <home>.old-<dead pid> holding it → ✗ Move with the mv back (text and JSON agree)', async () => {
    const { completeBrain } = await import('../helpers/doctor-brain-fixture.mjs');
    const b = completeBrain();
    try {
      const brainHome = path.join(b.parent, 'brain');                       // the Brain's own path: MISSING
      const old = `${brainHome}.old-${2 ** 30}`;                             // set aside by a move that died
      fs.mkdirSync(old); fs.renameSync(b.kbDir, path.join(old, 'kb'));
      const extraEnv = { RUVNET_BRAIN_HOME: brainHome, RUVNET_BRAIN_KB: path.join(brainHome, 'kb') };
      const text = b.doctor([], { extraEnv });
      const json = JSON.parse(b.doctor(['--json'], { extraEnv }).stdout);
      const move = json.lines.find((l) => l.id === 'move-leftover');
      const restore = `mv -- '${old}' '${brainHome}'`;
      expect(move).toMatchObject({ state: 'fail', fix: restore });
      expect(text.text).toMatch(new RegExp(`✗ Move\\s+the original Brain set aside by an interrupted move — the ONLY copy of the Brain: ${old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      expect(text.text).toContain(`fix: ${restore}`);
      // Never "run the installer": a fresh install there would build a second, public-only Brain.
      expect(text.text).not.toMatch(/run the installer first|npx ruvnet-brain\s*$/m);
      expect(json.lines.find((l) => l.id === 'install').fix).toBe(restore);
      expect(json.failing).toEqual(expect.arrayContaining(['install', 'move-leftover']));
      expect(text.status).toBe(1);
      expect(fs.existsSync(path.join(old, 'kb', 'SOURCE.json'))).toBe(true); // reported, never touched
    } finally { b.cleanup(); }
  }, 120_000);
});

// 4.5.2 (Fable review): after an interrupted move, a hook or the search server RECREATES the home on a failure path
// (health.json, a notice file). A home that exists but holds no Brain is still a missing Brain: the doctor names the
// restore (clear the recreated home, mv the leftover back), never `rm` of the leftover and never a reinstall; the
// installer refuses to install or update over it; SessionStart says restore, not reinstall.
describe('a home recreated without a Brain after an interrupted move', () => {
  const q = (p) => `'${p}'`;
  for (const [label, recreate, clear] of [
    ['recreated EMPTY', () => {}, (home) => `rmdir -- ${q(home)}`],
    ['recreated by a hook (health.json inside)', (home) => fs.writeFileSync(path.join(home, 'health.json'), '{"status":"down"}'),
      (home) => `mv -- ${q(home)} ${q(`${home}.recreated-${2 ** 30}`)}`],
  ]) {
    it(`${label}: doctor → ✗ restore (text and JSON), installer refuses, SessionStart says restore`, async () => {
      const { completeBrain } = await import('../helpers/doctor-brain-fixture.mjs');
      const { health } = await import('../../plugin/scripts/session-start-health.mjs');
      const b = completeBrain();
      try {
        const brainHome = path.join(b.home, '.cache', 'ruvnet-brain');
        const old = `${brainHome}.old-${2 ** 30}`;                           // set aside by a move that died
        fs.mkdirSync(old, { recursive: true }); fs.renameSync(b.kbDir, path.join(old, 'kb'));
        fs.mkdirSync(brainHome, { recursive: true }); recreate(brainHome);    // ... and the home came back without it
        const extraEnv = { RUVNET_BRAIN_HOME: brainHome, RUVNET_BRAIN_KB: path.join(brainHome, 'kb') };
        const restore = `${clear(brainHome)} && mv -- ${q(old)} ${q(brainHome)}`;
        const text = b.doctor([], { extraEnv });
        const json = JSON.parse(b.doctor(['--json'], { extraEnv }).stdout);
        expect(json.lines.find((l) => l.id === 'move-leftover'), text.text.slice(-1500)).toMatchObject({ state: 'fail', fix: restore });
        expect(json.lines.find((l) => l.id === 'install').fix).toBe(restore);
        expect(text.text).toContain(`fix: ${restore}`);
        expect(text.text).not.toContain(`rm -rf -- ${q(old)}`);
        expect(text.text).not.toMatch(/run the installer first|npx ruvnet-brain\s*$/m);
        expect([text.status, json.exitCode]).toEqual([1, 1]);

        for (const args of [['--update'], ['--yes', '--no-nightly-prompt']]) {
          const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install.mjs'), ...args],
            { cwd: b.project, env: { ...b.env, ...extraEnv }, encoding: 'utf8', timeout: 60_000 });
          const out = `${r.stdout}${r.stderr}`;
          expect(r.status, `${args.join(' ')}: ${out.slice(-1200)}`).toBe(1);
          expect(out).toContain('restore it, do NOT reinstall');
          expect(out).toContain(restore);
        }
        expect(fs.readdirSync(path.join(old, 'kb')).length).toBeGreaterThan(1);  // never touched
        expect(fs.existsSync(path.join(brainHome, 'kb'))).toBe(false);          // nothing installed beside it

        const said = health(b.home, false).problem;
        expect(said).toContain(`interrupted move left the ONLY copy at ${old}`);
        expect(said).not.toMatch(/reinstall: npx/);
      } finally { b.cleanup(); }
    }, 180_000);
  }
});

// Re-review S2: "AgentDB: recording stuck" was printed as narration but was not a line of the ONE verdict, so
// it vanished from --doctor --json. It is now a verdict line (advisory '!': recording is a project's
// opt-in memory, not the Brain's health), identical in text and JSON. Built with the REAL journal.
describe('AgentDB recording is a line of the one verdict', () => {
  it('a stuck outbox reads "! AgentDB" in text AND JSON; a directory without .swarm has no such line', async () => {
    const { completeBrain } = await import('../helpers/doctor-brain-fixture.mjs');
    const { ContinuityJournal, STUCK_AFTER_MS } = await import('../../plugin/scripts/continuity-journal.mjs');
    const { makeEvent } = await import('../../plugin/scripts/continuity-events.mjs');
    const { createStore } = await import('../helpers/continuity-fixture.mjs');
    const b = completeBrain();
    try {
      expect(b.doctor(['--json']).stdout).not.toMatch(/"id": "agentdb"/);
      fs.mkdirSync(path.join(b.project, '.swarm'));
      createStore(path.join(b.project, '.swarm', 'memory.db'));
      const ruflo = path.join(b.parent, 'ruflo'); fs.writeFileSync(ruflo, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const old = Date.now() - STUCK_AFTER_MS - 60_000;
      new ContinuityJournal({ projectRoot: b.project, ruflo, now: () => old })
        .record([makeEvent({ kind: 'lesson', at: old, source: 'explicit', authoritative: true, summary: 'Stuck for the doctor.' })]);
      const extraEnv = { RUFLO_BIN: ruflo };
      const text = b.doctor([], { extraEnv });
      const json = JSON.parse(b.doctor(['--json'], { extraEnv }).stdout);
      const line = json.lines.find((l) => l.id === 'agentdb');
      expect(line).toMatchObject({ state: 'warn', detail: expect.stringMatching(/recording stuck — 1 event\(s\) pending/) });
      expect(text.text).toMatch(/^\s+! AgentDB\s+recording stuck — 1 event\(s\) pending/m);
      expect(json.advisories).toContain('agentdb');
      expect(json.failing).not.toContain('agentdb');
    } finally { b.cleanup(); }
  }, 120_000);
});
