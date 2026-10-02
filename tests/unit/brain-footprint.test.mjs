// tests/unit/brain-footprint.test.mjs — the footprint guarantee (ADR-0098): classification, the safety
// rules a sweep must never break, and BREAK-IT mutants proving each safety assertion goes red when its
// guard is removed. Every test runs in a temp HOME; nothing here touches the real ~/.cache, ~/.claude,
// ~/.codex or ~/.npm (npm_config_cache is set OUTSIDE the temp HOME on purpose: it must be ignored).
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { FOOTPRINT_POLICY, inventoryFootprint, kbCopyPrefixes, sweepFootprint, footprintRoots } from '../../plugin/scripts/brain-footprint.mjs';
// (kbCopyProof is imported below; the S7 tests also spy on it through sweepFootprint's proveCopy seam.)
import { kbCopyProof } from '../../plugin/scripts/kb-copy-proof.mjs';
import { confirm, doctorVerdict, footprintAlarm, formatConfirmation, writeSignatureRecord } from '../../plugin/scripts/brain-confirmation.mjs';
import { footprintCheck } from '../../plugin/scripts/session-start-update-plane.mjs';
import { managedStorageInventory } from '../../kb/update-storage-transaction.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
const json = (file, value) => write(file, `${JSON.stringify(value, null, 2)}\n`);
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const old = (p, days) => { const t = new Date(NOW - days * 86_400_000); fs.utimesSync(p, t, t); };

/**
 * A KB tree shaped like an installed release: public stores and metadata (all listed, with their bytes, in
 * the tree's own ARCHIVE-MANIFEST.json, as scripts/build-bundle.mjs writes it), plus private stores — fenced
 * in PRIVATE-STORES.json and updateManaged:false by default (the owner's real shape), or only fenced
 * (`fenceOnly`), or only unmanaged (`unmanagedOnly`). Private files are never in the manifest.
 */
function kbTree(dir, { publicStores = {}, privateStores = {}, fenceOnly = [], unmanagedOnly = [], extra = {}, coverage = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const stores = {}; const generations = {}; const shippedFiles = ['forge-mcp-all.mjs', 'SOURCE.json', 'RVF-GENERATIONS.json', 'PRIVATE-STORES.json', 'COVERAGE.json'];
  for (const [name, body] of Object.entries(publicStores)) {
    write(path.join(dir, `${name}.big.rvf`), body);
    write(path.join(dir, `${name}.meta.json`), `{"store":"${name}"}`);
    stores[name] = { kbName: name, updateManaged: true };
    generations[name] = { file: `${name}.big.rvf` };
    shippedFiles.push(`${name}.big.rvf`, `${name}.meta.json`);
  }
  for (const [name, body] of Object.entries(privateStores)) {
    write(path.join(dir, `${name}.big.rvf`), body);
    write(path.join(dir, `${name}.passages.jsonl`), `${body}-passages`);
    stores[name] = { kbName: name, updateManaged: fenceOnly.includes(name) };
    generations[name] = { file: `${name}.big.rvf` };
  }
  write(path.join(dir, 'forge-mcp-all.mjs'), '// search\n');
  json(path.join(dir, 'SOURCE.json'), { builtUtc: new Date(NOW - 3_600_000).toISOString(), stores });
  json(path.join(dir, 'RVF-GENERATIONS.json'), { stores: generations });
  json(path.join(dir, 'PRIVATE-STORES.json'), { privateStores: Object.keys(privateStores).filter((n) => !unmanagedOnly.includes(n)) });
  json(path.join(dir, 'COVERAGE.json'), coverage || { rows: Object.keys(publicStores).map((name) => ({ kind: 'repository', name, artifact: { store: name } })) });
  json(path.join(dir, 'ARCHIVE-MANIFEST.json'), { files: shippedFiles.map((f) => {
    const bytes = fs.readFileSync(path.join(dir, f));
    return { path: f, sha256: sha(bytes), bytes: bytes.length };
  }) });
  for (const [file, body] of Object.entries(extra)) write(path.join(dir, file), body);
  return dir;
}

function machine() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'footprint-home-')));
  dirs.push(home);
  const brainHome = path.join(home, '.cache', 'ruvnet-brain');
  const kbDir = path.join(brainHome, 'kb');
  const outsideCache = fs.mkdtempSync(path.join(os.tmpdir(), 'footprint-real-npm-'));
  dirs.push(outsideCache);
  const env = { HOME: home, RUVNET_BRAIN_HOME: brainHome, RUVNET_BRAIN_KB: kbDir, CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), npm_config_cache: outsideCache };
  return { home, brainHome, kbDir, env, outsideCache };
}
const live = (m, extra = {}) => kbTree(m.kbDir, { publicStores: { alpha: 'alpha-v3' }, privateStores: { secret: 'secret-bytes' }, ...extra });
const opts = (m, more = {}) => ({ env: m.env, home: m.home, now: NOW, selfPath: '/nonexistent', ...more });
const item = (fp, p) => fp.items.find((i) => i.path === p);

describe('kbCopyProof: a KB copy is disposable only when nothing in it is unique', () => {
  it('an older public generation whose private files are byte-identical in live is disposable', () => {
    const m = machine(); live(m);
    const copy = kbTree(path.join(m.brainHome, 'kb.bak-1'), { publicStores: { alpha: 'alpha-v1', retired: 'gone' }, privateStores: { secret: 'secret-bytes' },
      coverage: { rows: [{ name: 'alpha' }, { name: 'retired' }] } });
    expect(kbCopyProof({ copyDir: copy, liveDir: m.kbDir })).toMatchObject({ disposable: true, unique: [] });
  });
  it('a private file that differs from (or is absent in) live KEEPS the copy and is named', () => {
    const m = machine(); live(m);
    const differs = kbTree(path.join(m.brainHome, 'kb.bak-2'), { publicStores: { alpha: 'alpha-v1' }, privateStores: { secret: 'OLDER-secret' } });
    const proof = kbCopyProof({ copyDir: differs, liveDir: m.kbDir });
    expect(proof.disposable).toBe(false);
    expect(proof.unique.map((u) => u.file)).toEqual(expect.arrayContaining(['secret.big.rvf', 'secret.passages.jsonl']));
    const only = kbTree(path.join(m.brainHome, 'kb.bak-3'), { publicStores: { alpha: 'alpha-v1' }, privateStores: { journal: 'only-here' } });
    expect(kbCopyProof({ copyDir: only, liveDir: m.kbDir }).unique.map((u) => u.file)).toContain('journal.big.rvf');
  });
  it('the fence of the COPY counts even when live no longer fences the name', () => {
    const m = machine(); kbTree(m.kbDir, { publicStores: { alpha: 'a' }, privateStores: {} });
    const copy = kbTree(path.join(m.brainHome, 'kb.bak-4'), { publicStores: { alpha: 'a0' }, privateStores: { diary: 'd' }, fenceOnly: ['diary'] });
    expect(kbCopyProof({ copyDir: copy, liveDir: m.kbDir }).disposable).toBe(false);
  });
  it('an updateManaged:false store that is not fenced is still private', () => {
    const m = machine(); kbTree(m.kbDir, { publicStores: { alpha: 'a' } });
    const copy = kbTree(path.join(m.brainHome, 'kb.bak-5'), { publicStores: { alpha: 'a0' }, privateStores: { ingest: 'x' }, unmanagedOnly: ['ingest'] });
    const proof = kbCopyProof({ copyDir: copy, liveDir: m.kbDir });
    expect(proof.disposable).toBe(false);
    expect(proof.unique.map((u) => u.file)).toContain('ingest.big.rvf');
  });
  it('a user file the release never shipped keeps the copy; an unfenced store with no public provenance too', () => {
    const m = machine(); live(m);
    const a = kbTree(path.join(m.brainHome, 'kb.bak-6'), { publicStores: { alpha: 'a1' }, privateStores: { secret: 'secret-bytes' }, extra: { 'notes/personal.txt': 'mine' } });
    expect(kbCopyProof({ copyDir: a, liveDir: m.kbDir }).unique.map((u) => u.file)).toEqual([path.join('notes', 'personal.txt')]);
    const b = kbTree(path.join(m.brainHome, 'kb.bak-7'), { publicStores: { alpha: 'a1' }, privateStores: { secret: 'secret-bytes' }, extra: { 'homegrown.big.rvf': 'v' } });
    expect(kbCopyProof({ copyDir: b, liveDir: m.kbDir }).unique.map((u) => u.file)).toEqual(['homegrown.big.rvf']);
  });
  it('never removes a copy while the live brain is missing (the copy may be the only good one)', () => {
    const m = machine();
    const copy = kbTree(path.join(m.brainHome, 'kb.install-prior-1'), { publicStores: { alpha: 'a' } });
    expect(kbCopyProof({ copyDir: copy, liveDir: m.kbDir })).toMatchObject({ disposable: false });
  });
  it('a link inside a copy is compared, never followed; a link the live brain lacks keeps the copy', () => {
    const m = machine(); live(m);
    const outside = path.join(m.home, 'outside.txt'); write(outside, 'external');
    const copy = kbTree(path.join(m.brainHome, 'kb.bak-8'), { publicStores: { alpha: 'a1' }, privateStores: { secret: 'secret-bytes' } });
    fs.symlinkSync(outside, path.join(copy, 'link-out'));
    expect(kbCopyProof({ copyDir: copy, liveDir: m.kbDir }).unique.map((u) => u.file)).toEqual(['link-out']);
  });
});

