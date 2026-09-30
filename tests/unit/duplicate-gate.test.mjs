import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, rank, prepare, extract, exemption, distinctFrom, largeNewExports, buildBudgetMs, IndexBudgetError, SKIPPED } from '../../plugin/scripts/duplicate-gate.mjs';
import { policiesFor } from '../../plugin/scripts/decision-gate.mjs';

/**
 * duplicate-gate — the owner's "no duplicates or replication across the project" as a write-time policy
 * of decision-gate. Every case runs against a throwaway git repository; nothing touches the real home.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const GATE = path.join(ROOT, 'plugin', 'scripts', 'duplicate-gate.mjs');
const DECISION_GATE = path.join(ROOT, 'plugin', 'scripts', 'decision-gate.mjs');
const temps = [];
afterEach(() => { for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const CENSUS = `#!/usr/bin/env node
/**
 * census-writer.mjs — the one writer of the census numbers on every claim surface.
 * Reads the installed KB's SOURCE.json and rewrites "N indexed stores and N source chunks".
 */
import fs from 'node:fs';
import path from 'node:path';

const SURFACES = ['README.md', 'explainer/index.html', 'explainer/llms.txt'];

export function censusOf(kbDir) {
  const source = JSON.parse(fs.readFileSync(path.join(kbDir, 'SOURCE.json'), 'utf8'));
  const stores = Object.values(source.stores || {});
  const chunks = stores.reduce((total, store) => total + (store.chunkCount || 0), 0);
  return { stores: stores.length, chunks };
}

export function rewriteCensus(text, { stores, chunks }) {
  return text
    .replace(/[\\d,]+ indexed stores and [\\d,]+ source chunks/g, \`\${stores} indexed stores and \${chunks} source chunks\`)
    .replace(/[\\d,]+ public stores/g, \`\${stores} public stores\`);
}

export function syncSurfaces(root, census, { check = false } = {}) {
  const drifted = [];
  for (const rel of SURFACES) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    const after = rewriteCensus(before, census);
    if (after === before) continue;
    drifted.push(rel);
    if (!check) fs.writeFileSync(file, after);
  }
  if (drifted.length && check) {
    process.exitCode = 1;
    console.error(\`census drift on \${drifted.length} surface(s): \${drifted.join(', ')}\`);
  }
  return drifted;
}
`;

const UNRELATED = `#!/usr/bin/env node
/**
 * palette.mjs — contrast ratios for the explainer's colour tokens (WCAG 2.2 relative luminance).
 */
export function luminance(hex) {
  const [r, g, b] = hex.replace('#', '').match(/../g).map((h) => parseInt(h, 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function passesAA(foreground, background, large = false) {
  return contrast(foreground, background) >= (large ? 3 : 4.5);
}
`;

/** A near-duplicate: the same job, renamed, with the body copied — the restamper that should never be written. */
const NEAR_DUP = CENSUS
  .replace('census-writer.mjs — the one writer of the census numbers on every claim surface.', 'restamp-census.mjs — restamp census numbers after a KB rebuild.')
  .replace('export function syncSurfaces', 'export function restampAll');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-gate-'));
  temps.push(dir);
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  put('plugin/scripts/decision-gate.mjs', '// marker: this is the RuvNet Brain checkout\n');
  put('scripts/census-writer.mjs', CENSUS);
  put('scripts/palette-old.mjs', '// unrelated\nexport const A = 1;\n');
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture');
  return { dir, put, state: path.join(dir, '.state') };
}

const writePayload = (dir, rel, content, session = 's1') => ({
  session_id: session, cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, rel), content },
});
const envFor = (state, extra = {}) => ({ RUVNET_DUPLICATE_GATE_STATE_DIR: state, ...extra });

