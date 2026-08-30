// distill-project.test.mjs — the guards that make ONE capability genuinely offerable.
//
// WHY. ADR-047 (offer dormant capabilities unprompted) was rejected by both duelists because the
// honest launch surface was ZERO: five `turnOn` commands, no verified inverses. Its one claimed
// exception sourced its undo from a DIFFERENT executor than the action it offered — raw
// `ruflo memory distill run`, which (verified against --help) takes no backup at all.
//
// scripts/distill-project.mjs is the answer to that, and its value is entirely in its REFUSALS: it
// must not mutate a store when the undo cannot be created or located. These tests exercise the
// refusals, because a wrapper that only works on the happy path adds nothing over the raw command.
//
// The happy path was proven by hand against the real store on 2026-07-24: 644 -> 648 patterns (+4),
// restore -> 644, re-run -> 648, five durable receipts. That needs a live ruflo and a real DB, so it
// is not reproduced here; what IS reproduced is every way the wrapper is supposed to say no.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(import.meta.dirname, '../../scripts/distill-project.mjs');

let tmp;
afterEach(() => { if (tmp) { fs.rmSync(tmp, { recursive: true, force: true }); tmp = null; } });

function sandbox() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-proj-'));
  fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
  return tmp;
}

/** Run the wrapper with an isolated project and a controllable fake `ruflo` on disk. */
function run(args, { rufloBody = null, env = {} } = {}) {
  const dir = tmp || sandbox();
  let ruflo = '/nonexistent/ruflo';
  if (rufloBody) {
    if (process.platform === 'win32') {
      // No shebang execution on Windows: keep the POSIX body as-is and shim it through the
      // Git Bash the windows CI job already relies on (product spawns via shell:true there).
      const sh = path.join(dir, 'fake-ruflo.sh');
      fs.writeFileSync(sh, rufloBody);
      ruflo = path.join(dir, 'fake-ruflo.cmd');
      fs.writeFileSync(ruflo, `@bash "${sh}" %*\r\n`);
    } else {
      ruflo = path.join(dir, 'fake-ruflo');
      fs.writeFileSync(ruflo, rufloBody, { mode: 0o755 });
    }
  }
  return spawnSync(process.execPath, [SCRIPT, '--project', dir, ...args], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, RUFLO_BIN: ruflo, ...env },
  });
}

describe('distill-project — it must refuse rather than mutate without an undo', () => {
  it('refuses when ruflo is absent — never silently skips the real tool', () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, '.swarm/memory.db'), 'x');
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ruflo is not at/);
  });

  it('refuses when the project has no memory store — nothing to distill is not an error to paper over', () => {
    sandbox();
    const r = run([], { rufloBody: '#!/bin/sh\nexit 0\n' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no memory store/);
  });

  it('REFUSES when the baseline cannot be read — a delta from an unknown baseline is a fabricated number', () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, '.swarm/memory.db'), 'x');
    // `distill status` fails ⇒ no baseline ⇒ must abort BEFORE any snapshot or mutation.
    const r = run([], { rufloBody: '#!/bin/sh\nif [ "$2" = "distill" ]; then exit 3; fi\nexit 0\n' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/cannot read distill status|refusing to run/i);
  });

  it('REFUSES to distill when the snapshot fails — this is the whole point of the wrapper', () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, '.swarm/memory.db'), 'x');
    // status succeeds with parseable counts; `memory backup` fails ⇒ no undo ⇒ must not distill.
    const body = '#!/bin/sh\n'
      + 'case "$2" in\n'
      + '  distill) echo "reasoning_patterns | 10"; echo "episodes | 5"; exit 0;;\n'
      + '  backup)  echo "snapshot exploded" >&2; exit 1;;\n'
      + 'esac\nexit 0\n';
    const r = run([], { rufloBody: body });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/REFUSING TO DISTILL/);
    expect(r.stderr).toMatch(/snapshot failed/i);
  });

  it('REFUSES when backup reports success but no snapshot file exists — success is not the same as an undo you can find', () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, '.swarm/memory.db'), 'x');
    const body = '#!/bin/sh\n'
      + 'case "$2" in\n'
      + '  distill) echo "reasoning_patterns | 10"; echo "episodes | 5"; exit 0;;\n'
      + '  backup)  exit 0;;\n'   // claims success, writes nothing
      + 'esac\nexit 0\n';
    const r = run([], { rufloBody: body });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no snapshot file is present|undo cannot be located/i);
  });

  it('REFUSES when backup reports success but only a STALE snapshot from a prior run is present — a leftover file is not evidence of THIS backup', () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, '.swarm/memory.db'), 'x');
    const backups = path.join(dir, '.swarm/backups');
    fs.mkdirSync(backups, { recursive: true });
    const stale = path.join(backups, 'memory-stale.db');
    fs.writeFileSync(stale, 'STALE');
    // Backdate it well outside the mtime-truncation grace window so it cannot be mistaken for a
    // write that happened during this run.
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);

    const body = '#!/bin/sh\n'
      + 'case "$2" in\n'
      + '  distill) echo "reasoning_patterns | 10"; echo "episodes | 5"; exit 0;;\n'
      + '  backup)  exit 0;;\n'   // claims success, writes NOTHING new into the backups dir
      + 'esac\nexit 0\n';
    const r = run([], { rufloBody: body });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/REFUSING TO DISTILL/);
    expect(r.stderr).toMatch(/undo cannot be located/i);
  });

  it('--dry-run takes no snapshot and writes no receipt', () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, '.swarm/memory.db'), 'x');
    const body = '#!/bin/sh\n'
      + 'case "$2" in\n'
      + '  distill) echo "reasoning_patterns | 10"; echo "episodes | 5"; exit 0;;\n'
      + 'esac\nexit 0\n';
    const r = run(['--dry-run'], { rufloBody: body });
    expect(r.stdout).toMatch(/dry-run/i);
    expect(fs.existsSync(path.join(dir, '.swarm/backups')), 'dry-run must not create a backups dir').toBe(false);
  });

  it('--restore refuses when there is no snapshot to restore from', () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, '.swarm/memory.db'), 'x');
    const r = run(['--restore'], { rufloBody: '#!/bin/sh\nexit 0\n' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no snapshot to restore from/i);
  });

  it('--restore snapshots the CURRENT state first — an undo that destroys what it replaces is not reversible', () => {
    const dir = sandbox();
    const db = path.join(dir, '.swarm/memory.db');
    const backups = path.join(dir, '.swarm/backups');
    fs.mkdirSync(backups, { recursive: true });
    fs.writeFileSync(db, 'CURRENT');
    const snap = path.join(backups, 'memory-2026-01-01T00-00-00-000Z.db');
    fs.writeFileSync(snap, 'OLDER');

    const r = run(['--restore', snap], { rufloBody: '#!/bin/sh\nexit 0\n' });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(db, 'utf8'), 'the snapshot must actually land').toBe('OLDER');
    const pre = fs.readdirSync(backups).filter((f) => f.startsWith('pre-restore-'));
    expect(pre.length, 'restoring must leave a way back to what was replaced').toBe(1);
    expect(fs.readFileSync(path.join(backups, pre[0]), 'utf8')).toBe('CURRENT');
  });
});
