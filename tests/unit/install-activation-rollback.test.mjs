import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { coverageGenerationFor, releaseCoverageGenerationFor, validateCoverageDirectory } from '../../plugin/scripts/coverage-integrity.mjs';
import { validatePublicInventory } from '../../scripts/public-inventory.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'))).version;
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

// Synthetic public bytes with genuine ReleaseCoverage validation, never a production bundle.
function layDown(dir, source) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SOURCE.json'), JSON.stringify(source, null, 2));
  fs.writeFileSync(path.join(dir, 'forge-guard.mjs'), `import fs from 'node:fs'; import path from 'node:path';
const args=process.argv.slice(2); const value=(name)=>args[args.indexOf(name)+1];
const doc=JSON.parse(fs.readFileSync(path.join(value('--dir'),'SOURCE.json'),'utf8'));
if (!doc.stores?.[value('--name')]) { console.error('no entry for store "'+value('--name')+'"'); process.exit(1); }\n`);
  const storeNames = Object.keys(source.stores).sort();
  const sourceSnapshot = 'd'.repeat(40);
  const publicLedger = { schemaVersion: 2, kind: 'ruvnet-brain-public-generation-ledger',
    brainVersion: source.brainVersion, releaseTag: `v${source.brainVersion}`, sourceSnapshot, stores: {} };
  for (const name of storeNames) {
    const bytes = Buffer.alloc(512, 7);
    fs.writeFileSync(path.join(dir, `${name}.big.rvf`), bytes);
    publicLedger.stores[name] = { file: `${name}.big.rvf`, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length, sourceCommit: source.stores[name].sourceCommit || null,
      model: 'fixture-model', dimensions: 384, builtUtc: '2026-08-21T12:00:00.000Z' };
  }
  const publicLedgerBytes = Buffer.from(`${JSON.stringify(publicLedger)}\n`);
  fs.writeFileSync(path.join(dir, 'RVF-GENERATIONS.json'), `${JSON.stringify({ ...publicLedger,
    kind: 'ruvnet-brain-runtime-generation-ledger' })}\n`);
  fs.writeFileSync(path.join(dir, 'PUBLIC-RVF-GENERATIONS.json'), publicLedgerBytes);
  fs.writeFileSync(path.join(dir, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: [] }));
  fs.writeFileSync(path.join(dir, 'public-store-classes.json'), JSON.stringify({ schemaVersion: 1, derived: [] }));
  const rows = storeNames.map((name) => ({ key: `repo:${name}`, kind: 'repository', name,
    url: `https://github.com/ruvnet/${name}`, status: 'CURRENT', disposition: 'eligible', upstream: {},
    artifact: { store: name }, reasons: [] }));
  const enumerationReceipt = { schemaVersion: 1, terminal: true, duplicateKeys: 0,
    repositories: { expected: rows.length, pages: [] }, gists: { expected: 0, pages: [] } };
  const generatorSourceSha = 'a'.repeat(64);
  const snapshotRoot = 'b'.repeat(64);
  const sourceObservationSha256 = 'c'.repeat(64);
  const policy = { policyDispositionDigests: [], exemptionDigests: [] };
  const corpus = { schemaVersion: 1, kind: 'ruvnet-brain-corpus-coverage', generatorSourceSha,
    snapshotRoot, sourceObservationSha256, rows, enumerationReceipt, policy,
    totals: { rows: rows.length, repositories: rows.length, gists: 0, byStatus: { CURRENT: rows.length } } };
  corpus.coverageGeneration = coverageGenerationFor({ generatorSourceSha, snapshotRoot,
    sourceObservationSha256, rows, enumerationReceipt, policyDispositionDigests: [], exemptionDigests: [] });
  const corpusBytes = `${JSON.stringify(corpus, null, 2)}\n`;
  fs.writeFileSync(path.join(dir, 'CORPUS-COVERAGE.json'), corpusBytes);
  const publicInventory = validatePublicInventory({ assetsDir: dir, coverage: corpus, ledger: publicLedger });
  const release = { ...structuredClone(corpus), kind: 'ruvnet-brain-release-coverage',
    releaseIdentity: { version: source.brainVersion, tag: `v${source.brainVersion}`, sourceSnapshot },
    corpusSeed: { tag: `corpus-sha256-${'e'.repeat(64)}`, archiveSha256: 'e'.repeat(64), archiveBytes: 1,
      receiptSha256: 'f'.repeat(64) },
    corpusCoverage: { file: 'CORPUS-COVERAGE.json', sha256: crypto.createHash('sha256').update(corpusBytes).digest('hex'),
      coverageGeneration: corpus.coverageGeneration },
    generationLedger: { file: 'PUBLIC-RVF-GENERATIONS.json', sha256: crypto.createHash('sha256').update(publicLedgerBytes).digest('hex'),
      bytes: publicLedgerBytes.length, storeCount: storeNames.length },
    publicInventoryPartitionSha256: publicInventory.partitionSha256,
    installedProjectionSchema: 2 };
  delete release.coverageGeneration;
  release.releaseCoverageGeneration = releaseCoverageGenerationFor(release);
  fs.writeFileSync(path.join(dir, 'COVERAGE.json'), JSON.stringify(release));
}

