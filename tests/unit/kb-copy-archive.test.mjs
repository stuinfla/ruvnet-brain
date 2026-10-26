// kb-copy-archive.test.mjs — issue #335: `--update` stuck behind old KB copies. Three owner-decided repairs,
// each driven through the real sweep / reclaim code on disposable fixtures, and each with the one property that
// matters asserted directly: NO unique byte is ever deleted.
//   (a) a file byte-identical in a KEPT sibling copy is accounted for, so duplicate preserved copies release to one;
//   (b) `--clean --archive` (opt-in, never automatic) copies only the unique files into kb.archive/<stamp>/ and
//       then releases the copy;
//   (c) kb/forge-update.mjs reclaimBackups treats a copy whose bytes all survive in live or an archive as accounted for.
import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inventoryFootprint, sweepFootprint } from '../../plugin/scripts/brain-footprint.mjs';
import { kbCopyProof } from '../../plugin/scripts/kb-copy-proof.mjs';
import { archiveRoots } from '../../plugin/scripts/footprint-io.mjs';
import { reclaimBackups } from '../../kb/forge-update.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
const NOW = Date.parse('2026-10-25T12:00:00.000Z');

function files(root, prefix = '', out = []) {
  for (const name of fs.readdirSync(path.join(root, prefix))) {
    const rel = path.join(prefix, name);
    const st = fs.lstatSync(path.join(root, rel));
    if (st.isDirectory()) files(root, rel, out); else if (st.isFile()) out.push(rel);
  }
  return out;
}
/** Every regular-file hash anywhere under the brain home: what must survive any sweep. */
const hashesUnder = (root) => new Set(files(root).map((rel) => sha(path.join(root, rel))));

function machine() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-archive-home-')));
  dirs.push(home);
  const brainHome = path.join(home, '.cache', 'ruvnet-brain');
  const kbDir = path.join(brainHome, 'kb');
  const env = { HOME: home, RUVNET_BRAIN_HOME: brainHome, RUVNET_BRAIN_KB: kbDir, CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), npm_config_cache: path.join(home, 'npm-cache') };
  write(path.join(kbDir, 'SOURCE.json'), JSON.stringify({ stores: { alpha: { kbName: 'alpha', updateManaged: true } } }));
  write(path.join(kbDir, 'alpha.big.rvf'), 'alpha-v3');
  write(path.join(kbDir, 'forge-mcp-all.mjs'), '// search\n');
  return { home, brainHome, kbDir, env };
}
const opts = (m, more = {}) => ({ env: m.env, home: m.home, now: NOW, selfPath: '/nonexistent', ...more });
/** A preserved generation holding two files the live brain does not: a retired store and a user's note. */
function preserved(m, name, { concepts = 'CONCEPTS-BYTES', note = 'my own note' } = {}) {
  const dir = path.join(m.brainHome, name);
  write(path.join(dir, 'SOURCE.json'), '{}');
  write(path.join(dir, 'alpha.big.rvf'), 'alpha-v3');
  write(path.join(dir, 'concepts.big.rvf'), concepts);
  write(path.join(dir, 'notes', 'user.txt'), note);
  return dir;
}

