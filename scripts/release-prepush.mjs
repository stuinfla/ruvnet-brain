#!/usr/bin/env node
// scripts/release-prepush.mjs — run, before the FIRST push of a release/X.Y.Z branch, every check
// release-candidate-preflight would otherwise fail on in its first minutes (CONTRIBUTING.md,
// "Releasing code"). An explicit command on purpose: tests/unit/development-push-boundary.test.mjs
// keeps ordinary pushes free of release gates, so this is never wired into the git pre-push hook.
//
//   npm run release:prepush [-- --receipt <file>] [--generation <corpus tag>]
//   npm run release:prepush -- --pre-dispatch --sha <SHA> [--receipt <file>]
//
// Runs ALL checks, collects every failure, prints each check's wall time and exits 1 on any failure.
// --pre-dispatch runs only the sealed-generation check: the corpus generation the preflight sealed for
// SHA must still be the newest one before protected-release.yml is dispatched.
// Programmatic: runPrepush({ root, sha, preDispatch, generation, repo, deps }) -> { ok, checks }.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rangeCensus } from './generation-census.mjs';
import {
  STATIC_GATES, anchoredTests, branchIdentity, censusCheck, clockZones, qualificationInventory, sealedGeneration, staticGate,
  strayArtifacts, uxGates,
} from './release-prepush-checks.mjs';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXEC_TIMEOUT_MS = 10 * 60 * 1000;

