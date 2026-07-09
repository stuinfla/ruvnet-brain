#!/usr/bin/env node
// embed-verifier.mjs — copy kb/verify-citation.mjs into bin/install.mjs as a base64 literal.
//
// WHY. The installer is deliberately ONE dependency-free file (package.json `files` ships only
// bin/install.mjs), which is what makes `npx ruvnet-brain` work with nothing preinstalled. But
// --doctor needs the citation verifier to prove grounding, and the published brain bundle predates
// that file — so loading it from the bundle would tell every new user "grounding not verifiable,
// re-run the installer", and re-running would not help. An honest message that sends you in a
// circle is not honest.
//
// So the installer carries the verifier and writes it into the KB when it isn't there. kb/ stays
// the single source of truth; this script regenerates the embedded copy; a unit test fails the
// build if the two ever drift.
//
//   node scripts/embed-verifier.mjs           # regenerate
//   node scripts/embed-verifier.mjs --check   # exit 1 if bin/install.mjs is stale
//
// base64, not a template literal: the module contains backticks, ${...} and backslashes, all of
// which would need escaping — and an escaping bug here silently corrupts the verifier.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'kb', 'verify-citation.mjs');
const DST = path.join(ROOT, 'bin', 'install.mjs');

const BEGIN = '// ── BEGIN GENERATED: verify-citation.mjs (node scripts/embed-verifier.mjs) ──';
const END = '// ── END GENERATED ──';

export const encode = (src) => Buffer.from(src, 'utf8').toString('base64');
export const decode = (b64) => Buffer.from(b64, 'base64').toString('utf8');

// The markers carry `(`, `)` and `.` — interpolating them raw turns "(node scripts/…)" into a
// capture group and the block is never found.
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const blockRe = () => new RegExp(`${rx(BEGIN)}\\nconst VERIFY_CITATION_B64 = '([^']*)';\\n${rx(END)}`);

/** Pull the embedded base64 out of install.mjs, or null when the block is absent. */
export function extractEmbedded(installSrc) {
  const m = blockRe().exec(installSrc);
  return m ? m[1] : null;
}

function main() {
  const check = process.argv.includes('--check');
  const srcText = fs.readFileSync(SRC, 'utf8');
  const want = encode(srcText);
  const installSrc = fs.readFileSync(DST, 'utf8');
  const got = extractEmbedded(installSrc);

  if (got === null) {
    console.error(`embed-verifier: no generated block in ${path.relative(ROOT, DST)} — add the BEGIN/END markers first`);
    process.exit(2);
  }
  if (got === want) {
    console.log('embed-verifier: bin/install.mjs is in sync with kb/verify-citation.mjs ✓');
    return;
  }
  if (check) {
    console.error('embed-verifier: STALE — bin/install.mjs no longer matches kb/verify-citation.mjs.');
    console.error('  Regenerate: node scripts/embed-verifier.mjs');
    process.exit(1);
  }
  const next = installSrc.replace(blockRe(), `${BEGIN}\nconst VERIFY_CITATION_B64 = '${want}';\n${END}`);
  fs.writeFileSync(DST, next, 'utf8');
  console.log(`embed-verifier: embedded ${srcText.length} bytes of kb/verify-citation.mjs into bin/install.mjs`);
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) main();
