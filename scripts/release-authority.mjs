#!/usr/bin/env node
// One-publisher source gate for issue #77. Rebuild and maintenance jobs may prepare bytes, but
// only the protected release entry (scripts/release.mjs) and its canonical provider
// (scripts/release-transaction-provider.mjs) may contain operations that create a GitHub Release,
// publish npm, or move an npm dist-tag. CI and the canonical release path both execute this check.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL_PUBLISHERS = new Set([
  'scripts/release.mjs',
  'scripts/release-transaction-provider.mjs',
]);
const SOURCE_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.sh', '.yml', '.yaml']);
const SCANNED_DIRECTORIES = Object.freeze([
  'scripts', 'deploy', 'bin', '.github/workflows', 'plugin', 'kb', 'console',
]);

// Cut a trailing line comment WITHOUT touching a `//` that lives inside a string literal. The old
// form was `line.replace(/\/\/.*$/, '')`, which cuts at the FIRST `//` on the line with no idea
// what it is inside: a single line carrying a URL ahead of the call — say
//   const registry = 'https://registry.npmjs.org'; execFileSync('npm', ['publish']);
// had the publish call deleted before any detector saw it, so the gate reported PASS on a file
// that plainly publishes. Quote-aware scan, escape-aware, no parser needed.
function stripLineComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === '\\') { index += 1; continue; }
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') { quote = character; continue; }
    if (character === '/' && line[index + 1] === '/') return line.slice(0, index);
  }
  return line;
}

// A heredoc body is DATA, not executable source — the same reason comments are stripped. Widening
// this gate to plugin/ immediately proved why it matters: plugin/scripts/ground-ruvnet.sh writes an
// instruction block containing the words "npm publish" inside `cat <<EOF`, and the gate reported it
// as an unauthorized publisher. A gate that rejects a compliant file is as broken as one that
// accepts a violating file; both get fixed, neither gets shipped.
function stripHeredocBodies(source) {
  const lines = source.split('\n');
  const kept = [];
  let terminator = null;
  for (const line of lines) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null;
      kept.push('');
      continue;
    }
    const opener = /<<-?\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(line);
    kept.push(line);
    if (opener) terminator = opener[1] || opener[2] || opener[3];
  }
  return kept.join('\n');
}

function executableSource(source) {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return stripHeredocBodies(withoutBlocks)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .map(stripLineComment)
    .join('\n');
}