describe('inventory: everything the Brain owns is classified', () => {
  function messy() {
    const m = machine(); live(m);
    kbTree(path.join(m.brainHome, 'kb.bak-2026-09-04'), { publicStores: { alpha: 'alpha-v1' }, privateStores: { secret: 'secret-bytes' } });
    kbTree(path.join(m.brainHome, 'kb.install-preserved-4vYVmt'), { publicStores: { alpha: 'alpha-v2' }, privateStores: { secret: 'secret-OLD' } });
    kbTree(path.join(m.brainHome, 'kb.pre-update-20260930'), { publicStores: { alpha: 'alpha-v2' }, privateStores: { secret: 'secret-bytes' } });
    const q = path.join(m.home, '.cache', 'ruvnet-brain-quarantine-20260916');
    kbTree(path.join(q, 'kb.bak-2026-09-01'), { publicStores: { alpha: 'alpha-v0' }, privateStores: { secret: 'secret-bytes' } });
    kbTree(path.join(q, 'kb.install-preserved-pPgP8t'), { publicStores: { alpha: 'alpha-v0' }, privateStores: { journal: 'unique' } });
    // an in-progress transaction (latest receipt LOCKED) owns kb.next-77
    kbTree(path.join(m.brainHome, 'kb.next-77'), { publicStores: { alpha: 'cand' } });
    json(path.join(m.brainHome, '.kb.update-transactions', '77', '001-LOCKED.json'), { state: 'LOCKED' });
    const stage = path.join(m.brainHome, '.kb.install-stage-abc'); fs.mkdirSync(stage); old(stage, 1);
    fs.mkdirSync(path.join(m.brainHome, '.forge-x-candidate-q1'));
    write(path.join(m.brainHome, 'evidence.jsonl'), 'x'.repeat(FOOTPRINT_POLICY.logCapBytes + 10));
    write(path.join(m.brainHome, 'token-ledger.jsonl'), '{"ok":1}\n');
    write(path.join(m.brainHome, '.last-kb-check.log'), `${'y'.repeat(FOOTPRINT_POLICY.textLogCapBytes)}\ntail-line\n`);
    for (const [hash, v] of [['a1', '4.3.39'], ['b2', '4.3.40'], ['c3', '4.9.9']]) {
      json(path.join(m.home, '.npm', '_npx', hash, 'package.json'), { _npx: { packages: [`ruvnet-brain@${v}`] } });
      json(path.join(m.home, '.npm', '_npx', hash, 'node_modules', 'ruvnet-brain', 'package.json'), { version: v });
      old(path.join(m.home, '.npm', '_npx', hash), 3);
    }
    json(path.join(m.home, '.npm', '_npx', 'dev', 'package.json'), { _npx: { packages: ['/Users/x/Code/ruvnet-brain'] } });
    json(path.join(m.home, '.npm', '_npx', 'dev', 'node_modules', 'ruvnet-brain', 'package.json'), { version: '4.3.28' });
    json(path.join(m.home, '.npm', '_npx', 'other', 'package.json'), { _npx: { packages: ['cowsay@1'] } });
    json(path.join(m.outsideCache, '_npx', 'real', 'package.json'), { _npx: { packages: ['ruvnet-brain@1.0.0'] } });
    json(path.join(m.outsideCache, '_npx', 'real', 'node_modules', 'ruvnet-brain', 'package.json'), { version: '1.0.0' });
    const scratch = path.join(m.brainHome, 'ruflo-cwd', 'p1');
    write(path.join(scratch, '.swarm', 'hnsw.metadata.json'), '{}');
    fs.mkdirSync(path.join(scratch, 'run-old')); old(path.join(scratch, 'run-old'), 1);
    fs.mkdirSync(path.join(scratch, 'run-live'));
    json(path.join(m.brainHome, 'leases', 'mcp-dead.json'), { pid: 2 ** 30, version: '4.2.7' }); old(path.join(m.brainHome, 'leases', 'mcp-dead.json'), 1);
    json(path.join(m.brainHome, 'leases', 'mcp-me.json'), { pid: process.pid, version: '4.2.7' }); old(path.join(m.brainHome, 'leases', 'mcp-me.json'), 1);
    write(path.join(m.brainHome, 'ruvector-mcp', 'ruvector.db'), 'their data');
    write(path.join(m.brainHome, 'open-issues.json.bak-20260808'), '[]'); old(path.join(m.brainHome, 'open-issues.json.bak-20260808'), 30);
    write(path.join(m.brainHome, 'console-instances.dead-20260930', 'x.json'), '{}');
    return { m, q };
  }

  it('classifies the measured 2026-10-01 machine: copies, quarantine, stage, logs, npx, scratch, leases, foreign data', () => {
    const { m, q } = messy();
    const fp = inventoryFootprint(opts(m));
    const cls = (p) => item(fp, p)?.class;
    expect(cls(m.kbDir)).toBe('must-exist');
    for (const n of ['kb.bak-2026-09-04', 'kb.install-preserved-4vYVmt', 'kb.pre-update-20260930']) expect(cls(path.join(m.brainHome, n))).toBe('must-not-exist');
    expect(item(fp, q)).toMatchObject({ class: 'must-not-exist', kind: 'quarantine', copies: 2 });
    expect(item(fp, path.join(m.brainHome, 'kb.next-77'))).toMatchObject({ class: 'may-exist', kind: 'transaction-candidate', action: 'keep' });
    expect(fp.kbCopies).toBe(1 + 3 + 1 + 2);
    expect(cls(path.join(m.brainHome, '.kb.install-stage-abc'))).toBe('must-not-exist');
    expect(cls(path.join(m.brainHome, '.forge-x-candidate-q1'))).toBe('must-not-exist');
    expect(item(fp, path.join(m.brainHome, 'evidence.jsonl'))).toMatchObject({ class: 'must-not-exist', action: 'rotate' });
    expect(item(fp, path.join(m.brainHome, 'token-ledger.jsonl'))).toMatchObject({ class: 'may-exist', action: 'keep' });
    expect(item(fp, path.join(m.brainHome, '.last-kb-check.log'))).toMatchObject({ action: 'truncate' });
    const npx = fp.items.filter((i) => i.kind === 'npx-copy');
    expect(npx.map((i) => [i.version, i.class]).sort()).toEqual([['4.3.39', 'must-not-exist'], ['4.3.40', 'must-not-exist'], ['4.9.9', 'may-exist']]);
    expect(fp.items.some((i) => i.path.startsWith(m.outsideCache))).toBe(false); // npm_config_cache outside HOME ignored
    expect(item(fp, path.join(m.home, '.npm', '_npx', 'dev'))).toMatchObject({ class: 'unowned', action: 'report' });
    expect(item(fp, path.join(m.home, '.npm', '_npx', 'other'))).toBeUndefined();
    expect(cls(path.join(m.brainHome, 'ruflo-cwd', 'p1', '.swarm'))).toBe('must-not-exist');
    expect(cls(path.join(m.brainHome, 'ruflo-cwd', 'p1', 'run-old'))).toBe('must-not-exist');
    expect(item(fp, path.join(m.brainHome, 'ruflo-cwd', 'p1', 'run-live'))).toBeUndefined();
    expect(cls(path.join(m.brainHome, 'leases', 'mcp-dead.json'))).toBe('must-not-exist');
    expect(item(fp, path.join(m.brainHome, 'leases', 'mcp-me.json'))).toBeUndefined(); // old mtime, live pid
    expect(item(fp, path.join(m.brainHome, 'ruvector-mcp'))).toMatchObject({ class: 'unowned', action: 'report' });
    // Hand-made backups: the Brain never wrote these names, so they are REPORTED, never removed (ADR-098).
    expect(item(fp, path.join(m.brainHome, 'open-issues.json.bak-20260808'))).toMatchObject({ class: 'unowned', action: 'report' });
    expect(item(fp, path.join(m.brainHome, 'console-instances.dead-20260930'))).toMatchObject({ class: 'unowned', action: 'report' });
  });

  it('sweep removes exactly what the proof allows, keeps private-unique copies by name, and is idempotent', () => {
    const { m, q } = messy();
    const result = sweepFootprint(opts(m, { apply: true }));
    const gone = (p) => !fs.existsSync(p);
    for (const n of ['kb.bak-2026-09-04', 'kb.pre-update-20260930', '.kb.install-stage-abc', '.forge-x-candidate-q1']) expect(gone(path.join(m.brainHome, n))).toBe(true);
    expect(gone(path.join(m.brainHome, 'kb.install-preserved-4vYVmt'))).toBe(false); // private differs
    expect(result.kept.find((k) => k.path.endsWith('kb.install-preserved-4vYVmt')).unique.map((u) => u.file)).toContain('secret.big.rvf');
    expect(gone(path.join(q, 'kb.bak-2026-09-01'))).toBe(true);
    expect(gone(path.join(q, 'kb.install-preserved-pPgP8t'))).toBe(false); // journal is unique
    expect(fs.existsSync(path.join(m.brainHome, 'kb.next-77'))).toBe(true); // in-progress transaction
    expect(fs.existsSync(path.join(m.brainHome, 'evidence.jsonl.1'))).toBe(true);
    expect(fs.readFileSync(path.join(m.brainHome, '.last-kb-check.log'), 'utf8')).toMatch(/tail-line\n$/);
    expect(fs.statSync(path.join(m.brainHome, '.last-kb-check.log')).size).toBeLessThanOrEqual(FOOTPRINT_POLICY.textLogCapBytes);
    expect(gone(path.join(m.home, '.npm', '_npx', 'a1')) && gone(path.join(m.home, '.npm', '_npx', 'b2'))).toBe(true);
    expect(fs.existsSync(path.join(m.home, '.npm', '_npx', 'c3'))).toBe(true);
    expect(fs.existsSync(path.join(m.outsideCache, '_npx', 'real'))).toBe(true);
    expect(fs.existsSync(path.join(m.brainHome, 'leases', 'mcp-me.json'))).toBe(true);
    expect(gone(path.join(m.brainHome, 'leases', 'mcp-dead.json'))).toBe(true);
    expect(fs.readFileSync(path.join(m.brainHome, 'ruvector-mcp', 'ruvector.db'), 'utf8')).toBe('their data');
    expect(fs.readFileSync(path.join(m.kbDir, 'secret.big.rvf'), 'utf8')).toBe('secret-bytes'); // live never touched
    expect(result.after.kbCopies).toBe(1 + 1 + 1 + 1); // live + kept preserved + in-progress next + quarantined unique
    const again = sweepFootprint(opts(m, { apply: true }));
    expect(again.removed).toEqual([]);
  });

  it('a hand-made backup (.bak-/.retired-/.dead-/bootstrap-backup-) is reported and NEVER deleted, however old or small', () => {
    const m = machine(); live(m);
    const planted = {
      'open-issues.json.bak-20260808': 'file', 'settings.json.retired-20260901': 'file', 'console-instances.dead-20260930': 'dir',
      'bootstrap-backup-20260901': 'dir', 'notes.bak-20250101': 'file',
    };
    for (const [name, kind] of Object.entries(planted)) {
      const p = path.join(m.brainHome, name);
      if (kind === 'dir') write(path.join(p, 'x.json'), '{"mine":true}'); else write(p, 'mine');
      old(p, 400); // far past any age limit
    }
    const result = sweepFootprint(opts(m, { apply: true }));
    for (const name of Object.keys(planted)) {
      expect(fs.existsSync(path.join(m.brainHome, name)), `${name} was deleted`).toBe(true);
      expect(item(result.before, path.join(m.brainHome, name))).toMatchObject({ class: 'unowned', action: 'report' });
    }
    expect(result.removed.filter((r) => Object.keys(planted).includes(path.basename(r.path)))).toEqual([]);
    // Reported, not counted as Brain cruft: a user's own file cannot make "No cruft" fail or name --clean.
    expect(result.after.cruft.filter((i) => Object.keys(planted).includes(path.basename(i.path)))).toEqual([]);
    expect(result.after.unowned.map((i) => path.basename(i.path))).toEqual(expect.arrayContaining(Object.keys(planted)));
  });

  it('never enters or removes a symlinked KB-copy name, and removing a copy never follows a link inside it', () => {
    const m = machine(); live(m);
    const target = path.join(m.home, 'elsewhere'); write(path.join(target, 'precious.txt'), 'keep me');
    fs.symlinkSync(target, path.join(m.brainHome, 'kb.bak-link'));
    const copy = kbTree(path.join(m.brainHome, 'kb.bak-9'), { publicStores: { alpha: 'a1' }, privateStores: { secret: 'secret-bytes' } });
    fs.symlinkSync(target, path.join(m.kbDir, 'node_modules'));            // same link in live …
    fs.symlinkSync(target, path.join(copy, 'node_modules'));               // … so the copy is disposable
    const result = sweepFootprint(opts(m, { apply: true }));
    expect(fs.lstatSync(path.join(m.brainHome, 'kb.bak-link')).isSymbolicLink()).toBe(true);
    expect(item(result.before, path.join(m.brainHome, 'kb.bak-link'))).toMatchObject({ class: 'unowned', action: 'report' });
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.readFileSync(path.join(target, 'precious.txt'), 'utf8')).toBe('keep me');
  });

  it('a refresh lock held by someone else freezes every KB sibling; the holder may proceed', () => {
    const m = machine(); live(m);
    kbTree(path.join(m.brainHome, 'kb.bak-1'), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'secret-bytes' } });
    write(path.join(m.brainHome, '.kb.refresh-run.lock'), '{}');
    sweepFootprint(opts(m, { apply: true }));
    expect(fs.existsSync(path.join(m.brainHome, 'kb.bak-1'))).toBe(true);
    sweepFootprint(opts(m, { apply: true, holdingRefreshLock: true }));
    expect(fs.existsSync(path.join(m.brainHome, 'kb.bak-1'))).toBe(false);
  });

  // Review S6: a plain `npx ruvnet-brain` install holds no refresh lock, so the detached SessionStart sweep
  // could run between the installer's two activation renames and delete kb.install-prior-* (the rollback
  // copy) — after which the installer's next rename fails and its rollback cannot restore anything.
  it('an install mid-activation freezes every KB sibling and the npx copies (marker, young stage, or a live install-prior pid)', () => {
    const npxCopy = (m, hash, v, days = 3) => {
      json(path.join(m.home, '.npm', '_npx', hash, 'package.json'), { _npx: { packages: [`ruvnet-brain@${v}`] } });
      json(path.join(m.home, '.npm', '_npx', hash, 'node_modules', 'ruvnet-brain', 'package.json'), { version: v });
      old(path.join(m.home, '.npm', '_npx', hash), days);
    };
    const scenarios = {
      marker: (m) => json(path.join(m.brainHome, '.kb.install-activation.lock'), { pid: process.pid, at: Date.now() }),
      stage: (m) => fs.mkdirSync(path.join(m.brainHome, '.kb.install-stage-young')), // mtime: now
      prior: () => {},
    };
    for (const [name, plant] of Object.entries(scenarios)) {
      const m = machine(); live(m);
      // The window between the renames: the NEW live KB is in place and the prior generation is beside it,
      // named by the installer's pid. Its contents are disposable, so only the in-progress guard keeps it.
      const prior = kbTree(path.join(m.brainHome, `kb.install-prior-${Date.now()}-${process.pid}`), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'secret-bytes' } });
      const bak = kbTree(path.join(m.brainHome, 'kb.bak-1'), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'secret-bytes' } });
      npxCopy(m, 'old', '4.3.1'); npxCopy(m, 'new', '7.7.0');
      plant(m);
      const result = sweepFootprint(opts(m, { apply: true, now: Date.now() }));
      expect(fs.existsSync(prior), `${name}: install-prior removed mid-activation`).toBe(true);
      if (name !== 'prior') {
        expect(fs.existsSync(bak), `${name}: a KB sibling was touched while an install activates`).toBe(true);
        expect(fs.existsSync(path.join(m.home, '.npm', '_npx', 'old')), `${name}: an npx copy was removed during an install`).toBe(true);
        expect(result.kept.some((k) => /an install is activating/.test(k.reason))).toBe(true);
      }
    }
  });

  // Re-review S5: a marker left by a crashed install whose pid was later reused (or a pid owned by another
  // user: kill(pid, 0) → EPERM, read as alive) froze the sweep forever. Proof of life is bounded by time.
  it('an activation marker or install-prior older than 2 h no longer freezes the sweep, whatever its pid says', () => {
    const cases = [
      ['marker, my pid, 3 h old', (m, now) => json(path.join(m.brainHome, '.kb.install-activation.lock'), { pid: process.pid, at: now - 3 * 3_600_000 }), false],
      ['marker, another user\'s pid (EPERM), 3 h old', (m, now) => json(path.join(m.brainHome, '.kb.install-activation.lock'), { pid: 1, at: now - 3 * 3_600_000 }), false],
      ['marker, another user\'s pid (EPERM), fresh', (m, now) => json(path.join(m.brainHome, '.kb.install-activation.lock'), { pid: 1, at: now }), true],
      // Re-review a6 NIT: a FUTURE 'at' (clock skew, a corrupt marker) gave a negative age that read as young forever.
      ['marker, EPERM pid, dated 3 h in the FUTURE', (m, now) => json(path.join(m.brainHome, '.kb.install-activation.lock'), { pid: 1, at: now + 3 * 3_600_000 }), false],
      ['install-prior named 3 h in the FUTURE with my pid', (m, now) => kbTree(path.join(m.brainHome, `kb.install-prior-${now + 3 * 3_600_000}-${process.pid}`), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'secret-bytes' } }), false],
      ['install-prior named 3 h ago with my pid', (m, now) => kbTree(path.join(m.brainHome, `kb.install-prior-${now - 3 * 3_600_000}-${process.pid}`), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'secret-bytes' } }), false],
    ];
    for (const [label, plant, blocks] of cases) {
      const m = machine(); live(m);
      const now = Date.now();
      const bak = kbTree(path.join(m.brainHome, 'kb.bak-1'), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'secret-bytes' } });
      plant(m, now);
      sweepFootprint(opts(m, { apply: true, now }));
      expect(fs.existsSync(bak), `${label}: ${blocks ? 'must still block' : 'must not block any more'}`).toBe(blocks);
    }
  });

  it('a finished activation (dead installer pid) leaves kb.install-prior-* to the normal proof; a recent npx copy is kept', () => {
    const m = machine(); live(m);
    const prior = kbTree(path.join(m.brainHome, `kb.install-prior-${NOW}-${2 ** 30}`), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'secret-bytes' } });
    json(path.join(m.brainHome, '.kb.install-activation.lock'), { pid: 2 ** 30, at: NOW - 3_600_000 }); // its process is gone
    for (const [hash, v, days] of [['older-recent', '4.3.1', 0], ['older-stale', '4.3.2', 3], ['newest', '7.7.0', 3]]) {
      json(path.join(m.home, '.npm', '_npx', hash, 'package.json'), { _npx: { packages: [`ruvnet-brain@${v}`] } });
      json(path.join(m.home, '.npm', '_npx', hash, 'node_modules', 'ruvnet-brain', 'package.json'), { version: v });
      if (days) old(path.join(m.home, '.npm', '_npx', hash), days);
    }
    sweepFootprint(opts(m, { apply: true, now: Date.now() }));
    expect(fs.existsSync(prior)).toBe(false);
    expect(fs.existsSync(path.join(m.home, '.npm', '_npx', 'older-stale'))).toBe(false);
    expect(fs.existsSync(path.join(m.home, '.npm', '_npx', 'older-recent'))).toBe(true); // may be running right now
    expect(fs.existsSync(path.join(m.home, '.npm', '_npx', 'newest'))).toBe(true);
  });

  it('Stable Spine generations: active, previous and live-leased are kept; an unreferenced one is reported for the update GC', () => {
    const m = machine(); live(m);
    json(path.join(m.brainHome, 'active.json'), { version: '7.7.0', codeRoot: 'versions/7.7.0', previous: { codeRoot: 'versions/4.2.7' } });
    for (const v of ['4.3.0', '4.3.9', '4.2.7', '7.7.0']) json(path.join(m.brainHome, 'versions', v, 'x.json'), {});
    json(path.join(m.brainHome, 'leases', 'mcp-me.json'), { pid: process.pid, version: '4.3.9' });
    old(path.join(m.brainHome, 'leases', 'mcp-me.json'), 1); // older than 6h, but its process is alive
    const fp = inventoryFootprint(opts(m));
    const at = (v) => item(fp, path.join(m.brainHome, 'versions', v));
    expect(at('7.7.0')).toMatchObject({ class: 'must-exist', action: 'keep' });
    expect(at('4.2.7')).toMatchObject({ class: 'may-exist', action: 'keep' });
    expect(at('4.3.9')).toMatchObject({ class: 'may-exist', action: 'keep' });
    expect(at('4.3.0')).toMatchObject({ class: 'must-not-exist', action: 'report', fix: 'npx ruvnet-brain@latest --update' });
    sweepFootprint(opts(m, { apply: true }));
    expect(fs.existsSync(path.join(m.brainHome, 'versions', '4.3.0'))).toBe(true); // the spine's own GC owns removal
  });

  it('plugin generations are only ever handed to the lease-aware collector, with the CLAUDE_CONFIG_DIR registry', () => {
    const m = machine(); live(m);
    const cache = path.join(m.home, '.claude', 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain');
    for (const v of ['4.3.37', '4.2.9']) json(path.join(cache, v, '.claude-plugin', 'plugin.json'), { version: v });
    write(path.join(cache, '4.3.37', '.in_use', 'lease-1.json'), '{}');
    json(path.join(m.home, '.claude', 'plugins', 'installed_plugins.json'), { plugins: { 'ruvnet-brain@ruvnet-brain': [{ installPath: path.join(cache, '4.2.9') }] } });
    const fp = inventoryFootprint(opts(m));
    expect(item(fp, path.join(cache, '4.2.9'))).toMatchObject({ class: 'must-exist' });
    expect(item(fp, path.join(cache, '4.3.37'))).toMatchObject({ class: 'may-exist', action: 'collect' });
    const calls = [];
    sweepFootprint(opts(m, { apply: true, collectPluginGenerations: (args) => { calls.push(args); return { removed: [] }; } }));
    expect(calls).toEqual([{ registryPath: path.join(m.home, '.claude', 'plugins', 'installed_plugins.json'), apply: true }]);
    expect(fs.existsSync(path.join(cache, '4.3.37'))).toBe(true); // the sweep itself never removes a generation
  });

  it('every KB-copy name the storage transaction or the updater knows is classified here (parity)', () => {
    const m = machine(); live(m);
    for (const n of ['kb.next-1', 'kb.rollback-2', 'kb.failed-3', 'kb.bak-4', 'kb.install-preserved-5', 'kb.install-prior-6']) {
      kbTree(path.join(m.brainHome, n), { publicStores: { alpha: 'z' } });
    }
    const managed = managedStorageInventory(m.kbDir).fullCorpusCopies.filter((c) => c.kind !== 'active').map((c) => c.path);
    const fp = inventoryFootprint(opts(m));
    for (const p of managed) expect(item(fp, p)?.class, p).toBe('must-not-exist');
    const updater = fs.readFileSync(path.join(ROOT, 'kb', 'forge-update.mjs'), 'utf8');
    const block = /const prefixes = \[([\s\S]*?)\];/.exec(updater)[1];
    const prefixes = [...block.matchAll(/`\$\{base\}([^`]+)`/g)].map((x) => `kb${x[1]}`);
    expect(prefixes.length).toBeGreaterThan(3);
    for (const p of prefixes) expect(kbCopyPrefixes('kb')).toContain(p);
  });
});

// Re-review S4: a DRY RUN wrote — sweepFootprint({ apply:false }) proved copies and cached the KEPT ones into
// .footprint-proof-cache.json, and --doctor runs exactly that dry run. A read-only check must change nothing.
const treeState = (dir) => {
  const out = {};
  const walk = (d) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); const st = fs.lstatSync(p);
    if (st.isDirectory()) walk(p); else out[path.relative(dir, p)] = `${st.size}:${st.mtimeMs}:${sha(fs.readFileSync(p))}`; } };
  walk(dir);
  return out;
};
describe('a dry run writes nothing (re-review S4)', () => {
  it('sweepFootprint({ apply:false }) leaves the brain home byte-identical, even with a copy it must keep', () => {
    const m = machine(); live(m);
    kbTree(path.join(m.brainHome, 'kb.bak-2'), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'OLDER-secret' } });
    const before = treeState(m.brainHome);
    sweepFootprint(opts(m, { apply: false, now: Date.now() }));
    expect(treeState(m.brainHome)).toEqual(before);
  });
  it('the real `--doctor` leaves the brain home byte-identical', async () => {
    const { completeBrain } = await import('../helpers/doctor-brain-fixture.mjs');
    const b = completeBrain({ modelsReady: true });
    try {
      // A copy the sweep would have to KEEP (its private store differs from live) beside the live KB.
      kbTree(path.join(b.parent, 'kb.bak-7'), { publicStores: { alpha: 'a0' }, privateStores: { journal: 'only-here' } });
      const before = treeState(b.brainHome);
      const r = b.doctor();
      expect(r.status, r.text.slice(-1500)).toBe(1); // the second KB copy is a structural ✗
      expect(treeState(b.brainHome)).toEqual(before);
    } finally { b.cleanup(); }
  }, 120_000);
});

describe('positive confirmation', () => {
  function clean() {
    const m = machine(); live(m);
    json(path.join(m.brainHome, 'active.json'), { version: '7.7.0', codeRoot: 'versions/7.7.0' });
    json(path.join(m.brainHome, 'versions', '7.7.0', 'x.json'), {});
    write(path.join(m.brainHome, '.last-version-check.log'), '7.7.0\n');
    writeSignatureRecord({ brainHome: m.brainHome, kbDir: m.kbDir, bundleSha256: 'a'.repeat(64), source: 'update', now: NOW });
    write(path.join(m.brainHome, 'token-ledger.jsonl'), `${JSON.stringify({ ts: new Date(NOW - 7_200_000).toISOString(), source: 'mcp', tool: 'search_ruvnet', bytes: 9 })}\n`);
    return m;
  }
  const run = (m, more = {}) => confirm({ footprint: inventoryFootprint(opts(m)), env: m.env, home: m.home, now: NOW,
    readiness: [{ pid: 42, state: 'ready', kbDir: m.kbDir }], ...more });

  it('green on a clean, current, signed, in-use machine', () => {
    const m = clean();
    const r = run(m);
    expect(r.lines.filter((l) => l.state === 'fail')).toEqual([]);
    expect(r.lines.find((l) => l.id === 'in-use')).toMatchObject({ state: 'ok', detail: expect.stringMatching(/opened this copy; last answer 2h ago/) });
    expect(r.lines.find((l) => l.id === 'knowledge').detail).toMatch(/^1 copy at .*\/kb · built .* · signature verified/);
    expect(footprintAlarm(r)).toBe('');
  });
  it('each failure names its one fix: behind, second copy, stale, unsigned, other-copy worker, cruft', () => {
    const m = clean();
    kbTree(path.join(m.brainHome, 'kb.bak-1'), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'secret-bytes' } });
    write(path.join(m.kbDir, 'COVERAGE.json'), '{"rows":[]}'); // bytes changed since the verified install
    const r = run(m, { npmLatest: { version: '7.8.0', checkedAt: NOW }, now: NOW + 3 * 86_400_000,
      readiness: [{ pid: 42, state: 'ready', kbDir: path.join(m.brainHome, 'kb.bak-1') }] });
    const by = Object.fromEntries(r.lines.map((l) => [l.id, l]));
    expect(by.software).toMatchObject({ state: 'warn', fix: 'npx ruvnet-brain@latest --update' }); // currency advises
    expect(by.knowledge.state).toBe('fail');
    expect(by.knowledge.detail).toMatch(/2 copies on disk.*signature record does not match.*built 3d ago/); // structural first, then currency
    expect(by.knowledge.fix).toBe('npx ruvnet-brain --clean');
    expect(by['in-use']).toMatchObject({ state: 'fail' });
    expect(by.cruft).toMatchObject({ state: 'fail', fix: 'npx ruvnet-brain --clean' });
    expect(footprintAlarm(r)).toMatch(/^\[RuvNet Brain — FOOTPRINT NOT CLEAN\] 2 knowledge-base copies/);
    expect(r.ok).toBe(false);
  });

  // Review S5 + the owner's ruling: ONE verdict, and currency only ADVISES. A correctly installed older build
  // (a recovery re-run, a quiet week with no new corpus) must stay green for install verification.
  it('currency is advisory: a 72h-old KB, a host plugin one version behind and a newer npm give ! lines and exit 0', () => {
    const m = clean();
    const cache = path.join(m.home, '.claude', 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain');
    json(path.join(cache, '7.6.9', '.claude-plugin', 'plugin.json'), { version: '7.6.9' });
    json(path.join(m.home, '.claude', 'plugins', 'installed_plugins.json'), { plugins: { 'ruvnet-brain@ruvnet-brain': [{ installPath: path.join(cache, '7.6.9') }] } });
    const r = run(m, { now: NOW + 72 * 3_600_000, npmLatest: { version: '7.7.1', checkedAt: NOW } });
    const by = Object.fromEntries(r.lines.map((l) => [l.id, l]));
    expect(by.knowledge).toMatchObject({ state: 'warn', fix: 'npx ruvnet-brain@latest --update' });
    expect(by.knowledge.detail).toMatch(/built 3d ago \(limit 48h\)/);
    expect(by.hosts).toMatchObject({ state: 'warn', detail: expect.stringMatching(/Claude Code 7\.6\.9 ≠ runtime 7\.7\.0/) });
    expect(by.software).toMatchObject({ state: 'warn' });
    expect(r.ok).toBe(true);
    const verdict = doctorVerdict(r, [{ id: 'grounding', label: 'Grounding', state: 'ok', detail: 'proven' }]);
    expect(verdict).toMatchObject({ ok: true, exitCode: 0, failing: [], advisories: expect.arrayContaining(['knowledge', 'hosts', 'software']) });
    const text = formatConfirmation(r);
    expect(text).toMatch(/^ {4}! Knowledge/m);
    expect(text).toMatch(/Green — 3 advisory line\(s\) marked ! do not block/);
    expect(text).not.toMatch(/Not green/);
  });

  // 4.5.1 ruling: a MISSING signature record is provenance UNKNOWN, not a provable defect — the release's own
  // install verification (a local sealed artifact) and the automatic updater never write one. It advises (!).
  // A record that is PRESENT but does not match the live bytes (or cannot be read) is provable: it gates (✗).
  it('signature record: missing → ! (exit 0); present but not matching the live bytes, or unreadable → ✗ (exit 1); valid → ✓', () => {
    const valid = run(clean());
    expect(valid.lines.find((l) => l.id === 'knowledge')).toMatchObject({ state: 'ok', detail: expect.stringMatching(/signature verified/) });

    const missing = clean();
    fs.rmSync(path.join(missing.brainHome, 'knowledge-signature.json'));
    const r = run(missing);
    expect(r.lines.find((l) => l.id === 'knowledge')).toMatchObject({ state: 'warn', fix: 'npx ruvnet-brain@latest --update',
      detail: expect.stringMatching(/installed or updated without a recorded signature verification/) });
    expect(doctorVerdict(r, [])).toMatchObject({ ok: true, exitCode: 0, failing: [], advisories: ['knowledge'] });

    const tampered = clean();
    const recordFile = path.join(tampered.brainHome, 'knowledge-signature.json');
    json(recordFile, { ...JSON.parse(fs.readFileSync(recordFile, 'utf8')), coverageSha256: 'f'.repeat(64) });
    const t = run(tampered);
    expect(t.lines.find((l) => l.id === 'knowledge')).toMatchObject({ state: 'fail', detail: expect.stringMatching(/signature record does not match the live COVERAGE\.json/) });
    expect(doctorVerdict(t, [])).toMatchObject({ ok: false, exitCode: 1, failing: ['knowledge'] });
    expect(formatConfirmation(doctorVerdict(t, []))).toMatch(/Not green/);

    const unreadable = clean();
    write(path.join(unreadable.brainHome, 'knowledge-signature.json'), '{ not json');
    expect(run(unreadable).lines.find((l) => l.id === 'knowledge')).toMatchObject({ state: 'fail', detail: expect.stringMatching(/signature record is unreadable/) });
  });

  it('a failing doctor check fails the ONE verdict', () => {
    const green = run(clean());
    expect(doctorVerdict(green, [{ id: 'grounding', label: 'Grounding', state: 'fail', detail: 'not proven', fix: 'npx ruvnet-brain' }]))
      .toMatchObject({ ok: false, exitCode: 1, failing: ['grounding'] });
  });
});

// An interrupted `--move-brain` (scripts/move-brain.mjs) leaves full Brain copies and links under names the
// inventory never looked at, so Knowledge said "1 copy" beside three. They are REPORTED (never removed), each
// with what it is and the exact next step, and only when their pid is dead (a live move is not flagged).
const q = (p) => `'${String(p).replace(/'/g, `'\\''`)}'`;

// Re-review a6 BLOCKER: the advised commands were `rm -rf ${path}` with the path UNQUOTED, so a volume named
// 'Backup 1' (macOS names a second same-named drive that way) made the pasted command `rm -rf /…/Backup …` —
// another drive wiped. Every emitted command is now quoted and EXECUTED here by the real shell, beside a
// sibling 'Backup' with a sentinel that must survive.
describe.skipIf(process.platform === 'win32')('advised commands are safe to paste (re-review a6 blocker)', () => {
  const DEAD = 2 ** 30;
  const linkedBrain = (volumeName) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'footprint-quote-')));
    dirs.push(root);
    write(path.join(root, 'Backup', 'SENTINEL'), 'another drive');
    const disk = path.join(root, volumeName, 'ruvnet-brain');
    kbTree(path.join(disk, 'kb'), { publicStores: { alpha: 'a' }, privateStores: { secret: 's' } });
    fs.mkdirSync(path.join(root, 'home', '.cache'), { recursive: true });
    fs.symlinkSync(disk, path.join(root, 'home', '.cache', 'ruvnet-brain'));
    const staging = path.join(root, volumeName, `.ruvnet-brain.moving-${DEAD}`);
    write(path.join(staging, 'kb', 'SOURCE.json'), '{}');
    return { root, disk, staging, env: { HOME: path.join(root, 'home') }, home: path.join(root, 'home') };
  };
  for (const volumeName of ['Backup 1', "it's Backup", 'Backup $HOME', 'Backup `id`', 'Backup;rm -rf x']) {
    it(`the staging-copy delete for a volume named ${JSON.stringify(volumeName)} removes ONLY that copy`, () => {
      const b = linkedBrain(volumeName);
      const it_ = inventoryFootprint({ env: b.env, home: b.home, now: Date.now() }).items.find((i) => i.path === b.staging);
      expect(it_.fix).toBe(`rm -rf -- ${q(b.staging)}`);
      expect(spawnSync('sh', ['-n', '-c', it_.fix]).status).toBe(0);
      const r = spawnSync('sh', ['-c', it_.fix], { cwd: b.root, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(fs.existsSync(b.staging)).toBe(false);
      expect(fs.readFileSync(path.join(b.root, 'Backup', 'SENTINEL'), 'utf8')).toBe('another drive');
      expect(fs.existsSync(path.join(b.disk, 'kb', 'SOURCE.json'))).toBe(true);
    });
  }
  it('a path with a control character (a newline in the volume name) gets NO command, only "inspect it"', () => {
    const b = linkedBrain('Backup\nX');
    const it_ = inventoryFootprint({ env: b.env, home: b.home, now: Date.now() }).items.find((i) => i.path === b.staging);
    expect(it_.fix).toMatch(/^inspect it by hand: /);
    expect(it_.fix).not.toMatch(/rm |mv /);
  });
  it('on Windows the commands are cmd syntax with quoted paths; a path with a double quote gets none', async () => {
    const { assessMoveLeftovers } = await import('../../plugin/scripts/footprint-io.mjs');
    const b = linkedBrain('Backup 1');
    const loc = { state: 'linked', real: b.disk, path: path.join(b.home, '.cache', 'ruvnet-brain') };
    const [s] = assessMoveLeftovers({ brainHome: loc.path, location: loc, isAlive: () => false, platform: 'win32' });
    expect(s.fix).toBe(`rmdir /s /q "${b.staging}"`);
    const dq = linkedBrain('Backup "1"');
    const dqLoc = { state: 'linked', real: dq.disk, path: path.join(dq.home, '.cache', 'ruvnet-brain') };
    const [t] = assessMoveLeftovers({ brainHome: dqLoc.path, location: dqLoc, isAlive: () => false, platform: 'win32' });
    expect(t.fix).toMatch(/^inspect it by hand: /);
  });
});

