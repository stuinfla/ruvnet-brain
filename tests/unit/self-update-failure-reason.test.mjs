// tests/unit/self-update-failure-reason.test.mjs — the nightly failed six times over three nights
// (2026-08-03..08-06) and escalated six times with an EMPTY reason. Not because the reason was
// unknown: scripts/corpus-qa.mjs had printed it, in full, into logs/nightly.log every time. The
// pipeline simply threw it away. execFileSync(..., {stdio:'inherit'}) gives a failing child's Error
// NO output at all — e.stdout and e.stderr are both null and e.message is only "Command failed:
// <argv>" (verified live 2026-08-06) — so the failure record, the [FATAL] summary built from it, and
// the push alert nightly-wrapper.sh samples from that summary all carried argv and nothing else.
//
// These tests exercise the SHIPPED runStep bytes (sliced out of scripts/self-update.mjs, not
// re-typed) against real child processes. The load-bearing case is the third one: corpus-qa writes
// its verdict table and every '↳ <reason>' line with console.log, i.e. to STDOUT — so capturing
// stderr alone would still have produced a reasonless escalation for the exact failure this exists
// to explain.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'scripts/self-update.mjs'), 'utf8');

/**
 * Slice a top-level `function name(...) { ... }` out of a source file. The parameter list is
 * matched by parens FIRST — `opts = {}` style defaults put braces before the body, so seeking the
 * first `{` after the name finds the wrong one and slices an empty function.
 */
function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in self-update.mjs`);
  let i = src.indexOf('(', start);
  let parens = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')') { parens--; if (parens === 0) { i++; break; } }
  }
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces after ${name}`);
}

let runStep;
let tmp;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'self-update-reason-'));
  const tailConst = /const STEP_TAIL_LINES = \d+;/.exec(SOURCE);
  expect(tailConst, 'STEP_TAIL_LINES must exist in self-update.mjs').toBeTruthy();
  const mod = [
    "import { spawnSync } from 'node:child_process';",
    tailConst[0],
    sliceFunction(SOURCE, 'runStep'),
    'export { runStep };',
  ].join('\n');
  const f = path.join(tmp, 'runstep.mjs');
  fs.writeFileSync(f, mod);
  ({ runStep } = await import(pathToFileURL(f).href));
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const NODE = process.execPath;
/** A child that writes `out` to stdout, `err` to stderr, and exits `code`. */
const child = (out, err, code) => [
  '-e',
  `${out ? `process.stdout.write(${JSON.stringify(out + '\n')});` : ''}`
  + `${err ? `process.stderr.write(${JSON.stringify(err + '\n')});` : ''}`
  + `process.exit(${code});`,
];

