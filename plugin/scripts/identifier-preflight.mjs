/**
 * identifier-preflight.mjs — an external identifier is CHECKED before it is committed to, or the
 * failure is silent and expensive.
 *
 * THE COST, measured 2026-08-13. I launched a 50-minute adversarial audit with
 * `codex exec --model gpt-5.6`. The real model is `gpt-5.6-sol`, and it was sitting in
 * `~/.codex/config.toml` where two seconds of reading would have found it. What made it expensive
 * was not the typo:
 *
 *     codex printed `ERROR: 400 The 'gpt-5.6' model is not supported` AND EXITED 0,
 *     into a file I had redirected and was not reading.
 *
 * So there was no exit code to catch, no exception, and no output on screen. Fifty minutes of the
 * owner's time bought nothing, and the loss surfaced only because he asked why the result was late.
 * The typo is a two-second fix; the SILENCE is the defect.
 *
 * WHY THIS IS THE FOURTH INSTANCE OF ONE PATTERN, not a new bug. This repo already owns
 * `scripts/verify-model-catalog.mjs`, whose own header calls it "THE WALL for model facts … the
 * enforcement of Rule 0 for the one place it kept getting skipped: model/version claims" (ADR-0016).
 * It verifies models written into `data/model-catalog.json`. It has never verified a model NAME
 * PASSED TO A COMMAND. Same shape as the freshness machinery pointed at coverage but not the eval,
 * `resolveBash()` present but unused at a new call site, and `findInvocations()` existing while a
 * ship glob greps raw text. The machinery keeps existing and keeps pointing one surface away from
 * where the failure happens.
 *
 * DESIGN, corrected against an adversarial review of my other hooks earlier the same day:
 *   · FAIL OPEN. An identifier this cannot resolve is ALLOWED, silently. The reviewed sibling turned
 *     a missing `sqlite3` into "the memory store is not durably persisting writes" — a fabricated
 *     diagnosis is worse than no check, because it burns the credibility the channel runs on.
 *   · NO CACHE. The same review found a cache keyed by $USER but probing a per-project path, so one
 *     project's verdict refused work in another. There is nothing here worth caching.
 *   · REFUSE ONLY ON A KNOWN-WRONG VALUE, never on an unknown one, and SAY THE RIGHT ANSWER — a wall
 *     that reports a problem without the fix is one the user routes around.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Each entry knows how to enumerate the identifiers its CLI actually accepts on THIS machine.
 * `known()` returning an empty list means "cannot tell" and the check stands down — that is the
 * fail-open path and it is the common one.
 */
export const CLIS = [
  {
    id: 'codex',
    // `codex exec --model X`, `codex -m X`. The flag may appear anywhere in the command.
    matches: (cmd) => /\bcodex\b/.test(cmd),
    flag: /(?:--model|(?<![\w-])-m)[= ]+["']?([\w.:-]+)["']?/,
    known: (home = os.homedir()) => {
      // The config's `model` is the one identifier PROVEN to work on this account — codex rejects
      // others per-account ("not supported when using Codex with a ChatGPT account"), so a static
      // list of "models that exist" would be exactly the stale-memory fact ADR-0016 forbids.
      try {
        const txt = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
        const m = txt.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
        return m ? [m[1]] : [];
      } catch { return []; }
    },
  },
];

/**
 * QUOTED TEXT IS AN ARGUMENT, NOT A FLAG. `codex exec "explain the --model gpt-5.6 error"` passes
 * that string as a PROMPT; refusing it would block asking about the very mistake this file exists
 * to prevent. Caught by testing the edge instead of assuming, minutes after an adversarial review
 * found a sibling fix greping raw command text for `git push` and matching
 * `grep -n "npm publish" docs/…`. Same defect, same day, two files apart: the truth-maker is the
 * EXECUTABLE POSITION, and a prompt is always quoted, so the quoted regions come out first.
 */
const unquoted = (cmd) => cmd.replace(/"[^"]*"/g, ' ').replace(/'[^']*'/g, ' ');

/** Pull the identifier a command commits to, if any. */
export function identifierIn(command, clis = CLIS) {
  const raw = String(command || '');
  const cmd = unquoted(raw);
  for (const c of clis) {
    if (!c.matches(cmd)) continue;
    const m = cmd.match(c.flag);
    if (m) return { cli: c, value: m[1] };
  }
  return null;
}

/**
 * The verdict. `unknown` is a first-class answer and it ALLOWS — this refuses only when the machine
 * can positively enumerate what the CLI accepts and the requested value is not among them.
 */
export function check(command, opts = {}) {
  const hit = identifierIn(command, opts.clis ?? CLIS);
  if (!hit) return { verdict: 'not-applicable' };
  const known = hit.cli.known(opts.home);
  if (!known.length) return { verdict: 'unknown', why: `cannot enumerate ${hit.cli.id} models on this machine` };
  if (known.includes(hit.value)) return { verdict: 'ok', value: hit.value };
  // A CONFIGURED MODEL IS A DEFAULT, NOT AN ALLOWLIST — and an audit was right to call the first
  // version a false-refusal waiting to happen: an account may accept several models, so `o3` or
  // `gpt-5.1-codex` are UNKNOWN here, not wrong, and must pass. What is knowably wrong is a NEAR MISS
  // of the configured value, because that is a typo rather than a choice — and it is exactly what
  // happened: `gpt-5.6` for `gpt-5.6-sol`, a truncation, 400 + exit 0, fifty minutes lost.
  const nearMiss = known.find((k) => k.startsWith(hit.value) || hit.value.startsWith(k)
    || k.replace(/[-._]/g, '') === hit.value.replace(/[-._]/g, ''));
  if (!nearMiss) return { verdict: 'unknown', why: `${hit.value} is not this machine's configured model, but may still be valid for the account` };
  return {
    verdict: 'wrong',
    nearMiss,
    value: hit.value,
    known,
    reason:
      `⛔ BLOCKED — "${hit.value}" is not a model this machine's ${hit.cli.id} accepts.\n`
      + `  configured and proven to work: ${known.join(', ')}\n`
      + `  source: ~/.codex/config.toml\n\n`
      + 'Checked because an unverified identifier fails SILENTLY here: on 2026-08-13 `codex exec\n'
      + '--model gpt-5.6` printed a 400 and EXITED 0 into a redirected file, and 50 minutes of a\n'
      + 'long-running audit produced nothing. There was no exit code to catch. Use the name above,\n'
      + 'or read the live source if you believe it is wrong — never retype one from memory.',
  };
}

const isMain = (() => {
  try { return process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (isMain) {
  let payload = '';
  try { payload = fs.readFileSync(0, 'utf8'); } catch { /* no stdin is not a refusal */ }
  let command = '';
  try { command = JSON.parse(payload)?.tool_input?.command ?? ''; } catch { /* malformed degrades to allow */ }
  const r = check(command);
  if (r.verdict !== 'wrong') process.exit(0);
  process.stderr.write(`${r.reason}\n`);
  process.exit(2);
}