const ACTIONS = [
  {
    action: 'github-release-create',
    jsPatterns: [
      /\[\s*['"]release['"]\s*,\s*['"]create['"]/,
    ],
    shellPatterns: [/^\s*(?:-\s*run:\s*)?gh\s+release\s+create\b/m],
  },
  {
    action: 'github-release-update',
    jsPatterns: [
      /['"]PATCH['"][\s\S]{0,120}releases\//,
      /\[\s*['"]release['"]\s*,\s*['"]edit['"]/,
    ],
    shellPatterns: [/^\s*(?:-\s*run:\s*)?gh\s+(?:release\s+edit|api\s+.*releases\/.*PATCH)\b/m],
  },
  {
    action: 'npm-publish',
    jsPatterns: [
      /(?:execFileSync|spawnSync)\(\s*['"]npm['"]\s*,\s*\[\s*['"]publish['"]/,
      /runOrDie\(\s*['"]npm publish['"]/,
    ],
    shellPatterns: [/^\s*(?:-\s*run:\s*)?npm\s+publish\b/m],
  },
  {
    action: 'npm-dist-tag',
    jsPatterns: [
      /(?:execFileSync|spawnSync)\(\s*['"]npm['"]\s*,\s*\[\s*['"]dist-tag['"]\s*,\s*['"]add['"]/,
      /runOrDie\(\s*['"]npm dist-tag[^'"]*['"]/,
    ],
    shellPatterns: [/^\s*(?:-\s*run:\s*)?npm\s+dist-tag\s+add\b/m],
  },
];

export function detectPublisherActions(file, source) {
  const relative = file.split(path.sep).join('/');
  if (CANONICAL_PUBLISHERS.has(relative)) return [];
  const executable = executableSource(source);
  const extension = path.extname(relative);
  const kind = ['.sh', '.yml', '.yaml'].includes(extension) || relative.startsWith('package.json#scripts.')
    ? 'shellPatterns'
    : 'jsPatterns';
  return ACTIONS
    .filter((action) => action[kind].some((pattern) => pattern.test(executable)))
    .map(({ action }) => ({ file: relative, action }));
}

function sourceFiles(root) {
  const files = [];
  const visit = (absolute) => {
    if (!fs.existsSync(absolute)) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(absolute, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(child);
    }
  };
  // Every directory that ships executable code, not just the four this gate started with. `plugin/`
  // and `kb/` were invisible here while both contain real, shipped, executable files — kb/ holds one
  // of the three trust-root copies checked below, and plugin/skills/*/scripts/ holds genuine release
  // machinery (plugin/skills/release-proof/scripts/release-proof.mjs). A one-publisher gate that
  // cannot see half the publishers is a gate in name only.
  for (const directory of SCANNED_DIRECTORIES) visit(path.join(root, ...directory.split('/')));
  return files;
}

// The Ed25519 trust root is EMBEDDED in the shipped executables deliberately (SEC-0010 #6): it has
// to travel with the code, or an attacker who swaps the downloaded bundle could swap the key it is
// checked against too. rUv's ADR-174 helper-signing bakes RUFLO_HELPERS_PUBKEY in for exactly this
// reason. Because bin/install.mjs and kb/forge-update.mjs ship standalone across a packaging
// boundary they cannot import one shared constant, so the copies are reconciled HERE — which is the
// gate kb/forge-update.mjs's own comment has always promised ("the release gate checks that
// identity") and which nothing has ever actually performed. Without it, a PR that edits an embedded
// key to an attacker's, leaving keys/*.pem untouched, ships to every installer and self-updating
// client with no test and no gate objecting.
const TRUST_ROOT_FILE = 'keys/ruvnet-brain-signing.pub.pem';
const TRUST_ROOT_HOLDERS = Object.freeze(['bin/install.mjs', 'kb/forge-update.mjs']);
const EMBEDDED_TRUST_ROOT = /const SIGNING_PUBKEY_PEM = `(-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----)`/;

const normalizeKey = (pem) => String(pem).replace(/\r\n/g, '\n').trim();

export function findTrustRootDrift(root = ROOT) {
  const drift = [];
  const canonicalFile = path.join(root, TRUST_ROOT_FILE);
  if (!fs.existsSync(canonicalFile)) return [{ file: TRUST_ROOT_FILE, reason: 'canonical trust root is missing' }];
  const canonical = normalizeKey(fs.readFileSync(canonicalFile, 'utf8'));
  for (const holder of TRUST_ROOT_HOLDERS) {
    const absolute = path.join(root, ...holder.split('/'));
    if (!fs.existsSync(absolute)) { drift.push({ file: holder, reason: 'trust-root holder is missing' }); continue; }
    const match = EMBEDDED_TRUST_ROOT.exec(fs.readFileSync(absolute, 'utf8'));
    if (!match) { drift.push({ file: holder, reason: 'embedded SIGNING_PUBKEY_PEM not found' }); continue; }
    if (normalizeKey(match[1]) !== canonical) {
      drift.push({ file: holder, reason: `embedded trust root differs from ${TRUST_ROOT_FILE}` });
    }
  }
  return drift;
}

export function findUnauthorizedPublishers(root = ROOT) {
  const findings = sourceFiles(root).flatMap((absolute) => {
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    return detectPublisherActions(relative, fs.readFileSync(absolute, 'utf8'));
  });
  const packageFile = path.join(root, 'package.json');
  if (fs.existsSync(packageFile)) {
    const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    for (const [name, command] of Object.entries(pkg.scripts || {})) {
      findings.push(...detectPublisherActions(`package.json#scripts.${name}`, String(command)));
    }
  }
  return findings;
}

export function main(root = ROOT) {
  const findings = findUnauthorizedPublishers(root);
  const drift = findTrustRootDrift(root);
  if (findings.length === 0 && drift.length === 0) {
    console.log('[release-authority] PASS: protected release entry scripts/release.mjs and canonical provider scripts/release-transaction-provider.mjs are authorized; trust root is identical in all copies');
    return 0;
  }
  if (findings.length) {
    console.error('[release-authority] FAIL: publication action found outside the protected release entry and canonical provider');
    for (const finding of findings) console.error(`  ${finding.file}: ${finding.action}`);
  }
  if (drift.length) {
    console.error('[release-authority] FAIL: the embedded Ed25519 trust root drifted from its canonical copy');
    for (const entry of drift) console.error(`  ${entry.file}: ${entry.reason}`);
  }
  return 1;
}

// realpath BOTH sides. `path.resolve` alone leaves a symlinked invocation comparing two different
// spellings of one file, so the guard silently reads false and the CLI exits 0 having done nothing —
// the same defect 6eead7bc fixed in release-projection.mjs, which is a gate this repo relies on.
if (((() => {
  try { return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})())) {
  process.exitCode = main();
}
