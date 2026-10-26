// tests/helpers/entrypoint-guard-scan.mjs — find hand-written "am I the entry point?" comparisons.
//
// The defect (plugin/scripts/entrypoint.mjs explains it): code that compares `process.argv[1]` with
// this module's own path without resolving symlinks, so a script run through a symlink silently does
// nothing. The fix is one helper, isDirectInvocation(import.meta.url). This scan flags any code that
// still compares argv[1] with the module's own location by hand, broken or not, so the next copy is a
// failing test rather than another night's rediscovery.
//
// RULE: after blanking comments and quoted strings, an occurrence of `process.argv[1]` is a hit when
// the same line or the line on either side also names the module's own location: `import.meta.url`,
// `import.meta.filename`, `__filename`, or a constant assigned exactly from one of those.
import fs from 'node:fs';
import path from 'node:path';

/** Every directory that holds code this repo runs or ships. tests/ and docs/ are out of scope. */
export const SCAN_DIRS = ['bin', 'kb', 'plugin', 'scripts', 'console', 'overlays', 'tri-smart-skill', 'config'];
const SKIP = new Set(['node_modules', '.git', 'coverage', 'dist', 'build']);
const EXT = /\.(?:mjs|cjs|js)$/;

/** Blank out block comments, line comments and one-line '…' / "…" strings, keeping line numbers.
 *  A `//` preceded by `:` (a URL scheme) is not a comment. Template literals are kept: generated code
 *  lives in them. */
export function codeOnly(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, (m) => `'${' '.repeat(m.length - 2)}'`)
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const SELF_ASSIGN = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:fileURLToPath\(\s*import\.meta\.url\s*\)|path\.resolve\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)|new URL\(\s*import\.meta\.url\s*\)\.pathname|import\.meta\.filename)\s*;/g;

/** Line numbers (1-based) of hand-written entry-point comparisons in `src`. */
export function findRawGuards(src) {
  const code = codeOnly(src);
  if (!code.includes('process.argv[1]')) return [];
  const selfNames = new Set(['__filename']);
  for (const m of code.matchAll(SELF_ASSIGN)) selfNames.add(m[1]);
  const names = [...selfNames].map((n) => n.replace(/[$]/g, '\\$')).join('|');
  const selfRe = new RegExp(`import\\.meta\\.(?:url|filename)|(?<![\\w$.])(?:${names})(?![\\w$])`);
  const lines = code.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    if (!line.includes('process.argv[1]')) return;
    const window = lines.slice(Math.max(0, i - 1), i + 2).join('\n');
    if (selfRe.test(window)) hits.push(i + 1);
  });
  return hits;
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && EXT.test(e.name)) out.push(full);
  }
}

/** { file (repo-relative, '/'-separated), lines } for every file under `root` with a raw guard. */
export function scanRawGuards(root, dirs = SCAN_DIRS) {
  const files = [];
  for (const d of dirs) walk(path.join(root, d), files);
  const out = [];
  for (const f of files.sort()) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const lines = findRawGuards(src);
    if (lines.length) out.push({ file: path.relative(root, f).split(path.sep).join('/'), lines });
  }
  return { scanned: files.length, hits: out };
}
