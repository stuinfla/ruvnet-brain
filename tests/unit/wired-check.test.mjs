// tests/unit/wired-check.test.mjs — the gate that had no test.
//
// Until 2026-07-22 nothing in tests/ referenced wired-check at all. It reported 62/62 wired, exit 0,
// and had never failed on this repo — which reads as health and was actually silence. Its allowlist
// was an uninjectable `const`, so it COULD NOT be tested against a known-bad input even in
// principle.
//
// ADR-037 §7: "A gate that has never failed has not been proven correct. It has been proven silent."
// Every test below is written to FAIL if the guard it covers is broken — the v1 predicate is used as
// the known-bad, so these tests would have failed against the shipped gate.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as wiredCheckModule from '../../scripts/wired-check.mjs';
import { audit, callerPattern, hookWiringAudit, lessonTriggerAudit } from '../../scripts/wired-check.mjs';

let repo;
const w = (rel, body) => {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};
const stateOf = (res, rel) => res.rows.find((r) => r.rel === rel)?.state;

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wired-check-')));
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('the predicate — a mention is not a caller', () => {
  it('FAILS a module referenced only by a comment (the v1 bug that wired 6 of 7 founding failures)', () => {
    w('scripts/widget.mjs', 'export const x = 1;\n');
    w('scripts/other.mjs', '// widget.mjs was written last week and is great\nexport const y = 2;\n');
    // v1 substring-matched the basename, so this comment made `widget` "wired".
    expect(stateOf(audit({ repo, standalone: [], held: {} }), 'scripts/widget.mjs')).toBe('unwired');
  });

  it('accepts a real import (quoted string)', () => {
    w('scripts/widget.mjs', 'export const x = 1;\n');
    w('scripts/other.mjs', "import { x } from './widget.mjs';\n");
    expect(stateOf(audit({ repo, standalone: [], held: {} }), 'scripts/widget.mjs')).toBe('wired');
  });

  // ADR-056, 2026-07-27. This assertion used to expect 'wired', and that belief is exactly how
  // scripts/doc-currency.mjs sat in the repo reported as wired while NOTHING ran it — it is absent
  // from pre-push, gate.sh, gates.mjs and every workflow, and its only "caller" was the package.json
  // line DEFINING it. Defining a script is not invoking it. The npm-script case is still a real way
  // in for a human, so it is not 'unwired' either; it is its own honest state.
  it('an npm script NOBODY runs is MANUAL, not wired (the doc-currency false green)', () => {
    w('scripts/widget.mjs', 'export const x = 1;\n');
    w('package.json', JSON.stringify({ scripts: { go: 'node scripts/widget.mjs' } }));
    const row = audit({ repo, standalone: [], held: {} }).rows.find((r) => r.rel === 'scripts/widget.mjs');
    expect(row.state).toBe('manual');
    expect(row.why).toMatch(/does not establish operational correctness/i);
    expect(row.why).not.toMatch(/built and correct|works|healthy/i);
  });

  it('an executable Dream manifest is a real caller', () => {
    w('scripts/widget.mjs', 'export const x = 1;\n');
    w('dream.config.json', JSON.stringify({ controlPlaneProbes: ['node scripts/widget.mjs --check'] }));
    expect(stateOf(audit({ repo, standalone: [], held: {} }), 'scripts/widget.mjs')).toBe('wired');
    w('dream.config.json', JSON.stringify({ controlPlaneProbes: [] }));
    expect(stateOf(audit({ repo, standalone: [], held: {} }), 'scripts/widget.mjs')).toBe('unwired');
  });

  it('an npm script a WORKFLOW runs is wired', () => {
    w('scripts/widget.mjs', 'export const x = 1;\n');
    w('package.json', JSON.stringify({ scripts: { go: 'node scripts/widget.mjs' } }));
    w('.github/workflows/ci.yml', 'jobs:\n  a:\n    steps:\n      - run: npm run go\n');
    expect(stateOf(audit({ repo, standalone: [], held: {} }), 'scripts/widget.mjs')).toBe('wired');
  });

  it('an npm script another COMPOSITE script runs is wired', () => {
    w('scripts/widget.mjs', 'export const x = 1;\n');
    w('package.json', JSON.stringify({ scripts: { go: 'node scripts/widget.mjs', all: 'npm run go && echo ok' } }));
    expect(stateOf(audit({ repo, standalone: [], held: {} }), 'scripts/widget.mjs')).toBe('wired');
  });

  it('an npm LIFECYCLE script is wired — npm itself runs it', () => {
    w('scripts/widget.mjs', 'export const x = 1;\n');
    w('package.json', JSON.stringify({ scripts: { prepare: 'node scripts/widget.mjs' } }));
    expect(stateOf(audit({ repo, standalone: [], held: {} }), 'scripts/widget.mjs')).toBe('wired');
  });

  // Both of these were introduced BY THE ADR-056 FIX ITSELF, in the JSDoc documenting it, and each
  // silently flipped the audited module back to 'wired'. Caught only by re-reading the row after the
  // change instead of trusting it. They are the block-comment form of the defect the whole file
  // already fixed twice (prose in v1; whole-line `//` usage examples in the 2026-07-23 regrade).
  it('an invocation-shaped path in a JSDoc BODY line is NOT a caller', () => {
    w('scripts/widget.mjs', 'export const x = 1;\n');
    w('scripts/other.mjs', '/**\n * Run it: node scripts/widget.mjs --flag\n */\nexport const y = 2;\n');
    expect(stateOf(audit({ repo, standalone: [], held: {} }), 'scripts/widget.mjs')).toBe('unwired');
  });

  it('an `npm run <script>` mention in a JSDoc BODY line does not make it automated', () => {
    w('scripts/widget.mjs', 'export const x = 1;\n');
    w('package.json', JSON.stringify({ scripts: { go: 'node scripts/widget.mjs' } }));
    w('scripts/other.mjs', '/**\n * A human types: npm run go\n */\nexport const y = 2;\n');
    expect(stateOf(audit({ repo, standalone: [], held: {} }), 'scripts/widget.mjs')).toBe('manual');
  });

  // git requires hooks to be named exactly `pre-push` — extensionless — so the extension filter
  // excluded this repo's primary ship gate from the caller set. Anything wired ONLY from pre-push
  // read as unwired, which is how the currency check still reported `manual` immediately after being
  // wired into it.
  it('an EXTENSIONLESS git hook counts as a caller', () => {
    w('scripts/widget.mjs', 'export const x = 1;\n');
    w('scripts/git-hooks/pre-push', '#!/bin/sh\nnode "$ROOT/scripts/widget.mjs" --check\n');
    expect(stateOf(audit({ repo, standalone: [], held: {} }), 'scripts/widget.mjs')).toBe('wired');
  });

  it('an extensionless file OUTSIDE git-hooks is still not scanned (scope stays narrow)', () => {
    w('scripts/widget.mjs', 'export const x = 1;\n');
    w('scripts/NOTES', 'node scripts/widget.mjs\n');
    expect(stateOf(audit({ repo, standalone: [], held: {} }), 'scripts/widget.mjs')).toBe('unwired');
  });

  it('a GENERATOR method (`*gen()`) is still real code, not a stripped JSDoc line', () => {
    w('scripts/widget.mjs', 'export const x = 1;\n');
    w('scripts/other.mjs', "const o = {\n  *gen() { return import('./widget.mjs'); }\n};\nexport default o;\n");
    expect(stateOf(audit({ repo, standalone: [], held: {} }), 'scripts/widget.mjs')).toBe('wired');
  });

  it('accepts a YAML workflow `run:` — the case ADR-037 draft 1 would have missed', () => {
    // Draft 1 said "add .github/ to the search roots" but not `*.yml`; every workflow is YAML, so
    // its own fix would have matched exactly zero workflow files.
    w('scripts/widget.mjs', 'export const x = 1;\n');
    w('.github/workflows/ci.yml', 'jobs:\n  a:\n    steps:\n      - run: node scripts/widget.mjs\n');
    expect(stateOf(audit({ repo, standalone: [], held: {} }), 'scripts/widget.mjs')).toBe('wired');
  });

  it('does NOT match a substring of a longer word (prove/proven, version/"version")', () => {
    w('scripts/prove.mjs', 'export const x = 1;\n');
    w('scripts/other.mjs', '// this is proven behaviour, approved and improved\n');
    expect(stateOf(audit({ repo, standalone: [], held: {} }), 'scripts/prove.mjs')).toBe('unwired');
  });

  // Live in this repo (2026-09-01): `scripts/gates.mjs` was reported "wired" partly via two PHANTOM
  // callers whose only real reference was to the unrelated `scripts/corpus-aggregates.mjs` — which
  // simply happens to END with the characters "gates.mjs" ("aggre-GATES.mjs"). Same shape for
  // `version.mjs` inside `set-version.mjs`/`sync-version.mjs`. The prior "prove/proven" test above
  // only proves prose (no quotes) is excluded; it says nothing about one REAL, quoted filename
  // swallowing another's inside the invocation-shaped branches themselves.
  it('a quoted reference to a DIFFERENT, longer filename does not wire a module whose name is its trailing substring', () => {
    w('scripts/gates.mjs', 'export const g = 1;\n');
    w('scripts/corpus-aggregates.mjs', 'export const rebuildCorpusAggregates = () => {};\n');
    w('scripts/consumer.mjs', "import { rebuildCorpusAggregates } from './corpus-aggregates.mjs';\n");
    const res = audit({ repo, standalone: [], held: {} });
    expect(stateOf(res, 'scripts/gates.mjs')).toBe('unwired');
    // The unrelated module must still be correctly wired — this is a precision fix, not a new hole.
    expect(stateOf(res, 'scripts/corpus-aggregates.mjs')).toBe('wired');
  });

  it('still wires a module reached through a real path-prefixed reference sharing the same tail', () => {
    w('scripts/gates.mjs', 'export const g = 1;\n');
    w('scripts/consumer.mjs', "import { g } from './gates.mjs';\n");
    expect(stateOf(audit({ repo, standalone: [], held: {} }), 'scripts/gates.mjs')).toBe('wired');
  });

  // The regrade (2026-07-23) found correction-detect-measure.mjs "wired" by a `node scripts/…measure.mjs`
  // usage example living in a header comment — the invocation branch of callerPattern matched prose.
  it('an INVOCATION-shaped usage example in a whole-line // comment is NOT a caller', () => {
    w('scripts/widget.mjs', 'export const x = 1;\n');
    w('scripts/other.mjs', '// run it by hand: node scripts/widget.mjs --flag\nexport const y = 2;\n');
    expect(stateOf(audit({ repo, standalone: [], held: {} }), 'scripts/widget.mjs')).toBe('unwired');
  });

  it('a backticked path inside a whole-line // comment is NOT a caller', () => {
    w('scripts/widget.mjs', 'export const x = 1;\n');
    w('scripts/other.mjs', '// see `scripts/widget.mjs` for the details\nexport const y = 2;\n');
    expect(stateOf(audit({ repo, standalone: [], held: {} }), 'scripts/widget.mjs')).toBe('unwired');
  });

  it('a REAL caller between a // that contains /* and a later */ STILL counts — the over-strip regression', () => {
    // The exact bug an early comment-strip introduced and this guards against forever: a global
    // /*…*/ regex span-matched from the `/*` sitting inside a line-comment across real code to the next
    // `*/`, eating a genuine caller (it hid sign-bundle.mjs's execFileSync in self-update.mjs). The
    // line-scoped strip blanks only the whole-line // comment and leaves the invocation intact.
    w('scripts/widget.mjs', 'export const x = 1;\n');
    w('scripts/caller.mjs',
      '// turn this off /* flaky, see the notes below\n'
      + "execFileSync(NODE, ['scripts/widget.mjs']);\n"
      + 'const z = 1; /* a real block comment */\n');
    expect(stateOf(audit({ repo, standalone: [], held: {} }), 'scripts/widget.mjs')).toBe('wired');
  });
});

