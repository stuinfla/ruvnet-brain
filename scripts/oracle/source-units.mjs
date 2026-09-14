#!/usr/bin/env node
/**
 * scripts/oracle/source-units.mjs — Step 14 (ADR-086, owner criterion C3) deterministic inventory.
 *
 * NO MODEL. Given a checked-out upstream snapshot and its exact commit, enumerate U "meaningful
 * source units", stratify them by top-level directory × language, and select min(100, U) with a
 * PRNG seeded from `${repo}@${commit}`. Same input → byte-identical JSON across a process boundary
 * (tests/unit/oracle-source-units.test.mjs proves it by running the CLI twice).
 *
 * Every unit is bound to path + git blob SHA (sha1 over "blob <len>\0<bytes>", identical to
 * `git hash-object`) + 1-based inclusive line span + sha256 of the unit text. A label produced later
 * can therefore be re-checked against exact upstream bytes, and regenerated ONLY when the blob
 * changes — the amortization Dual's C3 spec asks for.
 *
 * Covered: Markdown (ATX H2/H3 sections), JavaScript/TypeScript (@babel/parser AST: exported or
 * doc-commented top-level functions, classes, interfaces, type aliases, enums, namespaces), Rust
 * (regex: bare `pub` fn/struct/enum/trait/type/union, brace-matched), Python (regex: module-level
 * public def/class blocks). NOT covered (inventoried as `unsupported`, counted, never silently
 * dropped): Go, Java, C/C++, Shell, Svelte, YAML/JSON/TOML, setext Markdown headings, CommonJS
 * `module.exports` assignments, Rust items under `#[cfg(test)]`, Rust `pub(crate)` items.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as babelParse } from '@babel/parser';

export const RULES_VERSION = 'oracle-source-units/1';
export const MAX_SELECTED = 100;
export const MIN_MARKDOWN_WORDS = 40;
export const MIN_CODE_TOKENS = 25;
export const MAX_FILE_BYTES = 1_048_576;

export const LANGUAGE_BY_EXT = Object.freeze({
  '.md': 'markdown', '.markdown': 'markdown',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.rs': 'rust', '.py': 'python',
});

const VCS_IDE_DIRS = new Set(['.git', '.github', '.gitlab', '.vscode', '.idea', '.circleci', '.husky', '.devcontainer', '.svn', '.hg']);
const DEP_BUILD_DIRS = new Set(['node_modules', 'vendor', 'vendors', 'third_party', 'third-party', 'bower_components',
  'dist', 'build', 'out', 'target', 'coverage', '__pycache__', '.venv', 'venv', '.cache', '.next', '.turbo',
  '.pytest_cache', '.mypy_cache', 'site-packages']);
const TEST_DIRS = new Set(['test', 'tests', '__tests__', '__mocks__', 'fixtures', 'fixture', 'snapshots', '__snapshots__', 'e2e', 'spec']);
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock',
  'bun.lockb', 'go.sum', 'composer.lock', 'Gemfile.lock', 'flake.lock', 'uv.lock']);
const META_FILE = /^(license|licence|copying|notice|patents|changelog|changes|history|code_of_conduct|contributing|contributors|authors|security|codeowners)(\.[a-z0-9]+)?$/i;
const GENERATED_MARKER = /@generated|code generated|do not edit|automatically generated|auto-generated/i;
const BOILERPLATE_HEADING = /^(table of contents|contents|toc|license|licence|contributing|contributors|acknowledg(e)?ments|changelog|badges|star history|sponsors?|citation|credits)$/i;

/** Path-only exclusion rules, applied to every file. Order matters: the first match names the reason. */
export const PATH_RULES = Object.freeze([
  ['vcs-or-ide-dir', (rel) => dirSegments(rel).some((s) => VCS_IDE_DIRS.has(s))],
  ['dependency-or-build-dir', (rel) => dirSegments(rel).some((s) => DEP_BUILD_DIRS.has(s))],
  ['test-dir', (rel) => dirSegments(rel).some((s) => TEST_DIRS.has(s))],
  ['test-file', (rel) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || /(^|\/)test_[^/]*\.py$/.test(rel) || /_test\.py$/.test(rel)],
  ['license-changelog-or-meta', (rel) => META_FILE.test(path.posix.basename(rel))],
  ['lockfile', (rel) => LOCKFILES.has(path.posix.basename(rel)) || /\.lock$/.test(rel)],
  ['minified-map-or-typings', (rel) => /\.min\.[cm]?js$/.test(rel) || /\.map$/.test(rel) || /\.d\.[cm]?ts$/.test(rel) || /\.snap$/.test(rel)],
]);

