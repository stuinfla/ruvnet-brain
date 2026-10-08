import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { assessTestReport } from './release-qualification.mjs';
import { canonicalJson } from './coverage-integrity.mjs';
import { StringDecoder } from 'node:string_decoder';

export function verdictOf(results) {
  if (results.some(({ status }) => ['FAIL', 'TIMEOUT', 'BLOCKED'].includes(status))) return 'FAIL';
  return results.length && results.every((result) => result.status === 'PASS'
    && (result.testEvidenceRequired !== true || result.tests?.total > 0
      && result.tests.passed === result.tests.total && result.tests.failed === 0 && result.tests.skipped === 0)) ? 'PASS' : 'UNKNOWN';
}

// A source digest includes dirty tracked files and untracked source, never ignored build outputs.
export function sourceIdentity(root) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let sha = null;
  try { sha = git(['rev-parse', 'HEAD']).trim(); } catch { /* unborn repository */ }
  const files = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].sort();
  const hash = createHash('sha256');
  for (const relative of files) {
    const file = path.join(root, relative);
    let bytes = Buffer.from('deleted');
    try {
      const stat = fs.lstatSync(file);
      bytes = stat.isSymbolicLink() ? Buffer.from(`symlink:${fs.readlinkSync(file)}`)
        : stat.isFile() ? Buffer.concat([Buffer.from(`${stat.mode & 0o777}:`), fs.readFileSync(file)]) : Buffer.from('directory');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    hash.update(JSON.stringify([relative, createHash('sha256').update(bytes).digest('hex')]));
  }
  return { sha, dirty: Boolean(git(['status', '--porcelain']).trim()), digest: hash.digest('hex'), files: files.length, recipe: 'git-source-bytes-v1' };
}

export async function runLanes(lanes, execute, concurrency = 2) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('invalid QA concurrency');
  const names = new Set(lanes.map(({ name }) => name));
  if (names.size !== lanes.length || lanes.some((lane) => (lane.dependsOn || []).some((name) => !names.has(name)))) throw new Error('invalid QA dependency');
  const pending = [...lanes], completed = new Map();
  while (pending.length) {
    const resources = new Set(), batch = [];
    for (const lane of pending) {
      if (!(lane.dependsOn || []).every((name) => completed.has(name))) continue;
      if ((lane.dependsOn || []).some((name) => completed.get(name).status !== 'PASS')) {
        completed.set(lane.name, { name: lane.name, status: 'BLOCKED', reason: 'required prerequisite did not pass' });
        continue;
      }
      if (batch.length >= concurrency || (lane.resource && resources.has(lane.resource))) continue;
      batch.push(lane); resources.add(lane.resource);
    }
    if (!batch.length && !pending.some(({ name }) => completed.has(name))) throw new Error('QA dependency cycle');
    await Promise.all(batch.map(async (lane) => {
      let result;
      try { result = await execute(lane); }
      catch (error) { result = { name: lane.name, status: 'FAIL', reason: error.message }; }
      completed.set(lane.name, result);
    }));
    for (let index = pending.length - 1; index >= 0; index--) if (completed.has(pending[index].name)) pending.splice(index, 1);
  }
  return lanes.map(({ name }) => completed.get(name));
}

// Shared Vitest lanes use the release validator, not the subprocess success line.
export function vitestLaneFiles(lane, root) {
  if (!Array.isArray(lane.testTargets) || !lane.testTargets.length) throw new Error('Vitest lane test inventory missing');
  const files = [];
  const visit = (relative) => {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('unsafe Vitest test target');
    const file = path.join(root, relative), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('Vitest test inventory contains a symlink');
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
    else if (stat.isFile() && relative.endsWith('.test.mjs')) files.push(relative.split(path.sep).join('/'));
  };
  lane.testTargets.forEach(visit);
  if (!files.length || new Set(files).size !== files.length) throw new Error('Vitest lane test inventory empty or duplicated');
  return files.sort();
}

export function qualifyVitestLane(result, { root, evidenceFile, files }) {
  const required = { ...result, testEvidenceRequired: true };
  if (result.status !== 'PASS') return required;
  if (result.exitCode !== 0) return { ...required, status: 'UNKNOWN', reason: 'Vitest PASS requires a successful actual subprocess exit' };
  try {
    const bytes = fs.readFileSync(evidenceFile);
    const platform = { linux: 'linux', darwin: 'macos', win32: 'windows' }[process.platform];
    const tests = assessTestReport(JSON.parse(bytes), files, root, platform);
    return { ...required, tests, evidenceSha256: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) { return { ...required, status: 'UNKNOWN', reason: `Vitest execution evidence invalid: ${error.message}` }; }
}

// The CLI emits one machine receipt before its human ledger. Bound it independently of the tail.
export function claimsReceiptStream() {
  let buffer = '', receipt, failure;
  const decoder = new StringDecoder('utf8');
  return {
    write(chunk) {
      if (failure) return;
      buffer += decoder.write(chunk);
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > 1024 * 1024) { failure = 'claims stdout receipt exceeds bound'; return; }
        let value; try { value = JSON.parse(line); } catch { continue; }
        if (value?.schema !== 'ruvnet-brain.claims') continue;
        if (receipt) { failure = 'claims stdout receipt is duplicated'; return; }
        receipt = value;
      }
      if (Buffer.byteLength(buffer) > 1024 * 1024) failure = 'claims stdout receipt exceeds bound';
    },
    result() { return { receipt, failure }; },
  };
}

export async function qualifyClaimsLane(result, { evidenceFile, scope, reported }) {
  if (result.status !== 'PASS') return result;
  try {
    if (result.exitCode !== 0 || result.evidenceFile !== evidenceFile) throw new Error('claims process exit or report path differs');
    const stat = fs.lstatSync(evidenceFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('claims report is not a bounded regular file');
    const bytes = fs.readFileSync(evidenceFile), receipt = JSON.parse(bytes);
    if (reported?.failure || !reported?.receipt || canonicalJson(receipt) !== canonicalJson(reported.receipt)) throw new Error('claims artifact differs from actual emitted receipt');
    const { claimsScope, claimsVerdict } = await import('./claims-verify.mjs');
    const selected = claimsScope(scope);
    if (receipt.schema !== 'ruvnet-brain.claims' || receipt.scope !== selected.scope || receipt.complete !== selected.complete
      || canonicalJson(receipt.omitted) !== canonicalJson(selected.omitted) || !Array.isArray(receipt.rows)
      || receipt.rows.length !== selected.entries.length
      || receipt.rows.some((row, index) => ['id', 'claim', 'source'].some(key => row[key] !== selected.entries[index][key]))) throw new Error('claims scope or exact row inventory differs');
    const scoped = claimsVerdict(receipt.rows);
    const overall = scoped === 'FAIL' || selected.complete ? scoped : 'UNKNOWN';
    if (scoped !== 'PASS' || receipt.scopeVerdict !== scoped || receipt.verdict !== overall) throw new Error('required scoped claims did not all pass');
    return { ...result, evidenceSha256: createHash('sha256').update(bytes).digest('hex'),
      claims: { scope: selected.scope, scopeVerdict: scoped, verdict: overall, complete: selected.complete, rows: receipt.rows.length } };
  } catch (error) { return { ...result, status: 'UNKNOWN', reason: `Claims execution evidence invalid: ${error.message}` }; }
}
