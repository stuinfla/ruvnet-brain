// fourth-wall.test.mjs — issue #46 / ADR-055 §3, build items 4 + 5.
//
// THE CLAIM UNDER TEST: a model can no longer search, receive the right answer, and write its
// opposite with every gate green.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// T1 — THE INCIDENT, RUN RED FIRST. Verbatim, unedited, before a line of the implementation existed.
//
// The fixture is not invented: `tests/fixtures/fourth-wall/rvf-browser-html.json` is the REAL
// document from the REAL corpus (`~/.cache/ruvnet-brain/kb/ruvector.big.passages.jsonl`,
// `examples/rvf/scripts/rvf-browser.html`, 427 chars, sha fc855a5fd819) — rUv's own browser example:
// "npm install @ruvector/rvf-wasm", "No backend required." The write is the one the owner watched
// happen: `import init, { RvfStore } from "https://esm.sh/@ruvector/rvf-wasm"`.
//
// Both halves were replayed against origin/main @ 30505a9 — the tree as it shipped this morning,
// with the model genuinely grounded first (the real grounding-stamp.sh minting real 24h stamps for
// `ruvector` and `rvf` from a real successful search banner):
//
//   $ git show origin/main:plugin/scripts/grounding-stamp.sh > red-stamp.sh
//   $ git show origin/main:plugin/scripts/ground-before-write.sh > red-gate.sh
//   $ … | HOME=$SCRATCH bash red-stamp.sh
//   $ ls $SCRATCH/.cache/ruvnet-brain/grounded/
//   ruvector
//   rvf
//   --- STAMPED ---
//   $ HOME=$SCRATCH bash red-gate.sh < incident-write.json > out.txt 2> err.txt
//   exit=0
//   stdout bytes=       0
//   stderr bytes=       0
//   --- stdout ---
//   --- stderr ---
//   --- end ---
//   gate-blocks receipts:
//   0 (no file)
//
// Exit 0. Zero bytes on either stream. No receipt. That reproduces GPT-5.6's measured
// `LIVE_GATE_EXIT=0` from the ADR-055 duel exactly, and it is the whole of issue #46 in nine lines:
// the stamps were real, the search was real, the answer was right, and the wall had nothing to say
// because it only ever knew that a search RAN.
//
// T1 below is that same replay against this branch. It must exit 2, and the refusal must carry the
// source path AND the install command — a refusal without the evidence just trains an override.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// T2 — THE KNOWN-GOOD CORPUS. The most important test in this file. A wall with one true positive
//      and any false positives is worse than no wall: it gets switched off, and then the true
//      positive is gone too. 20 real historical writes from this repo's own git log, plus every
//      known-good shape ADR-055 §8 names, must all exit 0.
// T3 — MUTATION PROOF. Break each detector; its bad write must start passing. A detector whose
//      removal changes nothing was never protecting anything (ADR-055 §8).
// T4 — REFUSALS MINT NOTHING. The discipline grounding-stamp.sh had to learn the hard way
//      (ADR-054 §3: five distinct non-answers minted five valid 24h stamps on the pre-fix tree).
// T5 — LATENCY. The added stage is on the write path of every session; a budget nobody measures is
//      a budget nobody has.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GATE = path.join(REPO, 'plugin/scripts/ground-before-write.sh');
const STAMP = path.join(REPO, 'plugin/scripts/grounding-stamp.sh');
const SUBSTANCE = path.join(REPO, 'plugin/scripts/grounding-substance.mjs');
const FORGE_MCP = path.join(REPO, 'kb/forge-mcp-all.mjs');
const EVIDENCE_MOD = path.join(REPO, 'kb/forge-evidence.mjs');
const FIX = path.join(REPO, 'tests/fixtures/fourth-wall');

const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const bashOnly = !hasBash || process.platform === 'win32';

/** The real corpus document from the incident. Committed so the replay is hermetic AND real. */
const INCIDENT_DOC = JSON.parse(fs.readFileSync(path.join(FIX, 'rvf-browser-html.json'), 'utf8'));
/** A second real corpus document — this one CARRIES a CDN origin in its own text (ADR-055 F22). */
const UNPKG_DOC = JSON.parse(fs.readFileSync(path.join(FIX, 'ruvector-wasm-readme.json'), 'utf8'));
/**
 * A THIRD real corpus document that installs the SAME package as UNPKG_DOC (`@ruvector/wasm`) and
 * does NOT carry the CDN origin. The pair is what makes the "source-supported origin" question
 * order-dependent, and the real corpus holds six more of this shape — see the D1 ordering test.
 */
const LOCAL_WASM_DOC = JSON.parse(fs.readFileSync(path.join(FIX, 'ruvector-wasm-api-local.json'), 'utf8'));
/** 24 further real corpus documents that carry install commands — the hostile ledger for T2. */
const CORPUS = JSON.parse(fs.readFileSync(path.join(FIX, 'corpus-sample.json'), 'utf8'));

/** The exact write the owner watched happen. */
const INCIDENT_WRITE = 'import init, { RvfStore } from "https://esm.sh/@ruvector/rvf-wasm";\n\n'
  + 'await init();\nexport const store = new RvfStore(384);\n';

