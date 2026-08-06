import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyPublicBundlePreservingPrivate,
  capturePrivateOverlayState,
  restorePrivateOverlayState,
  selectUpdateManagedStores,
} from '../../kb/forge-update.mjs';

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function registryFixture() {
  const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-private-'));
  const privateStore = {
    kbName: 'makerkit-source',
    updateManaged: false,
    sourceCommit: 'private-commit',
  };
  writeJson(path.join(kbDir, 'SOURCE.json'), { stores: { public: { kbName: 'public' }, 'makerkit-source': privateStore } });
  writeJson(path.join(kbDir, 'RVF-GENERATIONS.json'), { stores: { public: { file: 'public.rvf' }, 'makerkit-source': { file: 'makerkit-source.rvf', sha256: 'private' } } });
  writeJson(path.join(kbDir, 'repo-aliases.json'), { public: ['public'], makerkit: ['makerkit-source'] });
  fs.writeFileSync(path.join(kbDir, 'capability-cards.md'), '# Cards\n\n## public\nold public\n\n## makerkit\nprivate card\n');
  fs.writeFileSync(path.join(kbDir, 'makerkit-source.rvf'), 'private-rvf-bytes');
  return { kbDir, privateStore };
}

describe('forge-update private overlay boundary', () => {
  const stores = [
    { kbName: 'ruvector' },
    { kbName: 'ruflo' },
    { kbName: 'makerkit-source', updateManaged: false },
    { kbName: 'saythanks', updateManaged: false },
  ];

  it('keeps private stores in provenance while excluding them from public updates', () => {
    expect(selectUpdateManagedStores(stores, 'complete').map((store) => store.kbName)).toEqual([
      'ruvector',
      'ruflo',
    ]);
  });

  it('applies the RuVector-only profile after excluding private stores', () => {
    expect(selectUpdateManagedStores(stores, 'ruvector')).toEqual([{ kbName: 'ruvector' }]);
  });

  it('restores private provenance after a public bundle replaces shared registries', () => {
    const { kbDir, privateStore } = registryFixture();
    const overlay = capturePrivateOverlayState({ kbDir, allStores: [privateStore] });

    writeJson(path.join(kbDir, 'SOURCE.json'), { stores: { public: { kbName: 'public', sourceCommit: 'new-public' } } });
    writeJson(path.join(kbDir, 'RVF-GENERATIONS.json'), { stores: { public: { file: 'public-v2.rvf' } } });
    writeJson(path.join(kbDir, 'repo-aliases.json'), { public: ['public-v2'] });
    fs.writeFileSync(path.join(kbDir, 'capability-cards.md'), '# Cards\n\n## public\nnew public\n');

    expect(restorePrivateOverlayState({ kbDir, overlay })).toEqual({ restored: 1 });
    expect(JSON.parse(fs.readFileSync(path.join(kbDir, 'SOURCE.json'), 'utf8')).stores).toEqual({
      public: { kbName: 'public', sourceCommit: 'new-public' },
      'makerkit-source': privateStore,
    });
    expect(JSON.parse(fs.readFileSync(path.join(kbDir, 'RVF-GENERATIONS.json'), 'utf8')).stores).toEqual({
      public: { file: 'public-v2.rvf' },
      'makerkit-source': { file: 'makerkit-source.rvf', sha256: 'private' },
    });
    expect(JSON.parse(fs.readFileSync(path.join(kbDir, 'repo-aliases.json'), 'utf8')).makerkit).toEqual(['makerkit-source']);
    expect(fs.readFileSync(path.join(kbDir, 'capability-cards.md'), 'utf8')).toContain('## makerkit\nprivate card');
  });

  it('fails a conflicting public/private name before writing any registry', () => {
    const { kbDir, privateStore } = registryFixture();
    const overlay = capturePrivateOverlayState({ kbDir, allStores: [privateStore] });
    writeJson(path.join(kbDir, 'SOURCE.json'), { stores: { 'makerkit-source': { kbName: 'makerkit-source', sourceCommit: 'public-collision' } } });
    const files = ['SOURCE.json', 'RVF-GENERATIONS.json', 'repo-aliases.json', 'capability-cards.md'];
    const before = Object.fromEntries(files.map((name) => [name, fs.readFileSync(path.join(kbDir, name))]));

    expect(() => restorePrivateOverlayState({ kbDir, overlay })).toThrow(/SOURCE\.json collision/);
    for (const name of files) expect(fs.readFileSync(path.join(kbDir, name))).toEqual(before[name]);
  });

  it('rolls the complete KB back when an extracted public bundle collides with private metadata', () => {
    const { kbDir, privateStore } = registryFixture();
    const overlay = capturePrivateOverlayState({ kbDir, allStores: [privateStore] });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-boundary-'));
    const backupPath = path.join(workspace, 'backup');
    const extractDir = path.join(workspace, 'extract');
    fs.cpSync(kbDir, backupPath, { recursive: true });
    fs.cpSync(kbDir, extractDir, { recursive: true });
    fs.unlinkSync(path.join(extractDir, 'makerkit-source.rvf'));
    writeJson(path.join(extractDir, 'SOURCE.json'), {
      stores: { 'makerkit-source': { kbName: 'makerkit-source', sourceCommit: 'public-collision' } },
    });
    fs.writeFileSync(path.join(extractDir, 'new-public-file.txt'), 'must be removed by rollback');
    const files = fs.readdirSync(kbDir);
    const before = Object.fromEntries(files.map((name) => [name, fs.readFileSync(path.join(kbDir, name))]));

    expect(() => applyPublicBundlePreservingPrivate({ extractDir, kbDir, backupPath, overlay }))
      .toThrow(/restored pre-update bytes/);
    for (const name of files) expect(fs.readFileSync(path.join(kbDir, name))).toEqual(before[name]);
    expect(fs.existsSync(path.join(kbDir, 'new-public-file.txt'))).toBe(false);
  });

  it('refuses a public bundle that contains a private RVF filename before copying', () => {
    const { kbDir, privateStore } = registryFixture();
    const overlay = capturePrivateOverlayState({ kbDir, allStores: [privateStore] });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-rvf-collision-'));
    const backupPath = path.join(workspace, 'backup');
    const extractDir = path.join(workspace, 'extract');
    fs.cpSync(kbDir, backupPath, { recursive: true });
    fs.mkdirSync(extractDir);
    fs.writeFileSync(path.join(extractDir, 'makerkit-source.rvf'), 'public-collision');
    const before = fs.readFileSync(path.join(kbDir, 'makerkit-source.rvf'));

    expect(() => applyPublicBundlePreservingPrivate({ extractDir, kbDir, backupPath, overlay }))
      .toThrow(/collides with private file makerkit-source\.rvf/);
    expect(fs.readFileSync(path.join(kbDir, 'makerkit-source.rvf'))).toEqual(before);
  });

  it('restores exact pre-update state when the filesystem copy itself fails partway through', () => {
    const { kbDir, privateStore } = registryFixture();
    const overlay = capturePrivateOverlayState({ kbDir, allStores: [privateStore] });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-copy-failure-'));
    const backupPath = path.join(workspace, 'backup');
    const extractDir = path.join(workspace, 'extract');
    fs.cpSync(kbDir, backupPath, { recursive: true });
    fs.mkdirSync(path.join(extractDir, 'z-block'), { recursive: true });
    fs.writeFileSync(path.join(extractDir, 'a-introduced.txt'), 'partial copy');
    fs.writeFileSync(path.join(extractDir, 'z-block', 'nested.txt'), 'forces type collision');
    fs.writeFileSync(path.join(kbDir, 'z-block'), 'existing file');
    fs.writeFileSync(path.join(backupPath, 'z-block'), 'existing file');

    expect(() => applyPublicBundlePreservingPrivate({ extractDir, kbDir, backupPath, overlay }))
      .toThrow(/restored pre-update bytes/);
    expect(fs.existsSync(path.join(kbDir, 'a-introduced.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(kbDir, 'z-block'), 'utf8')).toBe('existing file');
  });
});
