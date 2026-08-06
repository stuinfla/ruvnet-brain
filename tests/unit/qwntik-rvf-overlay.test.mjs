import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyOverlay,
  captureOverlay,
  verifyOverlayArtifacts,
  verifyOverlayRegistration,
} from '../../overlays/qwntik/rvf-families/registry.mjs';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwntik-rvf-overlay-'));
  const kbDir = path.join(root, 'kb');
  const manifestsDir = path.join(root, 'manifests-live');
  const overlayDir = path.join(root, 'overlay');
  const backupDir = path.join(root, 'backup');
  fs.mkdirSync(kbDir, { recursive: true });
  fs.mkdirSync(manifestsDir, { recursive: true });

  const entries = {};
  const customStores = [];
  const aliases = { untouched: ['public-store'] };
  for (const family of ['testimate', 'makerkit', 'saythanks']) {
    const name = `${family}-source`;
    const bytes = Buffer.from(`rvf:${family}`);
    fs.writeFileSync(path.join(kbDir, `${name}.rvf`), bytes);
    entries[name] = {
      file: `${name}.rvf`,
      sha256: sha(bytes),
      bytes: bytes.length,
      model: 'fixture',
      dimensions: 3,
      sourceCommit: `${family}-commit`,
      builtUtc: '2026-08-06T00:00:00.000Z',
      family: `${family}-cluster`,
      familyManifestHash: `${family}-manifest-hash`,
      producer: 'fixture',
      role: 'primary-source',
    };
    customStores.push({
      name,
      source: `/source/${family}`,
      source_commit: `${family}-commit`,
      family: `${family}-cluster`,
      family_manifest_hash: `${family}-manifest-hash`,
      producer: 'fixture',
      role: 'primary-source',
    });
    aliases[family] = [name];
    writeJson(path.join(overlayDir, 'manifests', `${family}-family-manifest.json`), {
      family,
      familyName: `${family}-cluster`,
      sourceCommit: `${family}-commit`,
      familyManifestHash: `${family}-manifest-hash`,
      registration: { activeRegistration: true },
      stores: [{
        name,
        role: 'primary-source',
        files: [{ path: `${family}/${name}.rvf`, sha256: sha(bytes), bytes: bytes.length }],
      }],
    });
    writeJson(path.join(overlayDir, 'manifests', `${family}-routing-alias.json`), {
      alias: `${family}-cluster`,
      familyManifestHash: `${family}-manifest-hash`,
      sourceCommit: `${family}-commit`,
      registration: { activeRegistration: true },
      stores: [name],
    });
  }

  writeJson(path.join(kbDir, 'repo-aliases.json'), aliases);
  writeJson(path.join(kbDir, 'RVF-GENERATIONS.json'), {
    schemaVersion: 1,
    brainVersion: 'fixture',
    releaseTag: 'fixture',
    stores: { public: { file: 'public.rvf' }, ...entries },
  });
  writeJson(path.join(kbDir, 'SOURCE.json'), { stores: { public: { kbName: 'public' } } });
  fs.writeFileSync(path.join(kbDir, 'capability-cards.md'), '# Cards\n\n## public\npublic card\n\n## saythanks\nprivate card\n');
  writeJson(path.join(manifestsDir, 'custom-stores.json'), {
    stores: [{ name: 'unrelated' }, ...customStores],
  });
  for (const name of fs.readdirSync(path.join(overlayDir, 'manifests'))) {
    fs.copyFileSync(path.join(overlayDir, 'manifests', name), path.join(manifestsDir, name));
  }
  return { root, kbDir, manifestsDir, overlayDir, backupDir };
}

