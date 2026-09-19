import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildCorpus } from '../../kb/forge-corpus.mjs';
import { assertCapabilityOnlyStore } from '../../kb/capability-only.mjs';
import { planReconciliation, executeReconciliation } from '../../scripts/corpus-reconcile.mjs';

const temporary = [];
afterEach(() => temporary.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

describe('Cognitum ruOS capability-only corpus', () => {
  it('removes stale seed sidecars after a capability-only worker is merged', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruos-policy-merge-'));
    temporary.push(root);
    const assetsDir = path.join(root, 'assets');
    fs.mkdirSync(assetsDir);
    const store = 'cognitum-ruos', sha = 'a'.repeat(40);
    fs.writeFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), '{"stores":{}}');
    fs.writeFileSync(path.join(assetsDir, `${store}.symbols.json`), 'PRIVATE_SYMBOL_CANARY');
    fs.writeFileSync(path.join(assetsDir, `${store}.rvf`), 'LEGACY_PRIVATE_CANARY');
    const plan = [{ name: store, store, upstreamSha: sha, url: 'https://github.com/cognitum-one/ruOS' }];
    const run = (command, args) => {
      if (command === 'git' && args[0] === 'clone') fs.mkdirSync(args.at(-1), { recursive: true });
      if (command === 'git' && args.includes('rev-parse')) return { status: 0, stdout: sha };
      if (command === process.execPath) {
        const out = args[args.indexOf('--out') + 1];
        const corpus = buildCorpus({ repo: root, name: store });
        for (const suffix of ['.big.rvf.idmap.json', '.big.rvf.embed.json']) fs.writeFileSync(path.join(out, store + suffix), '{}');
        fs.writeFileSync(path.join(out, `${store}.big.rvf`), 'rvf');
        fs.writeFileSync(path.join(out, `${store}.passages.jsonl`), corpus.chunks.map(c => JSON.stringify(c)).join('\n') + '\n');
        fs.writeFileSync(path.join(out, `${store}.meta.json`), JSON.stringify({ entries: { safe: { path: 'CAPABILITIES.md', kind: 'doc' } } }));
        fs.writeFileSync(path.join(out, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: { [store]: {
          file: `${store}.big.rvf`, sourceCommit: sha, bytes: 3,
          sha256: crypto.createHash('sha256').update('rvf').digest('hex'),
        } } }));
        fs.writeFileSync(path.join(out, 'SOURCE.json'), JSON.stringify({ stores: { [store]: { sourceCommit: sha } } }));
      }
      return { status: 0, stdout: '' };
    };
    await executeReconciliation({ plan, assetsDir, workspaceDir: path.join(root, 'work'), run });
    expect(() => assertCapabilityOnlyStore(assetsDir, store)).not.toThrow();
    expect(fs.existsSync(path.join(assetsDir, `${store}.symbols.json`))).toBe(false);
    expect(fs.existsSync(path.join(assetsDir, `${store}.rvf`))).toBe(false);
  });

  it('rebuilds an unchanged upstream store until its curated content and symbol policy pass', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruos-policy-rebuild-'));
    temporary.push(dir);
    const store = 'cognitum-ruos';
    const sha = 'a'.repeat(40);
    const bytes = Buffer.from('fixture rvf identity');
    fs.writeFileSync(path.join(dir, `${store}.big.rvf`), bytes);
    const ledger = { stores: { [store]: {
      sourceCommit: sha, file: `${store}.big.rvf`, bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    } } };
    const coverage = { schemaVersion: 1, coverageGeneration: 'fixture', rows: [{
      kind: 'repository', disposition: 'eligible', name: store,
      url: 'https://github.com/cognitum-one/ruOS', upstream: { sha }, artifact: { store },
    }] };
    const plan = () => planReconciliation({ coverage, ledger, assetsDir: dir });
    const passages = path.join(dir, `${store}.passages.jsonl`);
    fs.writeFileSync(passages, JSON.stringify({ path: 'agent.rs', text: 'PRIVATE_SOURCE_CANARY' }) + '\n');
    expect(plan()).toHaveLength(1);
    expect(() => assertCapabilityOnlyStore(dir, store)).toThrow(/capability-only policy/);
    const corpus = buildCorpus({ repo: dir, name: store });
    fs.writeFileSync(passages, corpus.chunks.map(c => JSON.stringify(c)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, `${store}.meta.json`), JSON.stringify({ entries: { safe: { path: 'CAPABILITIES.md', kind: 'doc' } } }));
    expect(() => assertCapabilityOnlyStore(dir, store)).not.toThrow();
    expect(plan()).toEqual([]);
    fs.writeFileSync(path.join(dir, `${store}.symbols.json`), '{"internal":"PRIVATE_SYMBOL_CANARY"}');
    expect(() => assertCapabilityOnlyStore(dir, store)).toThrow(/symbol index/);
    expect(plan()).toHaveLength(1);
  });

  it('excludes implementation in code, docs, config and manifests even with full indexing requested', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ruos-private-boundary-'));
    temporary.push(repo);
    for (const [file, body] of Object.entries({
      'README.md': '# INTERNAL_README_CANARY\nSecret architecture.',
      'agent.rs': '//! PRIVATE_SOURCE_CANARY\npub fn secret() {}',
      'settings.json': '{"secret":"PRIVATE_CONFIG_CANARY"}',
      'Cargo.toml': '[package]\nname="PRIVATE_MANIFEST_CANARY"',
    })) fs.writeFileSync(path.join(repo, file), body);
    const result = buildCorpus({ repo, name: 'cognitum-ruos', fullPrefixes: [''], keepNames: ['.git'] });
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks.every(c => c.path === 'CAPABILITIES.md' && c.kind === 'doc')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/CANARY|pub fn|Secret architecture/);
    expect(result.chunks[0].text).toContain('Workstation health monitoring');

    // The separate public desktop repository retains its normal coverage.
    const other = buildCorpus({ repo, name: 'ruos', fullPrefixes: [''] });
    expect(JSON.stringify(other)).toContain('PRIVATE_SOURCE_CANARY');
    expect(JSON.stringify(other)).toContain('INTERNAL_README_CANARY');
  });
});
