import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  apportion, buildInventory, extractJsUnits, extractMarkdownUnits, extractPythonUnits, extractRustUnits,
  gitBlobSha, seededRandom, seededShuffle, MIN_MARKDOWN_WORDS,
} from '../../scripts/oracle/source-units.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/oracle/source-units.mjs');
const prose = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

/**
 * A fixture repo with a KNOWN unit count, built from scratch so the expected U is derivable by hand.
 * Bodies are deliberately substantive: a unit must clear MIN_CODE_TOKENS (25 distinct-ish identifier
 * tokens), which is the "meaningful source unit" floor. A one-line `fn add(a, b)` is correctly NOT a
 * unit, and `trivialOneLiner` below pins that.
 */
function writeFixture(root) {
  const w = (rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
  w('README.md', [
    '# Title', 'intro that is not a unit',
    '## Install', prose(MIN_MARKDOWN_WORDS), // unit 1
    '## Tiny', 'too short',                    // below threshold → not a unit
    '### Usage', '```', '# not a heading', '```', prose(MIN_MARKDOWN_WORDS + 5), // unit 2 (fence ignored)
    '## License', prose(80),                  // boilerplate heading → excluded
  ].join('\n'));
  w('src/api.ts', [
    '/** Documented helper that normalises a retry policy. */',                                    // unit 3 (documented, not exported)
    'function normalisePolicy(policy: Config, fallbackRetries: number, fallbackTimeout: number) {',
    '  const retries = Number.isInteger(policy.retries) ? policy.retries : fallbackRetries;',
    '  const timeoutMs = policy.timeoutMs > 0 ? policy.timeoutMs : fallbackTimeout;',
    '  return { retries, timeoutMs, verbose: Boolean(policy.verbose), tags: policy.tags.slice() };',
    '}',
    'function trivialOneLiner() { return 1; }',                                                     // neither exported nor documented
    'export interface Config {',                                                                    // unit 4
    '  name: string; retries: number; timeoutMs: number; verbose: boolean; tags: string[];',
    '  onRetry?: (attempt: number, lastError: Error) => void; signal?: AbortSignal;',
    '  backoffMultiplier: number; maxConcurrency: number; endpointUrl: string;',
    '}',
    'export const run = async (config: Config) => {',                                               // unit 5
    '  const started = Date.now();',
    '  const normalised = normalisePolicy(config, 3, 30_000);',
    '  const result = await Promise.resolve(config.name);',
    '  return { result, started, elapsedMs: Date.now() - started, ...normalised };',
    '};',
    'export class Service {',                                                                       // unit 6
    '  constructor(private readonly config: Config) {}',
    '  start() { return this.config.name; }',
    '  stop() { return this.config.retries; }',
    '  restart() { return this.config.timeoutMs; }',
    '  describe() { return `${this.config.name} via ${this.config.endpointUrl}`; }',
    '}',
  ].join('\n'));
  w('src/lib.rs', [
    '/// Merges two spans, returning the tightest range covering both.',                            // unit 7
    'pub fn merge_spans(left: Range<usize>, right: Range<usize>) -> Range<usize> {',
    '    let start = std::cmp::min(left.start, right.start);',
    '    let end = std::cmp::max(left.end, right.end);',
    '    let clamped_end = std::cmp::max(end, start);',
    '    Range { start, end: clamped_end }',
    '}',
    'fn private_helper() {}',
    'pub(crate) fn crate_only(value: usize) -> usize { value }',                                    // pub(crate) → excluded
    'pub struct Point {',                                                                           // unit 8
    '    pub x: f64, pub y: f64,',
    '    pub label: String, pub weight: f32,',
    '    pub visible: bool, pub tags: Vec<String>,',
    '    pub metadata: HashMap<String, String>,',
    '}',
  ].join('\n'));
  w('pkg/mod.py', [
    'import os', '',
    'def summarise_batch(alpha, beta, gamma, weights=None):',                                       // unit 9
    '    """Summarise a batch of readings."""',
    '    weights = weights or [1.0, 1.0, 1.0]',
    '    total = alpha * weights[0] + beta * weights[1] + gamma * weights[2]',
    '    scaled = total / sum(weights) if sum(weights) else 0.0',
    '    return {"total": total, "scaled": scaled, "alpha": alpha, "beta": beta, "gamma": gamma}',
    '', 'def _private(x):', '    return x', '',
    'class Widget:',                                                                                // unit 10
    '    def __init__(self, name, size, colour="red"):',
    '        self.name = name',
    '        self.size = size',
    '        self.colour = colour',
    '    def describe(self):',
    '        return f"{self.name} {self.size} {self.colour}"',
  ].join('\n'));
  w('LICENSE', prose(200));
  w('CHANGELOG.md', `## 1.0.0\n${prose(200)}`);
  w('package-lock.json', '{}');
  w('node_modules/dep/index.js', `/** doc */\nexport function dep() { ${prose(40)} }`);
  w('tests/api.test.ts', 'export function shouldNotCount() { return 1; }');
  w('src/generated.ts', `// @generated by tool\nexport function gen() { ${prose(40)} }`);
  w('src/types.d.ts', 'export interface Skipped { a: string; b: string; c: string; d: string; e: string; f: string; g: string; }');
  w('assets/logo.svg', '<svg/>');
}
const EXPECTED_U = 10;

describe('oracle source-units: fixture inventory', () => {
  let root;
  beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-fixture-')); writeFixture(root); });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('enumerates exactly the known units and applies every exclusion rule by name', () => {
    const inv = buildInventory({ dir: root, repo: 'fixture', commit: 'deadbeef' });
    expect(inv.U).toBe(EXPECTED_U);
    expect(inv.selectedCount).toBe(EXPECTED_U); // min(100, U) with U < 100 selects everything
    expect(inv.selected.map((u) => u.kind).sort()).toEqual(
      ['js-class', 'js-const-function', 'js-function', 'md-section', 'md-section', 'py-class', 'py-function', 'rust-fn', 'rust-struct', 'ts-interface'],
    );
    expect(inv.selected.find((u) => u.name === 'License')).toBeUndefined();
    expect(inv.selected.find((u) => u.name === 'crate_only')).toBeUndefined();
    expect(inv.coverage.filesExcluded).toEqual({
      'dependency-or-build-dir': 1, 'test-dir': 1, 'license-changelog-or-meta': 2, lockfile: 1, 'minified-map-or-typings': 1, 'generated-marker': 1,
    });
    expect(inv.coverage.filesUnsupported).toEqual({ '.svg': 1 });
    expect(inv.coverage.filesTotal).toBe(12);
    expect(inv.coverage.uncoveredFiles).toEqual([]);
  });

  it('binds every unit to path, git blob sha, line span and unit-bytes sha256', () => {
    const inv = buildInventory({ dir: root, repo: 'fixture', commit: 'deadbeef' });
    const unit = inv.selected.find((u) => u.name === 'merge_spans');
    expect(unit.path).toBe('src/lib.rs');
    expect(unit.startLine).toBe(1); // the /// doc line is part of the unit
    expect(unit.endLine).toBe(7);
    const gitSha = execFileSync('git', ['hash-object', path.join(root, 'src/lib.rs')], { encoding: 'utf8' }).trim();
    expect(unit.blobSha).toBe(gitSha);
    expect(gitBlobSha(fs.readFileSync(path.join(root, 'src/lib.rs')))).toBe(gitSha);
    expect(unit.bytesSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is byte-identical across two separate process invocations (determinism across a process boundary)', () => {
    const run = () => execFileSync(process.execPath, [CLI, '--dir', root, '--repo', 'fixture', '--commit', 'deadbeef'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = run();
    const second = run();
    expect(first.length).toBeGreaterThan(100);
    expect(second).toBe(first);
    expect(JSON.stringify(first)).not.toMatch(/generatedAt|timestamp|Date/);
  });

  it('changes the selection when the seed (repo@commit) changes, and never when only wall-clock changes', () => {
    const big = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-big-'));
    try {
      const sections = Array.from({ length: 300 }, (_, i) => `## Section ${i}\n${prose(MIN_MARKDOWN_WORDS)}`).join('\n');
      fs.mkdirSync(path.join(big, 'a')); fs.mkdirSync(path.join(big, 'b'));
      fs.writeFileSync(path.join(big, 'a/doc.md'), sections);
      fs.writeFileSync(path.join(big, 'b/doc.md'), sections);
      const one = buildInventory({ dir: big, repo: 'r', commit: 'c1' });
      const same = buildInventory({ dir: big, repo: 'r', commit: 'c1' });
      const other = buildInventory({ dir: big, repo: 'r', commit: 'c2' });
      expect(one.U).toBe(600);
      expect(one.selectedCount).toBe(100);
      expect(one.strata.map((s) => s.selected)).toEqual([50, 50]);
      expect(same.selected.map((u) => u.unitId)).toEqual(one.selected.map((u) => u.unitId));
      expect(other.selected.map((u) => u.unitId)).not.toEqual(one.selected.map((u) => u.unitId));
    } finally { fs.rmSync(big, { recursive: true, force: true }); }
  });
});

describe('oracle source-units: extractors', () => {
  it('markdown: H2/H3 sections above the word floor, fences ignored, boilerplate headings excluded', () => {
    const units = extractMarkdownUnits(`# T\n## A\n${prose(MIN_MARKDOWN_WORDS)}\n## B\nshort\n### C\n\`\`\`\n## not heading\n\`\`\`\n${prose(50)}\n## Table of Contents\n${prose(90)}`);
    expect(units.map((u) => u.name)).toEqual(['A', 'C']);
    expect(units[0]).toMatchObject({ startLine: 2, endLine: 3, kind: 'md-section' });
  });
  it('markdown: badges, tables and bare links do not count as prose words', () => {
    const noise = Array.from({ length: 60 }, () => '[![b](https://x/y.svg)](https://x)').join('\n');
    expect(extractMarkdownUnits(`## Badges\n${noise}\n| a | b |\n|---|---|`)).toEqual([]);
  });
  it('javascript/typescript: exported or doc-commented top-level declarations only; parse errors are reported not thrown', () => {
    const { units } = extractJsUnits('export function a() {}\nfunction b() {}\n/** doc */\nfunction c() {}\nexport default class D {}\nexport const e = () => 1, f = 2;\nexport type T = string;', { typescript: true });
    expect(units.map((u) => [u.kind, u.name])).toEqual([
      ['js-function', 'a'], ['js-function', 'c'], ['js-class', 'D'], ['js-const-function', 'e'], ['ts-type', 'T'],
    ]);
    expect(units[1].startLine).toBe(3); // the doc comment is part of the unit
    expect(extractJsUnits('export function (', {}).error).toMatch(/^parse:/);
  });
  it('rust: bare pub items with docs/attrs attached, brace-matched, pub(crate) excluded', () => {
    const units = extractRustUnits('#[derive(Debug)]\n/// Doc\npub struct S { a: String } // "}" in comment\npub(crate) fn x() {}\npub trait T {\n  fn f(&self) -> String { "{".to_string() }\n}\npub type Alias = u8;');
    expect(units.map((u) => [u.kind, u.name, u.startLine, u.endLine])).toEqual([
      ['rust-struct', 'S', 1, 3], ['rust-trait', 'T', 5, 7], ['rust-type', 'Alias', 8, 8],
    ]);
  });
  it('python: module-level public def/class blocks with decorators, private names skipped', () => {
    const units = extractPythonUnits('@dec\ndef f(a,\n        b):\n    return a\n\ndef _p(): pass\nclass C:\n    x = 1\n\n    def m(self): pass\nprint(1)');
    expect(units.map((u) => [u.kind, u.name, u.startLine, u.endLine])).toEqual([['py-function', 'f', 1, 4], ['py-class', 'C', 7, 10]]);
  });
});

describe('oracle source-units: selection primitives', () => {
  it('apportion is Hamilton largest-remainder, sums to the total, never exceeds a stratum size', () => {
    expect(apportion({ a: 700, b: 200, c: 100 }, 100)).toEqual({ a: 70, b: 20, c: 10 });
    const alloc = apportion({ a: 1, b: 1, c: 1000 }, 100);
    expect(Object.values(alloc).reduce((s, v) => s + v, 0)).toBe(100);
    expect(alloc.a).toBeLessThanOrEqual(1);
    expect(apportion({ a: 3, b: 4 }, 100)).toEqual({ a: 3, b: 4 });
  });
  it('seeded shuffle is a function of the seed alone', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    expect(seededShuffle(items, seededRandom('s'))).toEqual(seededShuffle(items, seededRandom('s')));
    expect(seededShuffle(items, seededRandom('s'))).not.toEqual(seededShuffle(items, seededRandom('t')));
    expect([...seededShuffle(items, seededRandom('s'))].sort((a, b) => a - b)).toEqual(items);
  });
});