// Re-review a6 SHOULD-FIX 1: with the Brain's own path MISSING, every leftover is assessed; one that holds or
// points at a Brain is RESTORED there (never rm, never "install"), and the restore really works.
describe.skipIf(process.platform === 'win32')('the Brain path missing: restore from the leftover that holds it', () => {
  const DEAD = 2 ** 30;
  const setup = () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'footprint-restore-')));
    dirs.push(root);
    const other = path.join(root, 'Other Disk', 'ruvnet-brain');
    kbTree(path.join(other, 'kb'), { publicStores: { alpha: 'a' }, privateStores: { secret: 'private-bytes' } });
    const cache = path.join(root, 'home', '.cache'); fs.mkdirSync(cache, { recursive: true });
    return { root, other, cache, brainHome: path.join(cache, 'ruvnet-brain'), env: { HOME: path.join(root, 'home') }, home: path.join(root, 'home') };
  };
  const leftovers = (b) => inventoryFootprint({ env: b.env, home: b.home, now: Date.now() }).items.filter((i) => i.kind === 'move-leftover');
  it('an interrupted --back: link-old points at the real Brain, a staging copy sits beside — restore the link, rm nothing', () => {
    const b = setup();
    const linkOld = `${b.brainHome}.link-old-${DEAD}`; fs.symlinkSync(b.other, linkOld);
    const staging = path.join(b.cache, `.ruvnet-brain.moving-${DEAD}`); kbTree(path.join(staging, 'kb'), { publicStores: { alpha: 'a' } });
    const items = leftovers(b);
    const restore = items.find((i) => i.onlyCopy);
    expect(restore.path).toBe(linkOld);
    expect(restore.fix).toBe(`mv -- ${q(linkOld)} ${q(b.brainHome)}`);
    for (const i of items) expect(i.fix).not.toMatch(/\brm /);
    const r = confirm({ footprint: inventoryFootprint({ env: b.env, home: b.home, now: Date.now() }), env: b.env, home: b.home, now: Date.now(), readiness: [] });
    expect(r.lines.find((l) => l.id === 'knowledge').fix).toBe(restore.fix);
    expect(spawnSync('sh', ['-c', restore.fix]).status).toBe(0);
    expect(fs.realpathSync(b.brainHome)).toBe(b.other); // the private Brain is back where every reader looks
  });
  for (const what of ['link', 'old', 'moving']) {
    it(`a ${what} leftover holding the Brain is the restore candidate`, () => {
      const b = setup();
      const p = what === 'moving' ? path.join(b.cache, `.ruvnet-brain.moving-${DEAD}`) : `${b.brainHome}.${what}-${DEAD}`;
      if (what === 'link') fs.symlinkSync(b.other, p); else kbTree(path.join(p, 'kb'), { publicStores: { alpha: 'a' } });
      const [only] = leftovers(b);
      expect(only).toMatchObject({ path: p, onlyCopy: true, fix: `mv -- ${q(p)} ${q(b.brainHome)}` });
    });
  }
  it('a link-N whose target is gone is not a restore candidate', () => {
    const b = setup();
    fs.symlinkSync(path.join(b.root, 'Gone Disk', 'ruvnet-brain'), `${b.brainHome}.link-${DEAD}`);
    expect(leftovers(b)[0].onlyCopy).toBe(false);
  });
});