let tmp, evidenceFile, overrideFile;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fourth-wall-')));
  fs.mkdirSync(path.join(tmp, '.claude/model-router'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.claude/model-router/profile.json'), '{}');   // opt in
  evidenceFile = path.join(tmp, 'evidence.jsonl');
  overrideFile = path.join(tmp, 'overrides.jsonl');
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const env = (extra = {}) => ({
  ...process.env,
  HOME: tmp,
  USERPROFILE: tmp,
  RUVNET_EVIDENCE_FILE: evidenceFile,
  RUVNET_OVERRIDE_FILE: overrideFile,
  RUVNET_IMPL_POLICY: '',
  CLAUDE_PROJECT_DIR: tmp,
  ...extra,
});

/** Run the REAL substance writer over REAL documents, exactly as the MCP success path does. */
function record(docs, extraEnv = {}) {
  const src = `const ev = await import(${JSON.stringify(pathToFileURL(EVIDENCE_MOD).href)});
    const docs = JSON.parse(process.argv[1]);
    for (const d of docs) ev.recordAnswer({ query: 'how does rUv implement this?', repos: ['ruvector'], results: [d] });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src, JSON.stringify(docs)], {
    env: env(extraEnv), encoding: 'utf8', timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`recorder exited ${r.status}: ${r.stderr}`);
}

/** Mint the recency stamps the way a real grounded session does, through the REAL stamp hook. */
function groundRecency(doc = INCIDENT_DOC) {
  const body = `Searched 37 RuvNet repos (ruvector, rvf, agentdb, ruflo).\n#1  repo=${doc.repo}\n`
    + `path : ${doc.repo}/${doc.path}\ntitle: ${doc.title}\n`
    + `----- full document (${doc.fullText.length} chars) -----\n${doc.fullText}`;
  return spawnSync('bash', [STAMP], {
    input: JSON.stringify({
      tool_name: 'mcp__plugin_ruvnet-brain_ruvnet-brain__search_ruvnet',
      tool_input: { query: 'rvf ruvector agentdb ruflo: how do I do this?' },
      tool_response: body,
    }),
    env: env(), encoding: 'utf8', timeout: 30_000,
  });
}

/** Force every product term stamped, so T2's population reaches the substance stage. */
function groundEverything() {
  const dir = path.join(tmp, '.cache/ruvnet-brain/grounded');
  fs.mkdirSync(dir, { recursive: true });
  for (const t of ['agentdb', 'metaharness', 'ruvector', 'aidefence', 'agentic-flow', 'agentic-qe', 'ruv-swarm', 'rvf', 'ruflo']) {
    fs.writeFileSync(path.join(dir, t), '');
  }
}

/** Fire the REAL user-wired gate, the way Claude Code does: subprocess, JSON on stdin. */
function fireGate(toolInput, { toolName = 'Write', extraEnv = {} } = {}) {
  const r = spawnSync('bash', [GATE], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    env: env(extraEnv), encoding: 'utf8', timeout: 30_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const write = (content, file = '/Users/x/proj/src/rvf-browser-client.mjs') => ({ file_path: file, content });

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// T1 — THE INCIDENT
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(bashOnly)('T1 — the incident: stamped rvf-browser.html, written esm.sh import', () => {
  it('the fixture really is the corpus document ADR-055 names, not a paraphrase of it', () => {
    expect(INCIDENT_DOC.repo).toBe('ruvector');
    expect(INCIDENT_DOC.path).toBe('examples/rvf/scripts/rvf-browser.html');
    expect(INCIDENT_DOC.fullText).toContain('npm install @ruvector/rvf-wasm');
    expect(INCIDENT_DOC.fullText).toContain('No backend required');
    // …and it carries the CDN mention that makes a naive "any CDN is bad" rule a false-positive
    // machine. This line is why D1 compares against the origins the SOURCE carries (ADR-055 F22).
    expect(INCIDENT_DOC.fullText).toMatch(/load from CDN/i);
  });

  it('REFUSES the violating write, with exit 2', () => {
    record([INCIDENT_DOC]);
    groundRecency();
    const r = fireGate(write(INCIDENT_WRITE));
    expect(r.status).toBe(2);
  });

  it('the refusal carries the SOURCE PATH and the INSTALL COMMAND (evidence, not scolding)', () => {
    record([INCIDENT_DOC]);
    groundRecency();
    const { stderr } = fireGate(write(INCIDENT_WRITE));
    expect(stderr).toContain('examples/rvf/scripts/rvf-browser.html');
    expect(stderr).toContain('npm install @ruvector/rvf-wasm');
    expect(stderr).toContain('No backend required');           // the source's own words
    expect(stderr).toContain('https://esm.sh/@ruvector/rvf-wasm'); // what the write introduced
    expect(stderr).toMatch(/GROUNDING-NET|D1/);
    expect(stderr).toMatch(/RUVNET_GROUNDING_OVERRIDE/);       // the compliant escape hatch
  });

  it('the recency wall alone is NOT what refuses it — the stamps are genuinely fresh and valid', () => {
    // Guards against the test passing for the wrong reason. Without the ledger, the very same call
    // is permitted; the ONLY difference between exit 0 and exit 2 here is the substance.
    groundRecency();
    expect(fireGate(write(INCIDENT_WRITE)).status).toBe(0);    // ← today's behaviour, reproduced
    record([INCIDENT_DOC]);
    expect(fireGate(write(INCIDENT_WRITE)).status).toBe(2);    // ← the fourth wall, and nothing else
  });

  it('writes a durable gate receipt before refusing (ADR-055 §1.4)', () => {
    record([INCIDENT_DOC]);
    groundRecency();
    fireGate(write(INCIDENT_WRITE));
    const receipts = path.join(tmp, '.cache/ruvnet-brain/gate-blocks.jsonl');
    expect(fs.existsSync(receipts)).toBe(true);
    const last = JSON.parse(fs.readFileSync(receipts, 'utf8').trim().split('\n').pop());
    expect(last.gate).toBe('grounding-substance');
    expect(last.reason).toMatch(/D1/);
  });

  it('also catches it through Edit and MultiEdit, not only Write', () => {
    record([INCIDENT_DOC]);
    groundRecency();
    expect(fireGate({ file_path: '/p/a.mjs', old_string: 'x', new_string: INCIDENT_WRITE }, { toolName: 'Edit' }).status).toBe(2);
    expect(fireGate({ file_path: '/p/a.mjs', edits: [{ old_string: 'x', new_string: INCIDENT_WRITE }] }, { toolName: 'MultiEdit' }).status).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// T2 — THE KNOWN-GOOD CORPUS (the false-positive guard)
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(bashOnly)('T2 — known-good corpus: every legitimate write passes', () => {
  /** The hostile ledger: 27 real corpus documents, all recorded, as after a day of real searching. */
  function fullLedger() {
    record([INCIDENT_DOC, UNPKG_DOC, LOCAL_WASM_DOC, ...CORPUS]);
    groundEverything();
  }

  it('the compliant local-install write passes', () => {
    fullLedger();
    const r = fireGate(write('import { RvfStore } from "@ruvector/rvf-wasm";\nexport const s = new RvfStore(384);\n'));
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('unrelated code passes (and never even spawns the substance stage)', () => {
    fullLedger();
    expect(fireGate(write('export function add(a, b) { return a + b; }\n', '/p/math.mjs')).status).toBe(0);
  });

  it('an origin THE STAMPED SOURCE ITSELF CARRIES passes — the F22 case, and D1\'s whole design', () => {
    // `crates/ruvector-wasm/README.md` documents `https://unpkg.com/@ruvector/wasm/...` in its own
    // text. A wall that refused this would be enforcing a preference the source does not hold.
    fullLedger();
    const r = fireGate(write(
      'import init, { VectorDB } from "https://unpkg.com/@ruvector/wasm/pkg/ruvector_wasm.js";\n'
      + 'await init();\nexport const db = new VectorDB(384);\n',
    ));
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('a COMMENT discussing esm.sh passes — warnings about the bug are not the bug', () => {
    fullLedger();
    const r = fireGate(write(
      '// NEVER do this: import x from "https://esm.sh/@ruvector/rvf-wasm" — ruvector ships it locally\n'
      + 'import { RvfStore } from "@ruvector/rvf-wasm";\n',
    ));
    expect(r.status).toBe(0);
  });

  it('a source-carried origin passes IN EITHER LEDGER ORDER — permission is evidence, not walk order', () => {
    // The regression this pins. D1 originally asked "does THIS source carry the host?" inside the
    // source loop and moved on when it did — so with two stamped documents for one package (the
    // README that shows the CDN and the guide that shows only the local install), whichever the walk
    // reached second produced a refusal. The real corpus holds SEVEN documents installing
    // `@ruvector/wasm`, exactly one of which carries unpkg.com, so this was reachable by any ordinary
    // day of searching, not by a contrived ledger. Permission is now a property of the held evidence
    // as a whole: if ANY stamped source that ships the package carries the origin, the origin stands.
    expect(LOCAL_WASM_DOC.fullText).toContain('npm install @ruvector/wasm');
    expect(LOCAL_WASM_DOC.fullText).not.toContain('unpkg.com');   // the doc that would have accused
    expect(UNPKG_DOC.fullText).toContain('unpkg.com');            // the doc that grants permission
    for (const order of [[UNPKG_DOC, LOCAL_WASM_DOC], [LOCAL_WASM_DOC, UNPKG_DOC]]) {
      fs.rmSync(evidenceFile, { force: true });
      record(order);
      groundEverything();
      const r = fireGate(write(
        'import init, { VectorDB } from "https://unpkg.com/@ruvector/wasm/pkg/ruvector_wasm.js";\nawait init();\n',
      ));
      expect(r.status, `refused in ledger order [${order.map((d) => d.path).join(', ')}]:\n${r.stderr}`).toBe(0);
    }
  });

  it('an unknown-but-not-disproved API shape passes — retrieval silence is NOT contradiction (§3.3)', () => {
    fullLedger();
    const r = fireGate(write(
      'import { RvfStore } from "@ruvector/rvf-wasm";\n'
      + 'const s = new RvfStore(384);\nawait s.someMethodNobodyRetrieved({ x: 1 });\n',
    ));
    expect(r.status).toBe(0);
  });

  it('empty evidence passes, and ABSENT evidence passes — never block on absence', () => {
    groundEverything();
    expect(fs.existsSync(evidenceFile)).toBe(false);
    expect(fireGate(write(INCIDENT_WRITE)).status).toBe(0);    // no ledger at all
    fs.writeFileSync(evidenceFile, '');
    expect(fireGate(write(INCIDENT_WRITE)).status).toBe(0);    // empty ledger
    fs.writeFileSync(evidenceFile, '{"v":1,"id":"x","ts":"' + new Date().toISOString() + '","sources":[]}\n');
    expect(fireGate(write(INCIDENT_WRITE)).status).toBe(0);    // a receipt with no facts
    fs.writeFileSync(evidenceFile, 'not json at all\n{ truncated mid-writ');
    expect(fireGate(write(INCIDENT_WRITE)).status).toBe(0);    // a torn ledger is a malfunction, not a decision
  });

  it('STALE evidence does not block — a receipt older than the recency window is not held evidence', () => {
    record([INCIDENT_DOC]);
    groundEverything();
    const line = JSON.parse(fs.readFileSync(evidenceFile, 'utf8').trim());
    line.ts = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    fs.writeFileSync(evidenceFile, `${JSON.stringify(line)}\n`);
    expect(fireGate(write(INCIDENT_WRITE)).status).toBe(0);
  });

  // ── The population that actually decides whether this ships ────────────────────────────────────
  const HIST = JSON.parse(fs.readFileSync(path.join(FIX, 'historical-writes.json'), 'utf8')).writes;

  /** Historical bytes via `git show`; the working-tree file when history is unavailable (shallow CI). */
  function loadHistorical() {
    const out = [];
    for (const w of HIST) {
      let body = null;
      try {
        body = execFileSync('git', ['show', `${w.sha}:${w.path}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1e8 });
      } catch {
        try { body = fs.readFileSync(path.join(REPO, w.path), 'utf8'); } catch { /* genuinely gone */ }
      }
      if (body && body.length > 300) out.push({ ...w, body });
    }
    return out;
  }

  it('20 REAL historical writes from this repo\'s git log all pass — zero false positives', () => {
    const samples = loadHistorical();
    // A shrinking corpus silently weakens the guard, so the floor is asserted rather than assumed.
    expect(samples.length, 'the false-positive corpus collapsed — a small corpus proves nothing')
      .toBeGreaterThanOrEqual(15);
    fullLedger();
    const blocked = [];
    for (const s of samples) {
      const r = fireGate(write(s.body, path.join('/repo', s.path)));
      if (r.status !== 0) blocked.push(`${s.sha}:${s.path} -> exit ${r.status}\n${r.stderr.split('\n').slice(0, 6).join('\n')}`);
    }
    expect(blocked, `FALSE POSITIVES on real historical writes:\n${blocked.join('\n---\n')}`).toEqual([]);
  }, 180_000);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// T3 — MUTATION PROOF
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(bashOnly)('T3 — each detector is load-bearing: break it and its bad write passes', () => {
  /**
   * The three bad writes, one per detector. Each is refused with all detectors live and permitted
   * with exactly its own detector disabled — which is the only way to know a detector is the thing
   * doing the work, rather than another one catching the same case by accident.
   */
  const CASES = [
    {
      id: 'D1',
      why: 'a remote origin for a capability the stamped source ships locally',
      code: INCIDENT_WRITE,
    },
    {
      id: 'D2',
      why: 'package substitution — the same basename, a different owner (the wrong-crate class)',
      code: 'import { RvfStore } from "rvf-wasm";\nexport const s = new RvfStore(384);\n',
    },
    {
      id: 'D3',
      why: 'hand-rolling an API the stamped source exports',
      code: '// a local reimplementation for @ruvector/wasm\nexport class VectorDB {\n  constructor(dim) { this.dim = dim; }\n}\n',
    },
  ];

  for (const c of CASES) {
    it(`${c.id} — ${c.why}`, () => {
      record([INCIDENT_DOC, UNPKG_DOC]);
      groundEverything();

      const live = fireGate(write(c.code));
      expect(live.status, `${c.id} did not refuse its own bad write`).toBe(2);
      expect(live.stderr).toContain(c.id);

      const mutant = fireGate(write(c.code), { extraEnv: { RUVNET_GROUNDING_DISABLE: c.id } });
      expect(mutant.status, `${c.id} was disabled and the bad write STILL failed — something else is catching it, so ${c.id} is not the thing being tested`).toBe(0);
      expect(mutant.stderr, 'a disabled detector must announce itself — a silent bypass is a bypass')
        .toContain(`DETECTOR DISABLED: ${c.id}`);

      // …and restored.
      expect(fireGate(write(c.code)).status).toBe(2);
    });
  }

  it('disabling ALL THREE lets every bad write through — no fourth thing is quietly doing the work', () => {
    record([INCIDENT_DOC, UNPKG_DOC]);
    groundEverything();
    for (const c of CASES) {
      expect(fireGate(write(c.code), { extraEnv: { RUVNET_GROUNDING_DISABLE: 'D1,D2,D3' } }).status).toBe(0);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// T4 — REFUSALS MINT NO EVIDENCE
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('T4 — a non-answer mints nothing (the ADR-054 §3 discipline, extended to substance)', () => {
  const runNode = (src, extraEnv = {}) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], {
      env: env(extraEnv), encoding: 'utf8', timeout: 60_000,
    });
    if (r.status !== 0) throw new Error(`child exited ${r.status}\n${r.stderr}`);
    return r.stdout;
  };
  const IMPORT_EV = `const ev = await import(${JSON.stringify(pathToFileURL(EVIDENCE_MOD).href)});`;

  it('an EMPTY result set writes no ledger line — the search ran, the brain showed nothing', () => {
    runNode(`${IMPORT_EV} ev.recordAnswer({ query: 'anything', repos: ['ruvector'], results: [] });`);
    expect(fs.existsSync(evidenceFile)).toBe(false);
  });

  it('documents carrying NO extractable fact write no ledger line', () => {
    runNode(`${IMPORT_EV} ev.recordAnswer({ query: 'q', repos: ['r'], results: [{ repo: 'r', path: 'a.txt', fullText: 'just prose, no facts here' }] });`);
    expect(fs.existsSync(evidenceFile)).toBe(false);
  });

  it('a real answer DOES write exactly one line — the fix must not shut the writer permanently', () => {
    runNode(`${IMPORT_EV} ev.recordAnswer({ query: 'q', repos: ['r'], results: [${JSON.stringify(INCIDENT_DOC)}] });`);
    expect(fs.readFileSync(evidenceFile, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('RUVNET_BRAIN_EVIDENCE=0 mints nothing — the capture has an off switch of its own', () => {
    runNode(`${IMPORT_EV} ev.recordAnswer({ query: 'q', repos: ['r'], results: [${JSON.stringify(INCIDENT_DOC)}] });`, { RUVNET_BRAIN_EVIDENCE: '0' });
    expect(fs.existsSync(evidenceFile)).toBe(false);
  });

  it('EVERY call site sits after the refusals that can reach it — pinned at the source, not assumed', () => {
    // The producer⇄consumer pinning brain-off.test.mjs established: assert the ORDER in the real
    // file, so a future edit that hoists a capture above a refusal goes red here rather than
    // silently re-arming the write gate from an outage.
    //
    // THIS TEST USED TO ASSUME ONE CALL SITE and checked `src.indexOf(...)` — the FIRST one. When
    // the card lane became a first responder and earned its own receipt, the first occurrence moved
    // above three of the four refusals and this went red. The product was fine; the assumption was
    // not. So it now checks EACH site against the refusals that can actually reach it, which is the
    // property that was always meant — "a non-answer mints nothing", not "there is exactly one call".
    const raw = fs.readFileSync(FORGE_MCP, 'utf8');
    // COMMENTS ARE BLANKED, LENGTH-PRESERVING, so every offset below still indexes the real file.
    // Without this the scan matched `evidence.recordAnswer(...)` inside a PROSE COMMENT explaining
    // the shadowing bug, and reported a capture above the off switch that does not exist. Prose that
    // quotes code is not code — the same substring-is-not-substance mistake this repo keeps paying
    // for, this time inside the test that guards against it.
    const src = raw.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
    const at = (s) => { const i = src.indexOf(s); expect(i, `marker missing: ${s}`).toBeGreaterThan(-1); return i; };
    const sites = [...src.matchAll(/\.recordAnswer\(/g)].map((m) => m.index);
    expect(sites.length, 'no capture call sites found — the writer is unwired').toBeGreaterThan(0);

    const offSwitch = at('return disabledResult(id, k, offState)');
    // THE OFF SWITCH OUTRANKS EVERY LANE. A switched-off brain must mint nothing, whichever lane
    // would have answered — so this one applies to all sites without exception.
    for (const s of sites) expect(offSwitch, 'a capture sits above the off switch').toBeLessThan(s);

    // The outage and empty-result refusals belong to the HEAVY lane — they are states of searchAll,
    // which the card lane returns before ever calling. So they are checked against the LAST site,
    // the heavy one. The card lane cannot reach them: it mints only inside `if (cardHit.hit)`.
    const heavy = sites[sites.length - 1];
    expect(at('RUVNET BRAIN IS DOWN')).toBeLessThan(heavy);                      // outage
    // The empty-result refusal used to be anchored on its own literal text, `(no results — the
    // search ran`. Issue #132 moved that wording into kb/search-outcome.mjs, because forge-mcp-all
    // starts a server on import and a MESSAGE has to be assertable by what it says. The ORDERING
    // property this test guards is unchanged; only the marker moved, so it now anchors on the site
    // where the empty-result body is chosen rather than on the sentence it happens to produce.
    expect(at('+ emptyBody;')).toBeLessThan(heavy);                              // empty
    expect(at('search_ruvnet error:')).toBeGreaterThan(heavy);                   // thrown: in the catch, below
    expect(src.slice(0, sites[0])).toMatch(/if \(cardHit\.hit\)/);               // card lane guarded by a HIT

    // …and every capture is guarded, so a throw inside one can never become a failed query.
    for (const s of sites) {
      const before = src.slice(Math.max(0, s - 400), s);
      expect(before, `capture at ${s} is not inside a try`).toMatch(/try \{/);
    }
    // A receipt with no sources is not grounding — neither lane may attach one.
    // `\?(?!\.)` — the TRUTHINESS test `receipt ? {…}`, not optional chaining `receipt?.sources`.
    // Without the lookahead this matched the correct code and failed on the fix itself.
    expect(src).not.toMatch(/\.\.\.\(\s*(card)?[Rr]eceipt\s*\?(?!\.)/);
  });

  it('LIVE: a switched-off brain answers and writes NO evidence line', () => {
    const stateDir = path.join(tmp, '.config', 'ruvnet-brain');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'brain-off'), JSON.stringify({ off: true, since: new Date().toISOString() }));
    const kbDir = path.join(tmp, 'empty-kb');
    fs.mkdirSync(kbDir, { recursive: true });
    const call = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_ruvnet', arguments: { query: 'rvf browser' } } });
    const r = spawnSync(process.execPath, [FORGE_MCP], {
      input: `${call}\n`, env: env({ KB_DIR: kbDir, RUVNET_BRAIN_STATE_DIR: stateDir, RUVNET_BRAIN_METER: '0' }),
      encoding: 'utf8', timeout: 120_000,
    });
    const msg = (r.stdout || '').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((m) => m && m.id === 1);
    expect(msg?.result?.content?.[0]?.text).toContain('RuvNet Brain is disabled');
    expect(fs.existsSync(evidenceFile), 'a refusal minted evidence').toBe(false);
  }, 150_000);

  it('LIVE: an EMPTY corpus answers and writes NO evidence line', () => {
    const kbDir = path.join(tmp, 'empty-kb2');
    fs.mkdirSync(kbDir, { recursive: true });
    const call = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_ruvnet', arguments: { query: 'rvf browser' } } });
    const r = spawnSync(process.execPath, [FORGE_MCP], {
      input: `${call}\n`, env: env({ KB_DIR: kbDir, RUVNET_BRAIN_METER: '0' }), encoding: 'utf8', timeout: 180_000,
    });
    const msg = (r.stdout || '').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((m) => m && m.id === 2);
    expect(msg, `no JSON-RPC reply\nSTDERR:${r.stderr}`).toBeTruthy();
    expect(msg.result.structuredContent?.grounding, 'a factless answer must carry no grounding receipt').toBeUndefined();
    expect(msg.result.structuredContent?.answer, 'structured-only hosts must still see the factless answer')
      .toBe(msg.result.content[0].text);
    expect(fs.existsSync(evidenceFile)).toBe(false);
  }, 240_000);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// T5 — LATENCY
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(bashOnly)('T5 — the added stage stays inside its declared budget', () => {
  /**
   * Measured on the author's M3 Max, 25 warm iterations, ledger of 26 receipts, quiet machine:
   *   process-spawn floor (node -e '')   p50  27.4ms   p95  31.2ms
   *   substance stage                    p50  54.1ms   p95  78.4ms
   *   whole gate (recency + substance)   p50  81.6ms   p95 101.1ms
   * ADR-055 §6 budgets: prompt-path timeout ≤5s, warm p95 <500ms. The added stage's ceiling is 150ms.
   *
   * ── WHY THIS MEASURES A DELTA AND NOT A WALL CLOCK ──────────────────────────────────────────────
   * The first version asserted absolute wall-clock milliseconds. It passed at p95 78ms and then, on a
   * re-run twenty minutes later, reported 13,126ms — on identical code. The machine was at load
   * average 357 (three sibling worktrees running coverage suites at once). An absolute budget on a
   * shared machine measures the SCHEDULER, not this stage, and would have shipped as an intermittent
   * red that teaches people to re-run until green.
   *
   * So the assertion is on the DIFFERENCE against a process-spawn floor — the cost this stage
   * actually adds. That is also the honest reading of the ADR budget: the wall exists to not cost
   * the user 150ms of thinking, and forking a process on a machine already 357-deep is not a cost
   * this wall introduced.
   *
   * ── AND WHY THE SAMPLING IS PAIRED ──────────────────────────────────────────────────────────────
   * Subtracting one batch's p95 from another batch's p95 was still wrong, and said so out loud: at
   * load 497 the gate reported p50 645ms but p95 1328ms — a distribution whose spread is entirely
   * scheduler. Two batches sampled minutes apart under a load swinging 350→500 do not share a
   * contention level, so their difference is noise minus different noise.
   *
   * Each iteration therefore runs the floor and the subject BACK TO BACK and records that pair's own
   * difference. Both halves meet the same instantaneous machine, so contention cancels within the
   * pair instead of accumulating across batches, and the percentiles are taken over the DELTAS.
   * That alone moved the whole gate's measured cost from 869ms to 85ms at the same load 458.
   *
   * Pairing cancels contention on the FORK but not on the WORK — a machine five deep runs the
   * stage's own bytes five times slower too, and that shows up in the tail (p50 85ms, p95 187ms at
   * load 458). So the ceiling is asserted against the MEDIAN delta, which is the robust central
   * estimate, and the tail is held to a separate, looser bound. Both are printed. Neither is
   * self-certifying: the injection test below must make both of them go red.
   *
   * It can still fail on broken code, which is the point: a synchronous corpus scan, an unbounded
   * ledger read, or a network call in the hot path all show up as delta, and none of them hide behind
   * a busy machine. That is not left to assertion — the last test in this block INJECTS a delay into
   * the stage and requires this same measurement to reject it. Every number is PRINTED
   * unconditionally alongside the load average, because a budget nobody reads is the same as no
   * budget (ADR-055's own lesson about unread diagnostics).
   */
  const CEILING_MS = process.env.CI ? 500 : 150;
  const loadavg = () => os.loadavg().map((n) => n.toFixed(1)).join(' ');

  const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

  /**
   * Paired sampling. Returns the percentiles of the per-iteration DELTA (subject − floor), plus the
   * raw percentiles of each side for the printed record.
   */
  function pairedDelta(floorFn, runFn, n = 25) {
    for (let i = 0; i < 3; i++) { floorFn(); runFn(); }   // warm the page cache and the node binary
    const deltas = []; const floors = []; const runs = [];
    for (let i = 0; i < n; i++) {
      const a = process.hrtime.bigint();
      floorFn();
      const b = process.hrtime.bigint();
      runFn();
      const c = process.hrtime.bigint();
      const f = Number(b - a) / 1e6; const r = Number(c - b) / 1e6;
      floors.push(f); runs.push(r); deltas.push(r - f);
    }
    const s = (a) => [...a].sort((x, y) => x - y);
    const d = s(deltas); const fl = s(floors); const rn = s(runs);
    return {
      d50: pct(d, 0.5), d95: pct(d, 0.95),
      floor95: pct(fl, 0.95), run50: pct(rn, 0.5), run95: pct(rn, 0.95),
    };
  }

  /** The floor: what it costs this machine, right now, merely to fork a node that does nothing. */
  const nodeFloor = () => spawnSync(process.execPath, ['-e', ''], { env: env() });
  /**
   * The whole gate's floor must have the gate's PROCESS TOPOLOGY, not just its outer shell. The gate
   * is: spawn bash, then run `printf … | node checker` — three process creations, not one. Measuring
   * against a bare `bash -c exit 0` charged the gate for a whole node fork it did not cause: 456ms of
   * "added" cost at load 391, essentially all of it the OS creating processes.
   */
  const gateFloor = () => spawnSync(
    'bash', ['-c', `printf '%s' '' | "${process.execPath}" -e ''`], { env: env() },
  );

  /** One measurement: the subject, its paired floor, the delta, the load — printed either way. */
  function measure(label, floorFn, runFn, n = 25) {
    const m = pairedDelta(floorFn, runFn, n);
    console.log(`    [T5] load ${loadavg()} | ${label}: floor p95 ${m.floor95.toFixed(1)}ms `
      + `| subject p50 ${m.run50.toFixed(1)}ms p95 ${m.run95.toFixed(1)}ms `
      + `| PAIRED DELTA p50 ${m.d50.toFixed(1)}ms p95 ${m.d95.toFixed(1)}ms (budget ${CEILING_MS}ms)`);
    return m;
  }

  const PAYLOAD = JSON.stringify({
    tool_name: 'Write', tool_input: write('import { RvfStore } from "@ruvector/rvf-wasm";\n'),
  });

  it(`the substance stage adds under ${CEILING_MS}ms p95 over a bare process spawn`, () => {
    record([INCIDENT_DOC, UNPKG_DOC, ...CORPUS]);
    groundEverything();
    const m = measure('substance stage', nodeFloor,
      () => spawnSync(process.execPath, [SUBSTANCE], { input: PAYLOAD, env: env() }));
    expect(m.d50, 'the stage\'s own work exceeds its ceiling at the median — that is not contention').toBeLessThan(CEILING_MS);
    expect(m.d95, 'even the contention tail must stay within 2x the ceiling').toBeLessThan(CEILING_MS * 2);
  }, 180_000);

  it(`the WHOLE PreToolUse Write gate adds under ${CEILING_MS}ms p95 over the same process topology`, () => {
    record([INCIDENT_DOC, UNPKG_DOC, ...CORPUS]);
    groundEverything();
    const m = measure('whole gate', gateFloor,
      () => spawnSync('bash', [GATE], { input: PAYLOAD, env: env() }));
    expect(m.d50, 'the gate\'s own work exceeds its ceiling at the median — that is not contention').toBeLessThan(CEILING_MS);
    expect(m.d95, 'even the contention tail must stay within 2x the ceiling').toBeLessThan(CEILING_MS * 2);
  }, 180_000);

  it('the budget REJECTS a stage that got slow — proven by making it slow, not by asserting it', () => {
    // A latency budget nobody has watched fail is not a budget. This copies the real checker, injects
    // a delay an order of magnitude past the ceiling, and requires the SAME measurement + budget that
    // passed above to reject it. Without this, every number in this block could be noise agreeing
    // with itself.
    record([INCIDENT_DOC, UNPKG_DOC, ...CORPUS]);
    groundEverything();
    const slow = path.join(tmp, 'slow-substance.mjs');
    const real = fs.readFileSync(SUBSTANCE, 'utf8')
      .replace("from './hook-input.mjs'",
        `from ${JSON.stringify(pathToFileURL(path.join(REPO, 'plugin/scripts/hook-input.mjs')).href)}`);
    // A BLOCKING delay, charged where a real regression lands: inside the stage, after the process
    // already exists. Atomics.wait rather than a busy loop, so it does not add load of its own.
    const injected = real.replace('function main() {',
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);\nfunction main() {');
    expect(injected, 'the injection point moved — this test stopped injecting anything').not.toBe(real);
    fs.writeFileSync(slow, injected);
    // Fewer iterations: each one now costs 1.5s by construction.
    const m = measure('DELIBERATELY SLOW stage', nodeFloor,
      () => spawnSync(process.execPath, [slow], { input: PAYLOAD, env: env() }), 6);
    // BOTH bounds the passing tests rely on must reject it, or one of them was decorative.
    expect(m.d50, 'a 1.5s stage passed the median bound — that bound cannot detect a regression')
      .toBeGreaterThan(CEILING_MS);
    expect(m.d95, 'a 1.5s stage passed the tail bound — that bound cannot detect a regression')
      .toBeGreaterThan(CEILING_MS * 2);
  }, 180_000);

  it('a write naming NO rUv product never spawns the substance stage at all', () => {
    // "Cheaper" was the wrong way to test this. The claim is STRUCTURAL — no node process is created
    // — and a structural claim measured in milliseconds is a claim measured in scheduler noise. So
    // the process is COUNTED instead: `node` is replaced on PATH by a spy that appends a line and
    // then execs the real binary. Deterministic at any load, and it fails the moment the gate starts
    // forking the stage for every write.
    record([INCIDENT_DOC]);
    groundEverything();
    const spyDir = path.join(tmp, 'spy-bin');
    const calls = path.join(tmp, 'node-calls.log');
    fs.mkdirSync(spyDir, { recursive: true });
    for (const bin of ['date', 'stat', 'dirname', 'sh', 'printf']) {
      const abs = spawnSync('bash', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).stdout.trim();
      if (abs) { try { fs.symlinkSync(abs, path.join(spyDir, bin)); } catch { /* builtin, fine */ } }
    }
    fs.writeFileSync(path.join(spyDir, 'node'),
      `#!/bin/sh\necho called >> ${JSON.stringify(calls)}\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
    fs.chmodSync(path.join(spyDir, 'node'), 0o755);
    const spyEnv = { ...env(), PATH: `${spyDir}:${process.env.PATH}` };
    const fireSpied = (content, file) => spawnSync('bash', [GATE], {
      input: JSON.stringify({ tool_name: 'Write', tool_input: write(content, file) }),
      env: spyEnv, encoding: 'utf8', timeout: 30_000,
    });
    const countCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0);

    fireSpied('export const add = (a, b) => a + b;\n', '/p/math.mjs');
    expect(countCalls(), 'a write naming no rUv product still forked the substance stage').toBe(0);

    // …and the spy genuinely works, so the zero above is evidence and not a broken probe.
    fireSpied('import { RvfStore } from "@ruvector/rvf-wasm";\n');
    expect(countCalls(), 'the spy never fired even for a product write — it is not observing anything').toBeGreaterThan(0);
  }, 120_000);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE OVERRIDE (ADR-055 §3.5) — in-band, reasoned, receipted, and NOT an environment variable
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(bashOnly)('the override is mintable from a Write payload, which an env var can never be', () => {
  const OVERRIDE = 'RUVNET_GROUNDING_OVERRIDE: reproducing upstream issue 91 in a jsfiddle';

  it('an in-band token with a real reason permits the write and writes a receipt', () => {
    record([INCIDENT_DOC]);
    groundEverything();
    const r = fireGate(write(`// ${OVERRIDE}\n${INCIDENT_WRITE}`));
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/OVERRIDE ACCEPTED/);             // loud, per §3.5
    const rec = JSON.parse(fs.readFileSync(overrideFile, 'utf8').trim().split('\n').pop());
    expect(rec.detector).toBe('D1');
    expect(rec.reason).toBe('reproducing upstream issue 91 in a jsfiddle');
    expect(rec.reason).not.toMatch(/[}"]$/);                   // the reason is the reason, not payload tail
    expect(rec.adjudication).toBe('unadjudicated');            // §4: never scored until adjudicated
    expect(rec.receipt).toBeTruthy();
    expect(rec.diffHash).toMatch(/^[0-9a-f]{12}$/);            // scoped to THIS diff (§3.5)
  });

  it('a token with no real reason is NOT an override', () => {
    record([INCIDENT_DOC]);
    groundEverything();
    const r = fireGate(write(`// RUVNET_GROUNDING_OVERRIDE: meh\n${INCIDENT_WRITE}`));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/reason was too short/);
    expect(fs.existsSync(overrideFile)).toBe(false);
  });

  it('the legacy blanket env var no longer disarms the fourth wall (ADR-055 §3.5, retired)', () => {
    // It still skips the RECENCY wall, as documented since ADR-0012 — the recency stamps are
    // deliberately absent here and the write is still refused, which is the whole distinction:
    // recency is a ceremony you may skip; "you are writing the opposite of the source" is not.
    record([INCIDENT_DOC]);
    const r = fireGate(write(INCIDENT_WRITE), { extraEnv: { RUVNET_SKIP_GROUNDING_CHECK: '1' } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/GROUNDING-NET/);
  });

  it('the override is scoped to the write that carries it — the next write is refused again', () => {
    record([INCIDENT_DOC]);
    groundEverything();
    expect(fireGate(write(`// ${OVERRIDE}\n${INCIDENT_WRITE}`)).status).toBe(0);
    expect(fireGate(write(INCIDENT_WRITE)).status).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE USER-OWNED POLICY FILE (ADR-055 §3.2) — the only thing that can resolve source ambiguity
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(bashOnly)('.ruvnet/implementation-policy.json selects among source-supported options', () => {
  const UNPKG_WRITE = 'import init, { VectorDB } from "https://unpkg.com/@ruvector/wasm/pkg/ruvector_wasm.js";\nawait init();\n';

  it('absent policy: an origin the source carries is permitted (the honest default)', () => {
    record([UNPKG_DOC]);
    groundEverything();
    expect(fireGate(write(UNPKG_WRITE)).status).toBe(0);
  });

  it('bundled-only policy: the SAME source-supported origin is now refused, as the user asked', () => {
    record([UNPKG_DOC]);
    groundEverything();
    const pol = path.join(tmp, 'implementation-policy.json');
    fs.writeFileSync(pol, JSON.stringify({ network: { runtimeOrigins: 'bundled-only' } }));
    const r = fireGate(write(UNPKG_WRITE), { extraEnv: { RUVNET_IMPL_POLICY: pol } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/GROUNDING-POLICY|D4/);
    expect(r.stderr).toMatch(/policy requires bundled delivery/);
  });

  it('a project-local .ruvnet/implementation-policy.json is found by walking up from the file', () => {
    record([UNPKG_DOC]);
    groundEverything();
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(proj, '.ruvnet'), { recursive: true });
    fs.mkdirSync(path.join(proj, 'src', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.ruvnet/implementation-policy.json'),
      JSON.stringify({ network: { runtimeOrigins: 'bundled-only' } }));
    const r = fireGate(write(UNPKG_WRITE, path.join(proj, 'src/deep/a.mjs')));
    expect(r.status).toBe(2);
  });

  it('deniedPackages is enforced, and named as the user\'s decision rather than the source\'s', () => {
    record([INCIDENT_DOC]);
    groundEverything();
    const pol = path.join(tmp, 'p2.json');
    fs.writeFileSync(pol, JSON.stringify({ deniedPackages: ['@ruvector/rvf-wasm'] }));
    const r = fireGate(write('import { RvfStore } from "@ruvector/rvf-wasm";\n'), { extraEnv: { RUVNET_IMPL_POLICY: pol } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/implementation policy/);
  });

  it('a corrupt policy file is ignored rather than obeyed — malfunction is not a decision', () => {
    record([UNPKG_DOC]);
    groundEverything();
    const pol = path.join(tmp, 'p3.json');
    fs.writeFileSync(pol, '{ truncated mid-writ');
    expect(fireGate(write(UNPKG_WRITE), { extraEnv: { RUVNET_IMPL_POLICY: pol } }).status).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// STRUCTURAL CONTRACTS — the things a future edit could break silently
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('structure: the contracts that keep this honest', () => {
  it('the RECENCY wall is still pure bash — no node, no jq, no python above the stage-2 marker', () => {
    const src = fs.readFileSync(GATE, 'utf8');
    const marker = 'STAGE 2 — THE SUBSTANCE WALL';
    const cut = src.indexOf(marker);
    expect(cut, 'the stage-2 marker vanished — the dependency split can no longer be checked').toBeGreaterThan(0);
    const recency = src.slice(0, cut).split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    for (const bin of ['python3', 'jq', '$(cat', '| grep', '| sed', 'node ']) {
      expect(recency, `the recency wall must not depend on ${bin} (ADR-0021)`).not.toContain(bin);
    }
    expect(recency).toMatch(/BASH_REMATCH/);
  });

  it('the substance stage FAILS OPEN when NODE is missing', () => {
    // Proven by breaking it, not by reading the comment.
    //
    // The obvious way to write this — PATH='/nonexistent-bin' — is the way that proves NOTHING, and
    // it is how this test was first written. `spawnSync('bash', …)` resolves `bash` itself through
    // PATH, so stripping PATH made the SPAWN fail (status null, ENOENT): the gate never ran at all,
    // and the assertion was reading a harness failure. A test that cannot reach the code it names is
    // not a test.
    //
    // So: build a sandbox PATH that has everything the recency wall needs (date, stat, dirname) and
    // deliberately no node, and invoke bash by ABSOLUTE path so the spawn itself cannot be what fails.
    if (bashOnly) return;
    record([INCIDENT_DOC]);
    groundEverything();

    const bashAbs = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
    const sandbox = path.join(tmp, 'nodeless-bin');
    fs.mkdirSync(sandbox, { recursive: true });
    for (const bin of ['date', 'stat', 'dirname', 'sh']) {
      const abs = spawnSync('bash', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).stdout.trim();
      if (abs) fs.symlinkSync(abs, path.join(sandbox, bin));
    }
    const nodeless = { ...env(), PATH: sandbox };

    // The sandbox must really be nodeless, or the test passes for the wrong reason.
    expect(spawnSync(bashAbs, ['-c', 'command -v node'], { env: nodeless }).status,
      'the sandbox still has node — this test would prove nothing').not.toBe(0);

    const r = spawnSync(bashAbs, [GATE], {
      input: JSON.stringify({ tool_name: 'Write', tool_input: write(INCIDENT_WRITE) }),
      env: nodeless, encoding: 'utf8', timeout: 30_000,
    });
    expect(r.error, 'the gate itself failed to spawn — the harness broke, not the gate').toBeFalsy();
    expect(r.status, 'a missing node turned into a refusal — that is malfunction as decision').toBe(0);

    // …and the SAME sandbox WITH node restored still refuses, which is what proves the exit 0 above
    // came from the missing dependency and not from the sandbox quietly disarming the whole gate.
    fs.symlinkSync(process.execPath, path.join(sandbox, 'node'));
    const armed = spawnSync(bashAbs, [GATE], {
      input: JSON.stringify({ tool_name: 'Write', tool_input: write(INCIDENT_WRITE) }),
      env: nodeless, encoding: 'utf8', timeout: 30_000,
    });
    expect(armed.status, 'with node present the same sandbox must still refuse').toBe(2);
  });

  it('the substance stage FAILS OPEN when the CHECKER FILE is missing', () => {
    // The other half of the same claim, and the one an installer can actually cause: an older packed
    // bundle carries ground-before-write.sh but not grounding-substance.mjs. The gate resolves the
    // checker relative to its own BASH_SOURCE, so a copy standing alone reproduces that exactly.
    if (bashOnly) return;
    record([INCIDENT_DOC]);
    groundEverything();
    const lonely = path.join(tmp, 'lonely-scripts');
    fs.mkdirSync(lonely, { recursive: true });
    fs.copyFileSync(GATE, path.join(lonely, 'ground-before-write.sh'));
    const r = spawnSync('bash', [path.join(lonely, 'ground-before-write.sh')], {
      input: JSON.stringify({ tool_name: 'Write', tool_input: write(INCIDENT_WRITE) }),
      env: env(), encoding: 'utf8', timeout: 30_000,
    });
    expect(r.status, 'a missing checker turned into a refusal').toBe(0);
    expect(r.stderr).toBe('');
  });

  it('the checker never writes to stdout (PreToolUse stdout is not a channel for a wall)', () => {
    if (bashOnly) return;
    record([INCIDENT_DOC]);
    const r = spawnSync(process.execPath, [SUBSTANCE], {
      input: JSON.stringify({ tool_name: 'Write', tool_input: write(INCIDENT_WRITE) }),
      env: env(), encoding: 'utf8',
    });
    expect(r.stdout).toBe('');
    expect(r.status).toBe(2);
  });

  it('garbage in ⇒ exit 0 out, every shape', () => {
    if (bashOnly) return;
    for (const bad of ['', 'not json at all', '{}', '{"tool_name":"Write"}', '[1,2,3]', '{"tool_name":"Read","tool_input":{}}']) {
      const r = spawnSync(process.execPath, [SUBSTANCE], { input: bad, env: env(), encoding: 'utf8' });
      expect(r.status, `payload ${JSON.stringify(bad)} produced ${r.status}`).toBe(0);
    }
  });

  it('the two copies of the shared package helpers AGREE — duplication held by test, not by comment', async () => {
    // kb/forge-evidence.mjs and plugin/scripts/grounding-substance.mjs must duplicate these (the
    // bundle and the plugin ship separately and cannot import each other — issue #32). The
    // duplication is only safe while a drift goes red, so one table drives both copies.
    const a = await import(pathToFileURL(EVIDENCE_MOD).href);
    const b = await import(pathToFileURL(SUBSTANCE).href);
    const urls = [
      'https://esm.sh/@ruvector/rvf-wasm',
      'https://esm.sh/@ruvector/rvf-wasm@1.2.3/dist/x.js',
      'https://unpkg.com/@ruvector/wasm/pkg/ruvector_wasm.js',
      'https://cdn.jsdelivr.net/npm/@ruvector/edge-net/dist/edge-net.min.js',
      'https://unpkg.com/router-wasm/router_wasm.js',
      'https://example.com/',
      'not a url',
      '',
    ];
    for (const u of urls) expect(b.packageFromUrl(u), u).toBe(a.packageFromUrl(u));
    const specs = ['@ruvector/rvf-wasm', '@ruvector/rvf-wasm/dist/x.js', 'rvf-wasm', './local.mjs', 'node:fs', 'https://x/y', ''];
    for (const s of specs) expect(b.specToPackage(s), s).toBe(a.specToPackage(s));
    for (const n of ['@ruvector/rvf-wasm', 'rvf-wasm', '']) expect(b.pkgBase(n), n).toBe(a.pkgBase(n));
  });

  it('the evidence ledger is capped, so a busy machine cannot grow it without bound', () => {
    const src = fs.readFileSync(EVIDENCE_MOD, 'utf8');
    expect(src).toMatch(/MAX_BYTES/);
    expect(src).toMatch(/function capFile/);
    // …and every write path is swallowed: capture must never break a query.
    expect(src.match(/catch \{/g)?.length ?? 0).toBeGreaterThan(6);
  });

  it('kb/forge-evidence.mjs imports nothing outside kb/ (issue #32, MODULE_NOT_FOUND twice)', () => {
    // Comments are stripped before scanning: this file DOCUMENTS import syntax (`… from 'pkg'`) in a
    // doc comment, and a scanner that reads a comment as an import reports a dependency that does not
    // exist. Real ESM static imports are top-level, so they are anchored to the start of a line;
    // dynamic import() is matched separately because it is the form forge-mcp-all.mjs actually uses
    // to load this module.
    const src = fs.readFileSync(EVIDENCE_MOD, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const specs = [
      ...[...src.matchAll(/^\s*(?:import|export)\b[^\n]*?\bfrom\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
      ...[...src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
      ...[...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
      ...[...src.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
    ];
    expect(specs.length, 'the import scan found nothing — it stopped being able to fail').toBeGreaterThan(0);
    for (const s of specs) {
      expect(s.startsWith('node:'), `kb/ may not import ${s}`).toBe(true);
    }
    // Prove the scanner can still fail: the same scan over a file that DOES reach outside kb/.
    const outside = fs.readFileSync(SUBSTANCE, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const outsideSpecs = [...outside.matchAll(/^\s*(?:import|export)\b[^\n]*?\bfrom\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(outsideSpecs.some((s) => !s.startsWith('node:')), 'the scan can no longer detect a non-builtin import').toBe(true);
  });

  it('grounding-stamp.sh still mints on a RESULT (the ADR-054 fix survives) and now records the mode', () => {
    if (bashOnly) return;
    const src = fs.readFileSync(STAMP, 'utf8');
    expect(src).toContain('RuvNet Brain is disabled');
    expect(src).toContain('Searched ');
    // The derived SUBSTANCE-BOUND / SEARCH-ONLY state (ADR-055 §3.7.10) — never asserted, read off
    // the evidence ledger's own mtime.
    record([INCIDENT_DOC]);
    groundRecency();
    expect(fs.readFileSync(path.join(tmp, '.cache/ruvnet-brain/grounding-mode'), 'utf8').trim()).toBe('substance-bound');
  });

  it('with no ledger at all, the mode is SEARCH-ONLY — the honest state, not a silent claim', () => {
    if (bashOnly) return;
    groundRecency();
    expect(fs.readFileSync(path.join(tmp, '.cache/ruvnet-brain/grounding-mode'), 'utf8').trim()).toBe('search-only');
  });
});