/** Byte rules, applied only to files in a covered language (the only ones ever read). */
export const BYTE_RULES = Object.freeze([
  ['oversized', (buf) => buf.length > MAX_FILE_BYTES],
  ['binary', (buf) => buf.subarray(0, 8000).includes(0)],
  ['generated-marker', (buf) => GENERATED_MARKER.test(buf.subarray(0, 2000).toString('utf8').split('\n').slice(0, 5).join('\n'))],
]);

function dirSegments(rel) { return rel.split('/').slice(0, -1); }
export function sha256Hex(input) { return createHash('sha256').update(input).digest('hex'); }
/** Exactly what `git hash-object <file>` prints. */
export function gitBlobSha(buffer) {
  return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
}

// ── Markdown ───────────────────────────────────────────────────────────────────────────────────
const ATX = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^[ \t]{0,3}(```|~~~)/;
const WORD = /[A-Za-z][A-Za-z0-9'’-]+/g;

function fenceTracker() {
  let mark = null;
  return (line) => { // returns true when the line is a fence delimiter or inside a fence
    const f = FENCE.exec(line);
    if (f) {
      if (mark === null) mark = f[1];
      else if (line.trim().startsWith(mark)) mark = null;
      return true;
    }
    return mark !== null;
  };
}

export function countProseWords(lines) {
  const fenced = fenceTracker();
  let words = 0;
  for (const raw of lines) {
    if (fenced(raw)) continue;
    const line = raw.trim();
    if (!line || line.startsWith('|')) continue;
    if (/^(!?\[[^\]]*\]\([^)]*\)\s*)+$/.test(line)) continue; // badges / bare links
    if (/^<[^>]+>$/.test(line)) continue; // html-only line
    const prose = line.replace(/https?:\/\/\S+/g, ' ').replace(/<[^>]+>/g, ' ');
    words += (prose.match(WORD) || []).length;
  }
  return words;
}

export function extractMarkdownUnits(text) {
  const lines = text.split('\n');
  const fenced = fenceTracker();
  const headings = [];
  lines.forEach((line, i) => {
    if (fenced(line)) return;
    const m = ATX.exec(line);
    if (m) headings.push({ line: i, level: m[1].length, title: m[2].trim() });
  });
  const units = [];
  headings.forEach((h, idx) => {
    if (h.level !== 2 && h.level !== 3) return;
    if (BOILERPLATE_HEADING.test(h.title.replace(/[*_`:]/g, '').trim())) return;
    let end = lines.length;
    for (let j = idx + 1; j < headings.length; j++) if (headings[j].level <= 3) { end = headings[j].line; break; }
    while (end > h.line + 1 && lines[end - 1].trim() === '') end--;
    const words = countProseWords(lines.slice(h.line + 1, end));
    if (words < MIN_MARKDOWN_WORDS) return;
    units.push({ startLine: h.line + 1, endLine: end, kind: 'md-section', name: h.title });
  });
  return units;
}

// ── JavaScript / TypeScript ────────────────────────────────────────────────────────────────────
const JS_KINDS = {
  FunctionDeclaration: 'js-function', ClassDeclaration: 'js-class', TSInterfaceDeclaration: 'ts-interface',
  TSTypeAliasDeclaration: 'ts-type', TSEnumDeclaration: 'ts-enum', TSDeclareFunction: 'ts-declare-function',
  TSModuleDeclaration: 'ts-namespace',
};
const isDocComment = (c) => c.type === 'CommentBlock' && c.value.startsWith('*');

function commentStartLine(node) {
  const comments = node.leadingComments || [];
  let start = node.loc.start.line;
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i].loc.end.line < start - 1) break;
    start = comments[i].loc.start.line;
  }
  return start;
}

export function extractJsUnits(text, { typescript = false, jsx = false } = {}) {
  let ast;
  try {
    ast = babelParse(text, {
      sourceType: 'unambiguous', errorRecovery: true, attachComment: true,
      plugins: [...(typescript ? ['typescript'] : []), ...(jsx ? ['jsx'] : []), 'decorators-legacy', 'importAttributes'],
    });
  } catch (error) {
    return { error: `parse: ${error.message}`, units: [] };
  }
  const units = [];
  for (const node of ast.program.body) {
    let decl = node;
    let exported = false;
    if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') {
      if (!node.declaration) continue;
      decl = node.declaration;
      exported = true;
    }
    const documented = (node.leadingComments || []).some(isDocComment);
    if (!exported && !documented) continue;
    let kind = JS_KINDS[decl.type];
    let name = decl.id?.name ?? 'default';
    if (!kind && decl.type === 'VariableDeclaration') {
      const fns = decl.declarations.filter((d) => d.init && /^(Arrow)?FunctionExpression$/.test(d.init.type));
      if (fns.length === 0) continue;
      kind = 'js-const-function';
      name = fns.map((d) => d.id?.name ?? '(pattern)').join(',');
    }
    if (!kind) continue;
    units.push({ startLine: commentStartLine(node), endLine: node.loc.end.line, kind, name });
  }
  return { units };
}