describe('interrupted --move-brain leftovers are reported, never removed', () => {
  const DEAD = 2 ** 30;
  const brainCopy = (dir) => kbTree(path.join(dir, 'kb'), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'secret-bytes' } });
  it('a set-aside original, a staging copy and leftover links (dead pid) each get a line with the next step; a live move is not flagged', () => {
    const m = machine(); live(m);
    const cache = path.dirname(m.brainHome);
    const old = path.join(cache, `ruvnet-brain.old-${DEAD}`); brainCopy(old);
    const staging = path.join(cache, `.ruvnet-brain.moving-${DEAD}`); brainCopy(staging);
    const link = path.join(cache, `ruvnet-brain.link-${DEAD}`); fs.symlinkSync(m.brainHome, link);
    const linkOld = path.join(cache, `ruvnet-brain.link-old-${DEAD}`); fs.symlinkSync(m.brainHome, linkOld);
    const liveMove = path.join(cache, `ruvnet-brain.old-${process.pid}`); brainCopy(liveMove); // a move running now
    const fp = inventoryFootprint(opts(m, { now: Date.now() }));
    const leftovers = fp.items.filter((i) => i.kind === 'move-leftover');
    expect(leftovers.map((i) => i.path).sort()).toEqual([old, staging, link, linkOld].sort());
    for (const i of leftovers) expect(i).toMatchObject({ class: 'unowned', action: 'report' });
    expect(item(fp, old).fix).toBe(`rm -rf -- ${q(old)}`);
    expect(item(fp, staging).fix).toBe(`rm -rf -- ${q(staging)}`);
    expect(item(fp, link).fix).toBe(`rm -- ${q(link)}`);
    expect(fp.kbCopies).toBe(1);
    const r = confirm({ footprint: fp, env: m.env, home: m.home, now: Date.now(), readiness: [] });
    const move = r.lines.filter((l) => l.id === 'move-leftover');
    expect(move).toHaveLength(4);
    for (const l of move) expect(l.state).toBe('warn');
    expect(r.lines.find((l) => l.id === 'knowledge').detail).toMatch(/not counted: 2 interrupted-move copies \(/);
    const swept = sweepFootprint(opts(m, { apply: true, now: Date.now() }));
    for (const p of [old, staging, link, linkOld, liveMove]) expect(fs.existsSync(p) || fs.lstatSync(p, { throwIfNoEntry: false }), p).toBeTruthy();
    expect(swept.removed.map((x) => x.path)).not.toEqual(expect.arrayContaining([old]));
  });

  it('with the Brain MISSING, the set-aside original is the only copy: ✗ with the exact mv back', () => {
    const m = machine(); fs.mkdirSync(path.dirname(m.brainHome), { recursive: true });
    const old = path.join(path.dirname(m.brainHome), `ruvnet-brain.old-${DEAD}`); brainCopy(old);
    const fp = inventoryFootprint(opts(m, { now: Date.now() }));
    expect(item(fp, old)).toMatchObject({ kind: 'move-leftover', onlyCopy: true, fix: `mv -- ${q(old)} ${q(m.brainHome)}` });
    const r = confirm({ footprint: fp, env: m.env, home: m.home, now: Date.now(), readiness: [] });
    expect(r.lines.find((l) => l.id === 'move-leftover')).toMatchObject({ state: 'fail', fix: `mv -- ${q(old)} ${q(m.brainHome)}` });
    expect(r.lines.find((l) => l.id === 'knowledge').fix).toBe(`mv -- ${q(old)} ${q(m.brainHome)}`);
    expect(r.ok).toBe(false);
  });

  it('a home Brain\'s own ._* / .DS_Store stay ignored: not counted, not removed', () => {
    const m = machine(); live(m);
    for (const p of [path.join(m.brainHome, '._kb'), path.join(m.brainHome, '.DS_Store'), path.join(m.kbDir, '._SOURCE.json')]) write(p, 'meta');
    const fp = inventoryFootprint(opts(m, { now: Date.now() }));
    expect(fp.items.filter((i) => /(^|\/)\._|\.DS_Store/.test(i.path))).toEqual([]);
    sweepFootprint(opts(m, { apply: true, now: Date.now() }));
    for (const p of [path.join(m.brainHome, '._kb'), path.join(m.brainHome, '.DS_Store'), path.join(m.kbDir, '._SOURCE.json')]) expect(fs.existsSync(p), p).toBe(true);
  });
});