describe('a test is not a caller — the exclusion that is the entire point', () => {
  it('ignores tests/ directories', () => {
    w('scripts/widget.mjs', 'export const x = 1;\n');
    w('tests/unit/widget.test.mjs', "import { x } from '../../scripts/widget.mjs';\n");
    expect(stateOf(audit({ repo, standalone: [], held: {} }), 'scripts/widget.mjs')).toBe('unwired');
  });

  it('ignores a *.test.mjs sitting NEXT TO the source — in-tree v1 bug', () => {
    // scripts/console-engine.test.mjs counted as a caller under v1: the filter checked for a
    // `/tests/` path, never the filename. A test beside its source silently wired it.
    w('scripts/widget.mjs', 'export const x = 1;\n');
    w('scripts/widget.test.mjs', "import { x } from './widget.mjs';\n");
    expect(stateOf(audit({ repo, standalone: [], held: {} }), 'scripts/widget.mjs')).toBe('unwired');
  });

  it('does not put the test file itself in the inventory', () => {
    w('scripts/widget.test.mjs', 'export const x = 1;\n');
    expect(audit({ repo, standalone: [], held: {} }).rows.some((r) => r.rel.includes('.test.'))).toBe(false);
  });
});

describe('the inventory — invisible is worse than unwired', () => {
  it('audits plugin/scripts/*.sh — founding failure #4 (anticipate.sh) was structurally invisible to v1', () => {
    w('plugin/scripts/anticipate.sh', '#!/usr/bin/env bash\necho hi\n');
    const res = audit({ repo, standalone: [], held: {} });
    expect(stateOf(res, 'plugin/scripts/anticipate.sh')).toBe('unwired');
  });

  it('audits nested scripts/*/ and bin/', () => {
    w('scripts/proxy/thing.sh', '#!/usr/bin/env bash\n');
    w('bin/install.mjs', 'export const i = 1;\n');
    const res = audit({ repo, standalone: [], held: {} });
    expect(stateOf(res, 'scripts/proxy/thing.sh')).toBe('unwired');
    expect(stateOf(res, 'bin/install.mjs')).toBe('unwired');
  });

  it('counts every module in exactly one state (DDD-0010 WiringAudit invariant)', () => {
    w('scripts/a.mjs', 'x');
    w('scripts/b.mjs', 'x');
    w('scripts/c.mjs', 'x');
    const res = audit({ repo, standalone: [['b', 'human runs it']], held: { c: 'held' } });
    const sum = ['wired', 'exempt', 'held', 'unwired']
      .reduce((n, s) => n + res.rows.filter((r) => r.state === s).length, 0);
    expect(sum).toBe(res.inventory);
    expect(res.inventory).toBe(3);
  });
});

