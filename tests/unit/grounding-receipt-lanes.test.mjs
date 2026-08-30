// tests/unit/grounding-receipt-lanes.test.mjs — EVERY lane that answers must mint a receipt.
//
// TWO DEFECTS, BOTH LIVE ON MAIN ON 2026-07-27, BOTH SILENT, BOTH FOUND THE SAME HOUR:
//
//  1. SHADOWING. `kb/forge-mcp-all.mjs` imported the substance writer into a module-level binding
//     called `evidence`. Later, inside the request handler, `searchAll()`'s return value — which has
//     an unrelated member ALSO called `evidence` (a plain {grade, topScore, caveat} object) — was
//     destructured into the same block. From that moment `evidence.recordAnswer(...)` resolved to
//     the plain object, threw TypeError, and was swallowed by the `catch { /* never */ }` that
//     exists so evidence capture can never break a query. The substance writer was DEAD ON EVERY
//     PATH; the ledger silently stopped growing; every test and every gate stayed green.
//
//  2. THE RACE THE SPEED CREATED. Once fixed, the card lane STILL minted nothing — measured live.
//     The writer is loaded with a lazy `import()` that assigns a mutable on a later tick, and the
//     card lane answers in ~0.02ms p50. It beat the import and read `null`. The heavy path never
//     showed this: 19.6s is an eternity next to a module load. Making the lane fast reintroduced a
//     latent race that had been hidden by slowness — the receipt vanished for exactly the question
//     class (does rUv already ship X?) the founding esm.sh incident came from.
//
// What both have in common is the thing this file tests: a capability that quietly does nothing
// looks EXACTLY like a capability that is working. So these assertions bind to the mechanism —
// no shadowing, and an awaited promise rather than a hopeful mutable read — not to the outcome
// on one lucky run.
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildReceipt,
  extractFacts,
  recordAnswer,
  evidenceFile,
} from '../../kb/forge-evidence.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const SERVER = path.join(REPO, 'kb/forge-mcp-all.mjs');
const src = () => fs.readFileSync(SERVER, 'utf8');
const lineCount = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0);

let evidenceDir;
let previousEvidenceFile;
beforeEach(() => {
  evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-receipt-'));
  previousEvidenceFile = process.env.RUVNET_EVIDENCE_FILE;
  process.env.RUVNET_EVIDENCE_FILE = path.join(evidenceDir, 'evidence.jsonl');
});
afterEach(() => {
  if (previousEvidenceFile === undefined) delete process.env.RUVNET_EVIDENCE_FILE;
  else process.env.RUVNET_EVIDENCE_FILE = previousEvidenceFile;
  fs.rmSync(evidenceDir, { recursive: true, force: true });
});

/** Brace-depth scope walk — the same check that found defect 1. */
function shadowReport(source, importedName) {
  const lines = source.split('\n');
  let depth = 0;
  let declDepth = null;
  const shadows = [];
  const uses = [];
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].replace(/'[^']*'|"[^"]*"|`[^`]*`|\/\/.*$/g, '');
    if (new RegExp(`^\\s*(let|const|var)\\s+${importedName}\\b`).test(code)) declDepth ??= depth;
    if (declDepth !== null && depth > declDepth
        && new RegExp(`(const|let|var)\\s*\\{[^}]*\\b${importedName}\\b[^}]*\\}`).test(code)) {
      shadows.push({ line: i + 1, depth });
    }
    if (new RegExp(`\\b${importedName}\\.recordAnswer`).test(code)) uses.push({ line: i + 1, depth });
    for (const c of code) { if (c === '{') depth++; else if (c === '}') depth--; }
  }
  return { declDepth, shadows, uses };
}