describe('a brain moved to another volume (--move-brain: ~/.cache/ruvnet-brain is a link)', () => {
  it('a staging copy left on the TARGET disk by an interrupted move is found next to the linked Brain', () => {
    const m = moved();
    const staging = path.join(path.dirname(m.disk), `.ruvnet-brain.moving-${2 ** 30}`);
    kbTree(path.join(staging, 'kb'), { publicStores: { alpha: 'a0' }, privateStores: { secret: 's' } });
    const fp = inventoryFootprint({ env: m.env, home: m.home, now: Date.now() });
    expect(item(fp, staging)).toMatchObject({ kind: 'move-leftover', action: 'report', fix: `rm -rf -- ${q(staging)}` });
  });
  function moved() {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'footprint-moved-')));
    dirs.push(home);
    const disk = path.join(home, 'Volumes', 'SanDisk', 'ruvnet-brain');
    fs.mkdirSync(disk, { recursive: true });
    fs.mkdirSync(path.join(home, '.cache'), { recursive: true });
    fs.symlinkSync(disk, path.join(home, '.cache', 'ruvnet-brain'));
    kbTree(path.join(disk, 'kb'), { publicStores: { alpha: 'a' }, privateStores: { secret: 's' } });
    return { home, disk, env: { HOME: home }, link: path.join(home, '.cache', 'ruvnet-brain') };
  }
  it('counts the real KB once, reports its real location, and finds quarantines beside the spelled home', () => {
    const m = moved();
    kbTree(path.join(m.home, '.cache', 'ruvnet-brain-quarantine-1', 'kb.bak-x'), { publicStores: { alpha: 'old' }, privateStores: { secret: 's' } });
    const fp = inventoryFootprint({ env: m.env, home: m.home, now: NOW });
    expect(fp.kbCopies).toBe(2);
    expect(fp.liveKb.path).toBe(path.join(m.disk, 'kb'));
    expect(fp.roots.location).toMatchObject({ state: 'linked', real: m.disk }); // plugin/scripts/brain-location.mjs
    expect(fp.roots.kbDir).toBe(path.join(m.disk, 'kb'));
    const r = confirm({ footprint: fp, env: m.env, home: m.home, now: NOW, readiness: [] });
    expect(r.lines.find((l) => l.id === 'knowledge').detail).toContain(`at ${path.join(m.disk, 'kb')} (moved to `);
    sweepFootprint({ env: m.env, home: m.home, now: NOW, apply: true });
    expect(inventoryFootprint({ env: m.env, home: m.home, now: NOW }).kbCopies).toBe(1);
  });
  // A brain moved to an exFAT/FAT disk gets macOS volume metadata beside every file: AppleDouble `._*`,
  // .DS_Store, .fseventsd, .Spotlight-V100, .Trashes. They are the volume's, never ours: not cruft, not
  // removed on their own, and an AppleDouble file inside a KB copy does not make that copy "unique".
  it('macOS volume metadata on an exFAT brain is ignored: never cruft, never removed, never makes a copy unique', () => {
    const m = moved();
    const brain = m.disk;
    const meta = ['._kb', '._active.json', '.DS_Store', '._token-ledger.jsonl', '._open-issues.json.bak-20260808'];
    for (const n of meta) write(path.join(brain, n), 'AppleDouble');
    for (const d of ['.fseventsd', '.Spotlight-V100', '.Trashes', '.TemporaryItems']) write(path.join(brain, d, 'x'), 'volume');
    json(path.join(brain, 'active.json'), { version: '7.7.0', codeRoot: 'versions/7.7.0' });
    json(path.join(brain, 'versions', '7.7.0', 'x.json'), {});
    write(path.join(brain, 'versions', '._7.7.0'), 'AppleDouble');
    write(path.join(brain, 'leases', '._mcp-me.json'), 'AppleDouble'); old(path.join(brain, 'leases', '._mcp-me.json'), 2);
    write(path.join(brain, 'ruflo-cwd', '._p1'), 'AppleDouble');
    write(path.join(brain, 'kb', '._SOURCE.json'), 'AppleDouble');
    // A disposable copy whose only extra files are AppleDouble shadows of its own files.
    const copy = kbTree(path.join(brain, 'kb.bak-1'), { publicStores: { alpha: 'old' }, privateStores: { secret: 's' } });
    write(path.join(copy, '._SOURCE.json'), 'AppleDouble'); write(path.join(copy, '._secret.big.rvf'), 'AppleDouble');
    write(path.join(copy, '.DS_Store'), 'Finder');
    const metaPaths = [...meta.map((n) => path.join(brain, n)), path.join(brain, 'versions', '._7.7.0'), path.join(brain, 'leases', '._mcp-me.json'),
      path.join(brain, 'ruflo-cwd', '._p1'), ...['.fseventsd', '.Spotlight-V100', '.Trashes', '.TemporaryItems'].map((d) => path.join(brain, d))];
    const fp = inventoryFootprint({ env: m.env, home: m.home, now: NOW });
    for (const p of metaPaths) expect(item(fp, p), p).toBeUndefined();
    expect(fp.cruft.map((i) => path.basename(i.path))).toEqual(['kb.bak-1']);
    expect(kbCopyProof({ copyDir: copy, liveDir: path.join(brain, 'kb') })).toMatchObject({ disposable: true });
    const result = sweepFootprint({ env: m.env, home: m.home, now: NOW, apply: true });
    for (const p of metaPaths) expect(fs.existsSync(p), `${p} was removed`).toBe(true);
    expect(fs.existsSync(copy)).toBe(false);
    const r = confirm({ footprint: result.after, env: m.env, home: m.home, now: NOW, readiness: [] });
    expect(r.lines.find((l) => l.id === 'cruft')).toMatchObject({ state: 'ok' });
  });

  it('an unmounted volume (dangling link) is reported, and nothing is cleaned, created or reinstalled beside it', async () => {
    const m = moved();
    fs.renameSync(path.join(m.home, 'Volumes'), path.join(m.home, 'Unplugged')); // the drive is gone
    write(path.join(m.home, '.npm', '_npx', 'z', 'package.json'), JSON.stringify({ _npx: { packages: ['ruvnet-brain@1.0.0'] } }));
    write(path.join(m.home, '.npm', '_npx', 'z', 'node_modules', 'ruvnet-brain', 'package.json'), JSON.stringify({ version: '1.0.0' }));
    const before = fs.readdirSync(path.join(m.home, '.cache')).sort();
    const result = sweepFootprint({ env: m.env, home: m.home, now: NOW, apply: true });
    expect(result.removed).toEqual([]);
    expect(fs.readdirSync(path.join(m.home, '.cache')).sort()).toEqual(before);
    expect(fs.lstatSync(m.link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(m.home, '.npm', '_npx', 'z'))).toBe(true);
    const r = confirm({ footprint: result.after, env: m.env, home: m.home, now: NOW, readiness: [] });
    expect(r.lines.find((l) => l.id === 'knowledge')).toMatchObject({ state: 'fail', fix: expect.stringMatching(/^mount .*, then: npx ruvnet-brain --doctor/), detail: expect.stringMatching(/is not mounted/) });
    expect(footprintAlarm(r)).toMatch(/BRAIN VOLUME NOT MOUNTED/);
    const { health } = await import('../../plugin/scripts/session-start-health.mjs');
    expect(health(m.home, false).problem).toMatch(/is not mounted .*Do NOT reinstall\./);
  });
});

