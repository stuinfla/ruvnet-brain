import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { claimsScope } from '../../scripts/claims-verify.mjs';
import { claimsReceiptStream, qualifyClaimsLane } from '../../scripts/qa-contract.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const roots = [], sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const temporary = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-claims-proof-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
// Synthetic contract reports are adversarial input; they do not verify advertised product claims.
function report() {
  const selected = claimsScope('source');
  return { schema: 'ruvnet-brain.claims', scope: 'source', complete: false, verdict: 'UNKNOWN', scopeVerdict: 'PASS', omitted: selected.omitted,
    rows: selected.entries.map(({ id, claim, source }) => ({ id, claim, source, status: 'PASS', evidence: 'Synthetic report fixture only.' })) };
}
async function qualify(mutate = () => {}, resultChange = {}) {
  const root = temporary(), evidenceFile = path.join(root, 'report.json'), before = report();
  const stream = claimsReceiptStream(); stream.write(Buffer.from(JSON.stringify(before) + '\n'));
  const after = structuredClone(before); mutate(after); fs.writeFileSync(evidenceFile, JSON.stringify(after));
  return qualifyClaimsLane({ status: 'PASS', exitCode: 0, evidenceFile, ...resultChange }, { evidenceFile, scope: 'source', reported: stream.result() });
}
describe('required scoped claims receipt qualification', () => {
  it('preserves source-only scope PASS and overall UNKNOWN with exact artifact hash', async () => {
    const result = await qualify(); expect(result.status).toBe('PASS'); expect(result.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.claims).toMatchObject({ scope: 'source', scopeVerdict: 'PASS', verdict: 'UNKNOWN', complete: false });
  });
  it('rejects artifact tamper even when scope and verdict still look valid', async () => {
    expect((await qualify(value => { value.rows[0].evidence = 'substituted support'; })).status).toBe('UNKNOWN');
  });
  it('rejects nonzero exit, report path substitution and missing actual stdout receipt', async () => {
    expect((await qualify(() => {}, { exitCode: 1 })).status).toBe('UNKNOWN');
    expect((await qualify(() => {}, { evidenceFile: '/substitute' })).status).toBe('UNKNOWN');
    const root = temporary(), evidenceFile = path.join(root, 'report.json'); fs.writeFileSync(evidenceFile, JSON.stringify(report()));
    expect((await qualifyClaimsLane({ status: 'PASS', exitCode: 0, evidenceFile }, { evidenceFile, scope: 'source', reported: {} })).status).toBe('UNKNOWN');
  });
  it('rejects missing report and malformed/incomplete scope/row data despite exit0', async () => {
    const root = temporary(), evidenceFile = path.join(root, 'absent.json');
    expect((await qualifyClaimsLane({ status: 'PASS', exitCode: 0, evidenceFile }, { evidenceFile, scope: 'source' })).status).toBe('UNKNOWN');
    for (const mutate of [value => { value.scope = 'runtime'; }, value => { value.rows = []; }, value => { value.rows[0].id = 'foreign'; }, value => { value.omitted = []; }]) {
      const value = report(); mutate(value); fs.writeFileSync(evidenceFile, JSON.stringify(value));
      const stream = claimsReceiptStream(); stream.write(Buffer.from(JSON.stringify(value) + '\n'));
      expect((await qualifyClaimsLane({ status: 'PASS', exitCode: 0, evidenceFile }, { evidenceFile, scope: 'source', reported: stream.result() })).status).toBe('UNKNOWN');
    }
  });
  it('captures one UTF8 machine receipt independently of truncated human output', () => {
    const stream = claimsReceiptStream(), value = report(), bytes = Buffer.from(JSON.stringify(value) + '\n');
    for (const byte of bytes) stream.write(Buffer.from([byte]));
    stream.write(Buffer.from('human ledger\n'.repeat(1000)));
    expect(stream.result()).toEqual({ receipt: value, failure: undefined });
    stream.write(bytes); expect(stream.result().failure).toMatch(/duplicated/);
  });
});
function actualRunner(mode) {
  const root = temporary();
  for (const file of ['scripts/qa-runner.mjs', 'scripts/qa-lanes.mjs', 'scripts/qa-contract.mjs', 'scripts/release-qualification.mjs',
    'scripts/release-qualification-contract.mjs', 'scripts/coverage-integrity.mjs', 'plugin/scripts/coverage-integrity.mjs']) {
    const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(ROOT, file), target);
  }
  fs.symlinkSync(fs.realpathSync(path.join(ROOT, 'node_modules')), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.join(root, 'tests/unit'), { recursive: true }); fs.writeFileSync(path.join(root, 'tests/unit/one.test.mjs'), "import {it,expect} from 'vitest';it('actual prerequisite',()=>expect(2+3).toBe(5));\n");
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\ncoverage\n');
  const effects = mode === 'loss' ? 'fs.unlinkSync(file);' : mode === 'tamper' ? "value.rows[0].evidence='substituted';fs.writeFileSync(file,JSON.stringify(value));" : '';
  // Real canonical verifier exports are reused unchanged. ONLY CLI output is a disclosed synthetic fixture.
  fs.writeFileSync(path.join(root, 'scripts/claims-verify.mjs'), `export {claimsScope,claimsVerdict} from ${JSON.stringify(new URL('../../scripts/claims-verify.mjs', import.meta.url).href)};
import fs from 'node:fs';import {fileURLToPath} from 'node:url';if(process.argv[1]===fileURLToPath(import.meta.url)){
 const file=process.argv[process.argv.indexOf('--report')+1],value=${JSON.stringify(report())};console.log(JSON.stringify(value));fs.writeFileSync(file,JSON.stringify(value));${effects}console.log('human ledger tail'.repeat(1000));}`);
  spawnSync('git', ['init', '-q', root]);
  const child = spawnSync(process.execPath, ['scripts/qa-runner.mjs', '--lane', 'claims-source'], { cwd: root, encoding: 'utf8', timeout: 30000, env: { ...process.env, QA_TIMEOUT_MS: '20000' } });
  const summary = child.stdout.split('\n').filter(line => line.startsWith('{')).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).findLast(value => value.receiptDir);
  expect(summary, child.stderr + child.stdout).toBeTruthy(); roots.push(summary.receiptDir);
  const aggregate = JSON.parse(fs.readFileSync(path.join(summary.receiptDir, 'aggregate.json'))); return { child, aggregate, claims: aggregate.results.find(lane => lane.name === 'claims-source') };
}
describe('actual required report-backed QA consumer', () => {
  it('valid scoped report joins actual exit, exact filehash and current source while preserving overall UNKNOWN', () => {
    const { child, aggregate, claims } = actualRunner('valid'); expect(child.status).toBe(0); expect(aggregate.status).toBe('PASS');
    expect(aggregate.sourceStable).toBe(true); expect(claims.exitCode).toBe(0); expect(claims.claims.verdict).toBe('UNKNOWN');
    expect(claims.evidenceSha256).toBe(sha(fs.readFileSync(claims.evidenceFile)));
  }, 35000);
  for (const mode of ['loss', 'tamper']) it(`actual ${mode} plus producer exit0 cannot PASS`, () => {
    const { child, aggregate, claims } = actualRunner(mode); expect(claims.exitCode).toBe(0); expect(claims.status).toBe('UNKNOWN');
    expect(aggregate.sourceStable).toBe(true); expect(aggregate.status).toBe('UNKNOWN'); expect(child.status).toBe(4);
  }, 35000);
});
