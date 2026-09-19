import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildCorpus } from '../../kb/forge-corpus.mjs';
import { assertCapabilityOnlyStore } from '../../kb/capability-only.mjs';
import { planReconciliation } from '../../scripts/corpus-reconcile.mjs';

const temporary = [];
afterEach(() => temporary.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

describe('Cognitum ruOS capability-only corpus', () => {
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