describe('SessionStart footprint line', () => {
  it('silent when clean; one line plus one detached sweep when not (never in test mode unless asked)', () => {
    const m = machine(); live(m);
    const lines = []; const dispatched = [];
    const check = (env) => footprintCheck({ env, home: m.home, now: NOW, hookDir: path.join(ROOT, 'plugin', 'scripts'),
      emit: (l) => lines.push(l), dispatch: (...args) => { dispatched.push(args); return true; } });
    expect(check(m.env)).toMatchObject({ clean: true });
    expect(lines).toEqual([]);
    kbTree(path.join(m.brainHome, 'kb.bak-1'), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'secret-bytes' } });
    check({ ...m.env, RUVNET_BRAIN_TEST: '1' });
    expect(dispatched).toEqual([]);
    expect(lines.at(-1)).toMatch(/^\[RuvNet Brain — FOOTPRINT NOT CLEAN\] 2 knowledge-base copies.*Fix: npx ruvnet-brain --clean/);
    check({ ...m.env, RUVNET_BRAIN_TEST: '1', RUVNET_FOOTPRINT_SWEEP: 'on' });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0][4]).toEqual([path.join(ROOT, 'plugin', 'scripts', 'brain-footprint.mjs'), '--sweep', '--apply', '--json']);
    expect(lines.at(-1)).toMatch(/cleaning it up in the background now/);
    check({ ...m.env, RUVNET_BRAIN_TEST: '1', RUVNET_FOOTPRINT_SWEEP: 'on' });
    expect(dispatched).toHaveLength(1); // throttled: at most once per 6h
  });
  // Review S7: a copy kept because it holds private files the live brain lacks cannot be fixed by --clean.
  // Say the honest reason, never re-hash it every 6h, and never dispatch a sweep that can only keep it again.
  it('a private-unique copy: proven once, cached, honest fix (not --clean), no background sweep, shown once', () => {
    const m = machine(); live(m);
    const kept = kbTree(path.join(m.brainHome, 'kb.bak-2'), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'OLDER-secret' } });
    const calls = [];
    const proveCopy = (args) => { calls.push(args.copyDir); return kbCopyProof(args); };
    sweepFootprint(opts(m, { apply: true, now: Date.now(), proveCopy }));
    expect(calls).toEqual([kept]);
    sweepFootprint(opts(m, { apply: true, now: Date.now(), proveCopy }));
    expect(calls).toHaveLength(1); // cached: the 6-hourly sweep no longer re-hashes a copy it must keep
    const fp = inventoryFootprint(opts(m, { measure: false, now: Date.now() }));
    const it_ = item(fp, kept);
    expect(it_).toMatchObject({ action: 'report', class: 'must-not-exist' });
    expect(it_.fix).toMatch(/holds private data the live brain lacks.*secret\.big\.rvf/);
    expect(it_.fix).not.toMatch(/--clean/);
    const r = confirm({ footprint: fp, env: m.env, home: m.home, now: Date.now(), readiness: [] });
    expect(r.lines.find((l) => l.id === 'knowledge').fix).not.toMatch(/--clean/);
    expect(r.lines.find((l) => l.id === 'cruft').fix).not.toMatch(/--clean/);
    expect(footprintAlarm(r)).not.toMatch(/--clean/);
    expect(footprintAlarm(r)).toMatch(/private data the live brain lacks/);
    // SessionStart: no background sweep for it, and the line is shown once, not every session.
    const lines = []; const dispatched = [];
    const check = () => footprintCheck({ env: { ...m.env, RUVNET_BRAIN_TEST: '1', RUVNET_FOOTPRINT_SWEEP: 'on' }, home: m.home, now: Date.now(),
      hookDir: path.join(ROOT, 'plugin', 'scripts'), emit: (l) => lines.push(l), dispatch: (...args) => { dispatched.push(args); return true; } });
    check(); check();
    expect(dispatched).toEqual([]);
    expect(lines).toHaveLength(1);
    // The live brain changes (the owner restored the private store): the cache no longer applies.
    write(path.join(m.kbDir, 'secret.big.rvf'), 'OLDER-secret');
    write(path.join(m.kbDir, 'secret.passages.jsonl'), 'OLDER-secret-passages');
    json(path.join(m.kbDir, 'SOURCE.json'), { ...JSON.parse(fs.readFileSync(path.join(m.kbDir, 'SOURCE.json'), 'utf8')), restoredAt: 1 });
    sweepFootprint(opts(m, { apply: true, now: Date.now(), proveCopy }));
    expect(calls).toHaveLength(2);
    expect(fs.existsSync(kept)).toBe(false); // now provably disposable
  });

  it('the detached CLI sweep really removes a disposable copy and keeps a private-unique one', async () => {
    const m = machine(); live(m);
    kbTree(path.join(m.brainHome, 'kb.bak-1'), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'secret-bytes' } });
    kbTree(path.join(m.brainHome, 'kb.bak-2'), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'different' } });
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'plugin', 'scripts', 'brain-footprint.mjs'), '--sweep', '--apply', '--json'],
      { env: { PATH: process.env.PATH, ...m.env }, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.removed.map((x) => path.basename(x.path))).toContain('kb.bak-1');
    expect(fs.existsSync(path.join(m.brainHome, 'kb.bak-2'))).toBe(true);
  });
});

