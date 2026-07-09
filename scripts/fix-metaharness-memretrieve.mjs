#!/usr/bin/env node
// fix-metaharness-memretrieve.mjs — repair (and guard) a real bug in Ruflo's metaharness plugin.
//
// THE BUG
// -------
// `audit-list.mjs` and `audit-trend.mjs` read a stored audit record with:
//     npx @claude-flow/cli memory retrieve --namespace <ns> --key <key>
// ...WITHOUT `--format json`, then greedily `JSON.parse` whatever `{...}` they can scrape from
// human-formatted stdout. But `memory retrieve --format json` returns an ENVELOPE:
//     { id, key, namespace, content: "<the audit record, JSON-stringified>", ... }
// so the record lives in `.content` (a string) and must be unwrapped. Without both changes,
// memRetrieve() returns null for EVERY key, and `metaharness_audit_list` /
// `metaharness_drift_from_history` silently report `records: []` while `totalInNamespace > 0`.
// (Symptom: "0 audit records" even right after a successful oia-audit persisted one.)
//
// WHY THIS SCRIPT EXISTS
// ----------------------
// Both files live inside the GLOBAL npm package `@claude-flow/cli`, so `npm update -g` (or any
// reinstall) silently reverts the patch. This has already happened twice. Rather than hand-edit
// a third time, this script re-applies it idempotently AND can verify it in CI / a doctor check.
//
//   node scripts/fix-metaharness-memretrieve.mjs --check   # exit 1 if reverted (guard)
//   node scripts/fix-metaharness-memretrieve.mjs --apply   # patch in place (idempotent)
//
// The durable fix is upstream; this keeps the local install honest until that lands.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TARGET_DIR =
  process.env.METAHARNESS_SCRIPTS_DIR ||
  path.join(os.homedir(), '.npm-global/lib/node_modules/@claude-flow/cli/plugins/ruflo-metaharness/scripts');

export const FILES = ['audit-list.mjs', 'audit-trend.mjs'];
const SENTINEL = 'outer.content'; // present only when the fix is applied

const FIXED = `function memRetrieve(key) {
  const r = spawnSync('npx', [
    CLI_PKG, 'memory', 'retrieve',
    '--namespace', NS, '--key', key, '--format', 'json',
  ], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', shell: process.platform === 'win32' });
  if (r.status !== 0) return null;
  const m = /\\{[\\s\\S]*\\}/.exec(r.stdout || '');
  if (!m) return null;
  try {
    const outer = JSON.parse(m[0]);
    // \`memory retrieve --format json\` wraps the record: { id, key, content: "<record JSON>" }.
    // Unwrap \`content\` — parsing the envelope AS the record is the empty-results bug.
    const inner = typeof outer.content === 'string' ? outer.content
                : typeof outer.value === 'string' ? outer.value
                : null;
    if (inner) { try { return JSON.parse(inner); } catch { return null; } }
    return (outer.startedAt || outer.composite) ? outer : null;
  } catch { return null; }
}`;

// Match the whole memRetrieve function, up to the first closing brace at column 0.
const FN_RE = /function memRetrieve\(key\) \{[\s\S]*?\n\}/;

export function statusOf(file, dir = TARGET_DIR) {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) return { file, p, state: 'missing' };
  const src = fs.readFileSync(p, 'utf-8');
  if (src.includes(SENTINEL)) return { file, p, state: 'fixed', src };
  if (FN_RE.test(src)) return { file, p, state: 'reverted', src };
  return { file, p, state: 'unrecognized', src };
}

export function apply(dir = TARGET_DIR, log = console.log) {
  let changed = 0;
  for (const file of FILES) {
    const s = statusOf(file, dir);
    if (s.state === 'missing') { log(`  – ${file}: not installed here — nothing to patch`); continue; }
    if (s.state === 'fixed') { log(`  ✓ ${file}: already fixed`); continue; }
    if (s.state === 'unrecognized') { log(`  ⚠ ${file}: memRetrieve() not recognized — upstream changed shape; skipping`); continue; }
    fs.writeFileSync(s.p, s.src.replace(FN_RE, FIXED), 'utf-8');
    log(`  ✓ ${file}: PATCHED (envelope unwrap + --format json)`);
    changed++;
  }
  log(changed ? `\napplied to ${changed} file(s).` : '\nnothing to do — already healthy.');
  return 0;
}

// A guard that cries wolf gets ignored. `missing` means the metaharness plugin simply isn't
// installed on this machine (the common case in CI) — that is NOT a failure. Only a file that
// EXISTS and has lost the fix is a failure, because that is the exact state an `npm update -g`
// leaves behind, and the symptom is silent (`records: []`, never an error).
export function check(dir = TARGET_DIR, log = console.log) {
  let reverted = 0;
  let present = 0;
  for (const file of FILES) {
    const s = statusOf(file, dir);
    if (s.state === 'missing') { log(`  – ${file}: n/a (metaharness plugin not installed)`); continue; }
    present++;
    if (s.state === 'reverted') reverted++;
    log(`  ${s.state === 'fixed' ? '✓' : '✗'} ${file}: ${s.state}`);
  }
  if (!present) {
    log('\n– metaharness plugin not installed — guard not applicable (pass).');
    return 0;
  }
  if (reverted) {
    log(`\n✗ ${reverted} file(s) reverted — an npm update wiped the fix.`);
    log('  Repair: node scripts/fix-metaharness-memretrieve.mjs --apply');
    return 1;
  }
  log('\n✓ metaharness memRetrieve fix intact.');
  return 0;
}

// Only act when run directly, so tests can import the pure functions above.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  const mode = process.argv.includes('--check') ? 'check' : 'apply';
  console.log(`metaharness memRetrieve ${mode} — ${TARGET_DIR}\n`);
  process.exit(mode === 'check' ? check() : apply());
}
