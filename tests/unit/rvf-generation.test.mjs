import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RVF_GENERATIONS_FILE,
  canonicalRvfStores,
  hasCanonicalRvfStore,
  verifyRvfGenerations,
  validateSelectedRvfGenerations,
  writeRvfGeneration,
} from '../../scripts/rvf-generation.mjs';
import { getVersion, getVersionTag } from '../../scripts/version.mjs';

const dirs = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('release-selected RVF ledger closure', () => {
  it('rejects missing, extra, aliased, private, byte-drifted, and incomplete rows', () => {
    const dir = fixtureDir();
    fs.writeFileSync(path.join(dir, 'demo.big.rvf'), 'demo');
    writeRvfGeneration({ dir, store: 'demo', model: 'bge', dimensions: 768, sourceCommit: 'abc1234' });
    expect(validateSelectedRvfGenerations(dir, { selectedStores: ['demo'] }).failures).toEqual([]);
    const file = path.join(dir, RVF_GENERATIONS_FILE);
    const base = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const mutate of [
      (m) => { delete m.stores.demo; },
      (m) => { m.stores.extra = { ...m.stores.demo, file: 'extra.big.rvf' }; },
      (m) => { m.stores.Demo = m.stores.demo; delete m.stores.demo; },
      (m) => { m.stores.demo.bytes += 1; },
      (m) => { m.stores.demo.model = ''; },
    ]) {
      const manifest = structuredClone(base); mutate(manifest);
      fs.writeFileSync(file, JSON.stringify(manifest));
      expect(validateSelectedRvfGenerations(dir, { selectedStores: ['demo'] }).failures.length).toBeGreaterThan(0);
    }
    fs.writeFileSync(file, JSON.stringify(base));
    expect(validateSelectedRvfGenerations(dir, { selectedStores: ['demo'], privateStores: ['demo'] }).failures)
      .toContainEqual(expect.stringContaining('private'));
  });

  it('permits an explicitly excluded receipted store outside the selected release roots', () => {
    const dir = fixtureDir();
    fs.writeFileSync(path.join(dir, 'demo.big.rvf'), 'demo');
    writeRvfGeneration({ dir, store: 'demo', model: 'bge', dimensions: 768, sourceCommit: 'abc1234' });
    fs.writeFileSync(path.join(dir, 'excluded.big.rvf'), 'excluded');
    writeRvfGeneration({ dir, store: 'excluded', model: 'bge', dimensions: 768, sourceCommit: 'def5678' });
    expect(validateSelectedRvfGenerations(dir, {
      selectedStores: ['demo'], excludedStores: ['excluded'],
    }).failures).toEqual([]);
  });
});

function fixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvf-generation-'));
  dirs.push(dir);
  return dir;
}