describe('exemptions', () => {
  it('detects a duplicate name (v1 had memory-doctor twice; object last-wins hid it)', () => {
    w('scripts/widget.mjs', 'x');
    const res = audit({ repo, standalone: [['widget', 'first'], ['widget', 'second']], held: {} });
    expect(res.dupes).toContain('widget');
  });

  it('an exempt module is reported as exempt, not silently skipped', () => {
    // v1 dropped exemptions from the audit entirely, so 3 false reasons rotted unseen.
    w('scripts/widget.mjs', 'x');
    const res = audit({ repo, standalone: [['widget', 'launchd nightly']], held: {} });
    const row = res.rows.find((r) => r.rel === 'scripts/widget.mjs');
    expect(row.state).toBe('exempt');
    expect(row.why).toBe('launchd nightly');
  });
});

describe('callerPattern', () => {
  it('is anchored to the filename, not the basename', () => {
    expect(callerPattern('widget.mjs').test("import x from './widget.mjs'")).toBe(true);
    expect(callerPattern('widget.mjs').test('the widget module')).toBe(false);
    expect(callerPattern('widget.mjs').test('run: node scripts/widget.mjs')).toBe(true);
  });
});

describe('operational export wiring', () => {
  it('does not count definitions, imports, re-exports, or an unreachable export-to-export bridge as operation', () => {
    expect(wiredCheckModule.operationalExportAudit).toBeTypeOf('function');
    w('scripts/receipt.mjs', 'export async function materializeReceipt() { return true; }\n');
    w('scripts/bridge.mjs', "import { materializeReceipt } from './receipt.mjs';\n"
      + 'export async function runReceiptStage() { return materializeReceipt(); }\n');
    w('scripts/facade.mjs', "export { materializeReceipt } from './receipt.mjs';\n");
    const required = [
      { rel: 'scripts/receipt.mjs', symbol: 'materializeReceipt' },
      { rel: 'scripts/bridge.mjs', symbol: 'runReceiptStage' },
    ];

    let rows = wiredCheckModule.operationalExportAudit({ repo, required }).rows;
    expect(rows.find((row) => row.symbol === 'materializeReceipt')).toMatchObject({
      state: 'wired', callers: ['scripts/bridge.mjs'],
    });
    expect(rows.find((row) => row.symbol === 'runReceiptStage')).toMatchObject({ state: 'unwired', callers: [] });

    w('scripts/main.mjs', "import { runReceiptStage } from './bridge.mjs';\nawait runReceiptStage();\n");
    rows = wiredCheckModule.operationalExportAudit({ repo, required }).rows;
    expect(rows.every((row) => row.state === 'wired')).toBe(true);
  });
});

