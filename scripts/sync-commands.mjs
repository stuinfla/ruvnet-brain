#!/usr/bin/env node
/**
 * sync-commands.mjs — four spellings of one command share ONE body, generated, never hand-copied.
 *
 * ISSUE #135. `/rvbc`, `/rvcb`, `/brain-console` and `/ruvnet-brain:configure` each declare, in their
 * own words, that every spelling is equally valid and the user must never be corrected. Their BODIES
 * had drifted into four independent hand-written specs, measured on 4.0.36:
 *
 *     rvbc.md  4116 B      rvcb.md  976 B      brain-console.md  985 B      configure.md  1680 B
 *
 * Four rules lived only in `rvbc.md`: speak first before any tool call; the "Things NOT to do before
 * the page is open" list; the emphatic `run_in_background: true, ALWAYS` *with its reason*; and
 * "already running is success, not an error." So which spelling a user happened to type changed how
 * the assistant behaved — on the one command whose entire promise is that spelling does not matter.
 *
 * Two of those cost real silence. Without the "no knowledge search first" prohibition, grounding
 * before opening the page is a legal move and a cold embedding-model load is allowed up to 180
 * seconds. And `rvcb.md` kept the `run_in_background` RULE but dropped the REASON — that a foreground
 * run hangs the call until the 120-second timeout — and a rule whose reason is missing is a rule that
 * gets traded away.
 *
 * THE FIX IS NOT "COPY THE FOUR RULES ACROSS." That is what produced this: four copies of one fact,
 * drifting the moment anyone edits one. It is ADR-065's rule applied to prompts instead of values —
 * a fact that appears in more than one place gets exactly ONE producer, and every other occurrence is
 * written from it. `rvbc.md` is the producer; the other three are generated.
 *
 * WHAT EACH ALIAS KEEPS: its own `description:`. That is not duplicated knowledge — it is what the
 * user reads in the command picker, and each spelling legitimately introduces itself differently.
 * Everything below the frontmatter is byte-identical by construction.
 *
 *   node scripts/sync-commands.mjs           # rewrite the aliases from the canonical body
 *   node scripts/sync-commands.mjs --check   # fail if any alias has drifted (CI / pre-push)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR = path.join(ROOT, 'plugin', 'commands');
const CANONICAL = 'rvbc.md';
const ALIASES = ['rvcb.md', 'brain-console.md', 'configure.md'];
const CHECK = process.argv.includes('--check');

/** Split `---\n…\n---\n` frontmatter from the body. Both are returned verbatim. */
export function splitFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return { frontmatter: null, body: text };
  return { frontmatter: m[1], body: text.slice(m[0].length) };
}

/** The alias's own description line, kept; everything else in the frontmatter comes from canonical. */
function rebuild(aliasText, canonicalFrontmatter, canonicalBody) {
  const { frontmatter } = splitFrontmatter(aliasText);
  const desc = /^description:.*(?:\n[ \t]+.*)*$/m.exec(frontmatter || '');
  const rest = canonicalFrontmatter
    .split('\n')
    .filter((l) => !/^description:/.test(l))
    .join('\n');
  const head = [desc ? desc[0] : null, rest].filter(Boolean).join('\n');
  return `---\n${head}\n---\n${canonicalBody}`;
}

// RUN THE CLI ONLY WHEN INVOKED AS ONE. Without this guard, `import { splitFrontmatter }` from a test
// executed the whole generator — measured: importing this file printed "[commands] synced 0 alias(es)"
// inside the test runner, and had vitest's argv contained `--check` it would have called process.exit
// and taken the runner down with it. The identical defect was fixed in tests/unit/nightly-convergence
// one commit earlier (importing bin/install.mjs ran the installer main); it recurred here because that
// fix was applied to the CALLER instead of to the module. Fixing it at the module is what makes it
// stop recurring — same reasoning as ADR-066: one producer, not a rule every caller must remember.
// realpathSync THROWS on a path that does not resolve, and under vitest on Windows `process.argv[1]`
// is not a real file — measured in CI as `ENOENT: lstat 'D:\D:'`, which failed the whole SUITE at
// import time rather than any assertion. A guard that decides "am I the entrypoint" must never be
// able to crash the caller that merely imported this module: not-resolvable means not-main.
function resolvedIsMain() {
  try {
    return Boolean(process.argv[1])
      && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}
if (!resolvedIsMain()) { /* imported for its exports — do nothing else */ } else {

const canonicalText = fs.readFileSync(path.join(DIR, CANONICAL), 'utf8');
const { frontmatter: canonicalFrontmatter, body: canonicalBody } = splitFrontmatter(canonicalText);
if (!canonicalFrontmatter) {
  process.stderr.write(`[commands] ${CANONICAL} has no frontmatter — refusing to generate from it\n`);
  process.exit(2);
}

const drift = [];
let wrote = 0;
for (const alias of ALIASES) {
  const file = path.join(DIR, alias);
  if (!fs.existsSync(file)) { drift.push(`${alias} (missing)`); continue; }
  const before = fs.readFileSync(file, 'utf8');
  const after = rebuild(before, canonicalFrontmatter, canonicalBody);
  if (after === before) continue;
  if (CHECK) { drift.push(alias); continue; }
  fs.writeFileSync(file, after);
  process.stdout.write(`[commands] ${alias}: body regenerated from ${CANONICAL}\n`);
  wrote += 1;
}

if (CHECK) {
  if (drift.length) {
    process.stderr.write(
      `[commands] DRIFT: ${drift.length} alias(es) disagree with ${CANONICAL}. A user who types one\n`
      + '           spelling would get different behaviour from one who types another, on the command\n'
      + '           that promises spelling does not matter. Run: node scripts/sync-commands.mjs\n',
    );
    for (const d of drift) process.stderr.write(`    ${d}\n`);
    process.exit(1);
  }
  process.stdout.write(`[commands] all ${ALIASES.length} alias(es) share ${CANONICAL}'s body\n`);
  process.exit(0);
}
process.stdout.write(`[commands] synced ${wrote} alias(es) to ${CANONICAL}\n`);
}