// ── Rust (regex, conservative) ─────────────────────────────────────────────────────────────────
const RUST_ITEM = /^\s*pub\s+(?:(?:async|unsafe|const|extern\s+"[^"]*")\s+)*(fn|struct|enum|trait|type|union)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const stripRustLine = (line) => line
  .replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)'/g, "''").replace(/\/\/.*$/, '');

function findRustEnd(lines, from) {
  let depth = 0;
  let opened = false;
  for (let j = from; j < Math.min(lines.length, from + 3000); j++) {
    for (const ch of stripRustLine(lines[j])) {
      if (ch === '{') { depth++; opened = true; } else if (ch === '}') { depth--; if (opened && depth === 0) return j; } else if (ch === ';' && !opened) return j;
    }
  }
  return -1;
}

export function extractRustUnits(text) {
  const lines = text.split('\n');
  const units = [];
  for (let i = 0; i < lines.length; i++) {
    const m = RUST_ITEM.exec(lines[i]);
    if (!m) continue;
    let start = i;
    while (start > 0 && /^\s*(\/\/\/|#\[)/.test(lines[start - 1])) start--;
    const end = findRustEnd(lines, i);
    if (end < 0) continue;
    units.push({ startLine: start + 1, endLine: end + 1, kind: `rust-${m[1]}`, name: m[2] });
    i = end;
  }
  return units;
}

// ── Python (regex, conservative) ───────────────────────────────────────────────────────────────
const PY_DEF = /^(async\s+def|def|class)\s+([A-Za-z][A-Za-z0-9_]*)/;

export function extractPythonUnits(text) {
  const lines = text.split('\n');
  const units = [];
  for (let i = 0; i < lines.length; i++) {
    const m = PY_DEF.exec(lines[i]);
    if (!m) continue;
    let start = i;
    while (start > 0 && /^@/.test(lines[start - 1])) start--;
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') continue;
      if (/^[\s)\]]/.test(l)) { end = j; continue; }
      break;
    }
    units.push({ startLine: start + 1, endLine: end + 1, kind: m[1].startsWith('class') ? 'py-class' : 'py-function', name: m[2] });
    i = end;
  }
  return units;
}

// ── Per-file extraction ────────────────────────────────────────────────────────────────────────
const CODE_TOKEN = /[A-Za-z_$][A-Za-z0-9_$]+/g;
export function unitText(lines, startLine, endLine) { return lines.slice(startLine - 1, endLine).join('\n'); }

export function extractUnits(rel, text) {
  const ext = path.posix.extname(rel).toLowerCase();
  const language = LANGUAGE_BY_EXT[ext];
  if (language === 'markdown') return { language, units: extractMarkdownUnits(text) };
  let result;
  if (language === 'javascript' || language === 'typescript') {
    result = extractJsUnits(text, { typescript: language === 'typescript', jsx: ['.js', '.mjs', '.cjs', '.jsx', '.tsx'].includes(ext) });
  } else if (language === 'rust') result = { units: extractRustUnits(text) };
  else if (language === 'python') result = { units: extractPythonUnits(text) };
  else return { language: null, units: [] };
  const lines = text.split('\n');
  const units = result.units.filter((u) => (unitText(lines, u.startLine, u.endLine).match(CODE_TOKEN) || []).length >= MIN_CODE_TOKENS);
  return { language, units, error: result.error };
}

// ── Snapshot walk ──────────────────────────────────────────────────────────────────────────────
export function listSnapshotFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (e.name !== '.git') walk(path.join(abs, e.name), childRel); } else if (e.isFile()) out.push(childRel);
    }
  };
  walk(dir, '');
  return out.sort();
}

// ── Deterministic selection ────────────────────────────────────────────────────────────────────
export function seededRandom(seed) {
  let counter = 0;
  return () => createHash('sha256').update(seed).update(`\n${counter++}`).digest().readUIntBE(0, 6) / 2 ** 48;
}
export function seededShuffle(items, rand) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
/** Hamilton (largest-remainder) apportionment of `total` slots over strata sizes. */
export function apportion(sizes, total) {
  const keys = Object.keys(sizes).sort();
  const U = keys.reduce((s, k) => s + sizes[k], 0);
  if (U <= total) return Object.fromEntries(keys.map((k) => [k, sizes[k]]));
  const quota = Object.fromEntries(keys.map((k) => [k, (sizes[k] * total) / U]));
  const alloc = Object.fromEntries(keys.map((k) => [k, Math.floor(quota[k])]));
  let remaining = total - keys.reduce((s, k) => s + alloc[k], 0);
  const byFraction = keys.filter((k) => alloc[k] < sizes[k])
    .sort((a, b) => (quota[b] - alloc[b]) - (quota[a] - alloc[a]) || (a < b ? -1 : 1));
  for (const k of byFraction) { if (remaining <= 0) break; alloc[k]++; remaining--; }
  return alloc;
}

