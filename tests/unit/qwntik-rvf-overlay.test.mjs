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
  verifyRetiredArtifacts,
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
  const familyRoutes = {};
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
    const routingAlias = {
      alias: `${family}-cluster`,
      familyManifestHash: `${family}-manifest-hash`,
      sourceCommit: `${family}-commit`,
      registration: { activeRegistration: true },
      stores: [name],
      routes: { implementation: [name] },
    };
    writeJson(path.join(overlayDir, 'manifests', `${family}-routing-alias.json`), routingAlias);
    familyRoutes[routingAlias.alias] = routingAlias;
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
  writeJson(path.join(manifestsDir, 'family-routes.json'), { families: familyRoutes });
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

  it.skipIf(process.platform === 'win32')('rejects a sidecar symlink even when its bytes and digest match the manifest', () => {
    const f = fixture();
    const manifestFile = path.join(f.overlayDir, 'manifests', 'testimate-family-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const sidecar = Buffer.from('sidecar-bytes');
    const sidecarName = 'testimate-source.idmap.json';
    manifest.stores[0].files.push({ path: sidecarName, bytes: sidecar.length, sha256: sha(sidecar) });
    writeJson(manifestFile, manifest);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'qwntik-sidecar-outside-'));
    fs.writeFileSync(path.join(outside, sidecarName), sidecar);
    fs.symlinkSync(path.join(outside, sidecarName), path.join(f.kbDir, sidecarName));
    const overlay = captureOverlay(f);

    expect(verifyOverlayArtifacts({ overlay, ...f })).toEqual(expect.arrayContaining([
      expect.stringContaining('invalid sidecar testimate-source.idmap.json: file is a symbolic link'),
    ]));
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked manifests root before any external manifest write', () => {
    const f = fixture();
    const overlay = captureOverlay(f);
    const realManifests = `${f.manifestsDir}-real`;
    fs.renameSync(f.manifestsDir, realManifests);
    fs.symlinkSync(realManifests, f.manifestsDir, 'dir');
    const target = path.join(realManifests, 'testimate-family-manifest.json');
    const before = fs.readFileSync(target);

    expect(() => applyOverlay({ overlay, ...f })).toThrow(/manifests root must be a real directory/);
    expect(fs.readFileSync(target)).toEqual(before);
    expect(fs.existsSync(f.backupDir)).toBe(false);
  });

  it('allows a declared replacement whose name extends the retired store stem', () => {
    const f = fixture();
    const retired = 'saythanks-ua';
    const replacement = 'saythanks-ua-large';
    const retiredFile = `${retired}.big.rvf`;
    const replacementFile = `${replacement}.big.rvf`;
    fs.writeFileSync(path.join(f.kbDir, retiredFile), 'retired');
    fs.writeFileSync(path.join(f.kbDir, replacementFile), 'replacement');
    const familyFile = path.join(f.overlayDir, 'manifests', 'saythanks-family-manifest.json');
    const family = JSON.parse(fs.readFileSync(familyFile, 'utf8'));
    family.retiredStores = [{ name: retired, replacement, files: [{ path: retiredFile, bytes: 7, sha256: sha('retired') }] }];
    writeJson(familyFile, family);
    const overlay = captureOverlay(f);

    expect(verifyOverlayRegistration({ overlay, ...f })).not.toContain(
      `saythanks-ua: retired filesystem artifact remains: ${replacementFile}`,
    );
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

  it.skipIf(process.platform === 'win32')('rejects active artifact traversal and direct or ancestor symlinks', () => {
    const f = fixture();
    const overlay = captureOverlay(f);
    const name = 'testimate-source';
    const original = path.join(f.kbDir, `${name}.rvf`);
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwntik-overlay-outside-'));
    const outsideFile = path.join(outsideDir, 'outside.rvf');
    const bytes = fs.readFileSync(original);
    fs.writeFileSync(outsideFile, bytes);

    fs.unlinkSync(original);
    fs.symlinkSync(outsideFile, original);
    expect(verifyOverlayArtifacts({ overlay, ...f })).toContain(
      `${name}: invalid ${name}.rvf: file is a symbolic link`,
    );

    fs.unlinkSync(original);
    const linkDir = path.join(f.kbDir, 'linked');
    fs.symlinkSync(outsideDir, linkDir, 'dir');
    overlay.generations.stores[name].file = 'linked/outside.rvf';
    expect(verifyOverlayArtifacts({ overlay, ...f })).toContain(
      `${name}: invalid linked/outside.rvf: real path escapes the KB root`,
    );

    overlay.generations.stores[name].file = path.join('..', path.basename(outsideDir), 'outside.rvf');
    expect(verifyOverlayArtifacts({ overlay, ...f })).toEqual(expect.arrayContaining([
      expect.stringContaining('path escapes the KB root'),
    ]));
  });

  it.skipIf(process.platform === 'win32')('rejects a symbolic-link retirement artifact', () => {
    const f = fixture();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwntik-retired-outside-'));
    const outsideFile = path.join(outsideDir, 'retired.rvf');
    const bytes = Buffer.from('retired-outside');
    fs.writeFileSync(outsideFile, bytes);
    fs.symlinkSync(outsideFile, path.join(f.kbDir, 'retired.rvf'));
    const overlay = {
      retiredStores: [{
        name: 'retired',
        files: [{ path: 'retired.rvf', bytes: bytes.length, sha256: sha(bytes) }],
      }],
    };

    expect(verifyRetiredArtifacts({ overlay, ...f })).toEqual([
      'retired: invalid retirement artifact retired.rvf: file is a symbolic link',
    ]);
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
      path.join(f.manifestsDir, 'family-routes.json'),
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

  it('retires declared stores and artifacts while preserving a complete rollback', () => {
    const f = fixture();
    const retiredName = 'saythanks-compact';
    const retiredBytes = Buffer.from('retired-rvf');
    const retiredFile = `${retiredName}.rvf`;
    fs.writeFileSync(path.join(f.kbDir, retiredFile), retiredBytes);

    const aliases = JSON.parse(fs.readFileSync(path.join(f.kbDir, 'repo-aliases.json'), 'utf8'));
    aliases.saythanks.push(retiredName);
    aliases[retiredName] = ['legacy-compact'];
    writeJson(path.join(f.kbDir, 'repo-aliases.json'), aliases);
    const generations = JSON.parse(fs.readFileSync(path.join(f.kbDir, 'RVF-GENERATIONS.json'), 'utf8'));
    generations.stores[retiredName] = { file: retiredFile, sha256: sha(retiredBytes), bytes: retiredBytes.length };
    writeJson(path.join(f.kbDir, 'RVF-GENERATIONS.json'), generations);
    const source = JSON.parse(fs.readFileSync(path.join(f.kbDir, 'SOURCE.json'), 'utf8'));
    source.stores[retiredName] = { kbName: retiredName, updateManaged: false };
    writeJson(path.join(f.kbDir, 'SOURCE.json'), source);
    const custom = JSON.parse(fs.readFileSync(path.join(f.manifestsDir, 'custom-stores.json'), 'utf8'));
    custom.stores.push({ name: retiredName });
    writeJson(path.join(f.manifestsDir, 'custom-stores.json'), custom);
    fs.appendFileSync(path.join(f.kbDir, 'capability-cards.md'), `\n## ${retiredName}\nretired card\n`);

    const familyFile = path.join(f.overlayDir, 'manifests', 'saythanks-family-manifest.json');
    const family = JSON.parse(fs.readFileSync(familyFile, 'utf8'));
    family.retiredStores = [{
      name: retiredName,
      files: [{ path: retiredFile, sha256: sha(retiredBytes), bytes: retiredBytes.length }],
      replacement: 'saythanks-source',
    }];
    writeJson(familyFile, family);
    const routeFile = path.join(f.overlayDir, 'manifests', 'saythanks-routing-alias.json');
    const route = JSON.parse(fs.readFileSync(routeFile, 'utf8'));
    route.retiredStores = [retiredName];
    writeJson(routeFile, route);

    const overlay = captureOverlay(f);
    expect(verifyOverlayRegistration({ overlay, ...f })).toEqual(expect.arrayContaining([
      `repo-aliases.json retained retired store: ${retiredName}`,
      `RVF-GENERATIONS.json retained retired store: ${retiredName}`,
      `SOURCE.json retained retired store: ${retiredName}`,
      `custom-stores.json retained retired store: ${retiredName}`,
      `capability-cards.md retained retired store: ${retiredName}`,
    ]));
    aliases.afterCapture = [retiredName];
    writeJson(path.join(f.kbDir, 'repo-aliases.json'), aliases);
    expect(() => applyOverlay({ overlay, ...f })).toThrow(/unexpected reverse-alias collision: afterCapture/);
    expect(fs.existsSync(f.backupDir)).toBe(false);
    delete aliases.afterCapture;
    writeJson(path.join(f.kbDir, 'repo-aliases.json'), aliases);
    applyOverlay({ overlay, ...f });

    expect(verifyOverlayRegistration({ overlay, ...f })).toEqual([]);
    expect(fs.existsSync(path.join(f.kbDir, retiredFile))).toBe(false);
    expect(fs.readFileSync(path.join(f.backupDir, 'retired-artifacts', retiredFile))).toEqual(retiredBytes);
    expect(JSON.parse(fs.readFileSync(path.join(f.kbDir, 'RVF-GENERATIONS.json'), 'utf8')).stores[retiredName]).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(f.manifestsDir, 'family-routes.json'), 'utf8')).families['saythanks-cluster'])
      .toEqual(route);

    const secondBackup = path.join(f.root, 'backup-second');
    expect(applyOverlay({ overlay, ...f, backupDir: secondBackup })).toMatchObject({ alreadyApplied: true });
    expect(fs.existsSync(secondBackup)).toBe(false);
    fs.writeFileSync(path.join(f.kbDir, `${retiredName}.secret.rvf`), 'stale retired remnant');
    expect(verifyOverlayRegistration({ overlay, ...f })).toContain(
      `saythanks-compact: retired filesystem artifact remains: ${retiredName}.secret.rvf`,
    );
  });

  it('refuses to retire a store whose recorded predecessor changed after capture', () => {
    const f = fixture();
    const retiredName = 'saythanks-compact';
    const retiredBytes = Buffer.from('retired-rvf');
    fs.writeFileSync(path.join(f.kbDir, `${retiredName}.rvf`), retiredBytes);
    const generationsFile = path.join(f.kbDir, 'RVF-GENERATIONS.json');
    const generations = JSON.parse(fs.readFileSync(generationsFile, 'utf8'));
    generations.stores[retiredName] = { file: `${retiredName}.rvf`, sha256: sha(retiredBytes), bytes: retiredBytes.length };
    writeJson(generationsFile, generations);
    const familyFile = path.join(f.overlayDir, 'manifests', 'saythanks-family-manifest.json');
    const family = JSON.parse(fs.readFileSync(familyFile, 'utf8'));
    family.retiredStores = [{
      name: retiredName,
      files: [{ path: `${retiredName}.rvf`, sha256: sha(retiredBytes), bytes: retiredBytes.length }],
    }];
    writeJson(familyFile, family);
    const overlay = captureOverlay(f);
    generations.stores[retiredName] = { ...generations.stores[retiredName], owner: 'changed-after-capture' };
    writeJson(generationsFile, generations);

    expect(() => applyOverlay({ overlay, ...f }))
      .toThrow(/RVF-GENERATIONS\.json retired store unexpected collision: saythanks-compact/);
    expect(fs.existsSync(f.backupDir)).toBe(false);
    expect(fs.readFileSync(path.join(f.kbDir, `${retiredName}.rvf`))).toEqual(retiredBytes);
  });

  it('restores retired artifacts and family routes after a post-retirement failure', () => {
    const f = fixture();
    const retiredName = 'saythanks-compact';
    const retiredFile = `${retiredName}.rvf`;
    const retiredBytes = Buffer.from('retired-rvf');
    fs.writeFileSync(path.join(f.kbDir, retiredFile), retiredBytes);
    const generationsFile = path.join(f.kbDir, 'RVF-GENERATIONS.json');
    const generations = JSON.parse(fs.readFileSync(generationsFile, 'utf8'));
    generations.stores[retiredName] = { file: retiredFile, sha256: sha(retiredBytes), bytes: retiredBytes.length };
    writeJson(generationsFile, generations);
    const familyFile = path.join(f.overlayDir, 'manifests', 'saythanks-family-manifest.json');
    const family = JSON.parse(fs.readFileSync(familyFile, 'utf8'));
    family.retiredStores = [{
      name: retiredName,
      files: [{ path: retiredFile, sha256: sha(retiredBytes), bytes: retiredBytes.length }],
    }];
    writeJson(familyFile, family);
    const routeFile = path.join(f.overlayDir, 'manifests', 'saythanks-routing-alias.json');
    const route = JSON.parse(fs.readFileSync(routeFile, 'utf8'));
    route.refresh = 'retirement-target';
    writeJson(routeFile, route);
    const overlay = captureOverlay(f);
    const targets = [
      path.join(f.kbDir, 'repo-aliases.json'),
      generationsFile,
      path.join(f.kbDir, 'SOURCE.json'),
      path.join(f.kbDir, 'capability-cards.md'),
      path.join(f.manifestsDir, 'custom-stores.json'),
      path.join(f.manifestsDir, 'family-routes.json'),
      ...Object.keys(overlay.manifestDigests).map((name) => path.join(f.manifestsDir, name)),
    ];
    const before = new Map(targets.map((file) => [file, fs.readFileSync(file)]));

    expect(() => applyOverlay({
      overlay,
      ...f,
      injectFailure(boundary) {
        if (boundary === 'retired-artifacts') throw new Error('post-retirement failure');
      },
    })).toThrow(/post-retirement failure[\s\S]*Rolled back/);
    for (const file of targets) expect(fs.readFileSync(file)).toEqual(before.get(file));
    expect(fs.readFileSync(path.join(f.kbDir, retiredFile))).toEqual(retiredBytes);
  });
});
