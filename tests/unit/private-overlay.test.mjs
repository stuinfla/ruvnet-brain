// private-overlay.test.mjs — the writer that stamps `updateManaged:false` ownership onto pre-built
// PRIVATE stores so kb/forge-update.mjs preserves them across a public bundle apply.
//
// Every fixture here is a tmpdir. The root mirrors the CURRENT live shape measured 2026-09-12:
// SOURCE.json with a top-level canonicalManifestUrl + brainVersion/releaseTag and an OBJECT of
// stores; RVF-GENERATIONS.json with the schemaVersion-2 runtime-ledger identity; repo-aliases.json
// (canonical → nicknames); capability-cards.md (`## <name>` sections); PRIVATE-STORES.json fence.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyPrivateOverlay } from '../../scripts/private-overlay.mjs';
import { applyPublicBundlePreservingPrivate, capturePrivateOverlayState } from '../../kb/forge-update.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/private-overlay.mjs');
const STORE = 'fixture-private';
const MANIFEST_URL = 'https://example.invalid/releases/latest';
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
/** Byte snapshot of every regular file under a root, keyed by relative path. */
function treeBytes(root) {
  const out = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    out[path.relative(root, file)] = fs.readFileSync(file).toString('hex');
  }
  return out;
}
const allStores = (root) => Object.entries(readJson(path.join(root, 'SOURCE.json')).stores)
  .map(([kbName, value]) => ({ kbName, ...value }));

function liveShapedRoot({ fence = [STORE] } = {}) {
  const root = tmp('private-overlay-root-');
  const publicEntry = {
    kbName: 'public-store', sourceRepo: 'https://example.invalid/public-store', sourceCommit: 'a'.repeat(40),
    sourceDescribe: 'v1', builtUtc: '2026-08-20T07:15:56.544Z', builder: 'rvf-kb-forge',
    canonicalManifestUrl: MANIFEST_URL, canonicalBundleUrl: 'https://example.invalid/public-store-kb-bundle.zip',
  };
  writeJson(path.join(root, 'SOURCE.json'), {
    builder: 'rvf-kb-forge', builtUtc: '2026-08-20T07:16:20.675Z', canonicalManifestUrl: MANIFEST_URL,
    selfUpdate: 'node forge-update.mjs', brainVersion: '0.0.0-fixture-live', releaseTag: 'v0.0.0-fixture-live',
    stores: { 'public-store': publicEntry },
  });
  fs.writeFileSync(path.join(root, 'public-store.big.rvf'), 'public-bytes');
  writeJson(path.join(root, 'RVF-GENERATIONS.json'), {
    schemaVersion: 2, kind: 'ruvnet-brain-runtime-generation-ledger', brainVersion: '0.0.0-fixture-live', releaseTag: 'v0.0.0-fixture-live',
    sourceSnapshot: 'b'.repeat(40),
    stores: { 'public-store': { file: 'public-store.big.rvf', sha256: sha('public-bytes'), bytes: 12, model: 'fixture-model', dimensions: 8, sourceCommit: 'a'.repeat(40), builtUtc: '2026-08-20T17:36:29.517Z' } },
  });
  writeJson(path.join(root, 'repo-aliases.json'), { 'public-store': ['pub'] });
  fs.writeFileSync(path.join(root, 'capability-cards.md'), '# Capability Cards\n\nIntro paragraph.\n\n## public-store\nPublic card body.\n');
  writeJson(path.join(root, 'PRIVATE-STORES.json'), { privateStores: fence });
  return root;
}

function sidecarDir({ omit = [], primer = true, meta = { name: STORE, generated: '2026-07-31T15:15:56.164Z' } } = {}) {
  const from = tmp('private-overlay-from-');
  const files = {
    [`${STORE}.big.rvf`]: 'private-rvf-bytes',
    [`${STORE}.big.rvf.embed.json`]: JSON.stringify({ model: 'fixture-model', dimensions: 8, metric: 'cosine', generated: '2026-07-31T15:15:56.164Z' }),
    [`${STORE}.big.rvf.idmap.json`]: JSON.stringify({ 0: 'p0' }),
    [`${STORE}.meta.json`]: JSON.stringify(meta),
    [`${STORE}.passages.jsonl`]: '{"id":"p0","text":"fixture passage"}\n',
    [`${STORE}.symbols.json`]: JSON.stringify({ symbols: [] }),
  };
  if (primer) files[`${STORE}-primer.md`] = `# ${STORE} — Primer\n\n<!-- Generated primer -->\n\n## What it is & who it's for\n\n**Fixture-private** is a *test-only* store for the overlay writer.\n\n- one bullet\n\n## Capabilities\n\nignored second section\n`;
  for (const [name, body] of Object.entries(files)) if (!omit.includes(name)) fs.writeFileSync(path.join(from, name), body);
  return from;
}