describe('#335 (a): duplicate preserved copies release down to one', () => {
  it('two byte-identical preserved copies: one is released, the other keeps every unique byte', () => {
    const m = machine();
    const a = preserved(m, 'kb.install-preserved-AAAAAA');
    const b = preserved(m, 'kb.install-preserved-BBBBBB');
    const before = hashesUnder(m.brainHome);
    // Alone, each copy is (correctly) kept: it holds files the live brain lacks.
    expect(kbCopyProof({ copyDir: b, liveDir: m.kbDir }).disposable).toBe(false);
    const swept = sweepFootprint(opts(m, { apply: true }));
    expect(swept.removed.map((r) => r.path)).toEqual([b]);
    expect(fs.existsSync(a)).toBe(true);
    expect(fs.existsSync(path.join(m.brainHome, 'kb.archive'))).toBe(false); // never archived without --archive
    for (const h of before) expect(hashesUnder(m.brainHome).has(h)).toBe(true);
  });

  it('a sibling with DIFFERENT bytes at the same path accounts for nothing; both are kept', () => {
    const m = machine();
    preserved(m, 'kb.install-preserved-AAAAAA');
    const b = preserved(m, 'kb.install-preserved-BBBBBB', { note: 'a different note' });
    const before = hashesUnder(m.brainHome);
    const swept = sweepFootprint(opts(m, { apply: true }));
    expect(swept.removed).toEqual([]);
    expect(swept.kept.find((k) => k.path === b).unique.map((u) => u.file)).toEqual([path.join('notes', 'user.txt')]);
    for (const h of before) expect(hashesUnder(m.brainHome).has(h)).toBe(true);
    expect(fs.existsSync(b)).toBe(true);
  });

  it('the sweep never treats a live directory linked into the copy as evidence (review A, footprint side)', () => {
    const m = machine();
    const a = preserved(m, 'kb.install-preserved-AAAAAA');
    fs.symlinkSync(path.join(a, 'notes'), path.join(m.kbDir, 'notes'));
    for (const archive of [false, true]) {
      const swept = sweepFootprint(opts(m, { apply: true, archive }));
      expect(swept.removed.map((r) => r.path)).not.toContain(a);
      expect(fs.readFileSync(path.join(a, 'notes', 'user.txt'), 'utf8')).toBe('my own note');
    }
  });

  it('a copy is never a reference for itself, and a missing sibling accounts for nothing', () => {
    const m = machine();
    const a = preserved(m, 'kb.install-preserved-AAAAAA');
    expect(kbCopyProof({ copyDir: a, liveDir: m.kbDir, keptSiblings: [a] }).disposable).toBe(false);
    expect(kbCopyProof({ copyDir: a, liveDir: m.kbDir, keptSiblings: [path.join(m.home, 'missing')] }).disposable).toBe(false);
  });
});

