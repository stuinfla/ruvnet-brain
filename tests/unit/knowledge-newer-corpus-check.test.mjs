// knowledge-newer-corpus-check.test.mjs — "all accounts auto update anytime a new corpus of knowledge
// happens" (owner, 2026-10-02). Measured failure: the owner's Mac KB stayed at v4.4.1 for ~13h after
// v4.5.0 was published, because the self-heal only asked "is MY copy older than 24h?" and never "has
// something NEWER been published?". These tests pin the identity check: a fresh-by-age KB still gets a
// throttled, detached `forge-update.mjs --check`, and only a published corpus whose IDENTITY differs
// (and is not older — forge-update's REFUSED verdict) launches the one existing updater.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { knowledgeAutoUpdate } from '../../plugin/scripts/session-start-update-plane.mjs';
import { knowledgeCurrency, KNOWLEDGE_LINE_PREFIX } from '../../plugin/scripts/session-start-health.mjs';
import { confirm } from '../../plugin/scripts/brain-confirmation.mjs';
import { inventoryFootprint } from '../../plugin/scripts/brain-footprint.mjs';

const HOOK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin', 'scripts');
const NOW = Date.parse('2026-10-02T12:00:00Z');
const H = 3_600_000;
const TAG_A = `corpus-sha256-${'a'.repeat(64)}`;
const TAG_B = `corpus-sha256-${'b'.repeat(64)}`;
let home; let brain; let kb;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'newer-corpus-'));
  brain = path.join(home, '.cache', 'ruvnet-brain');
  kb = path.join(brain, 'kb');
  fs.mkdirSync(path.join(kb, 'node_modules', '@xenova', 'transformers'), { recursive: true });
  fs.writeFileSync(path.join(kb, 'node_modules', '@xenova', 'transformers', 'package.json'), '{}');
  fs.writeFileSync(path.join(kb, 'store.rvf'), 'x');
  fs.writeFileSync(path.join(kb, 'forge-update.mjs'), '// updater present\n');
  fs.writeFileSync(path.join(kb, 'SOURCE.json'), JSON.stringify({ builtUtc: new Date(NOW - H).toISOString(), corpusReleaseTag: TAG_A }));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const attemptFile = () => path.join(brain, 'auto-update.json');
const lockFile = () => path.join(brain, 'auto-update.lock');
const checkFile = () => path.join(brain, 'corpus-check.json');
const resultFile = () => path.join(brain, '.last-kb-check-result.json');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const fakeSpawn = () => {
  const calls = [];
  return { calls, fn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() {} }; } };
};
const run = (env = {}, spawnFn = fakeSpawn().fn, extra = {}) => {
  const emitted = [];
  const result = knowledgeAutoUpdate({ env: { HOME: home, ...env }, home, now: NOW, hookDir: HOOK_DIR,
    emit: (l) => emitted.push(l), spawnFn, ...extra });
  return { ...result, emitted };
};

describe('newer-published check — launch decision is identity-driven, never age-only', () => {
  it('a KB built 1h ago (fresh by age, proven by nothing newer) still launches ONE detached --if-newer check', () => {
    const s = fakeSpawn();
    expect(run({}, s.fn)).toMatchObject({ launched: true, mode: 'check' });
    expect(s.calls).toHaveLength(1);
    const { args, opts } = s.calls[0];
    expect(args.slice(4)).toEqual([path.join(HOOK_DIR, 'host-update.mjs'), '--knowledge', attemptFile(), lockFile(),
      '--if-newer', kb, checkFile(), resultFile()]);
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
    // A check is not an update attempt: the update throttle and the "launched, no outcome" alarm stay untouched.
    expect(fs.existsSync(attemptFile())).toBe(false);
    expect(readJson(checkFile())).toMatchObject({ outcome: 'checking', launchedAt: iso(0) });
    expect(fs.existsSync(lockFile())).toBe(true);
  });

  it('throttled per machine: a check 30 min ago blocks, 61 min ago does not; RUVNET_CORPUS_CHECK_MINUTES tunes it', () => {
    writeJson(checkFile(), { schemaVersion: 1, launchedAt: iso(30 * 60_000), outcome: 'current' });
    expect(run()).toMatchObject({ launched: false, why: 'fresh' });
    expect(run({ RUVNET_CORPUS_CHECK_MINUTES: '20' })).toMatchObject({ launched: true, mode: 'check' });
    fs.rmSync(lockFile());
    writeJson(checkFile(), { schemaVersion: 1, launchedAt: iso(61 * 60_000), outcome: 'current' });
    expect(run()).toMatchObject({ launched: true, mode: 'check' });
  });

  it('a FAILED update within 6h blocks the check (no hourly retry storm); a SUCCEEDED one does not', () => {
    writeJson(attemptFile(), { launchedAt: iso(H), outcome: 'failed', code: 1, reason: 'x', finishedAt: iso(H) });
    expect(run()).toMatchObject({ launched: false, why: 'throttled' });
    writeJson(attemptFile(), { launchedAt: iso(H), outcome: 'succeeded', code: 0, reason: '', finishedAt: iso(H), reported: true });
    expect(run()).toMatchObject({ launched: true, mode: 'check' });
  });

  it('a live lock (an update running) and the opt-outs block the check', () => {
    writeJson(lockFile(), { pid: 1, at: iso(60_000) });
    expect(run()).toMatchObject({ launched: false, why: 'locked' });
    fs.rmSync(lockFile());
    expect(run({ RUVNET_AUTO_UPDATE: 'off' })).toMatchObject({ launched: false, why: 'RUVNET_AUTO_UPDATE=off' });
    expect(run({ RUVNET_BRAIN_TEST: '1' })).toMatchObject({ launched: false, why: 'test mode' });
  });

  it('the MCP server timer (announce:false) never consumes the once-per-session UPDATED line', () => {
    writeJson(attemptFile(), { launchedAt: iso(2 * H), outcome: 'succeeded', code: 0, reason: '', finishedAt: iso(H) });
    writeJson(checkFile(), { schemaVersion: 1, launchedAt: iso(60_000), outcome: 'current' });
    expect(run({}, fakeSpawn().fn, { announce: false }).emitted).toEqual([]);
    expect(readJson(attemptFile()).reported).toBeUndefined();
    expect(run().emitted.join('\n')).toContain('UPDATED]');
  });
});

