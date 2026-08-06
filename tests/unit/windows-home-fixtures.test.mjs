import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Windows fixture isolation — a REGRESSION PIN over a MEASURED set, deliberately not a blanket rule.
//
// os.homedir() reads USERPROFILE on Windows and ignores HOME entirely. A suite that redirects only
// HOME therefore isolates nothing on the windows-unit lane: the code under test reads the runner's
// real profile, and the suite either goes red for a false reason or — worse — stays green while
// writing into that profile. 25cda46 fixed the first instance (dispatch-gate-wiring) and recorded
// the class without bulk-patching it, because "a blanket rewrite is what blinded a security scanner
// two days ago".
//
// WHY THIS LIST IS HARDCODED, and not a general "sets HOME ⇒ must set USERPROFILE" lint:
// that lint is measurably wrong. 25 suites under tests/unit set HOME without USERPROFILE; only
// these 6 are affected, so the general rule would fire 19 false positives and re-open the exact
// blanket-rewrite hazard above. Nor can the affected set be derived statically: following imports
// reaches os.homedir() for just 6 of the 25, and 18 of them reach it ONLY through a spawned child
// process, which no import graph can see. The membership below was established by RUNNING each
// suite with os.homedir() forced to Windows semantics (resolve from USERPROFILE) and recording
// both the verdict and every file the run left in the emulated profile:
//
//   suite                          before fix                              after
//   ruflo-bin-resolution           RED  2/13, 19 divergent homedir reads   green, 0 divergent
//   health-repair-flush-learning   RED  3/15, 18 divergent reads           green, 0 divergent
//   hook-hardening                 RED, + 83 files into the real profile   green, 0 files
//   star-ask-once                  GREEN, + 81 files into the real profile green, 0 files
//   hook-battery                   GREEN, + detached-jobs.jsonl            green, 0 files
//   token-meter                    GREEN, + .grounded-once                 green, 0 files
//
// TO EXTEND: do not add a suite here on suspicion. Re-run that measurement, and add it only if the
// suite is observed to diverge. A name in this list that was never measured is a claim, not a test.
// ════════════════════════════════════════════════════════════════════════════════════════════════
const MEASURED_AT_RISK = [
  'tests/unit/ruflo-bin-resolution.test.mjs',
  'tests/unit/health-repair-flush-learning.test.mjs',
  'tests/unit/hook-hardening.test.mjs',
  'tests/unit/star-ask-once.test.mjs',
  'tests/unit/hook-battery.test.mjs',
  'tests/unit/token-meter.test.mjs',
];

// `HOME:` bound to some fixture expression. The lookbehind is what keeps XDG_CACHE_HOME,
// RUVNET_BRAIN_HOME and CODEX_HOME — all legitimately HOME-suffixed and all irrelevant here — from
// being read as the account home.
const HOME_BINDING = /(?<![A-Z_])HOME:\s*([A-Za-z_$][\w$]*)/g;

/**
 * Blank out comments and string bodies, preserving offsets, so the match above sees CODE ONLY.
 *
 * This is not defensive tidiness — it is the guard's own bug report. Draft 1 fired on hook-battery's
 * comment "…which is exactly when this deletes HOME: measured", and draft 2 on its test NAME,
 * `it('runs twice with the same HOME: sane greeting both times…')`. Both parse as HOME bound to a
 * variable. A guard that fires on English teaches people to reword their prose around it, and a
 * noisy guard is worse than no guard — so it reads the code and nothing else.
 */
function codeOnly(source) {
  const out = [...source];
  let i = 0;
  const blank = (from, to) => { for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' '; };
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') { const end = source.indexOf('\n', i); blank(i, end === -1 ? source.length : end); i = end === -1 ? source.length : end; continue; }
    if (two === '/*') { const end = source.indexOf('*/', i + 2); const stop = end === -1 ? source.length : end + 2; blank(i, stop); i = stop; continue; }
    const q = source[i];
    if (q === "'" || q === '"' || q === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== q) { j += source[j] === '\\' ? 2 : 1; }
      blank(i + 1, Math.min(j, source.length));
      i = Math.min(j + 1, source.length);
      continue;
    }
    i += 1;
  }
  return out.join('');
}

describe('windows fixture isolation: HOME without USERPROFILE isolates nothing', () => {
  it.each(MEASURED_AT_RISK)('%s redirects USERPROFILE everywhere it redirects HOME', (rel) => {
    const source = codeOnly(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    const bound = [...source.matchAll(HOME_BINDING)].map((m) => m[1]);

    // A suite that stopped setting HOME entirely has been restructured; the measurement above no
    // longer describes it, so failing here is correct — re-measure rather than delete the entry.
    expect(bound.length, `${rel} no longer binds HOME to a fixture — re-measure before editing this list`)
      .toBeGreaterThan(0);

    // COUNTS, not mere presence. token-meter alone builds five separate env literals off the same
    // `tmpHome`; an existence check would let a sixth be added with HOME and no USERPROFILE and stay
    // green, which is the same silent-hole shape this file exists to close.
    for (const value of new Set(bound)) {
      const homes = bound.filter((v) => v === value).length;
      const profiles = (source.match(new RegExp(`USERPROFILE:\\s*${value}\\b`, 'g')) || []).length;
      expect(
        profiles,
        `${rel} binds HOME: ${value} ${homes}x but USERPROFILE: ${value} only ${profiles}x — on Windows `
        + 'os.homedir() ignores HOME, so any env literal missing USERPROFILE redirects nothing and the '
        + 'run reads (and writes) the real user profile',
      ).toBeGreaterThanOrEqual(homes);
    }
  });
});