describe('duplicate-gate — the policy', () => {
  it('near-duplicate new file: refuses ONCE with the matching file, then allows the retry and records it', () => {
    const { dir, state } = repo();
    const first = evaluate(writePayload(dir, 'scripts/restamp-census.mjs', NEAR_DUP), { env: envFor(state) });
    expect(first.allow).toBe(false);
    expect(first.matches[0].path).toBe('scripts/census-writer.mjs');
    expect(first.reason).toMatch(/scripts\/census-writer\.mjs/);
    expect(first.reason).toMatch(/DISTINCT-FROM: <path> — <reason>/);

    const retry = evaluate(writePayload(dir, 'scripts/restamp-census.mjs', NEAR_DUP), { env: envFor(state) });
    expect(retry).toMatchObject({ allow: true, why: 'acknowledged' });
    const acks = JSON.parse(fs.readFileSync(path.join(state, 'acks.json'), 'utf8'));
    expect(Object.values(acks)[0]).toMatchObject({ state: 'acknowledged', rel: 'scripts/restamp-census.mjs' });

    // A different session gets its own single interruption; the same session never loops.
    expect(evaluate(writePayload(dir, 'scripts/restamp-census.mjs', NEAR_DUP, 's2'), { env: envFor(state) }).allow).toBe(false);
    expect(evaluate(writePayload(dir, 'scripts/restamp-census.mjs', NEAR_DUP), { env: envFor(state) }).allow).toBe(true);
  });

  it('a valid DISTINCT-FROM header allows on the first attempt; one naming a missing path does not', () => {
    const { dir, state } = repo();
    const declared = NEAR_DUP.replace('#!/usr/bin/env node\n', '#!/usr/bin/env node\n// DISTINCT-FROM: scripts/census-writer.mjs — writes the private overlay surfaces, which that writer must never touch\n');
    expect(evaluate(writePayload(dir, 'scripts/restamp-census.mjs', declared), { env: envFor(state) }))
      .toMatchObject({ allow: true, why: 'distinct-from' });
    const bogus = declared.replace('DISTINCT-FROM: scripts/census-writer.mjs', 'DISTINCT-FROM: scripts/nope.mjs');
    expect(evaluate(writePayload(dir, 'scripts/restamp-other.mjs', bogus), { env: envFor(state) }).allow).toBe(false);
    expect(distinctFrom('// DISTINCT-FROM: scripts/census-writer.mjs\n', () => true), 'a path without a reason is not a declaration').toBeNull();
  });

  it('CUT 1: the same file name in another directory is a relocation, never a refusal', () => {
    const { dir, state } = repo();
    const r = evaluate(writePayload(dir, 'plugin/scripts/census-writer.mjs', CENSUS), { env: envFor(state) });
    expect(r).toMatchObject({ allow: true, why: 'no-match' });
    // Break-it: the SAME text under a different name is still refused — the cut is the name, not the content.
    expect(evaluate(writePayload(dir, 'plugin/scripts/census-copy.mjs', CENSUS), { env: envFor(state) }).allow).toBe(false);
  });

  it('CUT 2: a test that copies another test\'s scaffolding is a SHADOW would-block, logged, never refused', () => {
    const { dir, put, state } = repo();
    put('tests/unit/census-writer.test.mjs', CENSUS);
    spawnSync('git', ['add', '.'], { cwd: dir });
    const r = evaluate(writePayload(dir, 'tests/unit/census-copy.test.mjs', NEAR_DUP), { env: envFor(state, { RUVNET_DUPLICATE_GATE_BUDGET_MS: '60000' }) });
    expect(r).toMatchObject({ allow: true, why: 'shadow-test' });
    expect(fs.readFileSync(path.join(state, 'shadow.jsonl'), 'utf8')).toMatch(/"wouldBlock":true,"why":"test-scaffolding"/);
  });

  it('an unrelated new file is silent', () => {
    const { dir, state } = repo();
    const r = evaluate(writePayload(dir, 'scripts/palette.mjs', UNRELATED), { env: envFor(state) });
    expect(r).toMatchObject({ allow: true, why: 'no-match' });
  });

  it('an ordinary edit of an existing file is silent; an edit ADDING a large copied export is not', () => {
    const { dir, state } = repo();
    const file = path.join(dir, 'scripts/palette-old.mjs');
    const small = { session_id: 's1', cwd: dir, tool_name: 'Edit', tool_input: { file_path: file, old_string: 'export const A = 1;', new_string: 'export const A = 2;' } };
    expect(evaluate(small, { env: envFor(state) })).toMatchObject({ allow: true, why: 'no-new-code' });
    const copiedExport = CENSUS.slice(CENSUS.indexOf('export function syncSurfaces')).replace('syncSurfaces', 'syncEverything')
      + CENSUS.slice(CENSUS.indexOf('export function rewriteCensus'), CENSUS.indexOf('export function syncSurfaces')).replace('rewriteCensus', 'rewriteAgain');
    expect(largeNewExports(copiedExport).length).toBeGreaterThan(0);
    const big = { ...small, tool_input: { file_path: file, old_string: 'export const A = 1;', new_string: `export const A = 1;\n\n${copiedExport}` } };
    const r = evaluate(big, { env: envFor(state) });
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/new export syncEverything/);
  });

  it('exempts test mirrors, fixtures, generated files, stubs, docs and out-of-scope paths', () => {
    const stems = new Set(['census-writer']);
    expect(exemption('tests/unit/census-writer.test.mjs', CENSUS, stems)).toBe('test-mirror');
    expect(exemption('tests/fixtures/x.mjs', CENSUS, stems)).toBe('fixture');
    expect(exemption('scripts/x.mjs', `// @generated by build\n${CENSUS}`, stems)).toBe('generated');
    expect(exemption('scripts/shim.mjs', "// shim\nexport * from '../plugin/scripts/x.mjs';\n", stems)).toBe('too-small');
    expect(exemption('docs/x.md', CENSUS, stems)).toBe('out-of-scope');
    expect(exemption('scripts/x.json', CENSUS, stems)).toBe('not-code');
    expect(exemption('scripts/x.mjs', CENSUS, stems)).toBeNull();
  });

  it('Codex apply_patch (Add File, as codex-hook-adapter normalises it) is judged like a Write', () => {
    const { dir, state } = repo();
    const patch = `*** Begin Patch\n*** Add File: scripts/restamp-census.mjs\n${NEAR_DUP.split('\n').map((l) => `+${l}`).join('\n')}\n*** End Patch\n`;
    const payload = { session_id: 'c1', cwd: dir, tool_name: 'Edit', tool_input: { file_path: 'scripts/restamp-census.mjs', new_string: patch } };
    expect(evaluate(payload, { env: envFor(state) }).allow).toBe(false);
  });

  it('is scoped to this checkout unless opted in, and can be switched off', () => {
    const { dir, state } = repo();
    fs.rmSync(path.join(dir, 'plugin'), { recursive: true });
    expect(evaluate(writePayload(dir, 'scripts/restamp-census.mjs', NEAR_DUP), { env: envFor(state) }).why).toBe('not-this-repo');
    expect(evaluate(writePayload(dir, 'scripts/restamp-census.mjs', NEAR_DUP), { env: envFor(state, { RUVNET_DUPLICATE_GATE: 'on' }) }).allow).toBe(false);
    expect(evaluate(writePayload(dir, 'scripts/x.mjs', NEAR_DUP), { env: envFor(state, { RUVNET_DUPLICATE_GATE: 'off' }) }).why).toBe('disabled');
  });

  it('TEETH: without the similarity matcher the near-duplicate would pass — the block comes from rank()', () => {
    // Break-it: the same candidate against an index that lacks the original must be silent. If rank()
    // stopped matching (or the weights collapsed), the first test above would fail with it.
    const cand = extract('scripts/restamp-census.mjs', NEAR_DUP);
    const withOriginal = prepare([{ path: 'scripts/census-writer.mjs', f: extract('scripts/census-writer.mjs', CENSUS) }, { path: 'scripts/palette.mjs', f: extract('scripts/palette.mjs', UNRELATED) }]);
    const without = prepare([{ path: 'scripts/palette.mjs', f: extract('scripts/palette.mjs', UNRELATED) }]);
    expect(rank(withOriginal, cand, { testsOnly: false })[0].strength).toBeGreaterThanOrEqual(1);
    expect(rank(without, cand, { testsOnly: false })[0].strength).toBeLessThan(1);
  });
});