describe('#335 (b): --clean --archive keeps only the unique files, then releases the copy', () => {
  it('a legacy kb.bak with unknown files: archived byte-for-byte with a receipt, then released', () => {
    const m = machine();
    const legacy = path.join(m.brainHome, 'kb.bak-2026-07-13T10-47-54-235Z');
    write(path.join(legacy, 'SOURCE.json'), '{}');
    write(path.join(legacy, 'alpha.big.rvf'), 'alpha-v3');
    write(path.join(legacy, 'ruv-gists.big.rvf'), 'GISTS');
    write(path.join(legacy, 'legacy', 'unknown.bin'), Buffer.from([0, 1, 2, 3, 255]));
    const before = hashesUnder(m.brainHome);
    // Without --archive the copy is kept, and the fix names the explicit archive command.
    expect(sweepFootprint(opts(m, { apply: true })).removed).toEqual([]);
    const fp = inventoryFootprint(opts(m, { measure: false }));
    expect(fp.items.find((i) => i.path === legacy).fix).toMatch(/^npx ruvnet-brain --clean --archive/);
    const swept = sweepFootprint(opts(m, { apply: true, archive: true }));
    expect(swept.removed.map((r) => r.path)).toEqual([legacy]);
    expect(swept.removed[0].reason).toMatch(/archived 3 unique file\(s\) to .*kb\.archive/);
    expect(fs.existsSync(legacy)).toBe(false);
    const stamp = fs.readdirSync(path.join(m.brainHome, 'kb.archive'));
    expect(stamp).toHaveLength(1);
    const root = path.join(m.brainHome, 'kb.archive', stamp[0], path.basename(legacy));
    // Its own SOURCE.json differs from live, so it is unique too and is archived with the rest.
    expect(files(root).sort()).toEqual(['SOURCE.json', path.join('legacy', 'unknown.bin'), 'ruv-gists.big.rvf']);
    const receipt = JSON.parse(fs.readFileSync(`${root}.json`, 'utf8'));
    expect(receipt).toMatchObject({ kind: 'ruvnet-brain-kb-archive', source: legacy });
    for (const f of receipt.files) expect(sha(path.join(root, f.file))).toBe(f.sha256);
    for (const h of before) expect(hashesUnder(m.brainHome).has(h)).toBe(true);
    // The archive is classified (kept, not cruft) and a later sweep never touches it.
    const after = inventoryFootprint(opts(m, { measure: false }));
    expect(after.items.find((i) => i.kind === 'kb-archive')).toMatchObject({ class: 'may-exist', action: 'keep' });
    expect(after.cruft).toEqual([]);
    sweepFootprint(opts(m, { apply: true, archive: true }));
    expect(files(root).length).toBe(3);
  });

  it('two identical copies under --archive: one archive set, both copies released, every byte kept', () => {
    const m = machine();
    const a = preserved(m, 'kb.install-preserved-AAAAAA');
    const b = preserved(m, 'kb.install-preserved-BBBBBB');
    const before = hashesUnder(m.brainHome);
    const swept = sweepFootprint(opts(m, { apply: true, archive: true }));
    expect(swept.removed.map((r) => r.path).sort()).toEqual([a, b]);
    const [stamp] = fs.readdirSync(path.join(m.brainHome, 'kb.archive'));
    expect(fs.readdirSync(path.join(m.brainHome, 'kb.archive', stamp)).filter((n) => !n.endsWith('.json'))).toEqual([path.basename(a)]);
    for (const h of before) expect(hashesUnder(m.brainHome).has(h)).toBe(true);
  });

  it('re-proves a copy an earlier sweep cached as KEPT', () => {
    const m = machine();
    const a = preserved(m, 'kb.install-preserved-AAAAAA');
    sweepFootprint(opts(m, { apply: true }));
    expect(inventoryFootprint(opts(m, { measure: false })).items.find((i) => i.path === a).keptUnique).toBe(true);
    expect(sweepFootprint(opts(m, { apply: true, archive: true })).removed.map((r) => r.path)).toEqual([a]);
  });

  it('fails closed: a unique symbolic link, or a copy without readable metadata, is kept and nothing is released', () => {
    const m = machine();
    const linked = preserved(m, 'kb.install-preserved-AAAAAA');
    fs.symlinkSync('../somewhere', path.join(linked, 'outside-link'));
    const bare = path.join(m.brainHome, 'kb.bak-2026-07-14T00-00-00-000Z');
    write(path.join(bare, 'only-copy.txt'), 'irreplaceable');
    const before = hashesUnder(m.brainHome);
    const swept = sweepFootprint(opts(m, { apply: true, archive: true }));
    expect(swept.removed).toEqual([]);
    expect(swept.kept.find((k) => k.path === linked).reason).toMatch(/not archived: .*outside-link/);
    expect(fs.existsSync(bare)).toBe(true);
    for (const h of before) expect(hashesUnder(m.brainHome).has(h)).toBe(true);
  });

  // Review fix (4.7.21): an archive is all or nothing. A half-written <stamp>/<label> used to stay behind and every
  // later sweep compared copies against it.
  const archiveEntries = (m) => {
    const dir = path.join(m.brainHome, 'kb.archive');
    return fs.existsSync(dir) ? fs.readdirSync(dir).flatMap((stamp) => fs.readdirSync(path.join(dir, stamp))) : [];
  };
  it('a copy failure partway leaves no archive (no label tree, no receipt, no temp) and keeps the copy', () => {
    const m = machine();
    const a = preserved(m, 'kb.install-preserved-AAAAAA');
    const before = hashesUnder(m.brainHome);
    const real = fs.copyFileSync; let calls = 0;
    const spy = vi.spyOn(fs, 'copyFileSync').mockImplementation(function (...args) {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return real.apply(this, args);
    });
    let swept;
    try { swept = sweepFootprint(opts(m, { apply: true, archive: true })); } finally { spy.mockRestore(); }
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(swept.removed).toEqual([]);
    expect(swept.kept.find((k) => k.path === a).reason).toMatch(/not archived: archive failed: ENOSPC/);
    expect(archiveEntries(m)).toEqual([]);
    for (const h of before) expect(hashesUnder(m.brainHome).has(h)).toBe(true);
  });

  it('a copy the re-proof still keeps (unreadable metadata) leaves no archive behind', () => {
    const m = machine();
    const a = preserved(m, 'kb.install-preserved-AAAAAA');
    const seen = new Map();
    const proveCopy = (args) => {
      seen.set(args.copyDir, (seen.get(args.copyDir) || 0) + 1);
      return seen.get(args.copyDir) === 1 ? kbCopyProof(args)
        : { disposable: false, unique: [], reason: `unreadable or malformed metadata in ${args.copyDir}: not a metadata object` };
    };
    const swept = sweepFootprint(opts(m, { apply: true, archive: true, proveCopy }));
    expect(seen.get(a)).toBe(2);
    expect(swept.removed).toEqual([]);
    expect(swept.kept.find((k) => k.path === a).reason).toMatch(/unreadable or malformed metadata.*its archive was removed/);
    expect(fs.existsSync(a)).toBe(true);
    expect(archiveEntries(m)).toEqual([]);
  });

  // Review fix (4.7.21 r2): between archive and re-proof a concurrent updater (reclaimBackups counts the archive as
  // evidence) may delete the copy. The re-proof of a missing directory says "keep"; discarding the archive then would
  // lose the bytes in both places. The archive is discarded only while the copy still holds every archived byte.
  it('a copy deleted between archive and re-proof: the archive survives with every byte', () => {
    const m = machine();
    const a = preserved(m, 'kb.install-preserved-AAAAAA');
    const before = files(a).map((rel) => sha(path.join(a, rel)));
    let calls = 0;
    const proveCopy = (args) => {
      calls += 1;
      if (calls === 2) fs.rmSync(args.copyDir, { recursive: true, force: true }); // the concurrent reclaim
      return kbCopyProof(args);
    };
    const swept = sweepFootprint(opts(m, { apply: true, archive: true, proveCopy }));
    expect(calls).toBe(2);
    expect(fs.existsSync(a)).toBe(false);
    const roots = archiveRoots(path.join(m.brainHome, 'kb.archive'));
    expect(roots).toHaveLength(1);
    const receipt = JSON.parse(fs.readFileSync(`${roots[0]}.json`, 'utf8'));
    expect(receipt.files.map((f) => f.file).sort()).toEqual(['SOURCE.json', 'concepts.big.rvf', path.join('notes', 'user.txt')]);
    for (const f of receipt.files) expect(sha(path.join(roots[0], f.file))).toBe(f.sha256);
    // Every byte the copy held is still on disk: its unique files in the archive, the rest in the live brain.
    const surviving = hashesUnder(m.brainHome);
    for (const h of before) expect(surviving.has(h)).toBe(true);
    expect(swept.kept.find((k) => k.path === a).reason).toMatch(/archive at .* is kept: .* no longer a real directory/);
  });

  // GPT-6.1 review r2: the interleaving that loses data. Sweep A publishes the archive; sweep B sees it, proves the
  // original redundant against it and deletes the original; A's re-proof then finds the original missing. A published
  // archive is retained unless the original is proven intact and byte-identical (ADR-098: no unique byte lost).
  it('two interleaved sweeps: B releases the original against A\'s archive between A\'s publish and re-proof; every unique byte survives', () => {
    const m = machine();
    const a = preserved(m, 'kb.install-preserved-AAAAAA');
    const uniqueBefore = ['SOURCE.json', 'concepts.big.rvf', path.join('notes', 'user.txt')].map((rel) => sha(path.join(a, rel)));
    let calls = 0; let sweepB = null;
    const proveCopy = (args) => {
      calls += 1;
      if (calls === 2) sweepB = sweepFootprint(opts(m, { apply: true })); // B runs to completion right here
      return kbCopyProof(args);
    };
    sweepFootprint(opts(m, { apply: true, archive: true, proveCopy }));
    expect(sweepB.removed.map((r) => r.path)).toEqual([a]); // B really did release the original against the archive
    expect(fs.existsSync(a)).toBe(false);
    const surviving = hashesUnder(m.brainHome);
    for (const h of uniqueBefore) expect(surviving.has(h)).toBe(true);
    expect(archiveRoots(path.join(m.brainHome, 'kb.archive'))).toHaveLength(1);
  });

  it('a copy changed between archive and re-proof: the archive is kept', () => {
    const m = machine();
    const a = preserved(m, 'kb.install-preserved-AAAAAA');
    const note = sha(path.join(a, 'notes', 'user.txt'));
    let calls = 0;
    const proveCopy = (args) => {
      calls += 1;
      if (calls === 1) return kbCopyProof(args);
      fs.writeFileSync(path.join(args.copyDir, 'notes', 'user.txt'), 'edited since');
      return { disposable: false, unique: [], reason: 'kept on re-proof' };
    };
    const swept = sweepFootprint(opts(m, { apply: true, archive: true, proveCopy }));
    const [root] = archiveRoots(path.join(m.brainHome, 'kb.archive'));
    expect(root).toBeTruthy();
    expect(sha(path.join(root, 'notes', 'user.txt'))).toBe(note);
    expect(swept.kept.find((k) => k.path === a).reason).toMatch(/is no longer identical in/);
  });

  it('a half-written (dot-named) archive a killed sweep left is never a reference', () => {
    const m = machine();
    const a = preserved(m, 'kb.install-preserved-AAAAAA');
    const partial = path.join(m.brainHome, 'kb.archive', '2026-10-25T00-00-00-000Z', '.kb.install-preserved-AAAAAA.partial-1-abcd');
    for (const rel of ['SOURCE.json', 'concepts.big.rvf', path.join('notes', 'user.txt')]) write(path.join(partial, rel), fs.readFileSync(path.join(a, rel)));
    expect(archiveRoots(path.join(m.brainHome, 'kb.archive'))).toEqual([]);
    expect(sweepFootprint(opts(m, { apply: true })).removed).toEqual([]);
    expect(fs.existsSync(a)).toBe(true);
  });

  it('a quarantined copy is archived under the same <quarantine>--<child> label its rescued logs use', () => {
    const m = machine();
    const quarantine = path.join(m.brainHome, 'kb-quarantine-20260901');
    preserved(m, path.join('kb-quarantine-20260901', 'kb'));
    const swept = sweepFootprint(opts(m, { apply: true, archive: true }));
    expect(swept.removed.map((r) => r.path)).toEqual([path.join(quarantine, 'kb')]);
    expect(archiveEntries(m).sort()).toEqual(['kb-quarantine-20260901--kb', 'kb-quarantine-20260901--kb.json']);
  });

  it('a dry run (apply:false) never writes an archive', () => {
    const m = machine();
    preserved(m, 'kb.install-preserved-AAAAAA');
    sweepFootprint(opts(m, { apply: false, archive: true }));
    expect(fs.existsSync(path.join(m.brainHome, 'kb.archive'))).toBe(false);
  });
});