describe('defect 1 — the substance writer must not be shadowable', () => {
  it('the binding holding the forge-evidence module is never re-declared in an inner scope', () => {
    const rep = shadowReport(src(), 'evidenceWriter');
    expect(rep.declDepth, 'no module-level binding for the evidence writer was found').not.toBeNull();
    expect(
      rep.shadows,
      `the evidence writer binding is shadowed at line(s) ${rep.shadows.map((s) => s.line).join(', ')} — `
        + 'this is defect 1 verbatim: the call site would resolve to a different object and throw into a silent catch',
    ).toEqual([]);
  });

  it('KNOWN-BAD: the old name IS shadowed — proving the checker can fail, not just pass', () => {
    // The guard above only means something if it goes red on the real historical code. This
    // reproduces it: bind the module to `evidence`, then destructure searchAll's `evidence` into an
    // inner block, exactly as main did. A checker that cannot fail is not a checker.
    const broken = `
let evidence = null;
import('./forge-evidence.mjs').then((m) => { evidence = m; });
async function handler() {
  {
    {
      {
        const { results, repos, evidence } = await searchAll({});
        let receipt = null;
        try { if (evidence) receipt = evidence.recordAnswer({ query, repos, results }); } catch {}
      }
    }
  }
}`;
    const rep = shadowReport(broken, 'evidence');
    expect(rep.shadows.length, 'the historical shadowing must be detected').toBeGreaterThan(0);
    expect(rep.uses.length).toBeGreaterThan(0);
    // and the use sits at or below the shadow's depth — i.e. the shadow wins at the call site
    expect(rep.uses[0].depth).toBeGreaterThanOrEqual(rep.shadows[0].depth);
  });
});