describe('newer-published check — the knowledge line and the doctor say it once, as advisory', () => {
  const pending = (extra = {}) => writeJson(checkFile(), { schemaVersion: 1, launchedAt: iso(5 * 60_000), checkedAt: iso(4 * 60_000),
    outcome: 'updating', verdict: 'UPDATE_AVAILABLE', candidateTag: TAG_B, ...extra });

  it('pending newer corpus → one KNOWLEDGE UPDATE PENDING line naming both identities; silent once installed', () => {
    pending();
    const text = knowledgeCurrency({ env: { HOME: home }, home, now: NOW });
    expect(text).toContain(`${KNOWLEDGE_LINE_PREFIX}UPDATE PENDING]`);
    expect(text).toContain('corpus-sha256-bbbbbbbbbbbb');
    expect(text).toContain('corpus-sha256-aaaaaaaaaaaa');
    writeJson(lockFile(), { pid: 1, at: iso(60_000) });
    expect(knowledgeCurrency({ env: { HOME: home }, home, now: NOW })).toContain('installing it now');
    fs.rmSync(lockFile());
    // Installed B: the recorded check is now history, not a pending update.
    fs.writeFileSync(path.join(kb, 'SOURCE.json'), JSON.stringify({ builtUtc: iso(0), corpusReleaseTag: TAG_B }));
    expect(knowledgeCurrency({ env: { HOME: home }, home, now: NOW })).toBe('');
  });

  it('a CURRENT or REFUSED (remote older) check is never reported as pending', () => {
    pending({ outcome: 'current', verdict: 'CURRENT' });
    expect(knowledgeCurrency({ env: { HOME: home }, home, now: NOW })).toBe('');
    pending({ outcome: 'refused', verdict: 'REFUSED' });
    expect(knowledgeCurrency({ env: { HOME: home }, home, now: NOW })).toBe('');
  });

  it('the doctor shows a pending newer corpus as an advisory ! on the Knowledge line, never a gate', () => {
    pending();
    const env = { HOME: home };
    const result = confirm({ footprint: inventoryFootprint({ env, home, now: NOW, measure: false }), env, home, now: NOW });
    const knowledge = result.lines.find((l) => l.id === 'knowledge');
    expect(knowledge.state).not.toBe('fail');
    expect(knowledge.detail).toContain('newer corpus corpus-sha256-bbbbbbbbbbbb');
    pending({ outcome: 'current', verdict: 'CURRENT' });
    const quiet = confirm({ footprint: inventoryFootprint({ env, home, now: NOW, measure: false }), env, home, now: NOW });
    expect(quiet.lines.find((l) => l.id === 'knowledge').detail).not.toContain('newer corpus');
  });
});