// ── CHECK B: HOOK WIRING — a hook is not a module with an in-repo caller ──────────────────────────
//
// route-dispatch.sh already had a REAL caller under the module predicate above (hook-shim.mjs quotes
// its filename in TABLE) — so the module check alone would never have proven the real gap this class
// exists to catch: is the hook actually reachable from a live Claude Code config (hooks.json, this
// repo's .claude/settings.json, or the user's real ~/.claude/settings.json), not merely mentioned
// somewhere. Every test here uses a synthetic ~/.claude/settings.json stand-in (`homeSettingsFile`)
// so it never touches the real machine file.
describe('hook wiring — reachable from a real hook config, not merely mentioned', () => {
  const NO_HOME = () => path.join(repo, 'no-such-home-settings.json');

  it('FAILS a hook-intended script wired to nothing at all', () => {
    w('plugin/scripts/my-gate.sh', '#!/bin/bash\n# my-gate.sh — PreToolUse gate on Bash. Blocks a bad thing.\necho hi\n');
    const res = hookWiringAudit({ repo, homeSettingsFile: NO_HOME(), held: {} });
    expect(res.rows.find((r) => r.file === 'my-gate.sh').state).toBe('unwired');
  });

  it('WIRES a hook named directly in plugin/hooks/hooks.json', () => {
    w('plugin/scripts/my-gate.sh', '#!/bin/bash\n# my-gate.sh — PreToolUse gate on Bash.\necho hi\n');
    w('plugin/hooks/hooks.json', JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command',
        command: 'bash "${CLAUDE_PLUGIN_ROOT}/scripts/my-gate.sh"' }] }] },
    }));
    const res = hookWiringAudit({ repo, homeSettingsFile: NO_HOME(), held: {} });
    expect(res.rows.find((r) => r.file === 'my-gate.sh').state).toBe('wired');
  });

  it('resolves hook-shim.mjs\'s id-based TABLE indirection — the exact route-dispatch.sh shape', () => {
    // hooks.json never spells "my-gate.sh" — only the bare id "my-id" after hook-shim.mjs, exactly
    // like the real "route-dispatch" id in this repo's own hooks.json. Proving this resolves is the
    // whole point: a naive "does hooks.json contain this filename" check would miss it.
    w('plugin/scripts/my-gate.sh', '#!/bin/bash\n# my-gate.sh — PreToolUse gate on Bash.\necho hi\n');
    w('plugin/scripts/hook-shim.mjs', "const TABLE = {\n"
      + "  'my-id': { file: 'my-gate.sh', interpreter: 'bash', mode: 'blocking' },\n};\n");
    w('plugin/hooks/hooks.json', JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command',
        command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" my-id' }] }] },
    }));
    const res = hookWiringAudit({ repo, homeSettingsFile: NO_HOME(), held: {} });
    const row = res.rows.find((r) => r.file === 'my-gate.sh');
    expect(row.state).toBe('wired');
    expect(row.sources.join(' ')).toMatch(/hook-shim id "my-id"/);
  });

  it('resolves Codex\'s installed Stable Spine wrapper and its adapter spawn', () => {
    w('plugin/scripts/codex-hook-wrapper.mjs', "import path from 'node:path';\n"
      + "const adapter = path.join(root, 'scripts', 'codex-hook-adapter.mjs');\n");
    w('plugin/scripts/codex-hook-adapter.mjs', '#!/usr/bin/env node\n'
      + '/** codex-hook-adapter — the PostToolUse hook host boundary. */\n');
    w('plugin/scripts/hook-shim.mjs', "const TABLE = {\n"
      + "  'my-id': { file: 'my-gate.sh', interpreter: 'bash', mode: 'blocking' },\n};\n");
    w('plugin/hooks/codex-hooks.json', JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command',
        command: 'node -e "const w=p.join(b,\'codex-hook.mjs\')" 4500 my-id' }] }] },
    }));
    w('bin/install.mjs', "const codexHookWrapperPath = (codexDir) => path.join(codexDir, 'codex-hook.mjs');\n"
      + "function wire({ hookWrapperSource = path.join(root, 'plugin', 'scripts', 'codex-hook-wrapper.mjs') }) {\n"
      + '  atomicReplace(hookWrapperPath, (tmp) => fs.copyFileSync(hookWrapperSource, tmp));\n}\n');

    const res = hookWiringAudit({ repo, homeSettingsFile: NO_HOME(), held: {} });
    const wrapper = res.rows.find((r) => r.file === 'codex-hook-wrapper.mjs');
    const adapter = res.rows.find((r) => r.file === 'codex-hook-adapter.mjs');
    expect(wrapper).toMatchObject({ state: 'wired' });
    expect(wrapper.sources.join(' ')).toMatch(/codex-hooks\.json.*Stable Spine copy/i);
    expect(adapter).toMatchObject({ state: 'wired' });
    expect(adapter.sources).toContain('spawned by plugin/scripts/codex-hook-wrapper.mjs');
  });

  it('WIRES a hook found ONLY in ~/.claude/settings.json — the real route-dispatch.sh fix, reproduced', () => {
    // Nothing in the repo's own hooks.json or .claude/settings.json mentions this file — only the
    // (synthetic) home settings.json does, exactly what Stuart did for route-dispatch.sh.
    w('plugin/scripts/my-gate.sh', '#!/bin/bash\n# my-gate.sh — PreToolUse gate on subagent dispatch.\necho hi\n');
    const home = path.join(repo, 'fake-home-settings.json');
    w('fake-home-settings.json', JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Task', hooks: [{ type: 'command',
        command: '/bin/bash "/Users/x/.claude/plugins/marketplaces/ruvnet-brain/plugin/scripts/my-gate.sh"' }] }] },
    }));
    const res = hookWiringAudit({ repo, homeSettingsFile: home, held: {} });
    const row = res.rows.find((r) => r.file === 'my-gate.sh');
    expect(row.state).toBe('wired');
    expect(row.sources.join(' ')).toMatch(/~\/\.claude\/settings\.json/);
  });

  it('does NOT false-positive on a helper whose header wording mimics a self-declared hook '
    + '(hook-input.mjs\'s real phrasing: "every PreToolUse gate uses")', () => {
    w('plugin/scripts/hook-input.mjs', '#!/usr/bin/env node\n'
      + '// the ONE parser every PreToolUse gate uses to read the payload\n');
    const res = hookWiringAudit({ repo, homeSettingsFile: NO_HOME(), held: {} });
    // Excluded from the census entirely — not reported wired, not reported unwired, not reported at all.
    expect(res.rows.find((r) => r.file === 'hook-input.mjs')).toBeUndefined();
  });

  it('resolves the transitive spawn hop (unprompted-runtime.mjs -> anticipate.sh), the shape this '
    + 'repo uses today for the unprompted-speech chokepoint', () => {
    w('plugin/scripts/anticipate.sh', '#!/bin/sh\n# anticipate.sh — a UserPromptSubmit hook that reads the prompt.\necho hi\n');
    w('plugin/scripts/unprompted-runtime.mjs', "import path from 'node:path';\n"
      + "const ANTICIPATE = { argv: ['/bin/bash', path.join('SCRIPTS_DIR', 'anticipate.sh')] };\n");
    w('plugin/hooks/hooks.json', JSON.stringify({
      hooks: { UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command',
        command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/unprompted-runtime.mjs" UserPromptSubmit' }] }] },
    }));
    const res = hookWiringAudit({ repo, homeSettingsFile: NO_HOME(), held: {} });
    const row = res.rows.find((r) => r.file === 'anticipate.sh');
    expect(row.state).toBe('wired');
    expect(row.sources.join(' ')).toMatch(/spawned by plugin\/scripts\/unprompted-runtime\.mjs/);
    // The runtime itself is plumbing, not a hook body — never part of the census either.
    expect(res.rows.find((r) => r.file === 'unprompted-runtime.mjs')).toBeUndefined();
  });

  it('a genuinely unwired hook reports HELD (not unwired, not build-breaking) when explicitly named', () => {
    w('plugin/scripts/my-gate.sh', '#!/bin/bash\n# my-gate.sh — PreToolUse gate on Bash.\necho hi\n');
    const res = hookWiringAudit({
      repo, homeSettingsFile: NO_HOME(), held: { 'my-gate.sh': 'accepted pre-existing gap, owner\'s call' },
    });
    expect(res.rows.find((r) => r.file === 'my-gate.sh').state).toBe('held');
  });
});

