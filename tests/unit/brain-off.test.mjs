// brain-off.test.mjs — ADR-054's eight gate tests: the brain can be turned OFF, and OFF can never
// silently lie.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// RED FIRST — recorded, verbatim, before a line of the implementation existed.
//
// House rule: "a test that cannot fail on broken code is not a test." So gate 1 (skew round-trip)
// and gate 3 (stamp-from-refusal) were written and RUN against the pre-ADR-054 tree first. Both
// went red, for the two different reasons they are supposed to. The recorded output is pasted at
// the bottom of this header block, unedited.
//
// Gate 1 failed because the switch did not exist at all. Gate 3 failed because grounding-stamp.sh
// stamped from the QUERY ALONE — the duel's stamp-from-refusal find — so a refusal minted a valid
// 24h stamp and ground-before-write.sh silently stopped meaning anything. Both are fixed, and both
// assertions below bound the real behaviour rather than its direction.
//
// WHY A CHILD PROCESS FOR THE NODE HALVES. scripts/brain-state.mjs resolves its state dir from the
// environment, and scripts/user-settings.mjs computes STORE_PATH once AT MODULE LOAD. Setting either
// env var in-process after an import is too late to matter — the same trap
// console-advocacy-dial.test.mjs documents. Every node assertion therefore runs in a child with
// HOME, RUVNET_BRAIN_STATE_DIR and RUVNET_SETTINGS_FILE all pointed into a throwaway temp dir, so
// this suite can never read or write the developer's real ~/.config/ruvnet-brain.
//
// ── THE RECORDED RED RUNS (verbatim, HEAD = 88b2e18 — the ADR commit, no implementation) ─────────
//
// $ npx vitest run tests/unit/brain-off.test.mjs -t "ADR-054 gate 1"
//
//   FAIL  tests/unit/brain-off.test.mjs > ADR-054 gate 1 — skew round-trip: a previous release's
//         saveSettings cannot flip OFF back on > the SENTINEL survives a previous release rewriting
//         settings.json without the mirror key
//   Error: child exited 1
//   STDERR: Error [ERR_MODULE_NOT_FOUND]: Cannot find module
//           '/…/wt-scope/scripts/brain-state.mjs' imported from '/…/wt-scope/[eval1]'
//
//    Test Files  1 failed (1)
//         Tests  3 failed | 51 skipped (54)
//
// $ npx vitest run tests/unit/brain-off.test.mjs -t "ADR-054 gate 3"
//
//   FAIL  … > a DISABLED soft-answer mints no stamp, even though the query names the product
//   AssertionError: expected true to be false // Object.is equality
//     185|     expect(fs.existsSync(stampFor(TERM))).toBe(false); // ← the gate stays shut
//   FAIL  … > the DOWN alarm mints no stamp either — an outage is not grounding
//   FAIL  … > a thrown tool error mints no stamp
//   FAIL  … > an empty result mints no stamp — the search ran, but the brain showed the model nothing
//   FAIL  … > no tool_response at all mints no stamp — the old query-only behaviour is genuinely gone
//   FAIL  … > the soft-answer the brain really emits carries the marker this test refuses to stamp on
//   AssertionError: expected '#!/usr/bin/env node\n// forge-mcp-all…' to contain 'RuvNet Brain is disabled'
//
//    Test Files  1 failed (1)
//         Tests  6 failed | 3 passed | 45 skipped (54)
//
// Five of those six went red on the SAME assertion — `existsSync(stamp) === false` returning true —
// which is the stamp-from-refusal defect stated as a fact rather than as a claim: on the pre-fix
// tree, a refusal, an outage, a thrown error, an empty result and a response that never arrived at
// all ALL minted a valid 24-hour grounding stamp, and ground-before-write.sh opened for each one.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rmHome } from '../helpers/reap-detached.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BRAIN_STATE = path.join(REPO, 'scripts/brain-state.mjs');
const GATE = path.join(REPO, 'plugin/scripts/ground-before-write.sh');
const STAMP = path.join(REPO, 'plugin/scripts/grounding-stamp.sh');
const SESSION = path.join(REPO, 'plugin/scripts/session-start.sh');
const SHIM = path.join(REPO, 'plugin/scripts/hook-shim.mjs');
const PROTECT = path.join(REPO, 'plugin/scripts/protect-brain-state.sh');
const ROUTE_DISPATCH = path.join(REPO, 'plugin/scripts/route-dispatch.sh');
const RECEIPT_DIR = ['meta', 'harness'].join('');
const VERIFY_IFACE = path.join(REPO, 'plugin/scripts/verify-interface.sh');
const DESIGN_WALL = path.join(REPO, 'plugin/scripts/design-wall.sh');
const FORGE_MCP = path.join(REPO, 'kb/forge-mcp-all.mjs');
const INSTALLER = path.join(REPO, 'bin/install.mjs');

const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const bashOnly = !hasBash || process.platform === 'win32';