export function resolveCommit(dir, explicit) {
  if (explicit) return explicit;
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

export function buildInventory({ dir, repo, commit, maxSelected = MAX_SELECTED }) {
  const files = listSnapshotFiles(dir);
  const excluded = {};
  const unsupported = {};
  const uncoveredFiles = [];
  const all = [];
  let filesConsidered = 0;
  for (const rel of files) {
    const rule = PATH_RULES.find(([, test]) => test(rel));
    if (rule) { excluded[rule[0]] = (excluded[rule[0]] || 0) + 1; continue; }
    const ext = path.posix.extname(rel).toLowerCase();
    const language = LANGUAGE_BY_EXT[ext];
    if (!language) { const key = ext || '(none)'; unsupported[key] = (unsupported[key] || 0) + 1; continue; }
    const buf = fs.readFileSync(path.join(dir, rel));
    const byteRule = BYTE_RULES.find(([, test]) => test(buf));
    if (byteRule) { excluded[byteRule[0]] = (excluded[byteRule[0]] || 0) + 1; continue; }
    filesConsidered++;
    const text = buf.toString('utf8');
    const { units, error } = extractUnits(rel, text);
    if (units.length === 0) { uncoveredFiles.push({ path: rel, reason: error ? 'parse-error' : 'no-units' }); continue; }
    const blobSha = gitBlobSha(buf);
    const lines = text.split('\n');
    const topDir = rel.includes('/') ? rel.split('/')[0] : '(root)';
    for (const u of units) {
      const body = unitText(lines, u.startLine, u.endLine);
      all.push({
        unitId: sha256Hex(`${RULES_VERSION}\n${rel}\n${blobSha}\n${u.startLine}\n${u.endLine}`).slice(0, 16),
        path: rel, blobSha, startLine: u.startLine, endLine: u.endLine, kind: u.kind, name: u.name,
        language, stratum: `${topDir}|${language}`, bytesSha256: sha256Hex(Buffer.from(body, 'utf8')),
        chars: body.length,
      });
    }
  }
  const sizes = {};
  for (const u of all) sizes[u.stratum] = (sizes[u.stratum] || 0) + 1;
  const alloc = apportion(sizes, maxSelected);
  const seed = `${RULES_VERSION}|${repo}@${commit}`;
  const selectedIds = new Set();
  for (const key of Object.keys(alloc)) {
    const pool = all.filter((u) => u.stratum === key).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.startLine - b.startLine));
    for (const u of seededShuffle(pool, seededRandom(`${seed}|${key}`)).slice(0, alloc[key])) selectedIds.add(u.unitId);
  }
  const selected = all.filter((u) => selectedIds.has(u.unitId));
  return {
    schemaVersion: 1, kind: 'oracle-source-inventory', rulesVersion: RULES_VERSION, repo, commit, seed,
    U: all.length, selectedCount: selected.length, selected,
    strata: Object.keys(sizes).sort().map((key) => ({ key, U: sizes[key], selected: alloc[key] || 0 })),
    coverage: {
      filesTotal: files.length, filesExcluded: excluded, filesUnsupported: unsupported, filesConsidered,
      filesWithUnits: filesConsidered - uncoveredFiles.length, uncoveredFilesCount: uncoveredFiles.length, uncoveredFiles,
    },
    rules: { minMarkdownWords: MIN_MARKDOWN_WORDS, minCodeTokens: MIN_CODE_TOKENS, maxFileBytes: MAX_FILE_BYTES, languages: [...new Set(Object.values(LANGUAGE_BY_EXT))] },
  };
}

function arg(argv, flag) { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; }

export function main(argv = process.argv.slice(2)) {
  const dir = arg(argv, '--dir');
  const repo = arg(argv, '--repo');
  const out = arg(argv, '--out');
  if (!dir || !repo) { process.stderr.write('Usage: source-units.mjs --dir <snapshot> --repo <name> [--commit <sha>] [--out <file>]\n'); return 64; }
  const inventory = buildInventory({ dir: path.resolve(dir), repo, commit: resolveCommit(dir, arg(argv, '--commit')) });
  const json = `${JSON.stringify(inventory, null, 2)}\n`;
  if (out) fs.writeFileSync(out, json); else process.stdout.write(json);
  process.stderr.write(`[source-units] ${repo}@${inventory.commit.slice(0, 10)} U=${inventory.U} selected=${inventory.selectedCount} files=${inventory.coverage.filesTotal} uncovered=${inventory.coverage.uncoveredFilesCount}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
