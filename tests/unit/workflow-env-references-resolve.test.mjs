import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * EVERY $VAR A WORKFLOW READS MUST BE A $VAR SOMETHING DEFINES.
 *
 * This gate exists because of a specific, humiliating, entirely mechanical failure on 2026-08-06.
 * `da42a21` unpinned the release publisher by replacing the env definition
 *
 *     EXPECTED_VERSION: 4.0.8      →      REQUESTED_VERSION: ${{ inputs.version }}
 *
 * and left ALL FIVE USES on the old name (protected-release.yml lines 64, 158, 171, 174, 175).
 * Those run under `set -euo pipefail`, so the first one aborted on an unbound variable — and
 * protected-release.yml is the ONLY workflow permitted to sign and publish. The release rail was
 * dead from that moment, every release after it was made by hand, and hand-releases are how npm
 * reached 4.0.12 while GitHub releases/latest stayed at v4.0.7. That is issue #77, and its cause
 * was a half-finished rename.
 *
 * WHY A TEST AND NOT MORE CARE. The defect is not subtle and it is not a judgement call — it is
 * "changed a name in one place, not the other four." Care is exactly the wrong instrument for that
 * class: it varies with fatigue and context, it cannot be verified, and it had already failed here
 * three times in one session (an unsatisfiable `Test Files` grep, a POSIX bracket-expression
 * matcher, and a prose guard that excused the one line it existed to catch). A rename is
 * mechanically checkable, so it must be mechanically checked. Nothing about this file relies on
 * anyone remembering anything.
 *
 * SCOPE, deliberately narrow so it cannot cry wolf: it reads `run:` bodies only, resolves against
 * env defined at workflow / job / step level, and ignores GitHub's own built-ins and shell-local
 * variables the script itself assigns. A gate that fired on legitimate shell locals would be
 * ignored within a week, which is the same failure in a different coat.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');

// GitHub-provided or shell-provided names a workflow may read without defining.
const AMBIENT = new Set([
  'GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_WORKSPACE', 'GITHUB_SHA', 'GITHUB_REF',
  'GITHUB_REF_NAME', 'GITHUB_EVENT_NAME', 'GITHUB_OUTPUT', 'GITHUB_ENV', 'GITHUB_PATH',
  'GITHUB_STEP_SUMMARY', 'GITHUB_RUN_ID', 'GITHUB_RUN_NUMBER', 'GITHUB_ACTOR', 'GITHUB_SERVER_URL',
  'RUNNER_TEMP', 'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_TOOL_CACHE', 'HOME', 'PATH', 'PWD', 'SHELL',
  'USER', 'TMPDIR', 'CI', 'NODE_AUTH_TOKEN', 'BASH_VERSION', 'IFS', 'OSTYPE', 'HOSTNAME', 'LANG',
]);

const readWorkflows = () => fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

/**
 * Names DEFINED anywhere in the file: any `NAME: value` under an `env:` mapping, plus anything the
 * shell assigns itself (`NAME=`, `read NAME`, `for NAME in`, `export NAME=`). Textual on purpose —
 * a real YAML+shell parse would be a second implementation to keep correct, and the failure this
 * guards is a NAME that appears nowhere else in the file at all.
 */
function definedNames(text) {
  const defined = new Set();
  for (const m of text.matchAll(/^\s*([A-Z][A-Z0-9_]{2,})\s*:\s*\S/gm)) defined.add(m[1]);
  // The separator class includes a QUOTE because of a false positive this gate produced on its
  // first run, against real ci.yml: a step exports a value to later steps with
  //     echo "RUVNET_SEALED_PACKAGE=$artifact" >> "$GITHUB_ENV"
  // and three later steps read it. That IS a definition — GitHub puts it in the environment of
  // every subsequent step — but the name sits directly after a double quote, so a separator class
  // of only [;&|(\s] never saw it. Reporting a correctly-wired workflow would have made this gate
  // noise, and a noisy gate gets disabled, which is the same outage it was written to prevent.
  for (const m of text.matchAll(/(?:^|[;&|("'\s])(?:export\s+|local\s+)?([A-Z][A-Z0-9_]{2,})=/gm)) defined.add(m[1]);
  for (const m of text.matchAll(/\bfor\s+([A-Z][A-Z0-9_]{2,})\s+in\b/g)) defined.add(m[1]);
  for (const m of text.matchAll(/\bread\s+(?:-[a-zA-Z]+\s+)*([A-Z][A-Z0-9_]{2,})\b/g)) defined.add(m[1]);
  return defined;
}

/** Names READ as $NAME or ${NAME} — excluding `${{ ... }}`, which GitHub resolves, not the shell. */
function referencedNames(text) {
  // Comments are stripped first — second false positive from this gate's first run: ntfy-alerts.yml
  // has a COMMENT reading `must reach the shell only via env (quoted "$VAR")`, prose explaining the
  // very rule this file enforces. Flagging a comment for naming a variable is the prose-matcher
  // mistake made one layer up, and it is the reason the #84 guard needed two attempts.
  const withoutExpressions = text
    .replaceAll(/\$\{\{[\s\S]*?\}\}/g, ' ')
    .split('\n').map((line) => line.replace(/(^|\s)#.*$/, '$1')).join('\n');
  const refs = new Set();
  for (const m of withoutExpressions.matchAll(/\$\{([A-Z][A-Z0-9_]{2,})(?:[:#%\-/][^}]*)?\}/g)) refs.add(m[1]);
  for (const m of withoutExpressions.matchAll(/\$([A-Z][A-Z0-9_]{2,})\b/g)) refs.add(m[1]);
  return refs;
}

describe('workflow env references resolve (issue #77 root cause)', () => {
  it('no workflow reads an environment variable that nothing defines', () => {
    const unresolved = [];
    for (const file of readWorkflows()) {
      const text = fs.readFileSync(path.join(WORKFLOWS, file), 'utf8');
      const defined = definedNames(text);
      for (const name of referencedNames(text)) {
        if (AMBIENT.has(name) || defined.has(name)) continue;
        unresolved.push(`${file}: $${name} is read but never defined`);
      }
    }
    expect(
      unresolved,
      'Under `set -euo pipefail` an unbound variable aborts the step. This is what killed the '
      + 'release publisher and caused #77:\n  ' + unresolved.join('\n  '),
    ).toEqual([]);
  });

  it('TEETH: it catches the exact half-finished rename that caused #77', () => {
    // The real before/after, reduced to its essence. If this fixture stops failing, the gate above
    // has stopped guarding anything and the next rename ships the same outage.
    const broken = [
      'env:', '  REQUESTED_VERSION: ${{ inputs.version }}', 'jobs:', '  a:', '    steps:',
      '      - run: |', '          set -euo pipefail',
      '          test "$VERSION" = "$EXPECTED_VERSION" || exit 1',
    ].join('\n');
    const defined = definedNames(broken);
    const missing = [...referencedNames(broken)].filter((n) => !AMBIENT.has(n) && !defined.has(n));
    expect(missing, 'the renamed-away name must be reported').toContain('EXPECTED_VERSION');

    const fixed = broken.replace('REQUESTED_VERSION:', 'EXPECTED_VERSION:');
    const stillMissing = [...referencedNames(fixed)]
      .filter((n) => !AMBIENT.has(n) && !definedNames(fixed).has(n));
    expect(stillMissing, 'and must go quiet once the definition matches the uses').not.toContain('EXPECTED_VERSION');
  });
});