describe('self-update — a failing child step explains itself', () => {
  it('a zero-exit step does not throw', () => {
    expect(() => runStep('[qa] ok', NODE, child('all good', '', 0), {}, { captureStdout: true })).not.toThrow();
  });

  it('THE NIGHTLY CASE: a child that fails with its reason on STDOUT surfaces that reason (captureStdout)', () => {
    const reason = '    ↳ R1 self-retrieval missed: id=chunk:2b7c2755 ABSENT from top-500 submissions/x.txt';
    let caught = null;
    try {
      runStep('[qa] metaharness', NODE, child(`${reason}\n[corpus-qa] 0/1 store-variants PASS — 1 FAILED`, '', 1),
        {}, { captureStdout: true });
    } catch (e) { caught = e; }

    expect(caught, 'a nonzero exit must throw').toBeTruthy();
    expect(caught.step).toBe('[qa] metaharness');
    expect(caught.status).toBe(1);
    expect(caught.output).toContain('R1 self-retrieval missed');
    expect(caught.output).toContain('ABSENT from top-500');
    expect(caught.output).toContain('0/1 store-variants PASS');
    expect(caught.message).toContain('[qa] metaharness exited 1');
    expect(caught.message).toContain('R1 self-retrieval missed');   // the alert text itself carries it
    expect(caught.output.length).toBeGreaterThan(40);               // not a truncated stub
  });

  it('stderr-only capture would NOT have explained the nightly — stdout capture is load-bearing', () => {
    // Same child, captureStdout:false. This is the shape the "just pipe stderr" fix would have had.
    let caught = null;
    try {
      runStep('[qa] metaharness', NODE, child('    ↳ R1 self-retrieval missed: ABSENT from top-500', '', 1), {});
    } catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught.output).toBe('');                                  // nothing to escalate
    expect(caught.message).toContain('(child produced no output)');  // and it says so, out loud
  });

  it('a builder that fails with a stack on stderr surfaces it while stdout stays inherited (live progress)', () => {
    let caught = null;
    try {
      runStep('[refresh] metaharness', NODE, child('', 'Error: ENOENT no such file kb/metaharness.passages.jsonl', 2), {});
    } catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught.step).toBe('[refresh] metaharness');
    expect(caught.status).toBe(2);
    expect(caught.output).toContain('ENOENT');
    expect(caught.output).toContain('metaharness.passages.jsonl');
  });

  it('the captured reason is bounded — a screaming child cannot flood the alert', () => {
    const noisy = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
    let caught = null;
    try { runStep('[qa] noisy', NODE, child(noisy, '', 1), {}, { captureStdout: true }); } catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    const kept = caught.output.split(' | ');
    expect(kept.length).toBeLessThanOrEqual(20);      // a tail, not the whole log
    expect(kept.at(-1)).toBe('line 399');             // and it is the END of the output, where reasons live
    expect(kept).not.toContain('line 0');
  });
});

describe('self-update — the abort summary carries the reason it collected', () => {
  it('the failure record keeps step + reason, not just the argv', () => {
    expect(SOURCE).toContain('failures.push({ name: p.name, step: e.step');
    expect(SOURCE).toContain('reason: e.output');
  });

  it('the REFRESH step captures stdout — forge-refresh gates promotion on its own candidate QA, and that verdict is on stdout', () => {
    const at = SOURCE.indexOf('console.log(`[refresh] ${kb}`)');
    expect(at).toBeGreaterThan(-1);
    const refresh = SOURCE.slice(at, SOURCE.indexOf('console.log(`[symbols] ${kb}`)', at));
    expect(refresh).toContain('captureStdout: true');
  });

  it('the QA step — the one whose verdict must reach the alert — is wired with captureStdout', () => {
    const at = SOURCE.indexOf('console.log(`[qa] ${kb}`)');
    expect(at).toBeGreaterThan(-1);
    // ...the catch that FOLLOWS the qa step — self-update has earlier try/catch blocks, and
    // slicing to the first one in the file runs backwards and yields ''.
    const qa = SOURCE.slice(at, SOURCE.indexOf('} catch (e)', at));
    expect(qa).toContain('corpus-qa.mjs');
    expect(qa).toContain('captureStdout: true');
  });

  it('the [FATAL] block prints each reason, and the push alert quotes the first one', () => {
    const fatal = SOURCE.slice(SOURCE.indexOf('if (failures.length) {'), SOURCE.indexOf('[stamp] re-stamping'));
    expect(fatal).toContain('reason:');
    expect(fatal).toMatch(/NOTIFY\([\s\S]*first\.reason \|\| first\.error/);
  });
});

describe('nightly-wrapper — the escalation sample is wide enough to contain a reason', () => {
  const WRAPPER = fs.readFileSync(path.join(ROOT, 'scripts/nightly-wrapper.sh'), 'utf8');

  it('samples enough of the log that the [FATAL] reason lines survive', () => {
    const m = /tail -(\d+) "\$LOG"[\s\S]{0,80}?cut -c1-(\d+)/.exec(WRAPPER);
    expect(m, 'escalation tail/cut pair must exist').toBeTruthy();
    const [, lines, chars] = m.map(Number);
    // Was tail -8 | cut -c1-600: the [FATAL] block alone is 4+ lines and the old cut landed
    // mid-argv, so the alert was truncated before any reason could appear.
    expect(lines).toBeGreaterThanOrEqual(20);
    expect(chars).toBeGreaterThanOrEqual(1800);
  });
});