describe('duplicate-gate — fail open, and wired into the one refuser', () => {
  const fire = (script, args, payload, env) => spawnSync(process.execPath, [script, ...args], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env },
  });

  it('a blown index budget with NO cached index throws a typed, explained error — never a silent allow', () => {
    const { dir, state } = repo();
    expect(() => evaluate(writePayload(dir, 'scripts/restamp-census.mjs', NEAR_DUP), { env: envFor(state), deadline: Date.now() - 1 }))
      .toThrow(IndexBudgetError);
    expect(() => evaluate(writePayload(dir, 'scripts/restamp-census.mjs', NEAR_DUP), { env: envFor(state), deadline: Date.now() - 1 }))
      .toThrow(/index budget exhausted .*files unindexed; progress is cached/);
    // The CLI still never refuses on it: it exits SKIPPED (3) and says so in one line.
    const r = fire(GATE, [], writePayload(dir, 'scripts/restamp-census.mjs', NEAR_DUP), { ...envFor(state), RUVNET_DUPLICATE_GATE_BUDGET_MS: '0' });
    expect(r.status).toBe(SKIPPED);
    expect(r.stderr).toMatch(/^duplicate gate skipped: index budget exhausted/);
  });

  it('OVERLOAD DOES NOT DISABLE IT: with a warm-but-stale index and zero budget it still judges', () => {
    const { dir, state } = repo();
    expect(evaluate(writePayload(dir, 'scripts/palette.mjs', UNRELATED), { env: envFor(state) }).allow).toBe(true); // warms the index
    const orig = path.join(dir, 'scripts/census-writer.mjs');
    fs.appendFileSync(orig, '\n// touched: every cached entry for this file is now stale\n');
    const r = evaluate(writePayload(dir, 'scripts/restamp-census.mjs', NEAR_DUP), { env: envFor(state), deadline: Date.now() - 1 });
    expect(r.allow).toBe(false);
    expect(r.matches[0].path).toBe('scripts/census-writer.mjs');
  });

  it('the budget scales with measured load and never outruns decision-gate\'s deadline', () => {
    expect(buildBudgetMs({ env: {}, load: 2, cpus: 16 })).toBe(1300);
    expect(buildBudgetMs({ env: {}, load: 450, cpus: 16 })).toBe(5200);              // capped at 4x
    expect(buildBudgetMs({ env: { RUVNET_DECISION_DEADLINE: String(10_000) }, now: 9_000, load: 450, cpus: 16 })).toBe(750);
    expect(buildBudgetMs({ env: { RUVNET_DECISION_DEADLINE: String(10_000) }, now: 11_000 })).toBe(0);
  });

  it('git missing (PATH emptied) is "not applicable": exit 0, silent', () => {
    const { dir, state } = repo();
    // git missing entirely (PATH emptied): the CLI must exit 0 with no bytes on stderr.
    const r = fire(GATE, [], writePayload(dir, 'scripts/restamp-census.mjs', NEAR_DUP), { ...envFor(state), PATH: '' });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('a corrupt cache is rebuilt, not trusted', () => {
    const { dir, state } = repo();
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'index.json'), '{not json');
    expect(evaluate(writePayload(dir, 'scripts/restamp-census.mjs', NEAR_DUP), { env: envFor(state) }).allow).toBe(false);
  });

  it('decision-gate consults duplicate-code on the write route (remove the registration and this fails)', () => {
    expect(policiesFor('write').map((p) => p.id)).toContain('duplicate-code');
  });

  it('end to end through decision-gate: exit 2 with the duplicate reason, then exit 0 on retry', () => {
    const { dir, state } = repo();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-gate-home-'));
    temps.push(home);
    const env = { ...envFor(state), HOME: home, USERPROFILE: home, RUVNET_DECISION_LEDGER: path.join(home, 'ledger.jsonl') };
    const payload = writePayload(dir, 'scripts/restamp-census.mjs', NEAR_DUP);
    const first = fire(DECISION_GATE, ['write'], payload, env);
    expect(first.status).toBe(2);
    expect(first.stderr).toMatch(/looks like code this repo already has/);
    expect(first.stdout).toBe('');
    expect(fire(DECISION_GATE, ['write'], payload, env).status).toBe(0);
  }, 40_000);

  it('end to end: an overloaded duplicate gate is ALLOWED but recorded — one stderr line and a ledger row', () => {
    const { dir, state } = repo();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-gate-home-'));
    temps.push(home);
    const ledger = path.join(home, 'ledger.jsonl');
    const env = { ...envFor(state), HOME: home, USERPROFILE: home, RUVNET_DECISION_LEDGER: ledger, RUVNET_DUPLICATE_GATE_BUDGET_MS: '0' };
    const r = fire(DECISION_GATE, ['write'], writePayload(dir, 'scripts/restamp-census.mjs', NEAR_DUP), env);
    expect(r.status).toBe(0);                                                   // fail open: never a refusal on error
    expect(r.stderr).toMatch(/duplicate gate skipped: index budget exhausted.*duplicate-code did not vote/);
    const rows = fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(rows.some((x) => x.kind === 'policy-skipped' && x.policy === 'duplicate-code' && /index budget exhausted/.test(x.reason))).toBe(true);
  }, 40_000);
});
