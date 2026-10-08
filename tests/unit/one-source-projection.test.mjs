// tests/unit/one-source-projection.test.mjs — S4 (ONE PROVENANCE RECORD) / S5 regression guards.
//
// Before this gate, kb/forge-build.mjs, kb/forge-refresh.mjs, scripts/corpus-reconcile.mjs and
// scripts/private-overlay.mjs each independently constructed a SOURCE.json store entry's identity
// fields (sourceRepo/sourceCommit/sourceDescribe/builtUtc) as its own object literal — four places
// that could, in principle, drift apart from kb/RVF-GENERATIONS.json's own record of the same
// facts. scripts/rvf-generation.mjs's projectSourceStore() is now the ONE place those fields are
// read FROM the ledger; every direct writer calls it rather than restating the facts itself.
//
// These tests would FAIL on the pre-S4 code: projectSourceStore did not exist, none of the four
// files imported it, and forge-build.mjs/private-overlay.mjs each still had their own
// `sourceRepo: g.remote || R` / `sourceRepo: 'private'` style inline construction.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { projectSourceStore, writeRvfGeneration, readRvfGenerations, RVF_GENERATIONS_FILE } from '../../scripts/rvf-generation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WRITERS = ['kb/forge-build.mjs', 'kb/forge-refresh.mjs', 'scripts/corpus-reconcile.mjs', 'scripts/private-overlay.mjs', 'scripts/build-bundle.mjs'];

describe('S4/S5 — no second SOURCE.json writer', () => {
  it('every direct SOURCE.json writer projects its store entry via the one shared projectSourceStore', () => {
    for (const relative of WRITERS) {
      const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
      expect(source, `${relative} must call projectSourceStore(...) to build its SOURCE.json store entry`)
        .toMatch(/\bprojectSourceStore\s*\(/);
      expect(source, `${relative} must import projectSourceStore from the shared ledger module`)
        .toMatch(/\bimport\s*\{[^}]*\bprojectSourceStore\b[^}]*\}\s*from\s*['"][^'"]*rvf-generation\.mjs['"]/);
    }
  });

  it('projectSourceStore is exported from exactly one module: scripts/rvf-generation.mjs', () => {
    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.mjs')) {
          const text = fs.readFileSync(full, 'utf8');
          if (/\bexport\s+function\s+projectSourceStore\b/.test(text)) found.push(path.relative(ROOT, full));
        }
      }
    };
    for (const dir of ['kb', 'scripts', 'plugin', 'bin']) walk(path.join(ROOT, dir));
    expect(found).toEqual(['scripts/rvf-generation.mjs']);
  });

  it('none of the source writers independently constructs a sourceRepo/sourceDescribe object-literal key outside a call to writeRvfGeneration/projectSourceStore', () => {
    // Legitimate identity fields enter the ledger through writeRvfGeneration or private-overlay's
    // exact generation-row producer. An updater adapter may not substitute provenance missing from
    // the ledger. What must never reappear is
    // a full store-entry literal (kbName + sourceRepo/sourceCommit/sourceDescribe + builtUtc all
    // together) built by hand. Cheap, precise proxy: every sourceRepo:/sourceDescribe: occurrence in
    // these source writers must appear on a line that ALSO mentions writeRvfGeneration, projectSourceStore,
    // or is itself inside one of those calls (checked by requiring the immediately preceding
    // non-blank content within 3 lines to reference one of the two).
    for (const relative of WRITERS) {
      const lines = fs.readFileSync(path.join(ROOT, relative), 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!/\bsourceRepo\s*:|\bsourceDescribe\s*:/.test(line)) return;
        // This literal is the private ledger row itself, verified against persisted SOURCE below.
        if (relative === 'scripts/private-overlay.mjs' && /\bconst generation = \{/.test(line)
          && /\bsourceRepo: 'private'/.test(line)) return;
        const window = lines.slice(Math.max(0, index - 8), index + 1).join('\n');
        if (relative === 'scripts/build-bundle.mjs' && /ledgerStores\[name\]\s*=\s*\{/.test(window)
          && /source(?:Repo|Describe): generation\.source(?:Repo|Describe) \?\? null/.test(line)) return;
        expect(window, `${relative}:${index + 1} constructs sourceRepo/sourceDescribe outside writeRvfGeneration/projectSourceStore:\n${line}`)
          .toMatch(/writeRvfGeneration\s*\(|projectSourceStore\s*\(/);
      });
    }
  });
});

describe('S4/S5 — SOURCE.json regenerated equals projection of ledger', () => {
  it.each([{}, { sourceRepo: null, sourceDescribe: null }])('never substitutes updater provenance for absent or null ledger values', (identity) => {
    const generation = { ...identity, sourceCommit: null, builtUtc: '2026-10-08T00:00:00.000Z' };
    const before = structuredClone(generation);
    const updater = { sourceRepo: 'https://example.invalid/stale-updater', sourceDescribe: 'stale-updater-tag',
      sourceCommit: 'a'.repeat(40), builtUtc: '2020-01-01T00:00:00.000Z', canonicalManifestUrl: 'https://example.invalid/manifest' };
    expect(projectSourceStore('store', generation, updater)).toMatchObject({ sourceRepo: null, sourceDescribe: null,
      sourceCommit: null, builtUtc: generation.builtUtc, canonicalManifestUrl: updater.canonicalManifestUrl });
    expect(generation).toEqual(before);
  });

  it('every identity field in a projected SOURCE.json store entry equals the ledger row it was projected from', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-source-projection-'));
    fs.writeFileSync(path.join(dir, 'alpha.big.rvf'), 'alpha-bytes');
    fs.writeFileSync(path.join(dir, 'beta.big.rvf'), 'beta-bytes-longer');
    writeRvfGeneration({ dir, store: 'alpha', model: 'bge', dimensions: 768,
      sourceCommit: 'a'.repeat(40), sourceRepo: 'https://github.com/ruvnet/alpha', sourceDescribe: 'v1.0.0' });
    writeRvfGeneration({ dir, store: 'beta', model: 'bge', dimensions: 768, sourceCommit: 'b'.repeat(40) });

    const ledger = readRvfGenerations(dir);
    const stores = {};
    for (const [name, generation] of Object.entries(ledger.stores)) {
      stores[name] = projectSourceStore(name, generation, { canonicalManifestUrl: 'https://example.invalid/manifest.json',
        sourceRepo: 'https://example.invalid/stale-adapter', sourceDescribe: 'stale-adapter-tag' });
    }
    const sourceFile = path.join(dir, 'SOURCE.json');
    fs.writeFileSync(sourceFile, `${JSON.stringify({ builder: 'rvf-kb-forge', stores }, null, 2)}\n`);

    // Re-read both files fresh from disk (never reuse in-memory objects) and prove the relationship.
    const landedLedger = JSON.parse(fs.readFileSync(path.join(dir, RVF_GENERATIONS_FILE), 'utf8'));
    const landedSource = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    expect(Object.keys(landedSource.stores).sort()).toEqual(Object.keys(landedLedger.stores).sort());
    for (const name of Object.keys(landedLedger.stores)) {
      const row = landedLedger.stores[name];
      const entry = landedSource.stores[name];
      expect(entry.sourceCommit, `${name}.sourceCommit`).toBe(row.sourceCommit ?? null);
      expect(entry.sourceRepo, `${name}.sourceRepo`).toBe(row.sourceRepo ?? null);
      expect(entry.sourceDescribe, `${name}.sourceDescribe`).toBe(row.sourceDescribe ?? null);
      expect(entry.builtUtc, `${name}.builtUtc`).toBe(row.builtUtc);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
