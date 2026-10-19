// update-apply.test.mjs — the Stable Spine engine (ADR-023). Every test runs the REAL
// scripts/update-apply.mjs as a subprocess against a temp RUVNET_BRAIN_HOME — no mocks of the
// engine itself. Windows-safe by design (no symlinks anywhere), so no win32 skip.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'update-apply.mjs');

let HOME_DIR;
const run = (...args) => spawnSync(process.execPath, [ENGINE, ...args], {
  encoding: 'utf8',
  env: { ...process.env, RUVNET_BRAIN_HOME: HOME_DIR, CLAUDE_PLUGIN_ROOT: '' },
});
const active = () => { try { return JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'active.json'), 'utf8')); } catch { return null; } };

/** A minimal valid plugin payload: scripts/ with one good sh + one good mjs, parseable hooks.json. */
function makePayload(version, { badScript = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spine-payload-${version}-`));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'ok.sh'), '#!/bin/bash\necho ok\n');
  fs.writeFileSync(path.join(dir, 'scripts', 'ok.mjs'), 'console.log("ok");\n');
  // The broken fixture is a .mjs, not a .sh: node --check gates on EVERY platform, so the
  // gate-refusal test proves refusal on Windows too (bash -n only runs where /bin/bash exists).
  if (badScript) fs.writeFileSync(path.join(dir, 'scripts', 'broken.mjs'), 'const = broken syntax here(\n');
  fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), '{"hooks":{}}\n');
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ruvnet-brain', version }));
  return dir;
}

beforeEach(() => { HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-home-')); });
afterEach(() => { fs.rmSync(HOME_DIR, { recursive: true, force: true }); });

describe('update-apply.mjs — the single writer of the spine', () => {
  it('--from-dir gates, promotes, and flips: active.json points at an immutable versions/<v> copy', () => {
    const payload = makePayload('9.9.1-test');
    const r = run('--from-dir', payload);
    expect(r.status).toBe(0);
    const a = active();
    expect(a.version).toBe('9.9.1-test');
    expect(a.generation).toBe(1);
    // codeRoot resolves under versions/ and carries the payload
    const root = path.join(HOME_DIR, a.codeRoot);
    expect(fs.existsSync(path.join(root, 'scripts', 'ok.sh'))).toBe(true);
    // the flip IS the update: txn records the completed state
    const txn = JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'update-txn.json'), 'utf8'));
    expect(txn.state).toBe('active');
    fs.rmSync(payload, { recursive: true, force: true });
  });

  it('a candidate that fails the gate NEVER flips — spine untouched, failure named', () => {
    const good = makePayload('9.9.1-test');
    run('--from-dir', good);
    const before = active();
    const bad = makePayload('9.9.2-test', { badScript: true });
    const r = run('--from-dir', bad);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/FAILED the gate/);
    expect(r.stderr + r.stdout).toMatch(/broken\.mjs/); // the failure is NAMED, not generic
    expect(active().version).toBe(before.version);     // old world intact
    fs.rmSync(good, { recursive: true, force: true }); fs.rmSync(bad, { recursive: true, force: true });
  });

  it('rejects a payload version that escapes versions/ before deleting or copying anything', () => {
    const payload = makePayload('9.9.1-test');
    const escapedName = `escaped-${process.pid}-${Date.now()}`;
    const hostileVersion = `../../${escapedName}`;
    fs.writeFileSync(
      path.join(payload, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'ruvnet-brain', version: hostileVersion }),
    );
    const escaped = path.resolve(HOME_DIR, '..', escapedName);
    const r = run('--from-dir', payload);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/unsafe payload version|escapes versions/);
    expect(fs.existsSync(escaped)).toBe(false);
    expect(active()).toBe(null);
    fs.rmSync(payload, { recursive: true, force: true });
  });

  it('rejects payload symlinks instead of copying files from outside the payload', (ctx) => {
    if (process.platform === 'win32') return ctx.skip();
    const payload = makePayload('9.9.1-test');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-outside-'));
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'must-not-enter-generation');
    fs.symlinkSync(secret, path.join(payload, 'scripts', 'outside-link.txt'));
    const r = run('--from-dir', payload);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/payload contains a symbolic link/);
    expect(active()).toBe(null);
    expect(fs.existsSync(path.join(HOME_DIR, 'versions', '9.9.1-test', 'scripts', 'outside-link.txt'))).toBe(false);
    fs.rmSync(payload, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('--rollback is an instant flip to previous — generation increments, old payload still on disk', () => {
    const p1 = makePayload('9.9.1-test'); const p2 = makePayload('9.9.2-test');
    run('--from-dir', p1); run('--from-dir', p2);
    expect(active().version).toBe('9.9.2-test');
    const r = run('--rollback');
    expect(r.status).toBe(0);
    const a = active();
    expect(a.version).toBe('9.9.1-test');
    expect(a.generation).toBe(3); // rollback is a NEW generation, not a rewind
    expect(fs.existsSync(path.join(HOME_DIR, a.codeRoot))).toBe(true);
    fs.rmSync(p1, { recursive: true, force: true }); fs.rmSync(p2, { recursive: true, force: true });
  });

  it('concurrency: a held lock makes a second run no-op cleanly (never a corrupted spine)', () => {
    // Hold the lock the way a live engine would: lock dir + owner.json with OUR living pid.
    fs.mkdirSync(path.join(HOME_DIR, '.update.lock'), { recursive: true });
    fs.writeFileSync(path.join(HOME_DIR, '.update.lock', 'owner.json'), JSON.stringify({ pid: process.pid }));
    const payload = makePayload('9.9.1-test');
    const r = run('--from-dir', payload);
    expect(r.stdout).toMatch(/another update is in progress/);
    expect(active()).toBe(null); // nothing was written
    fs.rmSync(payload, { recursive: true, force: true });
  });

  it('a STALE lock (dead pid) is reclaimed — the engine never wedges forever', () => {
    fs.mkdirSync(path.join(HOME_DIR, '.update.lock'), { recursive: true });
    fs.writeFileSync(path.join(HOME_DIR, '.update.lock', 'owner.json'), JSON.stringify({ pid: 99999999 }));
    const payload = makePayload('9.9.1-test');
    const r = run('--from-dir', payload);
    expect(r.status).toBe(0);
    expect(active().version).toBe('9.9.1-test');
    fs.rmSync(payload, { recursive: true, force: true });
  });

  it('GC keeps active + previous + leased; collects the rest', () => {
    const p1 = makePayload('9.9.1-test'); const p2 = makePayload('9.9.2-test'); const p3 = makePayload('9.9.3-test');
    run('--from-dir', p1); run('--from-dir', p2);
    // lease 9.9.1 the way the MCP server would (fresh mtime)
    fs.mkdirSync(path.join(HOME_DIR, 'leases'), { recursive: true });
    fs.writeFileSync(path.join(HOME_DIR, 'leases', 'mcp-test.json'), JSON.stringify({ version: '9.9.1-test' }));
    run('--from-dir', p3); // now: active=9.9.3, previous=9.9.2, leased=9.9.1 — all three must survive
    const kept = fs.readdirSync(path.join(HOME_DIR, 'versions'));
    expect(kept).toContain('9.9.3-test');
    expect(kept).toContain('9.9.2-test');
    expect(kept).toContain('9.9.1-test'); // ONLY because of the lease
    [p1, p2, p3].forEach((p) => fs.rmSync(p, { recursive: true, force: true }));
  });

  it('dev mode: --auto refuses to flip away from a checkout (finding 24)', () => {
    const checkout = makePayload('dev-checkout');
    const r1 = run('--dev', checkout);
    expect(r1.status).toBe(0);
    const r2 = run('--auto');
    expect(r2.stdout).toMatch(/dev mode is ON/);
    expect(active()).toBe(null); // --auto wrote nothing
    run('--dev-off');
    expect(fs.existsSync(path.join(HOME_DIR, 'dev.json'))).toBe(false);
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  it('every flip leaves a receipt in the append-only ledger', () => {
    const payload = makePayload('9.9.1-test');
    run('--from-dir', payload);
    const lines = fs.readFileSync(path.join(HOME_DIR, 'update-receipts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.some((e) => e.event === 'CandidateGated' && e.passed === true)).toBe(true);
    expect(lines.some((e) => e.event === 'SpineFlipped' && e.to === '9.9.1-test')).toBe(true);
    fs.rmSync(payload, { recursive: true, force: true });
  });

  it('crash recovery: a dangling staging dir from a dead run is cleaned, world stays old', () => {
    const p1 = makePayload('9.9.1-test');
    run('--from-dir', p1);
    // simulate a crash mid-stage: leftover staging dir + a non-terminal txn
    fs.mkdirSync(path.join(HOME_DIR, 'versions', '9.9.9-test.staging-424242'), { recursive: true });
    fs.writeFileSync(path.join(HOME_DIR, 'update-txn.json'), JSON.stringify({ state: 'staging', to: '9.9.9-test' }));
    const r = run('--doctor'); // doctor takes no lock; use a real locked run to trigger recovery:
    const p2 = makePayload('9.9.2-test');
    run('--from-dir', p2);
    expect(fs.readdirSync(path.join(HOME_DIR, 'versions')).some((d) => d.includes('.staging-424242'))).toBe(false);
    expect(active().version).toBe('9.9.2-test');
    expect(r.status).toBe(0);
    fs.rmSync(p1, { recursive: true, force: true }); fs.rmSync(p2, { recursive: true, force: true });
  });

  // #420 item 6: --help / unknown flags used to fall through to the default action (lock + apply).
  const snapshot = (root) => {
    const out = {};
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { out[path.relative(root, f) + '/'] = 'dir'; walk(f); } else out[path.relative(root, f)] = fs.readFileSync(f, 'utf8'); } };
    walk(root); return out;
  };
  const runScratch = (home, ...args) => spawnSync(process.execPath, [ENGINE, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, RUVNET_BRAIN_HOME: path.join(home, 'brain'), CLAUDE_PLUGIN_ROOT: '' } });

  it.each(['--help', '-h'])('%s prints usage, exits 0, and leaves a populated scratch home byte-identical (no lock, no new files)', (flag) => {
    const brain = path.join(HOME_DIR, 'brain'); fs.mkdirSync(brain, { recursive: true });
    fs.writeFileSync(path.join(brain, 'active.json'), '{"version":"1.0.0","generation":1}\n');
    const before = snapshot(HOME_DIR);
    const r = runScratch(HOME_DIR, flag);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^usage: node update-apply\.mjs/);
    for (const f of ['--auto', '--seed', '--from-dir', '--rollback', '--dev-off', '--doctor', '--gc', '--no-gc', '--expected-version']) expect(r.stdout).toContain(f);
    expect(snapshot(HOME_DIR)).toEqual(before);
    expect(fs.existsSync(path.join(brain, '.update.lock'))).toBe(false);
  });

  it('--help on a scratch home that does not exist yet does not create it', () => {
    const r = runScratch(HOME_DIR, '--help');
    expect(r.status).toBe(0);
    expect(fs.readdirSync(HOME_DIR)).toEqual([]);
  });

  it('an unknown flag prints usage to stderr, exits nonzero, and touches nothing', () => {
    const r = runScratch(HOME_DIR, '--frobnicate');
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('--frobnicate');
    expect(r.stderr).toContain('usage: node update-apply.mjs');
    expect(fs.readdirSync(HOME_DIR)).toEqual([]);
  });
});
