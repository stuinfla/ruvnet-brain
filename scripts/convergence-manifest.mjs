#!/usr/bin/env node
// Deterministic convergence authority for source identity, version surfaces, ADR inventory,
// and executable ownership. No timestamps or live-network answers are included.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'convergence-manifest.json');
const VERSION_FILES = [
  'package.json', 'plugin/.claude-plugin/plugin.json', 'plugin/.codex-plugin/plugin.json',
  'data/manifest.json', 'kb/RVF-GENERATIONS.json', 'explainer/index.html', 'primer/ruvnet-primer.md',
];
const INVENTORY_DIRS = ['src', 'bin', 'console', 'data', 'docs/adr', 'kb', 'plugin', 'scripts', 'tests', '.github'];
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel));
const tracked = () => execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--', ...INVENTORY_DIRS], { encoding: 'buffer' })
  .toString().split('\0').filter(Boolean).sort();
const fileRows = (files) => files.filter((rel) => rel !== 'data/convergence-manifest.json' && fs.existsSync(path.join(ROOT, rel)))
  .map((rel) => ({ path: rel, sha256: sha256(read(rel)), bytes: fs.statSync(path.join(ROOT, rel)).size }));
const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

function build() {
  const versions = Object.fromEntries(VERSION_FILES.map((rel) => {
    const text = read(rel).toString('utf8');
    const match = rel.endsWith('.html') ? text.match(/softwareVersion["']\s*:\s*["']([^"']+)/)
      : rel.endsWith('.md') ? text.match(/Brain version:\s*v([^\s·]+)/i)
        : text.match(/"(?:version|brainVersion)"\s*:\s*"([^\"]+)"/);
    return [rel, match?.[1] || null];
  }));
  const version = JSON.parse(read('package.json')).version;
  const files = fileRows(tracked());
  const sourceIdentity = sha256(Buffer.from(files.map((row) => `${row.path}\0${row.sha256}\0${row.bytes}\n`).join('')));
  return { schemaVersion: 1, kind: 'ruvnet-brain-convergence-manifest', version, sourceIdentity,
    versionSurfaces: versions,
    adrInventory: fs.readdirSync(path.join(ROOT, 'docs/adr')).filter((name) => name.endsWith('.md')).sort(),
    trackedFileCount: files.length, trackedFilesSha256: sha256(Buffer.from(JSON.stringify(files))),
    ownershipChecks: ['version:check', 'doc:currency', 'wired:check'] };
}

function check() {
  if (!fs.existsSync(OUT)) throw new Error('manifest missing; run npm run convergence:write');
  const expected = build();
  const actual = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  if (stable(actual) !== stable(expected)) throw new Error('manifest is stale; run npm run convergence:write');
  if (Object.values(actual.versionSurfaces).some((value) => value !== actual.version)) {
    throw new Error('version surfaces do not converge on package.json');
  }
  console.log(JSON.stringify({ ok: true, version: actual.version, sourceIdentity: actual.sourceIdentity,
    trackedFileCount: actual.trackedFileCount, adrCount: actual.adrInventory.length }));
}

if (process.argv.includes('--write')) {
  fs.writeFileSync(OUT, `${JSON.stringify(build(), null, 2)}\n`);
  console.log(`[convergence] wrote ${path.relative(ROOT, OUT)}`);
} else {
  try { check(); } catch (error) { console.error(`[convergence] ${error.message}`); process.exitCode = 1; }
}