describe('installer exact-swap failure recovery', () => {
  for (const contents of ['unlisted-file', 'declared-private', 'symlink', 'managed-only']) {
    it(`preserves prior contents for ${contents} during a valid swap`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-preserve-'));
      roots.push(root);
      const source = path.join(root, 'source');
      const live = path.join(root, 'live');
      layDown(source, { brainVersion: version, stores: { alpha: { sourceCommit: 'a'.repeat(40) } } });
      fs.writeFileSync(path.join(source, 'forge-mcp-all.mjs'), '// new public fixture');
      expect(validateCoverageDirectory(source, { expectedVersion: version }).valid).toBe(true);
      fs.cpSync(source, live, { recursive: true });
      fs.writeFileSync(path.join(live, 'forge-mcp-all.mjs'), '// prior bytes, ownership not inferable from filename');
      if (contents === 'unlisted-file') fs.writeFileSync(path.join(live, 'personal.txt'), 'private bytes');
      if (contents === 'declared-private') {
        const manifest = JSON.parse(fs.readFileSync(path.join(live, 'SOURCE.json')));
        manifest.stores.personal = { updateManaged: false };
        fs.writeFileSync(path.join(live, 'SOURCE.json'), JSON.stringify(manifest));
        fs.writeFileSync(path.join(live, 'personal.rvf'), 'private vector bytes');
      }
      if (contents === 'symlink') {
        fs.writeFileSync(path.join(root, 'external.txt'), 'external private bytes');
        fs.symlinkSync(path.join(root, 'external.txt'), path.join(live, 'personal-link'));
      }
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { unzipInto } from ${JSON.stringify(new URL('../../bin/install.mjs', import.meta.url).href)};
        console.log(JSON.stringify(await unzipInto(null, ${JSON.stringify(live)}, ${JSON.stringify(source)})));
        if (${JSON.stringify(contents)} === 'managed-only') {
          console.log(JSON.stringify(await unzipInto(null, ${JSON.stringify(live)}, ${JSON.stringify(source)})));
        }
      `], { cwd: root, encoding: 'utf8', env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' } });
      expect(result.status).toBe(contents === 'declared-private' ? 1 : 0);
      const retained = fs.readdirSync(root).filter((name) => name.startsWith('live.install-preserved-'));
      const receipts = result.stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
      const old = contents === 'declared-private' ? live : receipts[0]?.priorGeneration?.path || path.join(root, 'missing');
      expect(fs.existsSync(path.join(old, 'forge-mcp-all.mjs'))).toBe(true);
      expect(fs.readFileSync(path.join(old, 'forge-mcp-all.mjs'), 'utf8')).toContain('prior bytes');
      if (contents === 'unlisted-file') expect(fs.readFileSync(path.join(old, 'personal.txt'), 'utf8')).toBe('private bytes');
      if (contents === 'declared-private') expect(fs.readFileSync(path.join(old, 'personal.rvf'), 'utf8')).toBe('private vector bytes');
      if (contents === 'symlink') {
        expect(fs.lstatSync(path.join(old, 'personal-link')).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(path.join(root, 'external.txt'), 'utf8')).toBe('external private bytes');
      }
      if (contents !== 'declared-private') {
        expect(retained).toHaveLength(contents === 'managed-only' ? 2 : 1);
        for (const receipt of receipts) expect(receipt.priorGeneration).toMatchObject({
          status: 'PRESERVED_UNCLASSIFIED', automaticCleanupEligible: false,
        });
        expect(result.stdout + result.stderr).toContain('repeated installs can grow disk usage');
        expect(validateCoverageDirectory(live, { expectedVersion: version }).valid).toBe(true);
        expect(fs.readFileSync(path.join(live, 'forge-mcp-all.mjs'), 'utf8')).toBe('// new public fixture');
      }
    });
  }
  for (const fault of ['first-rename', 'second-rename', 'landed-validation', 'rollback-rename', 'foreign-live']) {
    it(`preserves the prior generation after ${fault}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-swap-'));
      roots.push(root);
      const source = path.join(root, 'source');
      const live = path.join(root, 'live');
      layDown(source, { brainVersion: version, stores: { alpha: { sourceCommit: 'a'.repeat(40) } } });
      fs.writeFileSync(path.join(source, 'forge-mcp-all.mjs'), '// fixture');
      expect(validateCoverageDirectory(source, { expectedVersion: version }).valid).toBe(true);
      fs.mkdirSync(live);
      fs.writeFileSync(path.join(live, 'private-unlisted.txt'), 'prior private bytes');
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import fs from 'node:fs';
        import path from 'node:path';
        import { unzipInto } from ${JSON.stringify(new URL('../../bin/install.mjs', import.meta.url).href)};
        const live = ${JSON.stringify(live)};
        const fault = ${JSON.stringify(fault)};
        const rename = fs.renameSync;
        fs.renameSync = (from, to) => {
          if ((fault === 'first-rename' && from === live) ||
              (fault === 'second-rename' && to === live && from.includes('.install-stage-')) ||
              (fault === 'rollback-rename' && to === live && from.includes('.install-prior-'))) {
            throw new Error('injected ' + fault);
          }
          rename(from, to);
          if (to === live && from.includes('.install-stage-') && fault === 'foreign-live') {
            rename(live, live + '.displaced-candidate');
            fs.mkdirSync(live);
            fs.writeFileSync(path.join(live, 'foreign-private.txt'), 'unknown replacement bytes');
          }
          if (to === live && from.includes('.install-stage-') &&
              ['landed-validation', 'rollback-rename'].includes(fault)) {
            fs.writeFileSync(path.join(live, 'COVERAGE.json'), '{}');
          }
        };
        await unzipInto(null, live, ${JSON.stringify(source)});
      `], { cwd: root, encoding: 'utf8', env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' } });
      expect(result.status).toBe(1);
      const prior = fs.readdirSync(root).filter((name) => name.startsWith('live.install-prior-'));
      const preserved = ['rollback-rename', 'foreign-live'].includes(fault) ? path.join(root, prior[0] || 'missing') : live;
      expect(fs.existsSync(path.join(preserved, 'private-unlisted.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(preserved, 'private-unlisted.txt'), 'utf8')).toBe('prior private bytes');
      if (fault === 'first-rename') expect(result.stderr).not.toContain('restored the prior');
      if (['rollback-rename', 'foreign-live'].includes(fault)) {
        expect(result.stderr).toContain('rollback also failed');
        expect(result.stderr).not.toContain('Nothing is left half-installed');
        expect(result.stderr).toContain('Recovery requires inspection');
      }
      if (fault === 'foreign-live') {
        expect(fs.readFileSync(path.join(live, 'foreign-private.txt'), 'utf8')).toBe('unknown replacement bytes');
        expect(result.stderr).toContain('identity changed');
      } else {
        const stages = fs.readdirSync(root).filter((name) => name.startsWith('.live.install-stage-'));
        expect(stages).toHaveLength(1);
        expect(fs.existsSync(path.join(root, stages[0], 'forge-mcp-all.mjs'))).toBe(true);
      }
    });
  }
});
