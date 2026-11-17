// full-suite-gate.test.mjs — the whole-suite gate must be able to FAIL (WORK-REGISTER #26 sabotage proof).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountFiles, evaluateFullSuite, globToRegExp, isTimingFailure, listTestFiles, MAX_FLAKY, redFiles, summaryMarkdown } from '../../scripts/full-suite-gate.mjs';
import config from '../../vitest.config.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const include = ['tests/unit/**/*.test.mjs', 'tests/integration/*.test.mjs'];
const files = ['tests/unit/a.test.mjs', 'tests/unit/deep/b.test.mjs', 'tests/integration/c.test.mjs'];
const result = (file, cases, status) => ({ name: path.join(ROOT, file), status: status || (cases.some((c) => c.status === 'failed') ? 'failed' : 'passed'),
  assertionResults: cases.map(([fullName, s]) => ({ fullName, status: s, failureMessages: s === 'failed' ? ['AssertionError: boom'] : [] })) });
const green = () => ({ testResults: [result(files[0], [['a works', 'passed']]), result(files[1], [['b works', 'passed'], ['b later', 'todo']]),
  result(files[2], [['c works', 'passed']])] });
const run = (report, quarantine = { tests: [], excludedFiles: [] }, list = files) => evaluateFullSuite({ report, quarantine, files: list, include, root: ROOT });
const entry = (file, test) => ({ file, test, class: 'machine-state', reason: 'measured', owner: 'someone' });

describe('full-suite gate', () => {
  it('PASSES a fully green run that executed every included file', () => {
    const verdict = run(green());
    expect(verdict).toMatchObject({ verdict: 'PASS', problems: [], counts: { files: 3, passed: 3, failed: 0, todo: 1 } });
  });

  it('SABOTAGE: one unquarantined failing test turns the gate red and names it', () => {
    const report = green();
    report.testResults[1] = result(files[1], [['b works', 'failed']]);
    const verdict = run(report);
    expect(verdict.verdict).toBe('FAIL');
    expect(verdict.problems).toEqual([`RED: ${files[1]} :: b works: AssertionError: boom`]);
  });

  it('tolerates a red test only while it is quarantined, and fails once the quarantined test passes (stale)', () => {
    const report = green();
    report.testResults[1] = result(files[1], [['b works', 'failed']]);
    const quarantine = { tests: [entry(files[1], 'b works')], excludedFiles: [] };
    expect(run(report, quarantine)).toMatchObject({ verdict: 'PASS', counts: { quarantinedRed: 1 } });
    expect(run(green(), quarantine).problems).toEqual([`stale quarantine (now passes, remove it): ${files[1]} :: b works`]);
  });

  const failedWith = (file, name, message) => ({ name: path.join(ROOT, file), status: 'failed',
    assertionResults: [{ fullName: name, status: 'failed', failureMessages: [message] }] });
  const judge = (report, retry, extra = {}) => evaluateFullSuite({ report, quarantine: { tests: [] }, files, include, root: ROOT, retry, ...extra });
  const timeout = 'Error: Test timed out in 20000ms.';

  it('FLAKY only for a timing/budget failure that passes its one isolated retry, recorded with its message', () => {
    const report = green();
    report.testResults[1] = failedWith(files[1], 'b works', timeout);
    expect(redFiles(report, { tests: [] }, ROOT)).toEqual([files[1]]);
    const passedAlone = { testResults: [result(files[1], [['b works', 'passed']])] };
    expect(judge(report, passedAlone)).toMatchObject({ verdict: 'PASS', counts: { flaky: 1 },
      flaky: [{ test: `${files[1]} :: b works`, retry: 'passed', failure: timeout }] });
    // Red in both runs, or absent from the retry, stays RED.
    expect(judge(report, { testResults: [failedWith(files[1], 'b works', timeout)] }).verdict).toBe('FAIL');
    expect(judge(report, { testResults: [] }).verdict).toBe('FAIL');
  });

  it('SABOTAGE: a value-assertion red that passes alone stays RED (possible shared-state bug), even in a budget-named test', () => {
    const report = green();
    report.testResults[1] = failedWith(files[1], 'stays inside its declared budget', 'AssertionError: expected +0 to be 4');
    const verdict = judge(report, { testResults: [result(files[1], [['stays inside its declared budget', 'passed']])] });
    expect(verdict.verdict).toBe('FAIL');
    expect(verdict.flaky).toEqual([]);
  });

  it('classifies only vitest timeouts and numeric duration bounds as timing (real messages from 2026-10-01 runs)', () => {
    for (const m of [timeout, 'Error: Hook timed out in 20000ms.',
      'AssertionError: restore took 3745ms over 30 snapshots; samples 3340/3745/555/636/537: expected 3745 to be less than 1000',
      'AssertionError: even the contention tail must stay within 2x the ceiling: expected 337.294918 to be less than 300',
    ]) expect(isTimingFailure(m), m).toBe(true);
    for (const m of [
      // Value assertions that merely MENTION a budget, ceiling, latency or a duration: deterministic, RED.
      "AssertionError: expected 'capture budget exceeded' to be undefined",
      "AssertionError: stderr on an allow would surface as a spurious error to the user: expected '[decision-gate] 2000ms budget exhausted' to be ''",
      "AssertionError: expected 'render probe exceeded 250ms process deadline' to match /exceeded 250ms.*fixture:wedged/",
      "AssertionError: expected 'latency ceiling breached' to equal 'ok'",
      // A numeric bound with no duration cue is not provably timing.
      'AssertionError: expected 6340 to be less than 5000',
      // 4.4.1: a duration WORD next to an integer COUNT is a value assertion, not a timing.
      'AssertionError: retries before timeout: expected 5 to be less than 3',
      'AssertionError: pending timeout handlers: expected 4 to be greater than 6',
      'AssertionError: over budget by tokens: expected 1201 to be less than 1000',
      'AssertionError: expected +0 to be 4', "AssertionError: expected [] to deeply equal [ 'hang' ]",
      'Error: ENOENT: no such file or directory', "expected 'request timed out' to be 'ok'",
    ]) expect(isTimingFailure(m), m).toBe(false);
  });

  it('a file-level failure (beforeAll/collect error, zero failed cases) is never retried away and is listed in the summary', () => {
    const report = green();
    report.testResults[2] = { ...result(files[2], [['c works', 'skipped']], 'failed'),
      message: 'global Ruflo is required; this acceptance must not vacuously skip: expected null to be truthy' };
    expect(redFiles(report, { tests: [] }, ROOT)).toEqual([]);
    const verdict = judge(report, { testResults: [result(files[2], [['c works', 'passed']])] });
    expect(verdict.verdict).toBe('FAIL');
    expect(summaryMarkdown(verdict)).toContain(`file-level failure: ${files[2]}: global Ruflo is required`);
  });

  it('more than the flaky ceiling in one run fails the gate, and the summary lists every flaky test', () => {
    const many = ['t1', 't2', 't3', 't4'];
    const report = { testResults: [result(files[0], [['a works', 'passed']]), result(files[2], [['c works', 'passed']]),
      { name: path.join(ROOT, files[1]), status: 'failed', assertionResults: many.map((n) => ({ fullName: n, status: 'failed', failureMessages: [timeout] })) }] };
    const retry = { testResults: [result(files[1], many.map((n) => [n, 'passed']))] };
    expect(MAX_FLAKY).toBe(3);
    const over = judge(report, retry);
    expect(over.verdict).toBe('FAIL');
    expect(over.problems).toEqual(['too many flaky tests: 4 > 3 timing failures that passed alone']);
    expect(judge(report, retry, { maxFlaky: 4 }).verdict).toBe('PASS');
    const md = summaryMarkdown(over);
    for (const n of many) expect(md).toContain(`${files[1]} :: ${n}`);
    expect(md).toContain('## Full suite: FAIL');
  });

  it('rejects a quarantine entry without class, reason and owner', () => {
    const report = green();
    report.testResults[1] = result(files[1], [['b works', 'failed']]);
    expect(run(report, { tests: [{ file: files[1], test: 'b works' }] }).verdict).toBe('FAIL');
  });

  it('fails a file-level error even when it reports zero cases, and an included file that never executed', () => {
    const report = green();
    report.testResults[2] = { ...result(files[2], [], 'failed'), message: 'SyntaxError: Unexpected token' };
    expect(run(report).problems).toEqual([`file-level failure: ${files[2]}: SyntaxError: Unexpected token`]);
    const missing = green();
    missing.testResults.pop();
    expect(run(missing).problems).toEqual([`included file did not execute: ${files[2]}`]);
  });

  it('fails a test file outside the vitest include unless excludedFiles accounts for it', () => {
    const list = [...files, 'tests/diagnostics/d.test.mjs'];
    expect(run(green(), undefined, list).problems).toEqual(['never run: tests/diagnostics/d.test.mjs is outside vitest include and not in excludedFiles']);
    expect(run(green(), { tests: [], excludedFiles: [{ file: 'tests/diagnostics/d.test.mjs', reason: 'x' }] }, list).verdict).toBe('PASS');
  });

  it('matches vitest include globs the way the root config uses them', () => {
    expect(globToRegExp('tests/unit/**/*.test.mjs').test('tests/unit/a.test.mjs')).toBe(true);
    expect(globToRegExp('tests/unit/**/*.test.mjs').test('tests/unit/x/y/a.test.mjs')).toBe(true);
    expect(globToRegExp('tests/integration/*.test.mjs').test('tests/integration/fixtures/a.test.mjs')).toBe(false);
  });

  it('a file outside the vitest include is accounted for when a registered suite runs it, and only then', () => {
    const list = [...files, 'tests/acceptance/v5/s01.test.mjs', 'tests/acceptance/v5/wp9-new.test.mjs'];
    const suite = { name: 'v5', script: 'test:v5', include: ['tests/acceptance/v5/*.test.mjs'] };
    const scripts = { 'test:v5': 'node --test tests/acceptance/v5/*.test.mjs' };
    const judge = (quarantine, s = scripts) => evaluateFullSuite({ report: green(), quarantine: { tests: [], excludedFiles: [], ...quarantine }, files: list, include, root: ROOT, scripts: s });
    expect(judge({ suites: [suite] })).toMatchObject({ verdict: 'PASS', problems: [] });
    expect(judge({}).problems).toEqual(list.slice(3).map((file) => `never run: ${file} is outside vitest include and not in excludedFiles`));
    expect(judge({ suites: [suite] }, {}).problems).toEqual(['suite v5: npm script test:v5 does not exist']);
    expect(judge({ suites: [suite] }, { 'test:v5': 'node --test tests/acceptance/v5/s01.test.mjs' }).problems).toEqual(['suite v5: npm script test:v5 does not run tests/acceptance/v5/*.test.mjs']);
    expect(judge({ suites: [{ ...suite, include: ['tests/acceptance/v6/*.test.mjs'] }], }, { 'test:v5': 'node --test tests/acceptance/v6/*.test.mjs' }).problems).toEqual([
      'suite v5 matches no test file outside vitest include: tests/acceptance/v6/*.test.mjs',
      ...list.slice(3).map((file) => `never run: ${file} is outside vitest include and not in excludedFiles`)]);
    expect(judge({ suites: [suite], excludedFiles: [{ file: list[3], reason: 'x' }] }).problems).toEqual([`excludedFiles entry is run by suite v5: ${list[3]}`]);
    expect(accountFiles({ files: list, include, suites: [suite], scripts }).bySuite.get(list[4])).toBe('v5');
  });

  it('the committed quarantine accounts for every real test file the root config does not run', () => {
    const quarantine = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/known-red.json'), 'utf8'));
    const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const { unrun, bySuite, problems } = accountFiles({ files: listTestFiles(ROOT), include: config.test.include, suites: quarantine.suites || [], scripts });
    expect(problems).toEqual([]);
    expect(unrun.sort()).toEqual(quarantine.excludedFiles.map((row) => row.file).sort());
    // The version 5 acceptance suite is run by `npm run test:v5`, never excluded: its files are accounted for by that suite.
    expect([...bySuite.values()].every((name) => name === 'v5-acceptance')).toBe(true);
    expect([...bySuite.keys()].length).toBeGreaterThan(0);
    for (const row of quarantine.tests) expect(fs.existsSync(path.join(ROOT, row.file)), row.file).toBe(true);
  });
});
