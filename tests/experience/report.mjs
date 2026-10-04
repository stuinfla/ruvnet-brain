#!/usr/bin/env node
// tests/experience/report.mjs — ADR-053 §1 / ADR-058 D2: the experience-level coverage gate.
//
// tests/experience/scenarios.json is a hand-written list of ~20 coherent scenarios — never a
// Cartesian host x os x artifact x stage matrix. ADR-053 §1 killed the matrix approach on purpose:
// its false-orthogonal axes manufacture ~100 incoherent cells whose bulk-labeling as `manual` makes
// the report permanently green (the matrix Goodharts itself in one move). A hand-written list is
// human work by design; this script is what keeps that list honest instead of aspirational.
//
// FAILS on:
//   (a) any coherent scenario left UNCLASSIFIED (missing/invalid `classification`)
//   (b) `manual` exceeding 20% of the FULL list (each `manual` entry also requires a named `owner`,
//       and sits OUTSIDE the coverage denominator — it is not counted as covered)
//   (c) THE LOAD-BEARING CHECK: every `ci` / `scheduled-live-probe` scenario carries structured
//       `proofs`. Each proof joins a real workflow job to an exact repo test/driver path. The path
//       must exist AND the named job must invoke it, either literally or through an npm script's
//       explicit file/directory selector, or through the producer's explicit qualification suite.
//       A job-name-only join is ceremony: it stays green when the
//       test is renamed or simply stops running.
//
// Usage:  node tests/experience/report.mjs [path/to/scenarios.json]
// Exits 0 with a summary on success, 1 with a FAILURES list otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qualificationInvocationFiles } from './qualification-invocation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');
const SCENARIOS_PATH = path.resolve(process.argv[2] || path.join(HERE, 'scenarios.json'));

const CLASSIFICATIONS = new Set(['ci', 'scheduled-live-probe', 'manual']);
const MANUAL_CAP = 0.20;
const failures = [];
const fail = (msg) => failures.push(msg);

// ── load the scenario list ───────────────────────────────────────────────────────────────────────
let data;
try {
  data = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
} catch (e) {
  console.error(`FATAL: could not read/parse ${SCENARIOS_PATH}: ${e.message}`);
  process.exit(2);
}
const scenarios = Array.isArray(data) ? data : data.scenarios;
if (!Array.isArray(scenarios) || scenarios.length === 0) {
  console.error(`FATAL: no non-empty "scenarios" array found in ${SCENARIOS_PATH}`);
  process.exit(2);
}

// ── read the REAL job names out of every committed workflow file ───────────────────────────────
// Dependency-free (no yaml parser in package.json): reads the top-level `jobs:` block's 2-space-
// indented keys. Verified directly against every workflow file in this repo (ci.yml,
// integration-linux.yml, gists-nightly.yml, issue-watch.yml, ntfy-alerts.yml) before relying on it —
// `jobs:` is always the last top-level section and every job id is a bare 2-space-indented
// `name:` line (nested step/env keys are indented 4+ spaces, or carry a value after the colon).
function loadWorkflowJobs() {
  const map = new Map(); // 'ci.yml' -> Map('check' -> complete job YAML text)
  if (!fs.existsSync(WORKFLOWS_DIR)) return map;
  for (const f of fs.readdirSync(WORKFLOWS_DIR)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const jobs = new Map();
    const lines = fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8').split('\n');
    let inJobs = false;
    let current = null;
    let body = [];
    const flush = () => {
      if (current) jobs.set(current, body.join('\n'));
      current = null;
      body = [];
    };
    for (const line of lines) {
      if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
      if (!inJobs) continue;
      if (/^\S/.test(line)) { flush(); inJobs = false; continue; } // dedented back out of jobs:
      const m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
      if (m) {
        flush();
        current = m[1];
        body = [line];
      } else if (current) {
        body.push(line);
      }
    }
    flush();
    map.set(f, jobs);
  }
  return map;
}
const workflowJobs = loadWorkflowJobs();

const packageScripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts || {};