// ── BREAK IT: each safety assertion above must go RED when its guard is removed ─────────────────
// A mutant copy of the two modules is written to a temp dir with ONE guard disabled; the same scenario is
// run against it, and the unsafe outcome must occur. If a mutant still behaves safely, the scenario that
// "proves" that guard is not actually testing it.
async function mutant(replacements) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'footprint-mutant-'));
  dirs.push(dir);
  for (const f of ['brain-footprint.mjs', 'kb-copy-proof.mjs', 'brain-confirmation.mjs', 'mcp-readiness.mjs', 'brain-location.mjs', 'footprint-io.mjs']) {
    let src = fs.readFileSync(path.join(ROOT, 'plugin', 'scripts', f), 'utf8');
    for (const [file, from, to] of replacements) if (file === f) {
      expect(src.includes(from), `mutation anchor missing in ${f}: ${from}`).toBe(true);
      src = src.replace(from, to);
    }
    fs.writeFileSync(path.join(dir, f), src);
  }
  return import(pathToFileURL(path.join(dir, 'brain-footprint.mjs')).href);
}

describe('BREAK IT: every guard is proven by a mutant that goes red', () => {
  it('private byte-identity guard removed -> a private-unique copy is deleted', async () => {
    const mod = await mutant([['kb-copy-proof.mjs', 'if (!sameBytes(path.join(copyDir, relative), inLive)) {', 'if (false) {']]);
    const m = machine(); live(m);
    const copy = kbTree(path.join(m.brainHome, 'kb.bak-1'), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'OLD' } });
    mod.sweepFootprint(opts(m, { apply: true }));
    expect(fs.existsSync(copy)).toBe(false); // the unsafe outcome the real guard prevents
  });
  it('unknown-file guard removed -> a user file is deleted with its copy', async () => {
    const mod = await mutant([['kb-copy-proof.mjs', "unique.push({ file: relative, why: 'not in the live brain", "void ({ file: relative, why: 'not in the live brain"]]);
    const m = machine(); live(m);
    const copy = kbTree(path.join(m.brainHome, 'kb.bak-1'), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'secret-bytes' }, extra: { 'mine.txt': 'x' } });
    mod.sweepFootprint(opts(m, { apply: true }));
    expect(fs.existsSync(copy)).toBe(false);
  });
  it('symlink guard removed -> a symlinked KB-copy name is acted on', async () => {
    const mod = await mutant([['brain-footprint.mjs', "if (st.isSymbolicLink() || !st.isDirectory()) { add({ id: 'kb-copy', path: full, class: 'unowned'", "if (false) { add({ id: 'kb-copy', path: full, class: 'unowned'"],
      ['kb-copy-proof.mjs', 'if (!copy || copy.isSymbolicLink() || !copy.isDirectory())', 'if (!copy)']]);
    const m = machine(); live(m);
    const target = path.join(m.home, 'elsewhere'); write(path.join(target, 'SOURCE.json'), '{}');
    fs.symlinkSync(target, path.join(m.brainHome, 'kb.bak-link'));
    mod.sweepFootprint(opts(m, { apply: true }));
    expect(fs.existsSync(path.join(m.brainHome, 'kb.bak-link'))).toBe(false); // the link itself was removed
  });
  it('in-progress transaction guard removed -> a LOCKED transaction candidate is deleted', async () => {
    const mod = await mutant([['brain-footprint.mjs', 'if (state && !TERMINAL.has(state)) {', 'if (false) {']]);
    const m = machine(); live(m);
    kbTree(path.join(m.brainHome, 'kb.next-77'), { publicStores: { alpha: 'cand' } });
    json(path.join(m.brainHome, '.kb.update-transactions', '77', '001-LOCKED.json'), { state: 'LOCKED' });
    mod.sweepFootprint(opts(m, { apply: true }));
    expect(fs.existsSync(path.join(m.brainHome, 'kb.next-77'))).toBe(false);
  });
  it('report-only guard on hand-made backups removed -> a user backup is deleted', async () => {
    const mod = await mutant([['brain-footprint.mjs', "add({ id: 'leftover', path: full, class: 'unowned', kind: 'recovery-leftover', action: 'report',",
      "add({ id: 'leftover', path: full, class: 'must-not-exist', kind: 'recovery-leftover', action: 'remove',"]]);
    const m = machine(); live(m);
    const mine = path.join(m.brainHome, 'open-issues.json.bak-20260808'); write(mine, 'mine');
    sweepFootprint(opts(m, { apply: true }));
    expect(fs.existsSync(mine)).toBe(true); // real module: kept
    mod.sweepFootprint(opts(m, { apply: true }));
    expect(fs.existsSync(mine)).toBe(false); // mutant: deleted
  });
  // Review S7: removeWithin(item.path, path.dirname(item.path)) compared a path with its own parent, so it
  // could never refuse. If a directory on the way is swapped for a link between inventory and removal, the
  // sweep must refuse rather than delete through it.
  it('owned-root guard removed -> a parent swapped for a link mid-sweep lets the sweep delete outside its roots', async () => {
    const setup = () => {
      const m = machine(); live(m);
      const project = path.join(m.brainHome, 'ruflo-cwd', 'p1');
      write(path.join(project, '.swarm', 'hnsw.metadata.json'), '{}');
      const outside = path.join(m.home, 'Documents', 'project');
      write(path.join(outside, '.swarm', 'memory.db'), 'the user real store');
      const swap = (item) => {
        if (item.kind !== 'ruflo-scratch') return;
        fs.rmSync(project, { recursive: true, force: true });
        fs.symlinkSync(outside, project); // a link where the scratch directory was
      };
      return { m, outside, swap };
    };
    const real = setup();
    const result = sweepFootprint(opts(real.m, { apply: true, beforeRemove: real.swap }));
    expect(fs.readFileSync(path.join(real.outside, '.swarm', 'memory.db'), 'utf8')).toBe('the user real store');
    expect(result.errors.some((e) => /refusing to remove/.test(e.reason))).toBe(true);
    const mod = await mutant([['footprint-io.mjs', 'if (!realOk) throw', 'if (false) throw']]);
    const broken = setup();
    mod.sweepFootprint(opts(broken.m, { apply: true, beforeRemove: broken.swap }));
    expect(fs.existsSync(path.join(broken.outside, '.swarm'))).toBe(false); // mutant: deleted through the link
  });
  it('install-in-progress guard removed -> the rollback copy is deleted between the installer\'s renames', async () => {
    const mod = await mutant([['brain-footprint.mjs', '    : installing ? \'an install is activating', '    : false ? \'an install is activating']]);
    const m = machine(); live(m);
    const prior = kbTree(path.join(m.brainHome, `kb.install-prior-${Date.now()}-${process.pid}`), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'secret-bytes' } });
    sweepFootprint(opts(m, { apply: true, now: Date.now() }));
    expect(fs.existsSync(prior)).toBe(true); // real module: kept
    mod.sweepFootprint(opts(m, { apply: true, now: Date.now() }));
    expect(fs.existsSync(prior)).toBe(false); // mutant: the live installer's rollback copy is gone
  });
  it('recent-npx guard removed -> an installer copy fetched minutes ago is deleted', async () => {
    const mod = await mutant([['brain-footprint.mjs', "(recent ? 'fetched in the last 2h; it may be running now' : null)", 'null']]);
    const m = machine(); live(m);
    for (const [h, v] of [['o', '4.3.1'], ['n', '7.7.0']]) {
      json(path.join(m.home, '.npm', '_npx', h, 'package.json'), { _npx: { packages: [`ruvnet-brain@${v}`] } });
      json(path.join(m.home, '.npm', '_npx', h, 'node_modules', 'ruvnet-brain', 'package.json'), { version: v });
    }
    sweepFootprint(opts(m, { apply: true, now: Date.now() }));
    expect(fs.existsSync(path.join(m.home, '.npm', '_npx', 'o'))).toBe(true);
    mod.sweepFootprint(opts(m, { apply: true, now: Date.now() }));
    expect(fs.existsSync(path.join(m.home, '.npm', '_npx', 'o'))).toBe(false);
  });
  it('live-lease guard removed -> a lease whose process is alive is deleted', async () => {
    const mod = await mutant([['brain-footprint.mjs', '&& !pidAlive(readJson(lp)?.pid)', '']]);
    const m = machine(); live(m);
    json(path.join(m.brainHome, 'leases', 'mcp-me.json'), { pid: process.pid, version: '4.2.7' }); old(path.join(m.brainHome, 'leases', 'mcp-me.json'), 1);
    mod.sweepFootprint(opts(m, { apply: true }));
    expect(fs.existsSync(path.join(m.brainHome, 'leases', 'mcp-me.json'))).toBe(false);
  });
  it('live-brain-present guard removed -> install-prior is deleted while no live KB exists', async () => {
    const mod = await mutant([['kb-copy-proof.mjs', "return { disposable: false, unique: [], reason: 'the live brain is missing", "if (false) return { disposable: false, unique: [], reason: 'the live brain is missing"]]);
    const m = machine(); fs.mkdirSync(m.brainHome, { recursive: true });
    const prior = `kb.install-prior-1-${2 ** 30}`; // a finished (dead-pid) activation, so only the live-brain guard keeps it
    kbTree(path.join(m.brainHome, prior), { publicStores: { alpha: 'a' } });
    mod.sweepFootprint(opts(m, { apply: true }));
    expect(fs.existsSync(path.join(m.brainHome, prior))).toBe(false);
  });
  it('refresh-lock guard removed -> a copy is deleted while another process updates', async () => {
    const mod = await mutant([['brain-footprint.mjs', "const lockHeld = !holdingRefreshLock && Boolean(lstat(refreshLock));", 'const lockHeld = false;']]);
    const m = machine(); live(m);
    kbTree(path.join(m.brainHome, 'kb.bak-1'), { publicStores: { alpha: 'a0' }, privateStores: { secret: 'secret-bytes' } });
    write(path.join(m.brainHome, '.kb.refresh-run.lock'), '{}');
    mod.sweepFootprint(opts(m, { apply: true }));
    expect(fs.existsSync(path.join(m.brainHome, 'kb.bak-1'))).toBe(false);
  });
  it('npm-cache containment removed -> an npm cache outside HOME is swept', async () => {
    const mod = await mutant([['brain-footprint.mjs', "configured && physical(configured).startsWith(`${physical(home)}${path.sep}`) ? configured : defaultCache", 'configured || defaultCache']]);
    const m = machine(); live(m);
    for (const [h, v] of [['r1', '1.0.0'], ['r2', '2.0.0']]) {
      json(path.join(m.outsideCache, '_npx', h, 'package.json'), { _npx: { packages: [`ruvnet-brain@${v}`] } });
      json(path.join(m.outsideCache, '_npx', h, 'node_modules', 'ruvnet-brain', 'package.json'), { version: v });
      old(path.join(m.outsideCache, '_npx', h), 3);
    }
    mod.sweepFootprint(opts(m, { apply: true }));
    expect(fs.existsSync(path.join(m.outsideCache, '_npx', 'r1'))).toBe(false);
  });
  it('unmounted-volume guard removed -> the sweep acts on the machine while the brain is unplugged', async () => {
    const mod = await mutant([['brain-footprint.mjs', '  if (roots.dangling) {\n    add(', '  if (false) {\n    add('],
      ['brain-footprint.mjs', '  if (roots.dangling) {\n    return {', '  if (false) {\n    return {']]);
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'footprint-unplugged-')));
    dirs.push(home);
    fs.mkdirSync(path.join(home, '.cache'), { recursive: true });
    fs.symlinkSync(path.join(home, 'Volumes', 'Gone', 'ruvnet-brain'), path.join(home, '.cache', 'ruvnet-brain'));
    for (const [h, v] of [['o', '1.0.0'], ['n', '2.0.0']]) {
      write(path.join(home, '.npm', '_npx', h, 'package.json'), JSON.stringify({ _npx: { packages: [`ruvnet-brain@${v}`] } }));
      write(path.join(home, '.npm', '_npx', h, 'node_modules', 'ruvnet-brain', 'package.json'), JSON.stringify({ version: v }));
      old(path.join(home, '.npm', '_npx', h), 3);
    }
    sweepFootprint({ env: { HOME: home }, home, now: NOW, apply: true });
    expect(fs.existsSync(path.join(home, '.npm', '_npx', 'o'))).toBe(true); // real module: untouched
    mod.sweepFootprint({ env: { HOME: home }, home, now: NOW, apply: true });
    expect(fs.existsSync(path.join(home, '.npm', '_npx', 'o'))).toBe(false); // mutant: cleaned while unplugged
  });
  it('footprintRoots honours RUVNET_BRAIN_HOME through a symlink (physical path)', () => {
    const m = machine();
    const realHome = path.join(m.home, 'disk', 'brain'); fs.mkdirSync(realHome, { recursive: true });
    fs.mkdirSync(path.join(m.home, '.cache'), { recursive: true });
    fs.symlinkSync(realHome, path.join(m.home, '.cache', 'ruvnet-brain'));
    const roots = footprintRoots({ env: { HOME: m.home }, home: m.home });
    expect(roots.brainHome).toBe(fs.realpathSync(realHome));
    expect(roots.kbDir).toBe(path.join(fs.realpathSync(realHome), 'kb'));
  });
});
