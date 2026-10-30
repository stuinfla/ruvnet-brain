// tests/unit/no-silent-substitution.test.mjs — tests for the gate that catches the worst class of bug
// this project has produced: passing my own code off as rUv's.
//
// THE INCIDENT (2026-07-13): I wrote a 216-line model router with a self-described "placeholder
// policy" and SKILL.md called it "the MetaHarness router engine". @metaharness/router@0.3.2 — rUv's
// REAL learned cost-optimal router (ADR-040/043, Accepted/implemented) — was already on npm. Every
// unit test passed. Every CI gate was green. Nothing asked the only question that mattered:
// "does rUv already ship this, and am I wearing his name?"
//
// A gate with no tests is a script nobody trusts, so: these pin BOTH directions — it must FIRE on a
// substitution, and it must STAY SILENT on legitimate code. A gate that cries wolf gets switched off
// (the windows-unit lesson), and a gate that misses the crime is decoration.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audit, packageIsReallyUsed, CAPABILITIES } from '../../scripts/no-silent-substitution.mjs';

/** Build a throwaway repo with a given SKILL.md + package.json, and audit it. */
function fixture({ skill = '', pkg = {}, scripts = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-'));
  fs.mkdirSync(path.join(root, 'plugin', 'skills', 'ruvnet-brain'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(root, 'plugin/skills/ruvnet-brain/SKILL.md'), skill);
  for (const [name, body] of Object.entries(scripts)) fs.writeFileSync(path.join(root, 'scripts', name), body);
  return root;
}

// The literal shape of the crime: names rUv's product AND implements the capability.
const THE_LIE = 'The MetaHarness router engine — consult it FIRST. It picks the cheapest model that clears the qualityBar for cost-optimal model routing.';

describe('no-silent-substitution — it must FIRE on the real crime', () => {
  it('catches code that implements a capability AND wears rUv\'s name without using his package', () => {
    const v = audit(fixture({ skill: THE_LIE, pkg: { name: 'x' } }));
    expect(v.length).toBeGreaterThan(0);
    const hit = v.find((x) => x.pkg === '@metaharness/router');
    expect(hit, 'the router substitution MUST be caught — this is the exact bug').toBeTruthy();
    expect(hit.why).toMatch(/NOT a dependency|NEVER IMPORTED/);
  });

  it('catches the subtler case: the package is DECLARED but never actually imported (theatre)', () => {
    // Declaring a dependency you never call is a fig leaf. The gate demands real usage.
    const v = audit(fixture({ skill: THE_LIE, pkg: { name: 'x', dependencies: { '@metaharness/router': '^0.3.2' } } }));
    expect(v.find((x) => x.pkg === '@metaharness/router')?.why).toMatch(/NEVER IMPORTED/);
  });
});

describe('no-silent-substitution — it must STAY SILENT on legitimate code', () => {
  it('is silent when the real package is genuinely imported', () => {
    const root = fixture({
      skill: THE_LIE,
      pkg: { name: 'x', dependencies: { '@metaharness/router': '^0.3.2' } },
      scripts: { 'router.mjs': "import { Router } from '@metaharness/router';\nexport const r = Router;" },
    });
    expect(audit(root).find((v) => v.pkg === '@metaharness/router')).toBeUndefined();
  });

  it('is silent when the hand-roll is OPENLY DISCLOSED — you may hand-roll, never silently', () => {
    const disclosed = `${THE_LIE}\n\nHAND-ROLLED: no labelled examples exist yet. REAL TOOL: @metaharness/router`;
    expect(audit(fixture({ skill: disclosed, pkg: { name: 'x' } })).find((v) => v.pkg === '@metaharness/router')).toBeUndefined();
  });

  it('does NOT fire on prose that merely mentions a tool without implementing it', () => {
    // "We use agentic-qe for testing" is a usage claim (that's claims-verify's job), not a substitution.
    // A gate that flags every README mention gets switched off, and then it protects nothing.
    const v = audit(fixture({ skill: 'We run agentic-qe against this repo.', pkg: { name: 'x' } }));
    expect(v).toHaveLength(0);
  });
});

describe('the capability map — the thing that decides what gets policed', () => {
  it('covers the router (the capability that was actually faked)', () => {
    expect(CAPABILITIES.map((c) => c.pkg)).toContain('@metaharness/router');
  });

  it('finds a dependency declared in ANY manifest, not just the root', () => {
    // The first version read only the root package.json and reported @ruvector/rvf — declared in
    // kb/package.json and used everywhere — as fraud. False positives kill gates.
    const root = fixture({ pkg: { name: 'x' } });
    fs.mkdirSync(path.join(root, 'kb'), { recursive: true });
    fs.writeFileSync(path.join(root, 'kb/package.json'), JSON.stringify({ dependencies: { '@ruvector/rvf': '^0.2.3' } }));
    fs.writeFileSync(path.join(root, 'kb/load.mjs'), "const m = await import('@ruvector/rvf');"); // dynamic, not static
    const use = packageIsReallyUsed('@ruvector/rvf', root);
    expect(use.declared).toBe(true);
    expect(use.imported, 'a DYNAMIC import is still real usage — kb/ loads rvf lazily').toBe(true);
  });
});

describe('the live repo obeys its own rule', () => {
  it('has ZERO silent substitutions right now', () => {
    const v = audit();
    expect(v, v.map((x) => `${x.file}: ${x.why}`).join('\n')).toHaveLength(0);
  });
});

describe('state-file ratchet: an append is a CALL, not a name in a string (2026-10-30)', () => {
  it('names appendFile inside a scanner pattern: not an appender; a real appendFileSync( call: an appender', async () => {
    const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
    const { stateFileInventory } = await import('../../scripts/no-silent-substitution.mjs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-'));
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'scripts', 'scanner.mjs'), "export const FSW = '(?:writeFile|appendFile|createWriteStream)(?:Sync)?';\n");
    fs.writeFileSync(path.join(root, 'scripts', 'writer.mjs'), "import fs from 'node:fs';\nexport const log = (x) => fs.appendFileSync('runs.jsonl', x);\n");
    const found = stateFileInventory(root).map((s) => s.module);
    fs.rmSync(root, { recursive: true, force: true });
    expect(found).toEqual(['scripts/writer.mjs']);
  });
});