describe('private-overlay writer', () => {
  it('stamps updateManaged:false into SOURCE.json and preserves every existing key and entry', () => {
    const root = liveShapedRoot(); const from = sidecarDir();
    const before = readJson(path.join(root, 'SOURCE.json'));
    applyPrivateOverlay({ root, from, stores: [STORE] });
    const after = readJson(path.join(root, 'SOURCE.json'));
    expect(after.stores[STORE]).toEqual({
      kbName: STORE, updateManaged: false, builtUtc: '2026-07-31T15:15:56.164Z',
      sourceCommit: null, sourceRepo: 'private', canonicalManifestUrl: null,
    });
    expect(after.canonicalManifestUrl).toBe(MANIFEST_URL);
    const { stores: afterStores, ...afterTop } = after;
    const { stores: beforeStores, ...beforeTop } = before;
    expect(afterTop).toEqual(beforeTop);
    expect(afterStores['public-store']).toEqual(beforeStores['public-store']);
    expect(Object.keys(afterStores)).toEqual(['public-store', STORE]);
  });

  it('records the RVF generation with the ledger identity untouched and the bytes copied exactly', () => {
    const root = liveShapedRoot(); const from = sidecarDir();
    const before = readJson(path.join(root, 'RVF-GENERATIONS.json'));
    applyPrivateOverlay({ root, from, stores: [STORE] });
    const after = readJson(path.join(root, 'RVF-GENERATIONS.json'));
    expect(after.stores[STORE]).toEqual({
      file: `${STORE}.big.rvf`, sha256: sha('private-rvf-bytes'), bytes: 17, model: 'fixture-model', dimensions: 8,
      sourceCommit: null, builtUtc: '2026-07-31T15:15:56.164Z',
    });
    const { stores: _a, ...afterTop } = after; const { stores: _b, ...beforeTop } = before;
    expect(afterTop).toEqual(beforeTop);
    expect(afterTop.brainVersion).toBe('0.0.0-fixture-live');
    expect(after.stores['public-store']).toEqual(before.stores['public-store']);
    for (const suffix of ['.big.rvf', '.big.rvf.embed.json', '.big.rvf.idmap.json', '.meta.json', '.passages.jsonl', '.symbols.json']) {
      expect(fs.readFileSync(path.join(root, STORE + suffix))).toEqual(fs.readFileSync(path.join(from, STORE + suffix)));
    }
    expect(fs.readFileSync(path.join(root, 'capability-cards.md'), 'utf8')).toMatch(new RegExp(`^## ${STORE}\\n.*Fixture-private is a test-only store`, 'm'));
    expect(fs.readFileSync(path.join(root, 'capability-cards.md'), 'utf8')).toContain('## public-store\nPublic card body.');
  });

  it('snapshots SOURCE.json and RVF-GENERATIONS.json before the first write', () => {
    const root = liveShapedRoot(); const from = sidecarDir();
    const before = treeBytes(root);
    applyPrivateOverlay({ root, from, stores: [STORE], now: () => 1789200000000 });
    for (const file of ['SOURCE.json', 'RVF-GENERATIONS.json']) {
      expect(fs.readFileSync(path.join(root, `${file}.pre-overlay-1789200000000`)).toString('hex')).toBe(before[file]);
    }
  });

  it('is captured by forge-update and SURVIVES a public bundle apply that lacks the store', () => {
    const root = liveShapedRoot(); const from = sidecarDir();
    applyPrivateOverlay({ root, from, stores: [STORE] });
    const overlay = capturePrivateOverlayState({ kbDir: root, allStores: allStores(root) });
    expect(overlay.sourceStores[STORE].updateManaged).toBe(false);
    expect(Object.keys(overlay.files).sort()).toEqual([
      `${STORE}-primer.md`, `${STORE}.big.rvf`, `${STORE}.big.rvf.embed.json`, `${STORE}.big.rvf.idmap.json`,
      `${STORE}.meta.json`, `${STORE}.passages.jsonl`, `${STORE}.symbols.json`,
    ]);
    expect(overlay.cards[STORE]).toMatch(/^## fixture-private\n/);

    const workspace = tmp('private-overlay-bundle-');
    const backupPath = path.join(workspace, 'backup'); const extractDir = path.join(workspace, 'extract');
    fs.cpSync(root, backupPath, { recursive: true });
    fs.mkdirSync(extractDir);
    writeJson(path.join(extractDir, 'SOURCE.json'), { canonicalManifestUrl: MANIFEST_URL, brainVersion: '0.0.0-fixture-next', releaseTag: 'v0.0.0-fixture-next', stores: { 'public-store': { kbName: 'public-store', sourceCommit: 'c'.repeat(40) } } });
    writeJson(path.join(extractDir, 'RVF-GENERATIONS.json'), { schemaVersion: 2, brainVersion: '0.0.0-fixture-next', releaseTag: 'v0.0.0-fixture-next', stores: { 'public-store': { file: 'public-store.big.rvf', sha256: sha('public-v2'), bytes: 9 } } });
    writeJson(path.join(extractDir, 'repo-aliases.json'), { 'public-store': ['pub2'] });
    fs.writeFileSync(path.join(extractDir, 'capability-cards.md'), '# Capability Cards\n\n## public-store\nNew public card.\n');
    fs.writeFileSync(path.join(extractDir, 'public-store.big.rvf'), 'public-v2');
    writeJson(path.join(extractDir, 'PRIVATE-STORES.json'), { privateStores: [STORE] });

    expect(applyPublicBundlePreservingPrivate({ extractDir, kbDir: root, backupPath, overlay })).toEqual({ restored: 1 });
    expect(fs.readFileSync(path.join(root, `${STORE}.big.rvf`), 'utf8')).toBe('private-rvf-bytes');
    expect(fs.readFileSync(path.join(root, 'public-store.big.rvf'), 'utf8')).toBe('public-v2');
    const source = readJson(path.join(root, 'SOURCE.json'));
    expect(source.brainVersion).toBe('0.0.0-fixture-next');
    expect(source.stores[STORE].updateManaged).toBe(false);
    expect(readJson(path.join(root, 'RVF-GENERATIONS.json')).stores[STORE].sha256).toBe(sha('private-rvf-bytes'));
    expect(fs.readFileSync(path.join(root, 'capability-cards.md'), 'utf8')).toMatch(/^## fixture-private\n/m);
  });

  it('is idempotent: a second run changes nothing and adds no snapshot', () => {
    const root = liveShapedRoot(); const from = sidecarDir();
    const first = applyPrivateOverlay({ root, from, stores: [STORE] });
    expect(first.stores[0].changes.length).toBeGreaterThan(0);
    const after = treeBytes(root);
    const second = applyPrivateOverlay({ root, from, stores: [STORE] });
    expect(second.stores[0].changes).toEqual([]);
    expect(second.stores[0].copied).toEqual([]);
    const { 'private-overlay-receipt.json': _r1, ...afterFirst } = after;
    const { 'private-overlay-receipt.json': _r2, ...afterSecond } = treeBytes(root);
    expect(afterSecond).toEqual(afterFirst);
  });

  it('refuses an incomplete sidecar set and writes nothing', () => {
    const root = liveShapedRoot(); const from = sidecarDir({ omit: [`${STORE}.big.rvf.idmap.json`] });
    const before = treeBytes(root);
    expect(() => applyPrivateOverlay({ root, from, stores: [STORE] })).toThrow(/missing sidecar.*\.big\.rvf\.idmap\.json/);
    expect(treeBytes(root)).toEqual(before);
  });

  it('refuses a store the private fence does not list', () => {
    const root = liveShapedRoot({ fence: [] }); const from = sidecarDir();
    const before = treeBytes(root);
    expect(() => applyPrivateOverlay({ root, from, stores: [STORE] })).toThrow(/PRIVATE-STORES\.json/);
    expect(treeBytes(root)).toEqual(before);
  });

  it('refuses to overwrite a different existing .big.rvf without --force, and overwrites with it', () => {
    const root = liveShapedRoot(); const from = sidecarDir();
    fs.writeFileSync(path.join(root, `${STORE}.big.rvf`), 'other-bytes');
    const before = treeBytes(root);
    expect(() => applyPrivateOverlay({ root, from, stores: [STORE] })).toThrow(/--force/);
    expect(treeBytes(root)).toEqual(before);
    applyPrivateOverlay({ root, from, stores: [STORE], force: true });
    expect(fs.readFileSync(path.join(root, `${STORE}.big.rvf`), 'utf8')).toBe('private-rvf-bytes');
  });

  it('refuses a store with no card source instead of inventing one', () => {
    const root = liveShapedRoot(); const from = sidecarDir({ primer: false });
    const before = treeBytes(root);
    expect(() => applyPrivateOverlay({ root, from, stores: [STORE] })).toThrow(/no card source/);
    expect(treeBytes(root)).toEqual(before);
  });

  it('derives a card from the store\'s own meta.json facts when there is no primer', () => {
    const root = liveShapedRoot();
    // Build the meta fixture once, then derive the expected card text FROM it (mirroring
    // scripts/private-overlay.mjs's own metaFacts(): meetings joined with '; ', sources with ', ')
    // rather than re-typing the meeting date and source list a second time as regex literals — the
    // restated-truth class this repo has been burning down all session.
    const meta = { name: STORE, passages: 317, meetings: ['2026-07-16 fixture-meeting'], sources: ['a.txt', 'b.md'] };
    const from = sidecarDir({ primer: false, meta });
    applyPrivateOverlay({ root, from, stores: [STORE] });
    const cards = fs.readFileSync(path.join(root, 'capability-cards.md'), 'utf8');
    const escapeForRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const meetingsText = escapeForRegex(meta.meetings.join('; '));
    const sourcesText = escapeForRegex(meta.sources.join(', '));
    expect(cards).toMatch(new RegExp(`^## ${STORE}\\n.*${meetingsText}.*${sourcesText}`, 'm'));
    expect(cards).toMatch(/meta\.json/);
  });

  // Measured on the live root 2026-09-12: the installer's "local reader" step leaves npm's
  // node_modules/.bin/* symlinks in the KB root, and capturePrivateOverlayState walked the tree in
  // strict mode — so the first flagged private store made the overlay preflight throw on a symlink
  // that has nothing to do with any store. A `.rvf` symlink must still be refused (covered in
  // forge-update-private-overlay.test.mjs); a tooling symlink must be ignored, not fatal.
  it.skipIf(process.platform === 'win32')('is still captured when the root carries an npm .bin tooling symlink, as the installer leaves it', () => {
    const root = liveShapedRoot(); const from = sidecarDir();
    applyPrivateOverlay({ root, from, stores: [STORE] });
    fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'semver.js'), '// tooling');
    fs.symlinkSync(path.join('..', 'semver.js'), path.join(root, 'node_modules', '.bin', 'semver'));
    const overlay = capturePrivateOverlayState({ kbDir: root, allStores: allStores(root) });
    expect(Object.keys(overlay.sourceStores)).toEqual([STORE]);
    expect(Object.keys(overlay.files)).not.toContain(path.join('node_modules', '.bin', 'semver'));
    expect(Object.keys(overlay.files)).toContain(`${STORE}.big.rvf`);
  });

  it('--dry-run reports the plan and writes nothing (CLI entry point)', () => {
    const root = liveShapedRoot(); const from = sidecarDir();
    const before = treeBytes(root);
    const stdout = execFileSync(process.execPath, [SCRIPT, '--root', root, '--from', from, '--store', STORE, '--dry-run'], { encoding: 'utf8' });
    const receipt = JSON.parse(stdout);
    expect(receipt.dryRun).toBe(true);
    expect(receipt.stores[0]).toMatchObject({ name: STORE, changes: ['SOURCE.json', 'RVF-GENERATIONS.json', 'capability-cards.md'] });
    expect(treeBytes(root)).toEqual(before);
  });
});