describe('defect 2 — no lane may read a lazily-imported writer without awaiting it', () => {
  it('every recordAnswer call site awaits the import promise', () => {
    const live = src().split('\n').filter((l) => !l.trim().startsWith('//'));
    const callSites = live.filter((l) => /\.recordAnswer\s*\(/.test(l));
    expect(callSites.length, 'no recordAnswer call sites found — the writer is not wired at all').toBeGreaterThan(0);

    // Each call must be reached through a value obtained by awaiting the import, never by reading
    // the mutable the .then() eventually assigns. On the fast lane those are different answers.
    const text = live.join('\n');
    const awaits = (text.match(/await\s+evidenceReady/g) || []).length;
    expect(
      awaits,
      `${callSites.length} recordAnswer call site(s) but only ${awaits} \`await evidenceReady\` — `
        + 'a lane that reads the mutable directly loses the race whenever it answers faster than a module load',
    ).toBeGreaterThanOrEqual(callSites.length);
  });

  it('BOTH lanes are wired — the fast lane is not exempt because it is fast', () => {
    const text = src();
    // the card lane's early return must sit AFTER a recordAnswer call, not before every one of them
    const cardReturn = text.indexOf('cardLane: true');
    const firstRecord = text.indexOf('.recordAnswer(');
    expect(cardReturn, 'card lane not found').toBeGreaterThan(-1);
    expect(
      firstRecord < cardReturn,
      'the card lane returns before any receipt is minted — this is the exact regression the fast '
        + 'lane introduced when it became the first responder',
    ).toBe(true);
  });
});

describe('the writer itself still writes — the guard above is about wiring, not about this', () => {
  it('a card-shaped result carrying real facts appends exactly one ledger line', () => {
    const f = evidenceFile();
    const before = lineCount(f);
    const r = recordAnswer({
      query: 'receipt-lane test',
      repos: ['synaptic-mesh'],
      results: [{
        repo: 'synaptic-mesh',
        path: 'capability-cards.md#synaptic-mesh',
        text: 'npm install synaptic-mesh — runs fully local, no backend required.\nimport { Mesh } from "synaptic-mesh";',
        score: 0.4,
      }],
    });
    const after = lineCount(f);
    expect(r?.receiptId, 'a successful answer must produce a receipt id').toBeTruthy();
    expect(r.sources.length).toBeGreaterThan(0);
    expect(r.sources[0].enforceable).toBe(true);
    expect(after, 'exactly one JSONL record appended').toBe(before + 1);
  });

  it('a factless capability card emits an honest non-enforceable recommendation receipt', () => {
    const f = evidenceFile();
    const before = lineCount(f);
    const r = recordAnswer({
      query: 'which tool should I use',
      repos: ['agentdb'],
      results: [{
        repo: 'agentdb',
        path: 'capability-cards.md#agentdb',
        text: 'Use this building block for durable agent memory.',
        score: 0.8,
      }],
    });
    const after = lineCount(f);
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0]).toMatchObject({ capability: 'agentdb', enforceable: false });
    expect(after).toBe(before + 1);
  });

  it('treats Rust public traits, enums, types, modules, and re-exports as enforceable symbols', () => {
    const text = [
      'pub trait BackendAdapter {}',
      'pub enum Consistency { Fresh, Eventual, Frozen }',
      'pub type BackendId = String;',
      'pub mod cache;',
      'pub use backend::{BackendAdapter, LocalBackend};',
    ].join('\n');
    const r = recordAnswer({
      query: 'Rust public API',
      repos: ['rulake'],
      results: [{
        repo: 'rulake',
        path: 'crates/core/src/lib.rs',
        kind: 'source',
        text,
      }],
    });
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0].enforceable).toBe(true);
    expect(extractFacts({ text }).symbols.map((symbol) => symbol.name))
      .toEqual(expect.arrayContaining([
        'BackendAdapter',
        'Consistency',
        'BackendId',
        'cache',
      ]));
  });

  it('content-addresses a cited code source even when the bundled passage contains only its doc comment', () => {
    const facts = extractFacts({
      repo: 'qe-engine',
      path: 'src/generators/test-generator.ts',
      kind: 'source',
      text: 'Module src/generators/test-generator.ts — doc comment: Generates test code.',
    });
    expect(facts).toMatchObject({
      enforceable: false,
      sourceReference: {
        path: 'src/generators/test-generator.ts',
        sha: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    const receipt = buildReceipt({
      query: 'Does qe-engine generate tests automatically?',
      repos: ['qe-engine'],
      results: [{
        repo: 'qe-engine',
        path: 'src/generators/test-generator.ts',
        kind: 'source',
        text: 'Module source — Test Generator Factory creates framework-specific tests.',
      }],
    });
    expect(receipt.sources[0]).toMatchObject({
      enforceable: true,
      claimBinding: { method: 'tight-source-token-pair' },
    });
  });

  it('never treats a code extension and hash as capability enforcement when source terms are unrelated', () => {
    const receipt = buildReceipt({
      query: 'Does cipher-engine encrypt records and rotate keys?',
      repos: ['cipher-engine'],
      results: [{
        repo: 'cipher-engine',
        path: 'src/metrics.ts',
        kind: 'source',
        text: 'Encrypt metadata attached to records. Rotate counters emitted for keys.',
      }],
    });
    expect(receipt.sources[0]).toMatchObject({
      sourceReference: {
        path: 'src/metrics.ts',
        sha: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      enforceable: false,
    });
  });

  it('content-addresses Python implementation sources and extracts their public symbols', () => {
    const facts = extractFacts({
      repo: 'adaptive-engine',
      path: 'adaptive/core/learning.py',
      kind: 'source',
      text: [
        'class AdaptationEngine:',
        '    async def adapt_policy(self, feedback):',
        '        return feedback',
      ].join('\n'),
    });
    expect(facts).toMatchObject({
      sourceReference: {
        path: 'adaptive/core/learning.py',
        sha: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      enforceable: true,
    });
    expect(facts.symbols.map((symbol) => symbol.name))
      .toEqual(expect.arrayContaining(['AdaptationEngine', 'adapt_policy']));
  });

  it('extracts an explicit gold-fix grading firewall as enforceable posture', () => {
    const facts = extractFacts({
      repo: 'security-benchmark',
      path: 'scripts/evaluate.mjs',
      kind: 'source',
      text: 'The gold `patch` is NEVER applied here; gold is used only by --validate, never during grading.',
    });
    expect(facts).toMatchObject({
      enforceable: true,
      sourceReference: {
        path: 'scripts/evaluate.mjs',
        sha: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(facts.posture.join(' ')).toMatch(/gold .*never applied.*grading/i);
  });

  it('extracts explicit browser-local and no-upload source posture', () => {
    const facts = extractFacts({
      repo: 'visual-search',
      path: 'docs/live.js',
      kind: 'source',
      text: [
        'Visual search runs fully in the browser.',
        'Frames are embedded with CLIP locally. No server, no upload.',
      ].join('\n'),
    });
    expect(facts).toMatchObject({
      enforceable: true,
      sourceReference: {
        path: 'docs/live.js',
        sha: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(facts.posture.join(' ')).toMatch(/fully in the browser|no upload/i);
  });

  it('a factless source mints a receipt but writes NO ledger line — extraction is deterministic', () => {
    // Not a bug, and worth pinning so nobody "fixes" it: the ledger holds FACTS (install commands,
    // packages, symbols, verbatim posture), never prose. A card with none contributes none. This is
    // why the live card-lane run showed a receipt on the wire and an unchanged ledger.
    const f = evidenceFile();
    const before = lineCount(f);
    recordAnswer({
      query: 'factless',
      repos: ['x'],
      results: [{ repo: 'x', path: 'a/b.md', text: 'This document discusses ideas in general terms.', score: 0.1 }],
    });
    const after = lineCount(f);
    expect(after).toBe(before);
  });
});