// Expand only the package-script commands the workflow actually names. This is intentionally not
// a shell interpreter: it gives the semantic join visibility through `npm test` / `npm run foo`
// without claiming transitive runtime imports are CI invocation evidence.
function commandSurface(jobBody) {
  let surface = String(jobBody);
  const seen = new Set();
  for (let round = 0; round < 20; round++) {
    let changed = false;
    for (const m of surface.matchAll(/\bnpm\s+(?:run\s+)?([A-Za-z0-9:_-]+)\b/g)) {
      const name = m[1];
      if (seen.has(name) || !packageScripts[name]) continue;
      seen.add(name);
      surface += `\n${packageScripts[name]}`;
      changed = true;
    }
    if (!changed) break;
  }
  return surface.replaceAll('\\', '/');
}

function invokedBy(jobBody, repoPath) {
  const target = repoPath.replaceAll('\\', '/');
  if (qualificationInvocationFiles(jobBody).has(target)) return true;
  const surface = commandSurface(jobBody);
  if (surface.includes(target)) return true;

  // A runner such as `vitest run tests/unit` invokes every test below that exact directory.
  // Accept directory selectors only when they are explicit command tokens, never loose substrings.
  const ancestors = target.split('/').slice(0, -1);
  for (let n = ancestors.length; n >= 2; n--) {
    const dir = ancestors.slice(0, n).join('/');
    const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[\\s"'=])${escaped}(?=$|[\\s"'\\\\])`, 'm').test(surface)) return true;
  }
  return false;
}

// ── per-scenario checks ──────────────────────────────────────────────────────────────────────────
let manualCount = 0;
scenarios.forEach((s, i) => {
  const id = s && s.id ? s.id : `#${i}`;
  const cls = s && s.classification;

  if (!cls || !CLASSIFICATIONS.has(cls)) {
    fail(`${id}: UNCLASSIFIED (classification=${JSON.stringify(cls)}) — must be one of ${[...CLASSIFICATIONS].join(' | ')}`);
    return;
  }

  if (cls === 'manual') {
    manualCount++;
    if (!s.owner || !String(s.owner).trim()) fail(`${id}: classification=manual requires a named owner`);
    return;
  }

  // cls is 'ci' or 'scheduled-live-probe' — the semantic workflow → runnable proof join.
  if (!Array.isArray(s.proofs) || s.proofs.length === 0) {
    fail(`${id}: classification=${cls} but has no structured proofs[] joining a workflow job to an exact runnable path`);
    return;
  }
  for (const [proofIndex, proof] of s.proofs.entries()) {
    const label = `${id}.proofs[${proofIndex}]`;
    const file = String(proof?.workflow || '');
    const job = String(proof?.job || '');
    const repoPath = String(proof?.path || '').replaceAll('\\', '/');
    const jobs = workflowJobs.get(file);
    if (!jobs) {
      fail(`${label}: workflow "${file}" does not exist in .github/workflows/`);
      continue;
    }
    if (!jobs.has(job)) {
      fail(`${label}: job "${job}" does not exist in ${file} (real jobs there: ${[...jobs.keys()].join(', ') || 'none'})`);
      continue;
    }
    const absolute = path.join(ROOT, repoPath);
    if (!repoPath || path.isAbsolute(repoPath) || repoPath.startsWith('../') || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      fail(`${label}: runnable path "${repoPath || '(missing)'}" is not an existing repo file`);
      continue;
    }
    if (!invokedBy(jobs.get(job), repoPath)) {
      fail(`${label}: ${file}#${job} does not invoke "${repoPath}" directly, through an explicit npm-script file/directory selector, or through an explicit qualification suite`);
    }
  }
});

// ── manual-share cap (manual sits OUTSIDE the coverage denominator, but is capped against the FULL list) ──
const manualShare = manualCount / scenarios.length;
if (manualShare > MANUAL_CAP) {
  fail(`manual scenarios are ${(manualShare * 100).toFixed(1)}% of the list (${manualCount}/${scenarios.length}) — cap is ${(MANUAL_CAP * 100).toFixed(0)}%`);
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────
const covered = scenarios.length - manualCount;
console.log(`tests/experience/scenarios.json — ${scenarios.length} scenarios (${manualCount} manual, ${covered} machine-reachable — ci/scheduled-live-probe)`);
console.log(`manual share: ${(manualShare * 100).toFixed(1)}% (cap ${(MANUAL_CAP * 100).toFixed(0)}%)`);

if (failures.length) {
  console.log(`\nFAILURES (${failures.length}):`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('\nAll scenarios classified; every machine-reachable proof joins a real workflow job to an existing, invoked test/driver path; manual share within cap.');
process.exit(0);
