// tests/unit/install-state.test.mjs — the persisted grounding verdict (ADR-058 §D8): the shared
// read/write/predicate helpers in scripts/selfcheck.mjs that stop a failed smoke query from
// EVAPORATING the moment bin/install.mjs exits.
//
// Isolated via XDG_CACHE_HOME (the same env var bin/install.mjs's own meterSummaryLine() and
// scripts/token-report.mjs's CANONICAL_LEDGER already read) rather than HOME, because these
// functions read process.env directly at CALL time — no module-load-time caching to fight, unlike
// the brain-state.mjs / user-settings.mjs traps documented in tests/unit/brain-off.test.mjs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  installStatePath, readInstallState, writeInstallState, groundingUnproven,
} from '../../scripts/selfcheck.mjs';

let scratch, prevXdg;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'install-state-'));
  prevXdg = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = scratch;
});
afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = prevXdg;
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('installStatePath — resolution', () => {
  it('lives under XDG_CACHE_HOME/ruvnet-brain/install-state.json, a sibling of health.json/token-ledger', () => {
    expect(installStatePath()).toBe(path.join(scratch, 'ruvnet-brain', 'install-state.json'));
  });

  it('falls back to ~/.cache when XDG_CACHE_HOME is unset', () => {
    delete process.env.XDG_CACHE_HOME;
    expect(installStatePath()).toBe(path.join(os.homedir(), '.cache', 'ruvnet-brain', 'install-state.json'));
  });
});

describe('readInstallState — never throws', () => {
  it('returns null when nothing has ever been written (the common case: a fresh or pre-feature machine)', () => {
    expect(readInstallState()).toBeNull();
  });

  it('returns null on malformed JSON rather than crashing the caller', () => {
    fs.mkdirSync(path.dirname(installStatePath()), { recursive: true });
    fs.writeFileSync(installStatePath(), 'not json {{{');
    expect(readInstallState()).toBeNull();
  });

  it('returns the parsed object when a real verdict was written', () => {
    fs.mkdirSync(path.dirname(installStatePath()), { recursive: true });
    fs.writeFileSync(installStatePath(), JSON.stringify({ grounding: 'unproven', reason: 'no-answer' }));
    expect(readInstallState()).toMatchObject({ grounding: 'unproven', reason: 'no-answer' });
  });
});

describe('writeInstallState — merge-write, best-effort, never throws', () => {
  it('creates the directory and file on first write, stamping `at`', () => {
    const next = writeInstallState({ grounding: 'unproven', reason: 'no-answer' });
    expect(next.grounding).toBe('unproven');
    expect(next.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(fs.existsSync(installStatePath())).toBe(true);
    expect(readInstallState().grounding).toBe('unproven');
  });

  it('merges onto a PRIOR write rather than clobbering unrelated fields', () => {
    writeInstallState({ grounding: 'unproven', reason: 'no-answer', keepme: 'x' });
    const next = writeInstallState({ grounding: 'proven', clearedBy: 'search_ruvnet' });
    expect(next.keepme).toBe('x');        // survived the second write
    expect(next.grounding).toBe('proven'); // overwritten field wins
    expect(next.clearedBy).toBe('search_ruvnet');
  });

  it('a torn/prior-corrupt file is treated as empty rather than blocking the new write', () => {
    fs.mkdirSync(path.dirname(installStatePath()), { recursive: true });
    fs.writeFileSync(installStatePath(), 'garbage');
    const next = writeInstallState({ grounding: 'proven' });
    expect(next.grounding).toBe('proven');
  });
});

describe('groundingUnproven — the predicate --doctor gates on', () => {
  it('null state (never recorded) is NOT unproven — unknown must never be charged as a fail', () => {
    expect(groundingUnproven(null)).toBe(false);
  });

  it('grounding: "proven" is not unproven', () => {
    expect(groundingUnproven({ grounding: 'proven' })).toBe(false);
  });

  it('grounding: "unproven" IS unproven', () => {
    expect(groundingUnproven({ grounding: 'unproven' })).toBe(true);
  });

  it('any recorded state that is not literally "proven" counts as unproven (coarse by design)', () => {
    expect(groundingUnproven({ grounding: 'failed' })).toBe(true);
    expect(groundingUnproven({ grounding: null })).toBe(true);
    expect(groundingUnproven({})).toBe(true); // recorded, but no grounding field at all
  });
});

describe('mutation proof — groundingUnproven is load-bearing, not vestigial', () => {
  // House rule: "a test that cannot fail on broken code is not a test." Proven the same way
  // tests/unit/selfcheck-battery.test.mjs's §8 proves its own assertions: mutate the SOURCE, import
  // the mutated copy, re-judge the SAME input, and show the finding disappears.
  it('MUTANT: hardcode groundingUnproven to always return false → the unproven case goes GREEN', async () => {
    const SRC = path.join(path.resolve(import.meta.dirname, '../..'), 'scripts/selfcheck.mjs');
    const source = fs.readFileSync(SRC, 'utf8');
    const anchor = 'export function groundingUnproven(state) {\n  return Boolean(state) && state.grounding !== \'proven\';\n}';
    expect(source.includes(anchor), 'mutation anchor not found — the target moved').toBe(true);
    const mutated = source.replace(anchor, 'export function groundingUnproven(state) {\n  return false;\n}');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-groundingunproven-mutant-'));
    const file = path.join(dir, 'mutant.mjs');
    // hook-registry.mjs is loaded dynamically relative to THIS file's own dir — rewrite the one
    // anchor it depends on so the mutant is self-contained wherever it lives (same technique
    // selfcheck-battery.test.mjs's §8 mutant() helper uses).
    const REG_ANCHOR = "const here = path.dirname(fileURLToPath(import.meta.url));";
    expect(mutated.includes(REG_ANCHOR)).toBe(true);
    // Every RELATIVE dependency has to be re-pointed, not just `here`. selfcheck.mjs imports the
    // canonical continuity policy as '../plugin/scripts/continuity-hook-policy.mjs' (965ee55c,
    // which deleted a drifted second copy of that policy) — and from a tmpdir that path resolves
    // to nothing, so the mutant failed to import and this mutation proof silently stopped proving
    // anything. selfcheck-battery.test.mjs:622 already re-points it; this second copier did not.
    const POLICY_ANCHOR = "from '../plugin/scripts/continuity-hook-policy.mjs'";
    const REGISTRY_ANCHOR = "from '../plugin/scripts/hook-registry.mjs'";
    expect(mutated.includes(POLICY_ANCHOR), 'policy import anchor moved — re-point it for the mutant').toBe(true);
    const policyUrl = pathToFileURL(path.join(path.dirname(SRC), '../plugin/scripts/continuity-hook-policy.mjs')).href;
    fs.writeFileSync(file, mutated
      .replace(REG_ANCHOR, `const here = ${JSON.stringify(path.dirname(SRC))};`)
      .replace(POLICY_ANCHOR, `from ${JSON.stringify(policyUrl)}`)
      .replace(REGISTRY_ANCHOR, `from ${JSON.stringify(pathToFileURL(path.join(path.dirname(SRC), '../plugin/scripts/hook-registry.mjs')).href)}`));
    try {
      const mod = await import(`${file}?v=${Date.now()}`);
      expect(mod.groundingUnproven({ grounding: 'unproven' })).toBe(false); // ← the defect, reproduced
      expect(groundingUnproven({ grounding: 'unproven' })).toBe(true);     // the REAL file is untouched
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
