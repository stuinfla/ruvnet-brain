import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PROFILE_COMPLETE,
  PROFILE_RUVECTOR,
  applyBrainProfile,
  discoverStoreFamilies,
  measureBrainProfile,
  readBrainProfile,
  restoreCompleteProfile,
} from '../../kb/brain-profile.mjs';

let root;
let source;
let installed;

function writeBundle(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SOURCE.json'), JSON.stringify({ stores: {
    ruvector: { kbName: 'ruvector' }, ruflo: { kbName: 'ruflo' },
  } }));
  fs.writeFileSync(path.join(dir, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: [] }));
  for (const [name, size] of Object.entries({
    'ruvector.rvf': 50,
    'ruvector.big.rvf': 100,
    'ruvector.idmap.json': 10,
    'ruflo.rvf': 70,
    'ruflo.big.rvf': 140,
    'ruflo.idmap.json': 10,
  })) fs.writeFileSync(path.join(dir, name), Buffer.alloc(size, 1));
  fs.writeFileSync(path.join(dir, 'ruvector-primer.md'), 'ruvector primer');
  fs.writeFileSync(path.join(dir, 'ruflo-primer.md'), 'ruflo primer');
  fs.writeFileSync(path.join(dir, 'forge-mcp-all.mjs'), '// shared reader');
  fs.writeFileSync(path.join(dir, 'capability-cards.md'), [
    '# Capability Cards',
    '',
    'Shared introduction.',
    '',
    '## ruflo',
    'Orchestration.',
    '',
    '## ruvector',
    'Vector search.',
    '',
    '## agentdb',
    'Memory.',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'RVF-GENERATIONS.json'), JSON.stringify({
    stores: { ruflo: { release: 'x' }, ruvector: { release: 'x' } },
  }));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-profile-'));
  source = path.join(root, 'complete');
  installed = path.join(root, 'installed');
  writeBundle(source);
  fs.cpSync(source, installed, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('brain storage profiles', () => {
  it('preserves private, local and unlisted families and arbitrary managed-name siblings', () => {
    const sourceFile = path.join(installed, 'SOURCE.json');
    const policy = JSON.parse(fs.readFileSync(sourceFile));
    policy.stores.tenant = { kbName: 'tenant', updateManaged: false };
    policy.stores.secret = { kbName: 'secret' };
    fs.writeFileSync(sourceFile, JSON.stringify(policy));
    fs.writeFileSync(path.join(installed, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: ['SECRET'] }));
    const preserved = ['tenant.rvf', 'secret.rvf', 'local.rvf', 'ruflo.private-notes'];
    for (const name of preserved) fs.writeFileSync(path.join(installed, name), `private:${name}`);
    fs.mkdirSync(path.join(installed, 'ruflo'));
    fs.writeFileSync(path.join(installed, 'ruflo', 'notes'), 'private directory');
    const ledgerFile = path.join(installed, 'RVF-GENERATIONS.json');
    const ledger = JSON.parse(fs.readFileSync(ledgerFile));
    ledger.stores.tenant = { private: true };
    ledger.stores.local = { local: true };
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
    applyBrainProfile(installed, PROFILE_RUVECTOR);
    for (const name of preserved) expect(fs.readFileSync(path.join(installed, name), 'utf8')).toBe(`private:${name}`);
    expect(fs.readFileSync(path.join(installed, 'ruflo', 'notes'), 'utf8')).toBe('private directory');
    expect(JSON.parse(fs.readFileSync(ledgerFile)).stores.tenant).toEqual({ private: true });
    expect(JSON.parse(fs.readFileSync(ledgerFile)).stores.local).toEqual({ local: true });
    expect(fs.existsSync(path.join(installed, 'ruflo.rvf'))).toBe(false);
  });

  it.each(['SOURCE.json', 'PRIVATE-STORES.json', 'RVF-GENERATIONS.json'])('rejects corrupt %s before deleting files', (name) => {
    fs.writeFileSync(path.join(installed, name), '{broken');
    expect(() => applyBrainProfile(installed, PROFILE_RUVECTOR)).toThrow();
    expect(fs.existsSync(path.join(installed, 'ruflo.rvf'))).toBe(true);
    expect(fs.existsSync(path.join(installed, 'ruflo.big.rvf'))).toBe(true);
  });

  it('rejects missing ownership before deletion', () => {
    fs.unlinkSync(path.join(installed, 'SOURCE.json'));
    expect(() => applyBrainProfile(installed, PROFILE_RUVECTOR)).toThrow(/ownership|SOURCE/);
    expect(fs.existsSync(path.join(installed, 'ruflo.rvf'))).toBe(true);
  });

  it('rejects symlink artifacts before any family deletion', () => {
    fs.unlinkSync(path.join(installed, 'ruflo.idmap.json'));
    fs.symlinkSync(path.join(source, 'ruflo.idmap.json'), path.join(installed, 'ruflo.idmap.json'));
    expect(() => applyBrainProfile(installed, PROFILE_RUVECTOR)).toThrow(/symbolic|regular/);
    expect(fs.existsSync(path.join(installed, 'ruflo.rvf'))).toBe(true);
    expect(fs.existsSync(path.join(source, 'ruflo.idmap.json'))).toBe(true);
  });

  it('refuses restoration over a same-name private store without changing any bytes', () => {
    const sourceFile = path.join(installed, 'SOURCE.json');
    const policy = JSON.parse(fs.readFileSync(sourceFile));
    policy.stores.ruflo.updateManaged = false;
    fs.writeFileSync(sourceFile, JSON.stringify(policy));
    fs.writeFileSync(path.join(installed, 'ruflo.rvf'), 'private override');
    expect(() => restoreCompleteProfile(installed, source)).toThrow(/private|ownership/);
    expect(fs.readFileSync(path.join(installed, 'ruflo.rvf'), 'utf8')).toBe('private override');
  });

  it('preserves unlisted generation metadata when restoring managed families', () => {
    const ledgerFile = path.join(installed, 'RVF-GENERATIONS.json');
    const ledger = JSON.parse(fs.readFileSync(ledgerFile));
    ledger.stores.tenant = { private: true };
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
    restoreCompleteProfile(installed, source);
    expect(JSON.parse(fs.readFileSync(ledgerFile)).stores.tenant).toEqual({ private: true });
  });
  it('preserves private capability cards through filtering and restoration', () => {
    const cards = path.join(installed, 'capability-cards.md');
    fs.appendFileSync(cards, '\n## tenant\nPrivate capability.\n');
    applyBrainProfile(installed, PROFILE_RUVECTOR);
    expect(fs.readFileSync(cards, 'utf8')).toContain('Private capability.');
    restoreCompleteProfile(installed, source);
    expect(fs.readFileSync(cards, 'utf8')).toContain('Private capability.');
  });

  it('rejects malformed capability cards before deleting any managed artifact', () => {
    fs.writeFileSync(path.join(installed, 'capability-cards.md'), '# no RuVector card');
    expect(() => applyBrainProfile(installed, PROFILE_RUVECTOR)).toThrow();
    expect(fs.existsSync(path.join(installed, 'ruflo.rvf'))).toBe(true);
  });

  it('rejects an unknown restoration collision before overwriting an earlier managed family', () => {
    const policyFile = path.join(installed, 'SOURCE.json');
    const policy = JSON.parse(fs.readFileSync(policyFile));
    delete policy.stores.ruvector;
    fs.writeFileSync(policyFile, JSON.stringify(policy));
    fs.writeFileSync(path.join(installed, 'ruflo.rvf'), 'original managed bytes');
    expect(() => restoreCompleteProfile(installed, source)).toThrow(/ownership/);
    expect(fs.readFileSync(path.join(installed, 'ruflo.rvf'), 'utf8')).toBe('original managed bytes');
  });

  it.each([
    ['SOURCE.json', { stores: { ruflo: { updateManaged: 'false' } } }],
    ['SOURCE.json', { stores: [{ kbName: '../escape' }] }],
    ['SOURCE.json', { stores: [{ kbName: 'ruflo' }, { kbName: 'RUFLO' }] }],
    ['PRIVATE-STORES.json', { privateStores: 'secret' }],
  ])('rejects malformed ownership schema in %s before mutation', (name, data) => {
    fs.writeFileSync(path.join(installed, name), JSON.stringify(data));
    expect(() => applyBrainProfile(installed, PROFILE_RUVECTOR)).toThrow(/ownership/);
    expect(fs.existsSync(path.join(installed, 'ruflo.rvf'))).toBe(true);
  });

  it('reports a partial managed-file I/O failure without deleting private data or claiming ledger completion', () => {
    const privateFile = path.join(installed, 'tenant.rvf');
    fs.writeFileSync(privateFile, 'private bytes');
    const ledgerFile = path.join(installed, 'RVF-GENERATIONS.json');
    const before = fs.readFileSync(ledgerFile, 'utf8');
    const unlink = fs.unlinkSync;
    let calls = 0;
    vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
      if (++calls === 2) throw new Error('injected unlink failure');
      return unlink(file);
    });
    expect(() => applyBrainProfile(installed, PROFILE_RUVECTOR)).toThrow('injected unlink failure');
    expect(calls).toBe(2);
    expect(fs.readFileSync(privateFile, 'utf8')).toBe('private bytes');
    expect(fs.readFileSync(ledgerFile, 'utf8')).toBe(before);
  });

  it('refuses a restoration symlink before copying any artifact', () => {
    fs.unlinkSync(path.join(installed, 'ruvector.rvf'));
    const privateFile = path.join(root, 'private-rvf');
    fs.writeFileSync(privateFile, 'private bytes');
    fs.symlinkSync(privateFile, path.join(installed, 'ruvector.rvf'));
    fs.writeFileSync(path.join(installed, 'ruflo.rvf'), 'before');
    expect(() => restoreCompleteProfile(installed, source)).toThrow(/regular/);
    expect(fs.readFileSync(privateFile, 'utf8')).toBe('private bytes');
    expect(fs.readFileSync(path.join(installed, 'ruflo.rvf'), 'utf8')).toBe('before');
  });
  it('defaults safely and reads a durable RuVector choice', () => {
    const settings = path.join(root, 'settings.json');
    expect(readBrainProfile({ env: { RUVNET_SETTINGS_FILE: settings } })).toBe(PROFILE_COMPLETE);
    fs.writeFileSync(settings, JSON.stringify({ settings: { brainProfile: PROFILE_RUVECTOR } }));
    expect(readBrainProfile({ env: { RUVNET_SETTINGS_FILE: settings } })).toBe(PROFILE_RUVECTOR);
  });

  it('physically keeps only the RuVector family and filters shared indexes', () => {
    const before = measureBrainProfile(installed);
    const result = applyBrainProfile(installed, PROFILE_RUVECTOR);

    expect(before.stores).toEqual(['ruflo', 'ruvector']);
    expect(result.stores).toEqual(['ruvector']);
    expect(result.removedStores).toEqual(['ruflo']);
    expect(result.bytesFreed).toBeGreaterThan(200);
    expect(fs.existsSync(path.join(installed, 'forge-mcp-all.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(installed, 'ruflo.big.rvf'))).toBe(false);
    expect(fs.readFileSync(path.join(installed, 'capability-cards.md'), 'utf8')).toContain('## ruvector');
    expect(fs.readFileSync(path.join(installed, 'capability-cards.md'), 'utf8')).not.toContain('## ruflo');
    const ledger = JSON.parse(fs.readFileSync(path.join(installed, 'RVF-GENERATIONS.json'), 'utf8'));
    expect(Object.keys(ledger.stores)).toEqual(['ruvector']);
  });

  it('is idempotent and does not replace the complete-card backup with the filtered copy', () => {
    applyBrainProfile(installed, PROFILE_RUVECTOR);
    const second = applyBrainProfile(installed, PROFILE_RUVECTOR);
    expect(second.removed).toEqual([]);
    expect(fs.readFileSync(path.join(installed, 'capability-cards.complete.md'), 'utf8')).toContain('## ruflo');
  });

  it('restores the complete profile from the signed full-bundle source', () => {
    applyBrainProfile(installed, PROFILE_RUVECTOR);
    const restored = restoreCompleteProfile(installed, source);

    expect(restored.stores).toEqual(['ruflo', 'ruvector']);
    expect(discoverStoreFamilies(installed)).toEqual(['ruflo', 'ruvector']);
    expect(fs.readFileSync(path.join(installed, 'capability-cards.md'), 'utf8')).toContain('## ruflo');
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(installed, 'RVF-GENERATIONS.json'), 'utf8')).stores))
      .toEqual(['ruflo', 'ruvector']);
  });
});