// ── CHECK C: LESSON-TRIGGER WIRING — a ratified trigger nothing requests is inert ─────────────────
describe('lesson-trigger wiring — inert is a trigger no event in lesson-hooks.sh requests', () => {
  const lesson = (id, trigger, status = 'ratified') => ({
    id,
    statement: 'a statement long enough to pass the schema gate',
    trigger,
    enforcement: 'checklist',
    evidence: ['seen at least once'],
    origin: 'user-stated',
    status,
  });
  const caseBlock = (mapping) => '#!/bin/bash\ncase "$EVENT" in\n'
    + Object.entries(mapping).map(([evt, trig]) => `  ${evt}) TRIGGERS="${trig}"; CLAUDE_EVENT="X" ;;\n`).join('')
    + '  *) exit 0 ;;\nesac\n';

  it('FLAGS a ratified lesson whose trigger NO case branch requests — the L16 shape before its fix', () => {
    w('plugin/scripts/lesson-hooks.sh', caseBlock({ 'PreToolUse-write': 'write-code' }));
    const lessonsFile = path.join(repo, 'lessons.json');
    w('lessons.json', JSON.stringify({ lessons: [lesson('L-inert', 'relay-number')] }));
    const res = lessonTriggerAudit({ repo, lessonsFile });
    expect(res.inert.map((l) => l.id)).toContain('L-inert');
  });

  it('does NOT flag a ratified lesson whose trigger a case branch DOES request — the L16 shape after its fix', () => {
    w('plugin/scripts/lesson-hooks.sh', caseBlock({ UserPromptSubmit: 'choose-work' }));
    const lessonsFile = path.join(repo, 'lessons-wired.json');
    w('lessons-wired.json', JSON.stringify({ lessons: [lesson('L16-parallel-by-default', 'choose-work')] }));
    const res = lessonTriggerAudit({ repo, lessonsFile });
    expect(res.inert.map((l) => l.id)).not.toContain('L16-parallel-by-default');
    expect(res.requested).toContain('choose-work');
  });

  it('ignores a CANDIDATE lesson even with an unrequested trigger — only ratified/active lessons count', () => {
    w('plugin/scripts/lesson-hooks.sh', caseBlock({}));
    const lessonsFile = path.join(repo, 'lessons-candidate.json');
    w('lessons-candidate.json', JSON.stringify({ lessons: [lesson('L-pending', 'relay-number', 'candidate')] }));
    const res = lessonTriggerAudit({ repo, lessonsFile });
    expect(res.checked).toBe(0);
    expect(res.inert.map((l) => l.id)).not.toContain('L-pending');
  });

  it('degrades gracefully when the lesson store is absent — a fresh machine, not a failure', () => {
    w('plugin/scripts/lesson-hooks.sh', caseBlock({}));
    const res = lessonTriggerAudit({ repo, lessonsFile: path.join(repo, 'does-not-exist.json') });
    expect(res.checked).toBe(0);
    expect(res.inert).toEqual([]);
  });

  it('does NOT flag a trigger requested only dynamically — the real `ship` shape, no dead case label present', () => {
    // No static `TRIGGERS="ship"` case label anywhere — as if the dead PreToolUse-push branch had
    // already been cleaned up. `ship` reaches the gate ONLY via the dynamic conditional append, same
    // as production lesson-hooks.sh really does today.
    w('plugin/scripts/lesson-hooks.sh', '#!/bin/bash\ncase "$EVENT" in\n'
      + '  PreToolUse-bash) TRIGGERS="mutate-machine"; CLAUDE_EVENT="X" ;;\n'
      + '  *) exit 0 ;;\n'
      + 'esac\n'
      + 'ARGS=()\n'
      + 'if printf \'%s\' "$CMD_EXEC" | grep -qE \'\\bgit\\b[^|;&]*\\bpush\\b\'; then\n'
      + '  ARGS+=(--trigger ship)\n'
      + 'fi\n');
    const lessonsFile = path.join(repo, 'lessons-ship.json');
    w('lessons-ship.json', JSON.stringify({ lessons: [lesson('G-remote-ci-gates-shipping', 'ship')] }));
    const res = lessonTriggerAudit({ repo, lessonsFile });
    expect(res.requested).toContain('ship');
    expect(res.inert.map((l) => l.id)).not.toContain('G-remote-ci-gates-shipping');
  });

  it('the generic per-trigger dispatch loop (`ARGS+=(--trigger "$t")`) is a variable, not a literal — never pollutes `requested`', () => {
    // Mirrors production lesson-hooks.sh's actual dispatch loop: `for t in $TRIGGERS; do
    // ARGS+=(--trigger "$t"); done`. `$t` is a shell variable reference, not a trigger name — the
    // dynamic-append regex must not capture it as if it were a literal token.
    w('plugin/scripts/lesson-hooks.sh', '#!/bin/bash\ncase "$EVENT" in\n'
      + '  *) exit 0 ;;\n'
      + 'esac\n'
      + 'ARGS=()\n'
      + 'for t in $TRIGGERS; do ARGS+=(--trigger "$t"); done\n');
    const lessonsFile = path.join(repo, 'lessons-none.json');
    w('lessons-none.json', JSON.stringify({ lessons: [lesson('L-unrelated', 'relay-number')] }));
    const res = lessonTriggerAudit({ repo, lessonsFile });
    expect(res.requested).not.toContain('t');
    expect(res.requested).not.toContain('$t');
    expect(res.requested).toEqual([]);
  });
});