// The detached half, as a REAL process: host-update.mjs --knowledge ... --if-newer runs the INSTALLED
// kb/forge-update.mjs --check, and only a newer verdict reaches npx. The fake updater replays a recorded
// verdict (fake-check.json) exactly as forge-update.mjs prints and records it. The two cases that reach npx
// skip on win32 like their siblings in session-start-knowledge-auto-update.test.mjs: host-update.mjs spawns
// `npx.cmd` without a shell, which recent Node versions are documented to refuse (EINVAL) — NOT verified on Windows here.
describe('host-update --if-newer (real process, stub npx)', () => {
  let server; let probe;
  beforeAll(async () => {
    server = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end('{"version":"9.9.9"}'); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    probe = `http://127.0.0.1:${server.address().port}/ruvnet-brain/latest`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  const FAKE_UPDATER = `import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const f = JSON.parse(fs.readFileSync(path.join(dir, 'fake-check.json'), 'utf8'));
const at = process.argv.indexOf('--result-file');
console.log('canonical built:    ' + f.tag + ' (published 2026-10-02T00:40:00Z)');
if (f.exit === 2) { console.error('ERROR: network failure fetching x — nothing changed locally.'); process.exit(2); }
fs.writeFileSync(process.argv[at + 1], JSON.stringify({ kind: 'ruvnet-brain-check-result', recordedAt: new Date().toISOString(), currencyVerdict: f.verdict, candidateTag: f.tag }));
process.exit(f.exit);
`;
  const setup = (fake) => {
    fs.writeFileSync(path.join(kb, 'forge-update.mjs'), FAKE_UPDATER);
    writeJson(path.join(kb, 'fake-check.json'), fake);
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'npx'), '#!/bin/sh\necho "$@" >> "$HOME/npx-called"\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'npx.cmd'), '@echo %* >> "%HOME%\\npx-called"\r\n@exit /b 0\r\n');
    return bin;
  };
  const worker = (bin) => {
    writeJson(lockFile(), { pid: process.pid, at: new Date().toISOString() });
    // Async: the probe server lives in THIS process, so a spawnSync would starve it (a 5s false offline).
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(HOOK_DIR, 'host-update.mjs'), '--knowledge', attemptFile(), lockFile(),
        '--if-newer', kb, checkFile(), resultFile()], { stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RUVNET_AUTO_UPDATE_PROBE_URL: probe } });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.stdout.resume();
      child.on('close', (status) => resolve({ status, stderr }));
    });
  };
  const npxCalls = () => { try { return fs.readFileSync(path.join(home, 'npx-called'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };

  it('CURRENT: no update, outcome recorded, lock released', async () => {
    const r = await worker(setup({ exit: 0, verdict: 'CURRENT', tag: TAG_A }));
    expect(r.status, r.stderr).toBe(0);
    expect(npxCalls()).toEqual([]);
    expect(readJson(checkFile())).toMatchObject({ outcome: 'current', verdict: 'CURRENT', candidateTag: TAG_A });
    expect(fs.existsSync(lockFile())).toBe(false);
    expect(fs.existsSync(attemptFile())).toBe(false);
  });

  it('REFUSED (the published corpus is OLDER than the installed one): never downgrades', async () => {
    await worker(setup({ exit: 0, verdict: 'REFUSED', tag: TAG_B }));
    expect(npxCalls()).toEqual([]);
    expect(readJson(checkFile())).toMatchObject({ outcome: 'refused', verdict: 'REFUSED' });
  });

  it.skipIf(process.platform === 'win32')('decides by the recorded verdict, not the exit code: UPDATE_AVAILABLE with exit 0 (no profile stores) still updates', async () => {
    await worker(setup({ exit: 0, verdict: 'UPDATE_AVAILABLE', tag: 'v9.9.9' }));
    expect(npxCalls()).toHaveLength(1);
    expect(readJson(attemptFile())).toMatchObject({ outcome: 'succeeded', targetTag: 'v9.9.9' });
  });

  it('offline: recorded quietly, no update, no attempt failure', async () => {
    await worker(setup({ exit: 2, verdict: null, tag: TAG_B }));
    expect(npxCalls()).toEqual([]);
    expect(readJson(checkFile()).outcome).toBe('offline');
    expect(fs.existsSync(attemptFile())).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('UPDATE_AVAILABLE: runs the ONE existing updater once, records the target; the same target is not re-run within 6h', async () => {
    const bin = setup({ exit: 10, verdict: 'UPDATE_AVAILABLE', tag: TAG_B });
    await worker(bin);
    expect(npxCalls()).toEqual(['--yes ruvnet-brain@latest --update --no-nightly-prompt']);
    expect(readJson(attemptFile())).toMatchObject({ outcome: 'succeeded', trigger: 'newer-corpus-published', targetTag: TAG_B });
    expect(readJson(checkFile())).toMatchObject({ outcome: 'updating', verdict: 'UPDATE_AVAILABLE', candidateTag: TAG_B });
    expect(fs.existsSync(lockFile())).toBe(false);
    // The update "succeeded" but the published identity still differs (it did not converge): no download loop.
    await worker(bin);
    expect(npxCalls()).toHaveLength(1);
    expect(readJson(checkFile()).outcome).toBe('not-converged');
    // A DIFFERENT newer corpus is a new target and proceeds at once.
    writeJson(path.join(kb, 'fake-check.json'), { exit: 10, verdict: 'UPDATE_AVAILABLE', tag: `corpus-sha256-${'c'.repeat(64)}` });
    await worker(bin);
    expect(npxCalls()).toHaveLength(2);
  });
});