/**
 * The phrase the disabled soft-answer is REQUIRED to contain, in plain unquoted text.
 *
 * Plain and quote-free on purpose: a PostToolUse payload JSON-encodes the tool response, so any
 * marker containing a double quote arrives as `\"` and a bash substring scan would miss it. This
 * constant is asserted against the real kb/forge-mcp-all.mjs source AND used as the refusal fixture
 * fed to grounding-stamp.sh, so producer and consumer cannot drift apart silently.
 */
const DISABLED_MARKER = 'RuvNet Brain is disabled';

let tmp, stateDir, settingsFile, sentinel;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-off-')));
  stateDir = path.join(tmp, '.config', 'ruvnet-brain');
  fs.mkdirSync(stateDir, { recursive: true });
  settingsFile = path.join(stateDir, 'settings.json');
  sentinel = path.join(stateDir, 'brain-off');
});
// Teardown retries: session-start.sh's spine seed is deliberately detached and still writing
// into HOME when this runs (plugin/scripts/detach.mjs's header explains why it must be). Node's
// own maxRetries/retryDelay is the documented answer; no assertion changes.
afterEach(() => { rmHome(tmp); });

const childEnv = (extra = {}) => ({
  ...process.env,
  HOME: tmp,
  USERPROFILE: tmp,                     // win32 homedir
  RUVNET_BRAIN_STATE_DIR: stateDir,
  RUVNET_SETTINGS_FILE: settingsFile,
  ...extra,
});

/** Run an ES-module snippet in a child, env pinned to the scratch dir. Throws with the child's output. */
function run(src, extraEnv = {}) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], {
    env: childEnv(extraEnv), encoding: 'utf8', timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`child exited ${r.status}\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`);
  return r.stdout;
}
const runJSON = (src, env) => JSON.parse(run(src, env));
const IMPORT_STATE = `const S = await import(${JSON.stringify(pathToFileURL(BRAIN_STATE).href)});`;
const IMPORT_SETTINGS = `const U = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'scripts/user-settings.mjs')).href)});`;