describe('checksum-bound RVF generation identity', () => {
  it('discovers only canonical big RVFs and matches registry names case-insensitively', () => {
    const dir = fixtureDir();
    fs.writeFileSync(path.join(dir, 'ruvector.big.rvf'), 'canonical');
    fs.writeFileSync(path.join(dir, 'ruvector.rvf'), 'obsolete');
    fs.writeFileSync(path.join(dir, 'ruvector.big.rvf.idmap.json'), '{}');

    expect(canonicalRvfStores(dir)).toEqual(['ruvector']);
    expect(hasCanonicalRvfStore(dir, 'RuVector')).toBe(true);
    expect(hasCanonicalRvfStore(dir, 'ruflo')).toBe(false);
  });

  it('binds exact RVF bytes to the one Brain version and detects byte drift', () => {
    const dir = fixtureDir();
    fs.writeFileSync(path.join(dir, 'demo.big.rvf'), Buffer.from('rvf generation one'));
    const generation = writeRvfGeneration({
      dir,
      store: 'demo',
      model: 'Xenova/bge-base-en-v1.5',
      dimensions: 768,
      sourceCommit: 'abc123',
    });

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, RVF_GENERATIONS_FILE), 'utf8'));
    expect(manifest.brainVersion).toBe(getVersion());
    expect(manifest.releaseTag).toBe(getVersionTag());
    expect(generation.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyRvfGenerations(dir).failures).toEqual([]);

    fs.appendFileSync(path.join(dir, 'demo.big.rvf'), 'changed');
    expect(verifyRvfGenerations(dir).failures).toEqual([
      expect.stringContaining('demo: sha256='),
    ]);
  });

  // The pre-push gate (scripts/sync-version.mjs) verifies the COMMITTED ledger only. `kb/*.rvf` is
  // gitignored, so byte comparison there described the machine rather than the commit and blocked
  // every push — tags included — with a remedy line that could not clear it. These cases pin the
  // narrow contract of that mode: it drops byte checks and ONLY byte checks.
  it('verifyBytes:false ignores byte drift and absent RVFs — the push-time contract', () => {
    const dir = fixtureDir();
    fs.writeFileSync(path.join(dir, 'demo.big.rvf'), Buffer.from('rvf generation one'));
    writeRvfGeneration({ dir, store: 'demo', model: 'm', dimensions: 768, sourceCommit: 'abc123' });

    // byte drift: fails closed by default, ignored under the push-time contract
    fs.appendFileSync(path.join(dir, 'demo.big.rvf'), 'changed');
    expect(verifyRvfGenerations(dir).failures).toEqual([expect.stringContaining('demo: sha256=')]);
    expect(verifyRvfGenerations(dir, { verifyBytes: false }).failures).toEqual([]);

    // absent RVF: the real shape (ledger has 72 stores, a working checkout has 71)
    fs.rmSync(path.join(dir, 'demo.big.rvf'));
    expect(verifyRvfGenerations(dir).failures).toEqual([expect.stringContaining('demo: missing')]);
    expect(verifyRvfGenerations(dir, { verifyBytes: false }).failures).toEqual([]);
  });

  it('TEETH: verifyBytes:false is NOT a mute button — committed ledger drift still fails', () => {
    const dir = fixtureDir();
    fs.writeFileSync(path.join(dir, 'demo.big.rvf'), Buffer.from('rvf generation one'));
    writeRvfGeneration({ dir, store: 'demo', model: 'm', dimensions: 768, sourceCommit: 'abc123' });

    // brainVersion/releaseTag ARE committed, so they must still fail closed in push-time mode.
    const file = path.join(dir, RVF_GENERATIONS_FILE);
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.brainVersion = '0.0.0-wrong';
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(verifyRvfGenerations(dir, { verifyBytes: false }).failures).toEqual([
      expect.stringContaining('brainVersion=0.0.0-wrong'),
    ]);
    // and a store the ledger has never heard of is still reported, bytes or not
    expect(
      verifyRvfGenerations(dir, { verifyBytes: false, requiredStores: ['ghost'] }).failures,
    ).toContainEqual(expect.stringContaining('ghost: no generation record'));
  });

  it('merges another store without losing the previous generation record', () => {
    const dir = fixtureDir();
    fs.writeFileSync(path.join(dir, 'one.big.rvf'), 'one');
    fs.writeFileSync(path.join(dir, 'two.big.rvf'), 'two');
    writeRvfGeneration({ dir, store: 'one', model: 'bge', dimensions: 768 });
    writeRvfGeneration({ dir, store: 'two', model: 'bge', dimensions: 768 });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, RVF_GENERATIONS_FILE), 'utf8'));
    expect(Object.keys(manifest.stores).sort()).toEqual(['one', 'two']);
  });

  it('fails when a canonical store has no generation record', () => {
    const dir = fixtureDir();
    fs.writeFileSync(path.join(dir, 'recorded.big.rvf'), 'one');
    fs.writeFileSync(path.join(dir, 'missing.big.rvf'), 'two');
    writeRvfGeneration({ dir, store: 'recorded', model: 'bge', dimensions: 768 });
    expect(verifyRvfGenerations(dir, {
      requiredStores: ['recorded', 'missing'],
    }).failures).toContain('missing: no generation record');
  });

  it('can validate ledger metadata in a source-only checkout without the ignored RVF bytes', () => {
    const dir = fixtureDir();
    fs.writeFileSync(path.join(dir, 'demo.big.rvf'), 'canonical');
    writeRvfGeneration({ dir, store: 'demo', model: 'bge', dimensions: 768 });
    fs.rmSync(path.join(dir, 'demo.big.rvf'));

    expect(verifyRvfGenerations(dir, {
      allowMissingFiles: true,
    }).failures).toEqual([]);
  });
});