/** Promise-returning spawn: never blocks the event loop, so checks really run side by side. */
export function exec(command, args, { cwd, timeoutMs = EXEC_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const done = (status, error) => {
      clearTimeout(timer);
      resolve({ status, stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8') + (error ? `\n${error.message}` : '') });
    };
    child.on('error', (error) => done(127, error));
    child.on('close', (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}

function repoFromRemote(url) {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(url || '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The real effects. Tests replace any of them. */
export function defaultDeps({ root = ROOT, repo } = {}) {
  let token;
  const ghToken = async () => {
    if (token === undefined) {
      const result = await exec('gh', ['auth', 'token'], { cwd: root, timeoutMs: 15_000 });
      token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || (result.status === 0 ? result.stdout.trim() : null) || null;
    }
    return token;
  };
  return {
    exec,
    now: () => Date.now(),
    readFile: async (file) => fs.promises.readFile(file, 'utf8'),
    importModule: (file) => import(pathToFileURL(file).href),
    // The exact CI invocation (ci.yml release-qe), as a child process; its stdout is the descriptor.
    resolveSeed: async () => {
      const result = await exec(process.execPath, [path.join(root, 'scripts/corpus-next-seed.mjs'), '--repo', repo, '--require-coverage'], { cwd: root });
      if (result.status !== 0) throw new Error(`corpus-next-seed exited ${result.status}: ${result.stderr.trim().split('\n').slice(-3).join(' | ')}`);
      return JSON.parse(result.stdout);
    },
    census: async ({ tag, bytes }) => rangeCensus({ repo, tag, bytes, token: await ghToken(),
      privateStoresFile: path.join(root, 'kb/PRIVATE-STORES.json'), cacheDir: os.tmpdir() }),
  };
}

export async function runPrepush({ root = ROOT, sha = null, preDispatch = false, generation = null, repo = null, deps = {} } = {}) {
  const resolvedRoot = path.resolve(root);
  const probe = { ...defaultDeps({ root: resolvedRoot, repo: 'unresolved/unresolved' }), ...deps };
  let resolvedRepo = repo || process.env.GITHUB_REPOSITORY || null;
  if (!resolvedRepo) {
    const remote = await probe.exec('git', ['remote', 'get-url', 'origin'], { cwd: resolvedRoot });
    resolvedRepo = remote.status === 0 ? repoFromRemote(remote.stdout) : null;
  }
  const merged = { ...defaultDeps({ root: resolvedRoot, repo: resolvedRepo }), ...deps };
  let packageScripts = {};
  try { packageScripts = JSON.parse(await merged.readFile(path.join(resolvedRoot, 'package.json'))).scripts || {}; } catch { /* the gates name it */ }
  const ctx = { root: resolvedRoot, repo: resolvedRepo, sha, generation, deps: merged, packageScripts };

  const plan = preDispatch
    ? [['sealed-generation', sealedGeneration]]
    : [
      ['branch-identity', branchIdentity],
      ...STATIC_GATES.map((gate) => [gate.name, staticGate(gate)]),
      ['qualification-inventory', qualificationInventory],
      ['stray-artifacts', strayArtifacts],
      ['census', censusCheck],
      ['anchored-tests', anchoredTests],
      ['clock-zones', clockZones],
      ['ux-gates', uxGates],
    ];
  const checks = await Promise.all(plan.map(async ([name, check]) => {
    const started = Date.now();
    let outcome;
    try {
      outcome = resolvedRepo || !['census', 'sealed-generation'].includes(name)
        ? await check(ctx)
        : { ok: false, detail: 'cannot tell which GitHub repository this is (no GITHUB_REPOSITORY, no github.com origin)' };
    } catch (error) {
      outcome = { ok: false, detail: `check threw: ${error.message}` };
    }
    return { name, ok: outcome.ok === true, ms: Date.now() - started, detail: outcome.detail,
      ...(outcome.warnings?.length ? { warnings: outcome.warnings } : {}), ...(outcome.files ? { files: outcome.files } : {}) };
  }));
  return { ok: checks.every((check) => check.ok), checks };
}

function parseArgs(argv) {
  const opts = { preDispatch: false, sha: null, generation: null, receipt: null, repo: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value`);
      i += 1;
      return next;
    };
    if (flag === '--pre-dispatch') opts.preDispatch = true;
    else if (flag === '--sha') opts.sha = value();
    else if (flag === '--generation') opts.generation = value();
    else if (flag === '--receipt') opts.receipt = value();
    else if (flag === '--repo') opts.repo = value();
    else throw new Error(`unknown argument ${flag}`);
  }
  if (opts.sha && !opts.preDispatch) throw new Error('--sha is only meaningful with --pre-dispatch');
  return opts;
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, deps = {}, root = ROOT } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (error) {
    stderr.write(`[release:prepush] ${error.message}\nUsage: npm run release:prepush [-- --receipt FILE] [--generation TAG] | -- --pre-dispatch --sha SHA\n`);
    return 2;
  }
  const started = Date.now();
  const result = await runPrepush({ root, sha: opts.sha, preDispatch: opts.preDispatch, generation: opts.generation, repo: opts.repo, deps });
  const totalMs = Date.now() - started;
  for (const check of result.checks) {
    stdout.write(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name.padEnd(26)} ${(check.ms / 1000).toFixed(1).padStart(6)} s  ${check.detail}\n`);
    for (const warning of check.warnings || []) stdout.write(`WARN  ${check.name.padEnd(26)}          ${warning}\n`);
  }
  const failed = result.checks.filter((check) => !check.ok);
  stdout.write(`\n[release:prepush] ${result.ok ? 'PASS' : `FAIL (${failed.length}: ${failed.map((c) => c.name).join(', ')})`} in ${(totalMs / 1000).toFixed(1)} s\n`);
  if (opts.receipt) {
    const head = await (deps.exec || exec)('git', ['rev-parse', 'HEAD'], { cwd: root });
    const receipt = { schemaVersion: 1, kind: 'ruvnet-brain-release-prepush', mode: opts.preDispatch ? 'pre-dispatch' : 'pre-push',
      head: head.stdout.trim() || null, sha: opts.sha, generation: opts.generation, ok: result.ok,
      finishedAt: new Date().toISOString(), totalMs, checks: result.checks };
    fs.writeFileSync(path.resolve(opts.receipt), `${JSON.stringify(receipt, null, 2)}\n`);
  }
  return result.ok ? 0 : 1;
}

if (isDirectInvocation(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[release:prepush] ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