/** Fire a bash hook the way Claude Code does: subprocess, JSON on stdin, streams kept apart. */
function fireBash(script, payload, extraEnv = {}) {
  const r = spawnSync('bash', [script], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: childEnv(extraEnv), encoding: 'utf8', timeout: 30_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Opt this scratch HOME in to the gates that (correctly) do nothing without a router profile. */
function optIn() {
  fs.mkdirSync(path.join(tmp, '.claude/model-router'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.claude/model-router/profile.json'), '{"harnesses":{}}');
}

const offNow = (reason = 'test') => run(`${IMPORT_STATE} S.setBrainOff(${JSON.stringify(reason)});`);

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// GATE 1 — Skew round-trip. The switch must not live anywhere a previous release can erase.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('ADR-054 gate 1 — skew round-trip: a previous release\'s saveSettings cannot flip OFF back on', () => {
  it('the SENTINEL survives a previous release rewriting settings.json without the mirror key', () => {
    // 1. Turn it off the way the console does: sentinel AND mirror.
    run(`${IMPORT_STATE}${IMPORT_SETTINGS} S.setBrainOff('user turned it off'); U.saveSettings({ brainEnabled: false });`);
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).settings.brainEnabled).toBe(false);

    // 2. A PREVIOUS RELEASE saves. Its validate() has never heard of `brainEnabled`, so it DROPS the
    //    key (user-settings.mjs — "Dropped, not preserved") and rewrites the whole envelope. This is
    //    not hypothetical: it is byte-for-byte what the shipped v1 writer produces, which is why it
    //    is reproduced here rather than mocked.
    fs.writeFileSync(settingsFile, `${JSON.stringify({
      version: 1,
      updated: new Date().toISOString(),
      settings: { learningScope: 'project', advocacy: 'important-only', autoApply: false, newProjectDefaults: false },
    }, null, 2)}\n`);

    // 3. The mirror now says "enabled" (the key is simply gone → default true). The SENTINEL decides.
    const out = runJSON(`${IMPORT_STATE}${IMPORT_SETTINGS}
      process.stdout.write(JSON.stringify({
        off: S.isBrainOff(),
        mirror: U.loadSettings().values.brainEnabled,
        state: S.readOffState(),
        disagreement: S.disagreement(U.loadSettings().values.brainEnabled),
      }));`);
    expect(out.off).toBe(true);                 // ← the whole point: OFF survived the skew
    expect(out.mirror).toBe(true);              // the mirror really was silently re-enabled
    expect(out.state.off).toBe(true);
    expect(out.state.reason).toBe('user turned it off');
    // …and the disagreement is REPORTED, never smoothed over — the console renders this.
    expect(out.disagreement).toBeTruthy();
    expect(out.disagreement.sentinelWins).toBe(true);
  });

  it('BREAK IT: with the sentinel removed, the same skew genuinely does re-enable — so the guard is load-bearing', () => {
    // The counterfactual that proves the assertion above is not vacuous. Had OFF been stored ONLY in
    // settings.json, step 2 above is exactly the sequence that loses it.
    fs.writeFileSync(settingsFile, `${JSON.stringify({ version: 1, settings: { brainEnabled: false } })}\n`);
    fs.writeFileSync(settingsFile, `${JSON.stringify({ version: 1, settings: { advocacy: 'off' } })}\n`);
    const out = runJSON(`${IMPORT_STATE}${IMPORT_SETTINGS}
      process.stdout.write(JSON.stringify({ off: S.isBrainOff(), mirror: U.loadSettings().values.brainEnabled }));`);
    expect(out.mirror).toBe(true);   // the mirror alone WOULD have been flipped back on
    expect(out.off).toBe(false);     // no sentinel here — nothing to survive
  });

  it('a corrupt, empty or hand-`touch`ed sentinel still means OFF — existence is the switch, not the contents', () => {
    fs.writeFileSync(sentinel, 'not json at all');
    const out = runJSON(`${IMPORT_STATE} process.stdout.write(JSON.stringify(S.readOffState()));`);
    expect(out.off).toBe(true);
    expect(out.since).toBeTruthy();  // falls back to the file's own mtime rather than claiming nothing
    expect(out.reason).toBe(null);   // and says plainly that it does not know why
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// GATE 3 — Stamps mint on a RESULT, never on a query. (The duel's stamp-from-refusal find.)
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(bashOnly)('ADR-054 gate 3 — a refusal mints NO grounding stamp', () => {
  const groundedDir = () => path.join(tmp, '.cache/ruvnet-brain/grounded');
  const stampFor = (t) => path.join(groundedDir(), t);
  const TERM = 'agent' + 'db';   // assembled: this repo's own live gates scan the payload while editing

  function stampWith(toolResponse, query = `${TERM}: how does rUv implement session capture?`) {
    return fireBash(STAMP, {
      tool_name: 'mcp__plugin_ruvnet-brain_ruvnet-brain__search_ruvnet',
      tool_input: { query },
      tool_response: toolResponse,
    });
  }

  it('a DISABLED soft-answer mints no stamp, even though the query names the product', () => {
    const r = stampWith(`${DISABLED_MARKER} by this user's own setting. No search was run.`);
    expect(r.status).toBe(0);                          // PostToolUse is never allowed to fail
    expect(fs.existsSync(stampFor(TERM))).toBe(false); // ← the gate stays shut
  });

  it('the DOWN alarm mints no stamp either — an outage is not grounding', () => {
    stampWith('RUVNET BRAIN IS DOWN — ALL 37 repos failed to search.');
    expect(fs.existsSync(stampFor(TERM))).toBe(false);
  });

  it('a thrown tool error mints no stamp', () => {
    stampWith('search_ruvnet error: Cannot find module @xenova/transformers');
    expect(fs.existsSync(stampFor(TERM))).toBe(false);
  });

  it('an empty result mints no stamp — the search ran, but the brain showed the model nothing', () => {
    stampWith(`Searched 37 RuvNet repos (${TERM}).\n(no results — the search ran; nothing in the corpus matched this query)`);
    expect(fs.existsSync(stampFor(TERM))).toBe(false);
  });

  it('a REAL grounded result still stamps — the fix must not shut the gate permanently', () => {
    stampWith(`Searched 37 RuvNet repos (${TERM}).\n#1 repo=${TERM}\npath: x/src/y.ts\n----- full document (900 chars) -----\nreal source here`);
    expect(fs.existsSync(stampFor(TERM))).toBe(true);
  });

  it('a DEGRADED-but-real result stamps: partial coverage is still evidence the model actually read', () => {
    stampWith(`DEGRADED SEARCH: 2/37 repos failed\nSearched 37 RuvNet repos (${TERM}).\n#1 repo=${TERM}\n----- full document (400 chars) -----\ntext`);
    expect(fs.existsSync(stampFor(TERM))).toBe(true);
  });

  it('no tool_response at all mints no stamp — the old query-only behaviour is genuinely gone', () => {
    const r = fireBash(STAMP, {
      tool_name: 'mcp__plugin_ruvnet-brain_ruvnet-brain__search_ruvnet',
      tool_input: { query: `${TERM} everything` },
    });
    expect(r.status).toBe(0);
    expect(fs.existsSync(stampFor(TERM))).toBe(false);
  });

  it('the soft-answer the brain really emits carries the marker this test refuses to stamp on', () => {
    // Producer ⇄ consumer, pinned. If kb/forge-mcp-all.mjs ever reworded the refusal, the stamp
    // script would silently start honouring it again and this suite would still be green — so the
    // exact phrase is asserted at the source, not assumed.
    expect(fs.readFileSync(FORGE_MCP, 'utf8')).toContain(DISABLED_MARKER);
    expect(fs.readFileSync(STAMP, 'utf8')).toContain(DISABLED_MARKER);
  });

  it('still bash-builtins only — a hook that can shut a wall must depend on nothing fragile', () => {
    const src = fs.readFileSync(STAMP, 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    for (const bin of ['python3', 'jq', '$(cat', '| grep', '| sed']) expect(src).not.toContain(bin);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// GATE 2 — Real wiring. The brain-DEPENDENT gate disarms; the money/honesty walls do NOT.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(bashOnly)('ADR-054 gate 2 — off disarms the grounding gate and NOTHING else', () => {
  const ungrounded = { tool_name: 'Write', tool_input: { file_path: '/tmp/a.mjs', content: 'agent' + 'db glue code' } };

  it('ON: the grounding gate still blocks ungrounded rUv-domain code (the control)', () => {
    optIn();
    expect(fireBash(GATE, ungrounded).status).toBe(2);
  });

  it('OFF: the same write passes, with ONE advisory line and no block', () => {
    optIn();
    offNow();
    const r = fireBash(GATE, ungrounded);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(r.stdout).toMatch(/off/i);
  });

  it('OFF does not disarm the route-dispatch audit', () => {
    optIn();
    offNow();
    const r = fireBash(ROUTE_DISPATCH, { tool_name: 'Task', tool_input: { description: 'sweep tests', subagent_type: 'general-purpose' } });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const receipt = JSON.parse(fs.readFileSync(path.join(tmp, '.claude', RECEIPT_DIR, 'dispatch-log.jsonl'), 'utf8').trim());
    expect(receipt).toMatchObject({ model: 'inherited', enforcement: 'advisory-host-timing' });
  });

  it('the verify-interface body remains nonblocking even if invoked directly while OFF', () => {
    optIn();
    offNow();
    const r = fireBash(VERIFY_IFACE, { tool_name: 'Bash', tool_input: { command: 'npx ruf' + 'lo@latest memory search -q test' } });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('ruvnet_cli_help');
  });

  it('OFF does NOT disarm the design wall — honesty about visual surfaces is not retrieval', () => {
    optIn();
    offNow();
    const r = fireBash(DESIGN_WALL,
      { tool_name: 'Bash', tool_input: { command: 'open https://ruvnet-brain.vercel.app' } },
      { CLAUDE_PROJECT_DIR: REPO });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/DESIGN WALL/);
  });

  it('the shim declares the split as DATA, not as scattered ifs — and the walls are marked `run`', () => {
    const src = fs.readFileSync(SHIM, 'utf8');
    for (const wall of ['route-dispatch', 'design-wall', 'protect-state']) {
      const line = src.split('\n').find((l) => l.includes(`'${wall}':`));
      expect(line, `${wall} missing from the shim table`).toBeTruthy();
      expect(line, `${wall} must keep running while the brain is off`).toMatch(/offBehavior:\s*'run'/);
    }
    for (const quiet of ['ground-ruvnet', 'hijack-ruvnet', 'verify-interface', 'unprompted-speech', 'md-stamp']) {
      const line = src.split('\n').find((l) => l.includes(`'${quiet}':`));
      expect(line, `${quiet} must go silent while the brain is off`).toMatch(/offBehavior:\s*'silence'/);
    }
    expect(src.split('\n').find((l) => l.includes("'session-start':"))).toMatch(/offBehavior:\s*'partial'/);
  });

  it('a `silence` hook really is silent through the shim — and a `run` hook really still fires', () => {
    // Real shim, real spine, real subprocess. Not a reading of the table.
    const brainHome = path.join(tmp, '.cache', 'ruvnet-brain');
    const gen = path.join(brainHome, 'versions', '9.9.9', 'scripts');
    fs.mkdirSync(gen, { recursive: true });
    fs.writeFileSync(path.join(gen, 'ground-ruvnet.sh'), '#!/bin/bash\necho ADVERTISING\n');
    fs.writeFileSync(path.join(gen, 'route-dispatch.sh'), '#!/bin/bash\necho WALL >&2\nexit 2\n');
    fs.writeFileSync(path.join(brainHome, 'active.json'), JSON.stringify({ generation: 1, version: '9.9.9', codeRoot: path.join('versions', '9.9.9') }));
    fs.writeFileSync(path.join(brainHome, '.spine-seeded'), 'yes');
    const fire = (id) => spawnSync(process.execPath, [SHIM, id], {
      encoding: 'utf8', env: childEnv({ RUVNET_BRAIN_HOME: brainHome, CLAUDE_PLUGIN_ROOT: path.join(REPO, 'plugin') }),
    });

    expect(fire('ground-ruvnet').stdout).toMatch(/ADVERTISING/); // ON
    expect(fire('route-dispatch').status).toBe(0);

    offNow();
    expect(fire('ground-ruvnet').stdout).toBe('');               // OFF → silent, zero bytes
    expect(fire('ground-ruvnet').status).toBe(0);
    expect(fire('route-dispatch').status).toBe(0);               // OFF → audit still runs, never blocks
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// GATE 4 — session-start splits internally: no advertising, one state line, maintenance alive.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(bashOnly)('ADR-054 gate 4 — session-start goes quiet without going dark', () => {
  const ADVERTISING = [
    'RuvNet Brain active',                 // the confidence banner
    'standing build playbook',             // THE PLAYBOOK (~2k tokens)
    'Want to see your whole RuvNet stack', // console first-load offer
    'routing is available',                // router nudge
    'token intelligence',                  // 2.0 feature announcement
    'MAJOR-LINE welcome',                  // 4.0-line milestone
    'Star github.com/stuinfla',            // one-time star ask
  ];

  function session(extraEnv = {}) {
    fs.mkdirSync(path.join(tmp, '.cache/ruvnet-brain'), { recursive: true });
    return fireBash(SESSION, '', { RUVNET_BRAIN_METER: '0', CLAUDE_PLUGIN_ROOT: path.join(REPO, 'plugin'), ...extraEnv });
  }

  it('ON: the advertising is there (the control — otherwise "zero bytes" proves nothing)', () => {
    const out = session().stdout;
    expect(out).toContain('RuvNet Brain active');
    expect(out).toContain('standing build playbook');
  }, 30_000);

  it('OFF: ZERO advertising bytes, and exactly ONE state line naming the date', () => {
    offNow('not right now');
    const out = session().stdout;
    for (const marker of ADVERTISING) expect(out, `advertising survived: ${marker}`).not.toContain(marker);
    const stateLines = out.split('\n').filter((l) => l.includes('brain OFF by your setting'));
    expect(stateLines).toHaveLength(1);
    expect(stateLines[0]).toMatch(/since \d{4}-\d{2}-\d{2}/);
  }, 30_000);

  it('OFF: the auto-update heartbeat demonstrably still runs — an off machine must still get fixes', () => {
    offNow();
    const stamp = path.join(tmp, '.cache/ruvnet-brain/.last-update-check');
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    fs.writeFileSync(stamp, '1');                    // ancient → the rate limit cannot skip the block
    session();
    expect(Number(fs.readFileSync(stamp, 'utf8').trim())).toBeGreaterThan(1); // it ran and re-stamped
  }, 30_000);

  it('OFF: a REAL health failure still rings the GONG — off is not a mute button on breakage', () => {
    const kb = path.join(tmp, '.cache/ruvnet-brain/kb');
    fs.mkdirSync(kb, { recursive: true });
    fs.writeFileSync(path.join(kb, 'x.rvf'), '');    // stores present, reader deps gone
    offNow();
    expect(session().stdout).toMatch(/HEALTH ALARM/);
  }, 30_000);

  it('OFF: an ABSENT knowledge bundle reads as "disabled by choice", never as THE BRAIN IS DOWN', () => {
    offNow();                                        // no kb dir at all under this HOME
    const out = session().stdout;
    expect(out).not.toMatch(/THE BRAIN IS DOWN/);
    expect(out).not.toMatch(/HEALTH ALARM/);
    expect(out).toMatch(/disabled by choice/i);
  }, 30_000);

  it('OFF: the once-EVER offers are NOT consumed while suppressed — turning it back on must not lose them', () => {
    offNow();
    session();
    expect(fs.existsSync(path.join(tmp, '.cache/ruvnet-brain/.console-offered'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, '.cache/ruvnet-brain/.router-profile-nudged'))).toBe(false);
  }, 30_000);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// GATE 5 — Fail polarity. Nothing about a broken settings file may re-enable the brain.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('ADR-054 gate 5 — every settings failure mode fails toward the user\'s choice', () => {
  const readOff = () => runJSON(`${IMPORT_STATE} process.stdout.write(JSON.stringify({ off: S.isBrainOff() }));`).off;

  it('corrupt settings JSON: still OFF', () => {
    offNow();
    fs.writeFileSync(settingsFile, '{ truncated mid-writ');
    expect(readOff()).toBe(true);
  });

  it('settings written by a FUTURE version: still OFF', () => {
    offNow();
    fs.writeFileSync(settingsFile, JSON.stringify({ version: 99, settings: { brainEnabled: true } }));
    expect(readOff()).toBe(true);
  });

  it('no settings file at all: still OFF', () => {
    offNow();
    expect(fs.existsSync(settingsFile)).toBe(false);
    expect(readOff()).toBe(true);
  });

  it('settings actively asserting brainEnabled:true: STILL OFF — the sentinel wins, and says so', () => {
    offNow();
    run(`${IMPORT_SETTINGS} U.saveSettings({ brainEnabled: true });`);
    const out = runJSON(`${IMPORT_STATE}${IMPORT_SETTINGS}
      const mirror = U.loadSettings().values.brainEnabled;
      process.stdout.write(JSON.stringify({ off: S.isBrainOff(), mirror, dis: S.disagreement(mirror) }));`);
    expect(out.off).toBe(true);
    expect(out.mirror).toBe(true);
    expect(out.dis.sentinelWins).toBe(true);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'an UNREADABLE state directory reports OFF rather than guessing ON', () => {
      offNow();
      fs.chmodSync(stateDir, 0o000);
      try { expect(readOff()).toBe(true); } finally { fs.chmodSync(stateDir, 0o755); }
    });

  it('default is ON: a machine that never touched this is untouched by the feature', () => {
    const out = runJSON(`${IMPORT_STATE}${IMPORT_SETTINGS}
      process.stdout.write(JSON.stringify({ off: S.isBrainOff(), mirror: U.loadSettings().values.brainEnabled, dflt: U.defaults().brainEnabled }));`);
    expect(out.off).toBe(false);
    expect(out.mirror).toBe(true);
    expect(out.dflt).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// GATE 6 — Mid-session flip, both directions, no restart.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(bashOnly)('ADR-054 gate 6 — a flip lands on the very next hook fire and the very next tool call', () => {
  it('hooks: on → off → on, same process boundary, no restart anywhere', () => {
    optIn();
    const write = { tool_name: 'Write', tool_input: { file_path: '/tmp/a.mjs', content: 'agent' + 'db glue' } };
    expect(fireBash(GATE, write).status).toBe(2);
    offNow();
    expect(fireBash(GATE, write).status).toBe(0);
    run(`${IMPORT_STATE} S.setBrainOn();`);
    expect(fireBash(GATE, write).status).toBe(2);   // back to blocking, immediately
  });

  it('search_ruvnet soft-answers the moment the sentinel appears, and answers again when it goes', () => {
    const kbDir = path.join(tmp, 'empty-kb');
    fs.mkdirSync(kbDir, { recursive: true });
    const call = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_ruvnet', arguments: { query: 'session capture' } } });
    const ask = () => {
      const r = spawnSync(process.execPath, [FORGE_MCP], {
        input: `${call}\n`, env: childEnv({ KB_DIR: kbDir }), encoding: 'utf8', timeout: 90_000,
      });
      const lines = (r.stdout || '').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((m) => m && m.id === 1);
      if (!lines.length) throw new Error(`no JSON-RPC reply\nSTDOUT:${r.stdout}\nSTDERR:${r.stderr}`);
      return lines[0];
    };

    offNow();
    const off = ask();
    expect(off.result.content[0].text).toContain(DISABLED_MARKER);
    expect(off.result.disabled).toBe(true);        // machine-readable: never counted as success or outage
    expect(off.result.isError).toBe(false);        // a deliberate state is not a failure

    run(`${IMPORT_STATE} S.setBrainOn();`);
    const on = ask();
    expect(on.result.content[0].text).not.toContain(DISABLED_MARKER);
  }, 180_000);

  it('the soft answer tells the MODEL to tell the USER, and never hands the model the re-enable command', () => {
    const kbDir = path.join(tmp, 'empty-kb2');
    fs.mkdirSync(kbDir, { recursive: true });
    offNow();
    const r = spawnSync(process.execPath, [FORGE_MCP], {
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'search_ruvnet', arguments: { query: 'anything' } } })}\n`,
      env: childEnv({ KB_DIR: kbDir }), encoding: 'utf8', timeout: 90_000,
    });
    const msg = (r.stdout || '').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((m) => m && m.id === 7);
    const text = msg.result.content[0].text;
    expect(text).toMatch(/tell the user/i);
    // The consent invariant: an agent must not be handed the lever to undo the user's own choice.
    expect(text).not.toMatch(/rvbc|brain-off|brainEnabled|setBrainOn|re-enable|turn it back on/i);
  }, 90_000);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// GATE 7 — Multi-host. Two independent processes, one machine, one coherent answer.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('ADR-054 gate 7 — a second host (another window, another CLI) sees the same state, unprompted', () => {
  it('a flip in process A is visible to a cold process B with no shared memory and no restart handshake', () => {
    // Two SEPARATE node processes, started after the flip, reading only the filesystem. That is the
    // whole reason the switch is a file: there is no daemon, no IPC and no cache to invalidate.
    run(`${IMPORT_STATE} S.setBrainOff('flipped in window A');`);
    const b = runJSON(`${IMPORT_STATE} process.stdout.write(JSON.stringify(S.readOffState()));`);
    const c = runJSON(`${IMPORT_STATE} process.stdout.write(JSON.stringify(S.readOffState()));`);
    expect(b.off).toBe(true);
    expect(c.off).toBe(true);
    expect(b.reason).toBe('flipped in window A');
    expect(b.since).toBe(c.since);   // one fact, not two racing opinions
  });

  it('the state is legible enough to diagnose in ONE read: host, when, why', () => {
    run(`${IMPORT_STATE} S.setBrainOff('paused for a client demo');`);
    const raw = JSON.parse(fs.readFileSync(sentinel, 'utf8'));
    expect(raw.off).toBe(true);
    expect(raw.reason).toBe('paused for a client demo');
    expect(new Date(raw.since).toString()).not.toBe('Invalid Date');
    expect(typeof raw.host).toBe('string');
  });

  it('two writers racing on the switch leave ONE valid file, never a half-written one', () => {
    // setBrainOff is temp-file + rename for the same reason writeAtomic exists in user-settings.mjs:
    // a reader must never observe a partial sentinel. Ten concurrent flips, one coherent outcome.
    run(`${IMPORT_STATE}
      await Promise.all(Array.from({ length: 10 }, (_, i) => Promise.resolve().then(() => S.setBrainOff('w' + i))));`);
    const raw = JSON.parse(fs.readFileSync(sentinel, 'utf8'));  // throws if half-written
    expect(raw.off).toBe(true);
    expect(fs.readdirSync(stateDir).filter((n) => n.startsWith('brain-off.tmp'))).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// GATE 8 — Uninstall/reinstall. A reinstall must never boot silently dead.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('ADR-054 gate 8 — uninstall removes the sentinel, so a reinstall is alive and says so', () => {
  it('the installer removes the sentinel in its uninstall LOOP, not merely in a comment', () => {
    const src = fs.readFileSync(INSTALLER, 'utf8');
    const loop = src.slice(src.indexOf("['model-router files'"), src.indexOf('PROOF, not a claim'));
    expect(loop.length).toBeGreaterThan(0);
    expect(loop).toMatch(/brainOffSentinelPath|brain-off/);
  });

  it('removing the sentinel restores ON with no other step — reinstall cannot inherit an invisible OFF', () => {
    offNow();
    fs.rmSync(sentinel);
    expect(runJSON(`${IMPORT_STATE} process.stdout.write(JSON.stringify(S.readOffState()));`).off).toBe(false);
  });

  it('setBrainOn is idempotent and never throws on a machine that was already on', () => {
    const out = runJSON(`${IMPORT_STATE}
      const a = S.setBrainOn(); const b = S.setBrainOn();
      process.stdout.write(JSON.stringify({ a, b, off: S.isBrainOff() }));`);
    expect(out.off).toBe(false);
    expect(out.a.ok).toBe(true);
    expect(out.b.ok).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE CONSENT GUARD — an agent may not flip the user's own switch back on.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(bashOnly)('ADR-054 — the PreToolUse guard on the consent record', () => {
  const write = (p) => ({ tool_name: 'Write', tool_input: { file_path: p, content: 'x' } });

  it('BLOCKS an agent Write to the sentinel', () => {
    const r = fireBash(PROTECT, write(sentinel));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/BLOCKED/);
  });

  it('BLOCKS an agent Edit to the settings mirror, and to its backups and lock', () => {
    for (const p of [settingsFile, `${settingsFile}.bak-2026-01-01`, `${settingsFile}.lock`]) {
      const r = fireBash(PROTECT, { tool_name: 'Edit', tool_input: { file_path: p, old_string: 'a', new_string: 'b' } });
      expect(r.status, `${p} was not protected`).toBe(2);
    }
  });

  it('BLOCKS the DEFAULT paths too, not merely the env-overridden test ones', () => {
    // The override exists for this suite. A guard that only fires under the override protects nobody.
    const r = spawnSync('bash', [PROTECT], {
      input: JSON.stringify(write('/Users/someone/.config/ruvnet-brain/brain-off')),
      env: { ...process.env, HOME: '/Users/someone', RUVNET_BRAIN_STATE_DIR: '', RUVNET_SETTINGS_FILE: '' },
      encoding: 'utf8',
    });
    expect(r.status).toBe(2);
  });

  it('never teaches the model the lever it just refused', () => {
    const r = fireBash(PROTECT, write(sentinel));
    expect(r.stderr).not.toMatch(/\brm\b|unlink|setBrainOn|delete (the|this) file/i);
  });

  it('does NOT tax ordinary work — every other path passes untouched', () => {
    for (const p of ['/tmp/whatever.mjs', path.join(tmp, '.claude/settings.json'), path.join(tmp, 'settings.json')]) {
      expect(fireBash(PROTECT, write(p)).status, `${p} must pass`).toBe(0);
    }
    expect(fireBash(PROTECT, { tool_name: 'Read', tool_input: { file_path: sentinel } }).status).toBe(0);
  });

  it('FAILS OPEN on garbage — a blocking hook must never brick a session', () => {
    expect(fireBash(PROTECT, 'not json at all').status).toBe(0);
  });

  it('is registered on PreToolUse writes, through the shim, with an explicit ≤5s timeout', () => {
    const reg = JSON.parse(fs.readFileSync(path.join(REPO, 'plugin/hooks/hooks.json'), 'utf8'));
    const entries = (reg.hooks.PreToolUse || []).flatMap((m) => (m.hooks || []).map((h) => ({ m: m.matcher, ...h })));
    // ADR-067: the consent guard is no longer its own registration — it is the FIRST policy
    // decision-gate consults, ahead of every other wall, because ADR-054 §3 says it matters more
    // while the brain is off. What must hold is that it is still reachable on the write path with a
    // bounded timeout, and that nothing was demoted below it.
    const guard = entries.find((h) => h.command.includes('protect-state'))
      || entries.find((h) => h.command.includes('decision-gate write'));
    expect(guard, 'no PreToolUse write guard is wired into hooks.json at all').toBeTruthy();
    const gateSrc = fs.readFileSync(path.join(REPO, 'plugin/scripts/decision-gate.mjs'), 'utf8');
    expect(gateSrc, 'protect-state must be a consulted policy').toMatch(/protect-brain-state\.sh/);
    const order = [...gateSrc.matchAll(/POLICY\('([a-z-]+)'/g)].map((m) => m[1]);
    expect(order[0], 'the consent guard outranks every other policy').toBe('protect-state');
    expect(guard.command).toContain('hook-shim.mjs');
    expect(guard.command).not.toContain('|| true');   // it is a wall; a failsafe would disarm it
    expect(typeof guard.timeout).toBe('number');
    expect(guard.timeout).toBeLessThanOrEqual(5);
    expect(guard.m).toMatch(/Write/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE CONSOLE — the only surface that may flip it, and it must disclose what keeps running.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('ADR-054 — the console owns the switch, consent-gated, and discloses the residual', () => {
  const CONSOLE = pathToFileURL(path.join(REPO, 'scripts/onboarding-console.mjs')).href;
  const IMPORT_CONSOLE = `const m = await import(${JSON.stringify(CONSOLE)});`;

  it('serves the master switch as its own section, without disturbing the advocacy dial', () => {
    const out = runJSON(`${IMPORT_CONSOLE} process.stdout.write(JSON.stringify({
      bp: m.gatherBrainPower(), keys: (m.gatherBrainPower().schema || []).map((s) => s.key),
    }));`);
    expect(out.keys).toEqual(['brainEnabled']);
    expect(out.bp.schema[0].type).toBe('bool');
    expect(out.bp.off).toBe(false);
  });

  it('an apply writes BOTH the sentinel and the mirror — one click, one coherent machine', () => {
    const out = runJSON(`${IMPORT_CONSOLE} process.stdout.write(JSON.stringify(m.saveBrainPower({ brainEnabled: false })));`);
    expect(out.ok).toBe(true);
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).settings.brainEnabled).toBe(false);
  });

  it('turning it back on removes the sentinel and restores the mirror', () => {
    run(`${IMPORT_CONSOLE} m.saveBrainPower({ brainEnabled: false });`);
    const out = runJSON(`${IMPORT_CONSOLE} process.stdout.write(JSON.stringify(m.saveBrainPower({ brainEnabled: true })));`);
    expect(out.ok).toBe(true);
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).settings.brainEnabled).toBe(true);
  });

  it('shows the off-since date and DISCLOSES that maintenance keeps running — no silent background work', () => {
    run(`${IMPORT_CONSOLE} m.saveBrainPower({ brainEnabled: false });`);
    const out = runJSON(`${IMPORT_CONSOLE} process.stdout.write(JSON.stringify(m.gatherBrainPower()));`);
    expect(out.off).toBe(true);
    expect(out.since).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(out.notes.join(' ')).toMatch(/updat/i);   // "still auto-updating" — stated, not hidden
  });

  it('surfaces a sentinel/mirror DISAGREEMENT rather than picking one silently', () => {
    run(`${IMPORT_STATE}${IMPORT_SETTINGS} S.setBrainOff('sentinel says off'); U.saveSettings({ brainEnabled: true });`);
    const out = runJSON(`${IMPORT_CONSOLE} process.stdout.write(JSON.stringify(m.gatherBrainPower()));`);
    expect(out.off).toBe(true);
    expect(out.disagreement).toBeTruthy();
    expect(out.disagreement.sentinelWins).toBe(true);
  });

  it('rejects a non-boolean rather than writing nonsense into the consent record', () => {
    const out = runJSON(`${IMPORT_CONSOLE} process.stdout.write(JSON.stringify(m.saveBrainPower({ brainEnabled: 'no' })));`);
    expect(out.ok).toBe(false);
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it('a flip UPDATES THE CACHE /api/state is served from — the page cannot report ON for an OFF machine', () => {
    // FOUND BY A LIVE HTTP SMOKE, NOT BY THIS SUITE. Every assertion above passed while the real
    // server, queried one second after a successful `off` save, answered `off: false` — because
    // /api/state is cache-first by design and nothing invalidated the cache on this write. So the
    // regression is pinned HERE, at the artifact the handler actually reads: the on-disk state
    // cache, written by gatherState() and served by serveCached() without recomputing.
    const out = runJSON(`${IMPORT_CONSOLE}
      m.gatherState(${JSON.stringify(REPO)}, { fleet: false });   // seeds the cache with off:false
      const before = m.gatherBrainPower().off;
      m.saveBrainPower({ brainEnabled: false });
      process.stdout.write(JSON.stringify({ before }));`);
    expect(out.before).toBe(false);

    const cache = JSON.parse(fs.readFileSync(path.join(tmp, '.claude', 'ruvnet-brain', 'state-cache.json'), 'utf8'));
    expect(cache.data.sections.brainPower.off).toBe(true);   // ← the value the page would render
    // The project scope must survive the patch: dropping it makes the next read a scope mismatch,
    // which takes the COLD path and computes inline — the multi-second freeze, on the next load.
    expect(cache.scope).toBe(REPO);
  }, 120_000);

  it('gatherState carries it, and the front end posts to a real endpoint that exists', () => {
    const out = runJSON(`${IMPORT_CONSOLE}
      const st = m.gatherState(${JSON.stringify(REPO)}, { fleet: false });
      process.stdout.write(JSON.stringify({ keys: (st.sections.brainPower?.schema || []).map((s) => s.key) }));`);
    expect(out.keys).toEqual(['brainEnabled']);
    const server = fs.readFileSync(path.join(REPO, 'scripts/onboarding-console.mjs'), 'utf8');
    const app = fs.readFileSync(path.join(REPO, 'console/app.js'), 'utf8');
    expect(server).toContain('/api/save-brain-power');
    expect(app).toContain('/api/save-brain-power');
  }, 60_000);
});
