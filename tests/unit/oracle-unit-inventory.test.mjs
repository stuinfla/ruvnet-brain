// tests/unit/oracle-unit-inventory.test.mjs
//
// The parser-independent core of oracle-source-units/2 (EXTEND_FIRST Dual verdict, 2026-09-14). Real git
// fixtures, an injected TEST DOUBLE adapter (the production adapters are a separate decision). The cases
// pin the rules the verdict made binding:
//   - every tracked entry gets exactly one disposition; only a narrow published list is excluded;
//   - tests, dist output and changelogs are no longer blanket-excluded;
//   - an unsupported entry, a parser diagnostic, a throwing adapter or undecodable text makes the
//     inventory INCOMPLETE: U=null plus an `enumeratedU` lower bound, and it is never sampled;
//   - complete accounting that finds nothing is flagged for emptiness review, never read as a measurement.
import { describe, expect, it, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { snapshotManifest } from '../../scripts/oracle/source-tree.mjs';
import { buildInventory, fixedDisposition, RULES_VERSION } from '../../scripts/oracle/unit-inventory.mjs';

const repos = [];
afterAll(() => { for (const r of repos) fs.rmSync(r, { recursive: true, force: true }); });

/** Create a committed git repo from { path: string | Buffer | { symlink } }, plus optional gitlinks. */
function fixtureRepo(files, { gitlinks = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-inventory-'));
  repos.push(dir);
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  g('init', '-q'); g('config', 'user.email', 'f@example.invalid'); g('config', 'user.name', 'f'); g('config', 'commit.gpgsign', 'false');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (content && typeof content === 'object' && content.symlink) fs.symlinkSync(content.symlink, abs);
    else fs.writeFileSync(abs, content);
  }
  // -f: force-add, so the fixture never depends on the machine's global gitignore. Measured 2026-09-14 — a
  // global `node_modules/` ignore silently dropped the vendored fixture file and the case tested nothing.
  g('add', '-A', '-f');
  for (const p of gitlinks) g('update-index', '--add', '--cacheinfo', `160000,${'e'.repeat(40)},${p}`);
  g('commit', '-q', '-m', 'fixture');
  return { dir, commit: g('rev-parse', 'HEAD'), g };
}

const snapshot = (repo, name = 'fixture') => snapshotManifest({ repoDir: repo.dir, commit: repo.commit, repo: name });

/** TEST DOUBLE: one unit per "## " section of a .md file. Byte offsets are computed, not assumed. */
const markdownDouble = {
  id: 'test-markdown-double', version: '0', parserIdentity: 'test-double',
  matches: (entry) => entry.path.endsWith('.md'),
  enumerate: ({ text }) => {
    const starts = [];
    const re = /^## .*$/gm;
    let m;
    while ((m = re.exec(text))) starts.push(m.index);
    const byteAt = (charIndex) => Buffer.byteLength(text.slice(0, charIndex), 'utf8');
    return {
      errors: [],
      units: starts.map((s, i) => {
        const e = i + 1 < starts.length ? starts[i + 1] : text.length;
        return {
          kind: 'md-section', name: text.slice(s + 3, text.indexOf('\n', s)), sourceType: 'markdown',
          startByte: byteAt(s), endByte: byteAt(e), startLine: text.slice(0, s).split('\n').length, endLine: text.slice(0, e).split('\n').length,
        };
      }),
    };
  },
};

const SECTIONS = (n, tag) => Array.from({ length: n }, (_, i) => `## ${tag} section ${i}\n\nThe ${tag} behaviour number ${i} is documented here.\n`).join('\n');

describe('fixed dispositions: a narrow published list, and nothing skipped silently', () => {
  it('excludes lockfiles, vendored trees, license files, symlinks and gitlinks; binaries and LFS are modality-excluded', () => {
    expect(fixedDisposition({ path: 'package-lock.json', entryKind: 'file' })).toEqual({ disposition: 'excluded', reason: 'lockfile' });
    expect(fixedDisposition({ path: 'node_modules/dep/readme.md', entryKind: 'file' })).toEqual({ disposition: 'excluded', reason: 'vendored-dependency' });
    expect(fixedDisposition({ path: 'LICENSE', entryKind: 'file' })).toEqual({ disposition: 'excluded', reason: 'license-boilerplate' });
    expect(fixedDisposition({ path: 'link.md', entryKind: 'symlink' })).toEqual({ disposition: 'excluded', reason: 'symlink' });
    expect(fixedDisposition({ path: 'sub', entryKind: 'gitlink' })).toEqual({ disposition: 'excluded', reason: 'submodule-pointer' });
    expect(fixedDisposition({ path: 'img.png', entryKind: 'binary' })).toEqual({ disposition: 'modality-excluded', reason: 'opaque-binary' });
    expect(fixedDisposition({ path: 'w.bin', entryKind: 'lfs-pointer' })).toEqual({ disposition: 'modality-excluded', reason: 'lfs-object-not-in-tree' });
  });

  it('no longer blanket-excludes tests, dist output, changelogs or contributing guides', () => {
    for (const p of ['tests/spec.md', 'dist/bundle.md', 'CHANGELOG.md', 'CONTRIBUTING.md', '.github/workflows/ci.md', 'examples/demo.md']) {
      expect(fixedDisposition({ path: p, entryKind: 'file' }), p).toBeNull();
    }
  });
});

describe('a complete inventory is enumerated, bound to owned bytes, and sampled', () => {
  const repo = () => fixtureRepo({
    'docs/guide.md': SECTIONS(3, 'guide'),
    'tests/spec.md': SECTIONS(1, 'spec'),
    'dist/out.md': SECTIONS(1, 'dist'),
    'LICENSE': 'MIT License\n',
    'package-lock.json': '{}\n',
    'node_modules/dep/readme.md': SECTIONS(2, 'vendored'),
    'img.png': Buffer.from([0x89, 0x00, 0x01]),
    'link.md': { symlink: 'docs/guide.md' },
  }, { gitlinks: ['sub'] });

  it('counts units from tests and dist, never from vendored code, and gives every entry one disposition', () => {
    const r = repo();
    const { manifest, blobs } = snapshot(r);
    const inv = buildInventory({ manifest, blobs, adapters: [markdownDouble] });
    expect(inv.rulesVersion).toBe(RULES_VERSION);
    expect(inv.inventoryComplete).toBe(true);
    expect(inv.U).toBe(5); // 3 guide + 1 tests + 1 dist; the 2 vendored sections are excluded
    expect(inv.entries.map((e) => e.path).sort()).toEqual(manifest.entries.map((e) => e.path).sort());
    const byPath = Object.fromEntries(inv.entries.map((e) => [e.path, e.disposition]));
    expect(byPath).toMatchObject({
      'docs/guide.md': 'eligible', 'tests/spec.md': 'eligible', 'dist/out.md': 'eligible',
      'LICENSE': 'excluded', 'package-lock.json': 'excluded', 'node_modules/dep/readme.md': 'excluded',
      'img.png': 'modality-excluded', 'link.md': 'excluded', 'sub': 'excluded',
    });
    expect(inv.selection).toMatchObject({ U: 5, K: 5, N: 10 });
  });

  it('binds each unit to the exact owned bytes of the committed blob, with a deterministic id', () => {
    const r = repo();
    const { manifest, blobs } = snapshot(r);
    const a = buildInventory({ manifest, blobs, adapters: [markdownDouble] });
    const b = buildInventory({ manifest, blobs, adapters: [markdownDouble] });
    expect(a.units).toEqual(b.units);
    for (const u of a.units) {
      const blob = blobs.get(u.blobSha);
      expect(u.bytesSha256).toBe(crypto.createHash('sha256').update(blob.subarray(u.startByte, u.endByte)).digest('hex'));
      expect(u.adapter).toBe('test-markdown-double@0');
    }
    expect(new Set(a.units.map((u) => u.unitId)).size).toBe(a.units.length);
  });
});

describe('INCOMPLETE inventories report U=null with a lower bound, and are never sampled', () => {
  it('MUST BLOCK: an entry no adapter supports', () => {
    const r = fixtureRepo({ 'README.md': SECTIONS(2, 'readme'), 'scripts/run.sh': '#!/bin/sh\necho hi\n' });
    const { manifest, blobs } = snapshot(r);
    const inv = buildInventory({ manifest, blobs, adapters: [markdownDouble] });
    expect(inv).toMatchObject({ inventoryComplete: false, U: null, enumeratedU: 2, selection: null });
    expect(inv.unsupported.map((u) => u.path)).toEqual(['scripts/run.sh']);
  });

  it('MUST BLOCK: parser diagnostics on any file, recorded with the adapter identity', () => {
    const failing = { ...markdownDouble, id: 'diagnosing-double', enumerate: ({ path: p, text }) => (p === 'bad.md'
      ? { units: [], errors: [{ message: 'unmatched fence', location: { line: 3 } }] }
      : markdownDouble.enumerate({ text })) };
    const r = fixtureRepo({ 'good.md': SECTIONS(2, 'good'), 'bad.md': SECTIONS(4, 'bad') });
    const { manifest, blobs } = snapshot(r);
    const inv = buildInventory({ manifest, blobs, adapters: [failing] });
    expect(inv).toMatchObject({ inventoryComplete: false, U: null, enumeratedU: 2, selection: null });
    expect(inv.failures).toEqual([expect.objectContaining({ path: 'bad.md', adapter: 'diagnosing-double@0', message: 'unmatched fence' })]);
    // Never a whole-file fallback: the failed file contributes no units at all.
    expect(inv.units.every((u) => u.path === 'good.md')).toBe(true);
  });

  it('MUST BLOCK: an adapter that throws is a recorded failure, not a crash and not a silent skip', () => {
    const throwing = { ...markdownDouble, id: 'throwing-double', enumerate: () => { throw new Error('boom'); } };
    const r = fixtureRepo({ 'a.md': SECTIONS(1, 'a') });
    const { manifest, blobs } = snapshot(r);
    const inv = buildInventory({ manifest, blobs, adapters: [throwing] });
    expect(inv).toMatchObject({ inventoryComplete: false, U: null });
    expect(inv.failures[0].message).toMatch(/adapter threw: boom/);
  });

  it('MUST BLOCK: text that is not valid UTF-8', () => {
    const r = fixtureRepo({ 'a.md': Buffer.from([0x23, 0x23, 0x20, 0xff, 0xfe, 0x41, 0x0a]) });
    const { manifest, blobs } = snapshot(r);
    const inv = buildInventory({ manifest, blobs, adapters: [markdownDouble] });
    expect(inv).toMatchObject({ inventoryComplete: false, U: null });
    expect(inv.failures[0].message).toMatch(/not valid UTF-8/);
  });

  it('refuses an adapter that returns an owned span outside the blob — that is a programming error', () => {
    const bogus = { ...markdownDouble, id: 'bogus-double', enumerate: () => ({ errors: [], units: [{ kind: 'x', sourceType: 'markdown', startByte: 0, endByte: 9_999_999 }] }) };
    const r = fixtureRepo({ 'a.md': SECTIONS(1, 'a') });
    const { manifest, blobs } = snapshot(r);
    expect(() => buildInventory({ manifest, blobs, adapters: [bogus] })).toThrow(/invalid owned span/);
  });
});

describe('complete accounting that finds nothing is flagged for review, never read as a measurement', () => {
  it('U=0 is NOT_MEASURED: no selection, and emptiness requires independent review', () => {
    const r = fixtureRepo({ 'LICENSE': 'MIT\n', 'logo.png': Buffer.from([0x00, 0x01, 0x02]), 'alias.md': { symlink: 'LICENSE' } });
    const { manifest, blobs } = snapshot(r);
    const inv = buildInventory({ manifest, blobs, adapters: [markdownDouble] });
    expect(inv).toMatchObject({ inventoryComplete: true, U: 0, emptyOfEligibleSource: true, requiresEmptinessReview: true, selection: null });
  });

  it('refuses to run without a source-tree snapshot manifest', () => {
    expect(() => buildInventory({ manifest: { repo: 'r' }, blobs: new Map(), adapters: [] })).toThrow(/snapshot manifest/);
  });
});