describe('#335 (c): reclaimBackups treats an archived copy as accounted for', () => {
  function reclaimFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-archive-'));
    dirs.push(root);
    const live = path.join(root, 'kb');
    write(path.join(live, 'a.rvf'), 'same vectors');
    write(path.join(live, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: { a: { file: 'a.rvf' } } }));
    const backup = path.join(root, 'kb.bak-2026-07-13T10-47-54-235Z');
    write(path.join(backup, 'a.rvf'), 'same vectors');
    write(path.join(backup, 'concepts.rvf'), 'retired store');
    write(path.join(backup, 'legacy.txt'), 'unknown legacy file');
    return { root, live, backup };
  }
  const archiveAt = (root, entries) => {
    for (const [rel, body] of Object.entries(entries)) write(path.join(root, 'kb.archive', '2026-10-25T12-00-00-000Z', 'kb.bak-2026-07-13T10-47-54-235Z', rel), body);
  };

  it('without an archive the legacy copy blocks the update, as before', () => {
    const { live, backup } = reclaimFixture();
    const result = reclaimBackups({ kbDir: live, env: {} });
    expect(result.removed).toEqual([]);
    expect(result.blockingRetained.map((r) => r.path)).toEqual([backup]);
  });

  it('with its unique files archived byte-for-byte, it is reclaimed and the update may proceed', () => {
    const { root, live, backup } = reclaimFixture();
    archiveAt(root, { 'concepts.rvf': 'retired store', 'legacy.txt': 'unknown legacy file' });
    const result = reclaimBackups({ kbDir: live, env: {} });
    expect(result.removed).toEqual([backup]);
    expect(result.blockingRetained).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'kb.archive', '2026-10-25T12-00-00-000Z', 'kb.bak-2026-07-13T10-47-54-235Z', 'legacy.txt'), 'utf8')).toBe('unknown legacy file');
  });

  it('a dry run reports it without deleting', () => {
    const { root, live, backup } = reclaimFixture();
    archiveAt(root, { 'concepts.rvf': 'retired store', 'legacy.txt': 'unknown legacy file' });
    expect(reclaimBackups({ kbDir: live, env: {}, dryRun: true }).wouldRemove).toEqual([backup]);
    expect(fs.existsSync(backup)).toBe(true);
  });

  it('a half-written (dot-named) archive tree is not counted as an archive', () => {
    const { root, live, backup } = reclaimFixture();
    for (const [rel, body] of Object.entries({ 'concepts.rvf': 'retired store', 'legacy.txt': 'unknown legacy file' })) {
      write(path.join(root, 'kb.archive', '2026-10-25T12-00-00-000Z', '.kb.bak-2026-07-13T10-47-54-235Z.partial-1-abcd', rel), body);
    }
    expect(reclaimBackups({ kbDir: live, env: {} }).removed).toEqual([]);
    expect(fs.existsSync(backup)).toBe(true);
  });

  // Cross-vendor review A (P1): with any archive present, the comparison used to follow a live directory link; a
  // live/notes pointing INTO the backup compared the backup with itself and approved deleting it.
  it('a live directory linked into the backup being judged is never evidence, even with an archive present', () => {
    const { root, live, backup } = reclaimFixture();
    write(path.join(backup, 'notes', 'user.txt'), 'only copy of my note');
    archiveAt(root, { 'concepts.rvf': 'retired store', 'legacy.txt': 'unknown legacy file' });
    fs.symlinkSync(path.join(backup, 'notes'), path.join(live, 'notes'));
    const result = reclaimBackups({ kbDir: live, env: {} });
    expect(result.removed).toEqual([]);
    expect(fs.readFileSync(path.join(backup, 'notes', 'user.txt'), 'utf8')).toBe('only copy of my note');
  });

  it('an archive tree that resolves inside the backup being judged is never evidence', () => {
    const { root, live, backup } = reclaimFixture();
    fs.mkdirSync(path.join(root, 'kb.archive', '2026-10-25T12-00-00-000Z'), { recursive: true });
    // An archive stamp whose label directory is the backup itself (a link): every file would "match".
    fs.symlinkSync(backup, path.join(root, 'kb.archive', '2026-10-25T12-00-00-000Z', 'kb.bak-2026-07-13T10-47-54-235Z'));
    // ...and a real archive dir whose subdirectory links into the backup.
    const label = path.join(root, 'kb.archive', '2026-10-25T12-00-00-000Z', 'other');
    fs.mkdirSync(label);
    fs.writeFileSync(path.join(label, 'concepts.rvf'), 'retired store');
    const result = reclaimBackups({ kbDir: live, env: {} });
    expect(result.removed).toEqual([]);
    expect(fs.existsSync(path.join(backup, 'legacy.txt'))).toBe(true);
  });

  it('one file missing from, or different in, the archive keeps the whole copy', () => {
    for (const entries of [{ 'concepts.rvf': 'retired store' }, { 'concepts.rvf': 'retired store', 'legacy.txt': 'DIFFERENT legacy file' }]) {
      const { root, live, backup } = reclaimFixture();
      archiveAt(root, entries);
      const result = reclaimBackups({ kbDir: live, env: {} });
      expect(result.removed).toEqual([]);
      expect(fs.readFileSync(path.join(backup, 'legacy.txt'), 'utf8')).toBe('unknown legacy file');
    }
  });
});