describe('QWNTIK private RVF overlay', () => {
  it('captures, applies, backs up, and verifies private families without replacing unrelated entries', () => {
    const f = fixture();
    const overlay = captureOverlay(f);
    expect(Object.keys(overlay.generations.stores)).toHaveLength(3);
    expect(Object.values(overlay.sourceStores).every((store) => store.updateManaged === false)).toBe(true);
    expect(overlay.capabilityCards.saythanks).toBe('## saythanks\nprivate card');
    expect(verifyOverlayArtifacts({ overlay, ...f })).toEqual([]);
    expect(verifyOverlayRegistration({ overlay, ...f })).toEqual(expect.arrayContaining([
      expect.stringMatching(/^SOURCE\.json mismatch:/),
    ]));

    applyOverlay({ overlay, ...f });

    expect(verifyOverlayRegistration({ overlay, ...f })).toEqual([]);
    expect(fs.existsSync(path.join(f.backupDir, 'SOURCE.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(f.kbDir, 'SOURCE.json'))).stores.public).toEqual({ kbName: 'public' });
    expect(JSON.parse(fs.readFileSync(path.join(f.manifestsDir, 'custom-stores.json'))).stores[0]).toEqual({ name: 'unrelated' });
    expect(fs.readFileSync(path.join(f.kbDir, 'capability-cards.md'), 'utf8')).toContain('## public\npublic card');
  });

  it('refuses to reuse a rollback directory', () => {
    const f = fixture();
    const overlay = captureOverlay(f);
    fs.mkdirSync(f.backupDir);
    expect(() => applyOverlay({ overlay, ...f })).toThrow(/backup directory already exists/);
  });

  it('fails artifact verification when an RVF changes after capture', () => {
    const f = fixture();
    const overlay = captureOverlay(f);
    fs.appendFileSync(path.join(f.kbDir, 'testimate-source.rvf'), 'tampered');
    expect(verifyOverlayArtifacts({ overlay, ...f })).toEqual(expect.arrayContaining([
      expect.stringMatching(/^testimate-source: bytes/),
      expect.stringMatching(/^testimate-source: sha256/),
    ]));
  });

  it('rejects a private source entry that could reach the public updater', () => {
    const f = fixture();
    const overlay = captureOverlay(f);
    overlay.sourceStores['testimate-source'].updateManaged = true;
    overlay.sourceStores['testimate-source'].canonicalBundleUrl = 'https://example.invalid/public.zip';
    expect(verifyOverlayArtifacts({ overlay, ...f })).toEqual(expect.arrayContaining([
      'testimate-source: private source entry must set updateManaged=false',
      'testimate-source: private source entry must not declare a public update URL',
    ]));
  });

  it('rejects semantic drift between family and routing manifests', () => {
    const f = fixture();
    const overlay = captureOverlay(f);
    const file = path.join(f.overlayDir, 'manifests', 'testimate-family-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.familyName = 'wrong-family';
    writeJson(file, manifest);
    overlay.manifestDigests['testimate-family-manifest.json'] = sha(fs.readFileSync(file));
    expect(verifyOverlayArtifacts({ overlay, ...f })).toContain('testimate: familyName does not match routing alias');
  });

  it('rejects per-store role drift across the canonical registrations', () => {
    const f = fixture();
    const overlay = captureOverlay(f);
    overlay.generations.stores['testimate-source'].role = 'wrong-role';
    expect(verifyOverlayArtifacts({ overlay, ...f })).toContain(
      'testimate-source: generation role does not match family manifest',
    );
  });

  it('fails an unexpected live ownership collision before any write or backup', () => {
    const f = fixture();
    const overlay = captureOverlay(f);
    const sourceFile = path.join(f.kbDir, 'SOURCE.json');
    const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    source.stores['testimate-source'] = { kbName: 'testimate-source', owner: 'unexpected-public-owner' };
    writeJson(sourceFile, source);
    const before = fs.readFileSync(sourceFile);

    expect(() => applyOverlay({ overlay, ...f })).toThrow(/SOURCE\.json unexpected collision: testimate-source/);
    expect(fs.readFileSync(sourceFile)).toEqual(before);
    expect(fs.existsSync(f.backupDir)).toBe(false);
  });

  it('fails when a recorded non-null predecessor unexpectedly disappears', () => {
    const f = fixture();
    const initial = captureOverlay(f);
    const sourceFile = path.join(f.kbDir, 'SOURCE.json');
    const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    source.stores['testimate-source'] = initial.sourceStores['testimate-source'];
    writeJson(sourceFile, source);
    const overlay = captureOverlay(f);
    delete source.stores['testimate-source'];
    writeJson(sourceFile, source);

    expect(() => applyOverlay({ overlay, ...f })).toThrow(/SOURCE\.json unexpected collision: testimate-source/);
    expect(fs.existsSync(f.backupDir)).toBe(false);
  });

  it('fails when a recorded manifest predecessor unexpectedly disappears', () => {
    const f = fixture();
    const overlay = captureOverlay(f);
    fs.unlinkSync(path.join(f.manifestsDir, 'testimate-family-manifest.json'));

    expect(() => applyOverlay({ overlay, ...f })).toThrow(/manifest unexpected collision: testimate-family-manifest\.json/);
    expect(fs.existsSync(f.backupDir)).toBe(false);
  });

  it('restores every registry, card, and manifest after an injected post-mutation failure', () => {
    const f = fixture();
    const overlay = captureOverlay(f);
    const targets = [
      path.join(f.kbDir, 'repo-aliases.json'),
      path.join(f.kbDir, 'RVF-GENERATIONS.json'),
      path.join(f.kbDir, 'SOURCE.json'),
      path.join(f.kbDir, 'capability-cards.md'),
      path.join(f.manifestsDir, 'custom-stores.json'),
      ...Object.keys(overlay.manifestDigests).map((name) => path.join(f.manifestsDir, name)),
    ];
    const before = new Map(targets.map((file) => [file, fs.readFileSync(file)]));

    expect(() => applyOverlay({
      overlay,
      ...f,
      injectFailure(boundary) {
        if (boundary === 'capability-cards') throw new Error('injected failure');
      },
    })).toThrow(/injected failure[\s\S]*Rolled back/);
    for (const file of targets) expect(fs.readFileSync(file)).toEqual(before.get(file));
  });
});
