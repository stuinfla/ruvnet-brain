/**
 * hook-registry-lint.test.mjs — the MESH invariants over the MERGED registry (ADR-055 build item 1).
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS: the suite could not see five sixths of the machine.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `hook-contract.test.mjs` — the file written after a Stop hook looped every turn in every project
 * on this machine — reads exactly one registry: `plugin/hooks/hooks.json` (its line 43). That file
 * holds 15 of the 42 hook registrations a session here actually loads. The other 27 live in
 * `~/.claude/settings.json`, this project's `.claude/settings.json`, and three third-party plugins,
 * and NOTHING in this repo had ever read them. ADR-055 F16 names it exactly: "the test suite cannot
 * see the merged registry". A suite that cannot see a layer cannot go red on it, and everything
 * that went wrong in those layers — an untimed blocking wall, a stale Stop override, thirteen
 * handlers on the host's 600s default — went wrong there for months, in the open, unread.
 *
 * So this file does not test a hook. It tests the MESH: `scripts/hook-registry.mjs` enumerates every
 * registration across every registry and normalizes it to one record, and the invariants below are
 * evaluated over all of them at once.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * BORN RED — verbatim, before a single fix, 2026-07-27, spine gen 22 / 3.9.85-dev.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `node scripts/hook-registry.mjs --lint` on this laptop, with the invariants written and NOTHING
 * else changed:
 *
 *     Merged hook registry — 42 active registrations in the mesh, 30 in code-copy mirrors
 *      15   plugin            · 11 user · 2 project
 *       9   third-party:security-guidance · 4 third-party:vercel · 1 third-party:superpowers
 *
 *     M1: 3 FINDING(S)
 *        PreToolUse::Task::route-dispatch.sh      roots ["spine","marketplace-clone"]      blocking
 *        PreToolUse::TaskStop::route-dispatch.sh  roots ["spine","marketplace-clone"]      blocking
 *        Stop::*::continuation-gate.mjs           roots ["plugin-root", "<repo>/plugin/scripts"]
 *     M3: 14 FINDING(S)   (1 wrong-unit: security-guidance SessionStart timeout 180;
 *                          13 missing: 8 security-guidance, 4 vercel, 1 superpowers)
 *     M5: 18 FINDING(S)   (6 plugin, 1 project, 5 user, 6 third-party — unanchored tool matchers)
 *     M5-stale: clean
 *     M6: 28 FINDING(S)   (plugin Stop, both project entries, all 11 user, all 14 third-party —
 *                          no declared offBehavior anywhere outside the shim's table)
 *
 *     63 finding(s) over 42 mesh registrations
 *
 * That is the ADR's predicted born-red set, found independently by the lint rather than by reading
 * the ADR: F5 (Stop bypasses the spine — no mode, no offBehavior) · F6 (double continuation-gate
 * from two code roots, its own removal condition satisfied 50 versions earlier) · F3 (route-dispatch
 * registered blocking from two code copies, and unanchored `Task` also selecting TaskStop) ·
 * F4 (unanchored matchers; NotebookEdit reaching four hooks by substring accident) ·
 * F14 (offBehavior declared for the shim's eleven and nothing else) · F18 (thirteen third-party
 * handlers with no timeout at all, plus a 180s SessionStart dominating every cold start).
 * F16 is not a finding here — it is the defect this file's existence closes. The census assertion
 * below proves every present mesh registry with declared hooks appears in the normalized records;
 * the 42-versus-15 figures above are the historical born-red measurement, not a fixed ratio.
 *
 * NOT COVERED, said plainly rather than implied: F17 (Codex's plugin parser rejects hooks.json's
 * `_note`) is a cross-host PARSER question, not a registry-shape one — ADR-055 §7.14, and it
 * belongs to the artifact/battery items, not to these four invariants. F20 (held-open stdin) and
 * F11 (learn-flush's 48s worst case inside a 30s timeout) are BUDGET facts about hook BODIES; a
 * registry census cannot see them and this file does not pretend to. Battery v2 (item 2) owns both.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * FIXED IN THE REPO vs DOCUMENTED AS MACHINE-LOCAL — and why the split is where it is.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * FIXED (all repo-owned, all shipped by this branch):
 *   • F5 — Stop now dispatches `hook-shim.mjs continuation-gate`, with mode `advisory` (behaviourally
 *     identical to the `|| true` it replaces) and offBehavior `run`, reasoned in the shim's table.
 *     ADR-055 left this "undecided today"; the decision and its discriminator are recorded there,
 *     and the two assertions at the bottom of this file prove the declaration is HONOURED — the
 *     gate still fires under a live brain-off sentinel, while a `silence` entry under the same
 *     sentinel writes zero bytes. A declaration nothing checks is the ceremony ADR-055 §4 refuses.
 *   • F6 — this project's Stop override is deleted. Its own `_note` said "REMOVE once the spine
 *     ships >=3.9.34"; the spine was at 3.9.85.
 *   • F14, repo half — `plugin/hooks/hook-contracts.json` now carries the out-of-shim contract for
 *     the one repo-owned registration outside the table (the project's version-bump-gate).
 *   • F4/F3, recorded not hidden — every unanchored matcher this repo ships is in that file's
 *     `matcherAllowlist`, each with its reason and the ADR-055 build item that retires it. ADR-055
 *     orders battery v2 (item 2) BEFORE any registration change (item 3), so anchoring them today
 *     would be fixing them out of order, against the ADR, with no battery to catch the fallout.
 *     The allowlist is a ratchet, not an amnesty: a NEW unanchored matcher is red on arrival, and
 *     a stale entry is itself a failure (`M5-stale`).
 *
 * DOCUMENTED, NOT FIXED — every one of these is a file this repo does not own:
 *   `~/.claude/settings.json` is the machine owner's; the three third-party plugins are Anthropic's
 *   and Vercel's. Inventing an offBehavior for someone else's hook, or editing a stranger's
 *   registry from a test run, is precisely the fiction this lint exists to prevent. They are
 *   reported in appendix B without making the presence of foreign defects a test prerequisite.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { continuationProjectIdentity } from '../../plugin/scripts/continuation-objective.mjs';
import {
  buildRegistry, discoverSources, census, lintM1, lintM3, lintM5, lintAllowlistStale, lintM6,
  matchedTools, isAnchored, hasFailsafe, mesh, OFF_BEHAVIORS, codexDispatchIdIn, shimTable,
} from '../../scripts/hook-registry.mjs';
import { continuityContractIds, continuityRegistrations } from '../../plugin/scripts/continuity-hook-policy.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const SHIM = path.join(REPO, 'plugin/scripts/hook-shim.mjs');


/** `version` from a plugin.json, or null. Never throws — a missing mirror is not a test failure. */
function readVersion(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).version || null; } catch { return null; }
}

/**
 * The version Claude Code has actually INSTALLED, read from its registry rather than guessed from a
 * directory name — the registry is the only authority on which generation is live (issue #128 is the
 * whole story of what happens when the cache is trusted instead).
 */
function installedPluginVersion() {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    const rows = Object.entries(reg?.plugins || {})
      .filter(([name]) => /^ruvnet-brain@/.test(name))
      .flatMap(([, v]) => (Array.isArray(v) ? v : []));
    return rows[0]?.version || null;
  } catch { return null; }
}

/** Numeric-segment compare; a prerelease sorts BELOW its release, as semver requires. */
function cmpVersion(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).split('-');
    return { nums: core.split('.').map((n) => Number(n) || 0), pre: pre || null };
  };
  const A = parse(a); const B = parse(b);
  for (let i = 0; i < Math.max(A.nums.length, B.nums.length); i++) {
    const d = (A.nums[i] || 0) - (B.nums[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  if (A.pre && !B.pre) return -1;
  if (!A.pre && B.pre) return 1;
  if (A.pre && B.pre) return A.pre === B.pre ? 0 : (A.pre > B.pre ? 1 : -1);
  return 0;
}

/** Repo-owned layers only — exactly what a CI runner has. Must be, and stay, clean. */
const repoReg = buildRegistry({ repo: REPO, includeMachine: false });
/** The full merged mesh, including this machine's user + third-party registries. */
const fullReg = buildRegistry({ repo: REPO, includeMachine: true });

const machinePresent = discoverSources({ repo: REPO }).some((s) => s.machineLocal && s.present);

/**
 * Registrations in the merged mesh that this repo does NOT own — the machine owner's user layer and
 * any third-party plugin. Appendix B is a claim about a machine that HAS these; on a machine with
 * none, the claim has no subject and the block is skipped WITH A STATED REASON rather than being
 * evaluated against something it was never about. Deliberately independent of whether the findings
 * themselves hold: a predicate that skipped when the findings were absent could never go red, and a
 * check that cannot fail is not a check.
 */
const foreignRegs = mesh(fullReg.records).filter((r) => r.layer === 'user' || r.layer.startsWith('third-party'));

const declaredRegistrationCount = (file) => {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const hooks = doc.hooks ?? doc;
  return Object.values(hooks).reduce((total, groups) => total + (Array.isArray(groups)
    ? groups.reduce((eventTotal, group) => eventTotal + (Array.isArray(group?.hooks) ? group.hooks.length : 0), 0)
    : 0), 0);
};

const MACHINE_SKIP_REASON =
  process.env.CI === 'true' ? 'CI — no user or third-party registries exist here'
    : process.env.RUVNET_MESH_LINT_MACHINE === '0' ? 'RUVNET_MESH_LINT_MACHINE=0 — machine block disabled by request'
      : !machinePresent ? 'no machine-local registry found (~/.claude absent)'
        : foreignRegs.length === 0 ? 'this machine registers no hooks outside this repo — appendix B has no subject here'
          : null;

const show = (findings) => findings.map((f) => JSON.stringify(f)).join('\n  ');

/** True-but-not-a-defect readings. Printed at the end so a non-failing observation is still SEEN. */
const driftNotes = [];

describe('the merged census — six registries, not one', () => {
  afterAll(() => {
    // stderr, not console.log — MEASURED on vitest 4.1.10: the default reporter suppresses
    // `console.log` entirely on a file that passes, and a report nobody can read is the same as no
    // report. A direct stderr write is printed either way, which is the whole point of moving these
    // readings off the failure path.
    if (driftNotes.length) {
      process.stderr.write(`\n── code-copy mirror drift (reported, not failed) ──\n  ${driftNotes.join('\n  ')}\n`);
    }
  });

  it('enumerates every registry this repo owns and proves only continuity is registered', () => {
    const REQUIRED = ['layer', 'file', 'locator', 'event', 'matcher', 'command', 'timeout', 'mode', 'offBehavior', 'reachesStrangers'];
    // DERIVED FROM THE POLICY, not from a remembered count. This assertion held the number 4 and
    // the four handler names, so it measured the size of the plane rather than the property worth
    // holding: every shipped registration is one the policy declares, and every declared one ships.
    // hook-shim.mjs's own dispatch table is the authority on which FILE an id runs, so the
    // expectation resolves through it rather than restating four filenames a rename would orphan.
    const table = shimTable(REPO);
    const handlerFor = (id) => {
      const entry = table[id];
      expect(entry, `hook-shim.mjs declares no route for '${id}'`).toBeTruthy();
      return entry.file;
    };
    const expectedHandlers = [
      ...continuityRegistrations('claude').map((s) => handlerFor(s.id)),
      ...continuityRegistrations('codex').map((s) => handlerFor(s.id)),
    ].sort();
    expect(repoReg.records).toHaveLength(expectedHandlers.length);
    expect(repoReg.records.map((r) => r.handler).sort()).toEqual(expectedHandlers);
    for (const r of repoReg.records) {
      for (const k of REQUIRED) expect(Object.keys(r), `${r.layer} ${r.locator} missing ${k}`).toContain(k);
      expect(r.locator, 'a locator with no line number cannot point anybody at anything').toMatch(/:\d+$/);
    }
    // `reachesStrangers` is not decoration: the plugin and codex registries are the ONLY channels
    // that reach another machine (ADR-055 §5; codex-hooks.json joined 2026-08-20 — it ships in
    // package.json's "files" tree exactly like plugin/), and an invariant that treats a local hook
    // and a shipped hook as equally consequential is not reading the same product the users are.
    expect(repoReg.records.filter((r) => r.reachesStrangers).every((r) => r.layer === 'plugin' || r.layer === 'codex')).toBe(true);
    expect(repoReg.records.some((r) => r.layer === 'project')).toBe(false);
  });

  it('routes EVERY plugin registration through the shim — the F5 regression fixture', () => {
    // Stop was the one exception, for the one event that can force a turn to continue. If a future
    // registration is added to hooks.json pointing straight at a body again, it lands here first.
    const strays = repoReg.records
      .filter((r) => r.layer === 'plugin' && r.contractSource !== 'shim-table')
      .map((r) => `${r.locator} ${r.event} → ${r.handler}`);
    expect(strays, `plugin registration(s) bypassing hook-shim.mjs:\n  ${strays.join('\n  ')}`).toEqual([]);
  });

  it('counts the code-copy MIRRORS separately from the mesh — they are one registration, not two', () => {
    // The installed plugin cache and the marketplace clone are the same registrations delivered to
    // different directories. Folding them into the mesh would invent phantom duplicates and make M1
    // fire on itself; dropping them entirely would erase the axis F3 is about. (The count is read
    // from the plugin registry, never hardcoded — an earlier comment here said "15" and was wrong
    // within a day of signal-watch landing as the 16th.)
    const c = census(fullReg);
    const repoCount = c.rows.find((r) => r.layer === 'plugin').count;
    for (const row of c.rows.filter((r) => !r.inMesh && r.present)) {
      // A DRIFT reading, not a defect reading — and the DIRECTION is the whole difference, which an
      // equality assertion could not express. This is the one true positive among the six reds the
      // 2026-07-28 grading found, and it is kept as a real assertion rather than moved to appendix B.
      //
      // BEHIND (mirror < repo) is the NORMAL, self-clearing state of every checkout that holds a
      // registration not yet published — it is true by construction between `git commit` and the
      // plugin cache refreshing, on the maintainer's machine and on any contributor's. Failing on it
      // makes a red that every contributor inherits through no act of their own, which is exactly the
      // "red is normal" erosion this file was re-graded for. It is REPORTED, loudly, and does not fail.
      //
      // AHEAD (mirror > repo) is a genuine local defect and stays a hard red: the installed copy
      // carries registrations this checkout does not, so the working tree is behind what is already
      // published and the next `publish` would REGRESS the shipped registry.
      if (row.count < repoCount) {
        driftNotes.push(
          `${row.layer} mirror has ${row.count} registration(s); the repo declares ${repoCount}. `
          + 'The installed copy is BEHIND — expected between a registration landing here and a '
          + 'publish; `npm run release` + restart Claude Code refreshes it. Reported, not failed.',
        );
      }
      // VERSION IS THE DISCRIMINATOR THIS CHECK WAS MISSING (ADR-067). A higher mirror count means
      // "you are on an older branch" ONLY when the installed copy is actually newer. It is equally the
      // signature of a deliberate CONSOLIDATION: ADR-067 merged four PreToolUse walls into one gate
      // and legitimately REMOVED four registrations, and this fired as a hard red on the very commit
      // that improved the registry. Counting alone cannot tell a regression from a simplification;
      // comparing the versions can, and refusing to compare them is how a good guard becomes one
      // people learn to override.
      const repoVersion = readVersion(path.join(REPO, 'plugin', '.claude-plugin', 'plugin.json'));
      const mirrorVersion = installedPluginVersion();
      const repoIsNewer = repoVersion && mirrorVersion && cmpVersion(repoVersion, mirrorVersion) > 0;
      if (row.count > repoCount && repoIsNewer) {
        driftNotes.push(
          `${row.layer} mirror has ${row.count} registration(s); the repo declares ${repoCount}, and the `
          + `repo (${repoVersion}) is NEWER than the mirror (${mirrorVersion}). Fewer registrations in a `
          + 'newer tree is a consolidation, not a regression. Reported, not failed.',
        );
      } else {
        expect(
          row.count,
          `${row.layer} mirror has ${row.count} registration(s) but the repo declares only ${repoCount}, `
            + `and the repo (${repoVersion || '?'}) is NOT newer than the mirror (${mirrorVersion || '?'}). `
            + 'The installed copy is AHEAD of this checkout — you are on an older branch, and publishing '
            + 'from here would REGRESS the shipped registry. Rebase onto the branch that shipped them.',
        ).toBeLessThanOrEqual(repoCount);
      }
    }
    expect(c.mesh + c.mirrors).toBe(c.total);
  });

  it('matcher semantics model what Claude Code really does — a SEARCH, which is why the accidents happen', () => {
    // Not a style preference: `Task` selecting TaskStop (F3) and `Write|Edit|MultiEdit` selecting
    // NotebookEdit (F4) are both consequences of substring search, and a lint that modelled full
    // matching would report both registries as clean.
    expect(matchedTools('Task', 'PreToolUse')).toContain('TaskStop');
    expect(matchedTools('Write|Edit|MultiEdit', 'PostToolUse')).toContain('NotebookEdit');
    expect(matchedTools('^(Write|Edit|MultiEdit)$', 'PreToolUse')).not.toContain('NotebookEdit');
    expect(matchedTools('*', 'PreToolUse')).toEqual(['*']);
    expect(matchedTools('startup', 'SessionStart')).toEqual(['*']);   // lifecycle source, not a tool
    expect(isAnchored('^Bash$')).toBe(true);
    expect(isAnchored('Bash')).toBe(false);
    expect(hasFailsafe('node x.mjs || true')).toBe(true);
    expect(hasFailsafe('node x.mjs')).toBe(false);
  });

  it('discovers codex-hooks.json as a repo-owned, in-mesh layer (Dream Cycle 2026-08-20)', () => {
    // BORN RED 2026-08-20: before this candidate, discoverSources() enumerated exactly two
    // repo-owned layers ('plugin', 'project') — codex-hooks.json existed, shipped to strangers, and
    // was invisible to every invariant below. `git show HEAD~1:...hook-registry.mjs` reproduces it.
    const sources = discoverSources({ repo: REPO, includeMachine: false });
    const codex = sources.find((s) => s.layer === 'codex');
    expect(codex, 'no codex layer in discoverSources()').toBeTruthy();
    expect(codex.present).toBe(true);
    expect(codex.inMesh).toBe(true);
    expect(codex.reachesStrangers, 'codex-hooks.json ships in the package.json "files" tree, same as plugin/').toBe(true);
    expect(codex.file.endsWith('codex-hooks.json')).toBe(true);

    const codexRecs = mesh(repoReg.records).filter((r) => r.layer === 'codex');
    const declared = declaredRegistrationCount(codex.file);
    expect(declared).toBe(continuityRegistrations('codex').length);
    expect(codexRecs).toHaveLength(declared);
    // Non-vacuous resolution: every codex record's dispatch id hits hook-shim.mjs's table, so
    // handler/mode/offBehavior come from the SAME declared contract Claude Code uses — not nulls
    // that would make M1/M3/M5/M6 pass merely because nothing was resolved.
    for (const r of codexRecs) {
      expect(r.codexHookId, `${r.locator} resolved no Codex dispatch id`).toBeTruthy();
      expect(r.handler, `${r.locator} (${r.codexHookId}) has no handler`).toBeTruthy();
      expect(OFF_BEHAVIORS, `${r.locator} (${r.codexHookId}) offBehavior not declared`).toContain(r.offBehavior);
      expect(r.codeRoot).toBe('spine');
    }
  });

  it('codexDispatchIdIn() reads the wrapper\'s trailing CLI token, not any earlier quoted word', () => {
    expect(codexDispatchIdIn('node -e "...body..." 4500 session-start')).toBe('session-start');
    expect(codexDispatchIdIn('node -e "...body..." 9000 unprompted-speech UserPromptSubmit')).toBe('unprompted-speech');
    expect(codexDispatchIdIn('node -e "const w=p.join(b,\'codex-hook.mjs\')" 6500 decision-gate write')).toBe('decision-gate');
    expect(codexDispatchIdIn('plain command with no budget/id suffix')).toBeNull();
    expect(codexDispatchIdIn(null)).toBeNull();
  });

  it('the shipped dispatch audit is retired with every other automatic route', () => {
    const dispatch = mesh(repoReg.records).filter((r) => r.layer === 'plugin' && r.handler === 'route-dispatch.sh');
    expect(dispatch).toEqual([]);
  });
});

describe('mesh invariants over the layers this repo OWNS (must stay clean — this is the CI gate)', () => {
  it('M1 — no handler is registered twice from two different code roots on an overlapping (event, tool)', () => {
    const f = lintM1(repoReg.records);
    expect(f, `duplicate handler across code copies:\n  ${show(f)}`).toEqual([]);
  });

  it('M3 — every registration declares a timeout, and any value >60 is a wrong-unit bug by fiat', () => {
    const f = lintM3(repoReg.records);
    expect(f, `timeout defects:\n  ${show(f)}`).toEqual([]);
  });

  it('M5 — every tool-event matcher is anchored, or named in the checked-in allowlist with a reason', () => {
    const f = lintM5(repoReg.records, repoReg.matcherAllowlist);
    expect(f, `unanchored matcher(s) not on the allowlist:\n  ${show(f)}`).toEqual([]);
  });

  it('M5 — and the allowlist carries no fiction: every entry matches a live registration', () => {
    // An amnesty list that outlives the thing it excused is how a ratchet turns into permission.
    const f = lintAllowlistStale(repoReg.records, repoReg.matcherAllowlist);
    expect(f, `stale allowlist entr(ies):\n  ${show(f)}`).toEqual([]);
    expect(repoReg.matcherAllowlist.map((a) => `${a.layer}:${a.event}:${a.matcher}`).sort())
      .toEqual([...new Set(continuityRegistrations().map((s) => `plugin:${s.event}:${s.matcher}`))].sort());
    for (const a of repoReg.matcherAllowlist) {
      expect(a.reason, `allowlist entry ${a.layer}/${a.event}/${a.matcher} has no reason`).toBeTruthy();
      expect(a.retiredBy, `allowlist entry ${a.layer}/${a.event}/${a.matcher} names no exit condition`).toBeTruthy();
    }
  });

  it('M6 — every registration declares an offBehavior, through the shim table or hook-contracts.json', () => {
    const f = lintM6(repoReg.records);
    expect(f, `no declared brain-OFF behaviour:\n  ${show(f)}`).toEqual([]);
    for (const r of mesh(repoReg.records)) expect(OFF_BEHAVIORS).toContain(r.offBehavior);
  });

  it('M6 — every continuity contract is explicit and matches the enforcing policy', () => {
    const doc = JSON.parse(fs.readFileSync(path.join(REPO, 'plugin/hooks/hook-contracts.json'), 'utf8'));
    expect(doc.contracts.map((c) => `${c.event}:${c.id}`).sort()).toEqual(continuityContractIds().sort());
    expect(doc.matcherAllowlist).toHaveLength(
      new Set(continuityRegistrations().map((s) => `${s.event}:${s.matcher}`)).size);
    // The file must also still SAY what the plane is, in a form a reader can check against the code.
    expect(doc._version).toBeGreaterThanOrEqual(4);
    expect(doc._eventOwners.map((row) => `${row.event}:${row.owner}`).sort()).toEqual(continuityContractIds().sort());
  });

  it('registers the guarded Stop continuation on both hosts, and Stop capture where it is proven', () => {
    const stops = mesh(repoReg.records).filter((r) => r.event === 'Stop');
    const byLayer = new Map();
    for (const s of stops) byLayer.set(s.layer, [...(byLayer.get(s.layer) ?? []), `${s.locator} ${s.handler}`]);
    expect([...byLayer.keys()].sort()).toEqual(['codex', 'plugin']);
    // The policy is the authority on how many Stop handlers each host carries, derived (never
    // hand-listed) so a future registration change is covered the moment it lands. Codex Stop
    // DELIVERY itself was not observed by the 2026-09-11 probe for the NATURAL-completion case, but
    // continuation-gate was already registered there before that probe and stays; grounding-turn-gate
    // joined it 2026-09-12 on the same PreToolUse/PostToolUse-adjacent Stop path continuation-gate
    // already proved reachable (see continuity-hook-policy.mjs's header for the measurement).
    const expectedCodexStops = continuityRegistrations('codex').filter((s) => s.event === 'Stop').length;
    const expectedStops = continuityRegistrations('claude').filter((s) => s.event === 'Stop').length
      + expectedCodexStops;
    expect(stops).toHaveLength(expectedStops);
    expect(byLayer.get('codex')).toHaveLength(expectedCodexStops);
  });
});

describe('falsifiability — every invariant proven to fail on a seeded violation (ADR-055 §7.15)', () => {
  // An invariant nobody has watched fail is a claim. Each case below feeds the REAL lint function a
  // record set with one seeded defect, and asserts it goes red — and that removing the defect makes
  // it green again, so the rule is bound to the defect and not to the fixture's mere existence.
  const rec = (over = {}) => ({
    layer: 'plugin', file: 'x', locator: 'x:1', event: 'PreToolUse', matcher: '^Bash$', command: 'node a.mjs',
    timeout: 5, mode: 'blocking', offBehavior: 'run', reachesStrangers: true, inMesh: true,
    handler: 'a.mjs', codeRoot: 'spine', effectiveMode: 'blocking', anchored: true, tools: ['Bash'], ...over,
  });

  it('M1 goes red when one handler appears from two code roots — and green from one', () => {
    const clash = [rec(), rec({ layer: 'user', codeRoot: 'marketplace-clone', locator: 'y:2' })];
    expect(lintM1(clash)).toHaveLength(1);
    expect(lintM1(clash)[0].blocking).toBe(true);
    expect(lintM1([rec(), rec({ layer: 'user', locator: 'y:2' })]), 'same root = one behaviour').toEqual([]);
  });

  it('M3 goes red on a missing timeout AND on a milliseconds-intent value in a seconds field', () => {
    expect(lintM3([rec({ timeout: null })])[0].kind).toBe('missing');
    expect(lintM3([rec({ timeout: 5000 })])[0].kind).toBe('wrong-unit');
    expect(lintM3([rec({ timeout: 60 })]), '60 is the boundary and is legal').toEqual([]);
  });

  it('M5 goes red on an unanchored tool matcher, green when allowlisted, green on a lifecycle event', () => {
    const bad = rec({ matcher: 'Bash', anchored: false, tools: ['Bash', 'BashOutput'] });
    expect(lintM5([bad], [])).toHaveLength(1);
    expect(lintM5([bad], [{ layer: 'plugin', event: 'PreToolUse', matcher: 'Bash', handler: 'a.mjs' }])).toEqual([]);
    expect(lintM5([rec({ event: 'SessionStart', matcher: 'startup', anchored: false })], [])).toEqual([]);
  });

  it('M5-stale goes red on an allowlist entry that matches nothing', () => {
    expect(lintAllowlistStale([rec()], [{ layer: 'plugin', event: 'PreToolUse', matcher: 'ghost', reason: 'r' }])).toHaveLength(1);
  });

  it('M6 goes red on an undeclared offBehavior and on a misspelled one', () => {
    expect(lintM6([rec({ offBehavior: null })])).toHaveLength(1);
    expect(lintM6([rec({ offBehavior: 'quiet' })]), 'a value outside the contract is not a declaration').toHaveLength(1);
    expect(lintM6([rec({ offBehavior: 'partial' })])).toEqual([]);
  });

  it('every invariant ignores the code-copy mirrors — otherwise it fires on itself', () => {
    const mirror = rec({ layer: 'marketplace-clone', inMesh: false, timeout: null, offBehavior: null, codeRoot: 'marketplace-clone' });
    expect(lintM1([rec(), mirror])).toEqual([]);
    expect(lintM3([mirror])).toEqual([]);
    expect(lintM6([mirror])).toEqual([]);
  });
});

describe('the Stop off-contract is HONOURED, not merely declared (ADR-054 §3 applied to F5)', () => {
  // The shim table now says `offBehavior: 'run'` for continuation-gate. That is a string in a file.
  // These two cases drive the REAL shim as a subprocess against a REAL brain-off sentinel, because
  // the only thing that makes an off-contract worth declaring is that the machine obeys it.
  const roots = [];
  afterAll(() => { for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true }); });
  const sessionId = 'mesh-explicit-objective';
  const fire = (id, { off, ledger, home, payload = {} }) => {
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: path.join(REPO, 'plugin'),
      RUVNET_BRAIN_HOME: path.join(home, 'brain'),
      RUVNET_BRAIN_STATE_DIR: path.join(home, 'cfg'),
      RUVNET_CONTINUATION_COOLDOWN_MS: '0',
      RUVNET_OPEN_ISSUES_FILE: path.join(home, 'no-open-issues.json'),
    };
    if (ledger) env.RUVNET_WORK_LEDGER = ledger;
    if (off) fs.writeFileSync(path.join(home, 'cfg', 'brain-off'), '');
    const r = spawnSync('node', [SHIM, id], {
      input: JSON.stringify({ hook_event_name: 'Stop', cwd: home,
        stop_hook_active: false, session_id: sessionId, ...payload }),
      encoding: 'utf8', env, timeout: 15000,
    });
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };

  const scratch = () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-off-'));
    roots.push(home);
    fs.mkdirSync(path.join(home, 'cfg'), { recursive: true });
    const ledger = path.join(home, 'ledger.json');
    const at = new Date().toISOString();
    const identity = continuationProjectIdentity(home);
    // Explicit fixture consent, not authority inferred from an open legacy backlog row.
    fs.writeFileSync(ledger, JSON.stringify({ items: [{ text: 'an open commitment', done: false, at }],
      objective: { schemaVersion: 1, kind: 'continuation-preferences', authoritative: false,
        id: 'mesh-objective', text: 'an open commitment', at, state: 'active',
        projectId: identity.projectId, worktreeIds: [identity.worktreeId], sessionIds: [sessionId],
        authorization: { kind: 'user', reference: 'fixture-explicit-user-request' } } }));
    return { home, ledger };
  };

  it('brain ON: the gate fires through the shim and its envelope reaches STDOUT (the control)', () => {
    const { home, ledger } = scratch();
    const r = fire('continuation-gate', { off: false, ledger, home });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.hookEventName).toBe('Stop');
    expect(r.stdout).toContain('an open commitment');
  });

  it('brain OFF: it STILL fires — honesty about open work is not a retrieval feature', () => {
    const { home, ledger } = scratch();
    const r = fire('continuation-gate', { off: true, ledger, home });
    expect(r.code).toBe(0);
    expect(r.stdout, 'declared run, behaved silent — the declaration would be decoration').toContain('an open commitment');
  });

  it('brain OFF: a `silence` entry under the SAME sentinel writes zero bytes — otherwise "run" proves nothing', () => {
    const { home } = scratch();
    const r = fire('md-stamp', { off: true, home });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });
  it.each([{ stop_hook_active: true }, { cancelled: true }, { session_id: 'unapproved-session' }])(
    'brain OFF does not bypass continuation safety: %j', (payload) => {
      const { home, ledger } = scratch();
      const r = fire('continuation-gate', { off: true, home, ledger, payload });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
    },
  );
});

/**
 * APPENDIX B — observational diagnostics for files this repository does not own.
 *
 * Product-owned registrations remain enforced by the invariant suite above.
 * Foreign findings are printed whether present or resolved. A host repair must never
 * make product QA fail, and a broken foreign configuration must never be a prerequisite
 * for a passing suite. Deterministic fixtures below prove the detectors retain teeth.
 * Stop registrations from Claude and Codex are inventory, not competing callbacks.
 */
const appendixB = [];

describe('foreign diagnostics detect defects and clear after repair', () => {
  const broken = { inMesh: true, layer: 'third-party:fixture', event: 'PreToolUse',
    matcher: 'Task', anchored: false, timeout: null, offBehavior: null,
    locator: 'fixture:1', handler: 'fixture.mjs', tools: ['Task', 'TaskStop'] };
  const fixed = { ...broken, matcher: '^(Task|Agent)$', anchored: true,
    timeout: 5, offBehavior: 'silence', tools: ['Task', 'Agent'] };
  for (const [name, lint] of [['timeouts', lintM3], ['matchers', lintM5], ['off behavior', lintM6]]) {
    it(`${name}: broken -> corrected -> broken remains falsifiable`, () => {
      expect(lint([broken])).toHaveLength(1);
      expect(lint([fixed])).toEqual([]);
      expect(lint([broken])).toHaveLength(1);
    });
  }
});

/** Preserve live findings independently of the product gate outcome. */
const record = (id, ownerAction, findings) => {
  appendixB.push({ id, ownerAction, findings });
  return findings;
};

describe.skipIf(MACHINE_SKIP_REASON)(
  `the FULL merged mesh, this machine — diagnostics (ADR-055 appendix B)${MACHINE_SKIP_REASON ? ` — SKIPPED: ${MACHINE_SKIP_REASON}` : ''}`,
  () => {
    afterAll(() => {
      // Findings remain visible without making a repaired host fail the product suite.
      const lines = appendixB.map(({ id, ownerAction, findings }) => [
        `${id} — ${findings.length} observation(s)${findings.length === 0 ? ' — clear' : ''}`,
        ...ownerAction.map((l) => `    ${l}`),
        ...findings.map((x) => `    ${typeof x === 'string' ? x : JSON.stringify(x)}`),
      ].join('\n'));
      // stderr, not console.log — MEASURED on vitest 4.1.10: the default reporter drops
      // `console.log` on a passing file, and this block's whole purpose now is to be READ while the
      // suite is green. See the same note on the census block's afterAll.
      process.stderr.write(
        `\n── ADR-055 appendix B — ${appendixB.length} documented condition(s) in files this repo does not own ──\n`
        + `${lines.join('\n\n')}\n`,
      );
    });

    it('the merged mesh includes every present registry that declares a hook (F16)', () => {
      const expectedFiles = fullReg.sources
        .filter((source) => source.present && source.inMesh && declaredRegistrationCount(source.file) > 0)
        .map((source) => source.file)
        .sort();
      const representedFiles = [...new Set(mesh(fullReg.records).map((record) => record.file))].sort();
      expect(fullReg.errors, 'a malformed present registry makes the merged census incomplete').toEqual([]);
      expect(representedFiles, 'every present mesh registry with declared hooks must be represented').toEqual(expectedFiles);
      expect(foreignRegs.length, 'the machine block must include at least one non-plugin registration').toBeGreaterThan(0);
    });

    it('F3 — report overlapping registrations in the merged mesh', () => {
      const f = record('F3', ['Inspect duplicate registrations within the affected host.'], lintM1(fullReg.records));
      expect(Array.isArray(f)).toBe(true);
    });

    it('F18 — report third-party timeout findings without requiring defects to persist', () => {
      const f = record('F18', [
        'OWNER ACTION: these are Anthropic\'s and Vercel\'s plugins, not ours — the fix is upstream',
        '(or disabling the plugin), never a local edit to a stranger\'s registry. Recorded because a',
        '600s default on a prompt-path hook is the exact failure ADR-053 shipped a timeout lint for:',
      ], lintM3(fullReg.records));
      expect(Array.isArray(f)).toBe(true);
    });

    it('F3/F4 — report foreign matcher findings in both broken and corrected environments', () => {
      const f = record('F3/F4', [
        'OWNER ACTION: the user-layer entries are yours to anchor; the third-party ones are upstream.',
        'NOT allowlisted on purpose — this repo\'s allowlist covers registrations this repo ships, and',
        'excusing someone else\'s matcher in our file would be recording a decision we cannot make:',
      ], lintM5(fullReg.records, fullReg.matcherAllowlist));
      expect(Array.isArray(f)).toBe(true);
    });

    it('F14 — report foreign brain-OFF declarations without gating product source', () => {
      const f = record('F14', [
        'OWNER ACTION (ADR-055 build item 8): the two walls that belong to this product',
        '(ground-before-write, route-dispatch) move into the shipped plugin, where the shim table',
        'declares their off-contract natively. The rest are third-party and stay undeclared —',
        'honestly enumerated rather than silently assumed silent:',
      ], lintM6(fullReg.records));
      expect(Array.isArray(f)).toBe(true);
    });

    it('F19 — inventory Stop registrations separately for the two host runtimes', () => {
      const stops = record('F19', [
        'INVENTORY ONLY: Claude and Codex registrations do not execute in one shared turn.',
        'Assess competing Stop behavior within each host, never from the cross-host total:',
      ], mesh(fullReg.records).filter((r) => r.event === 'Stop')
        .map((r) => `${r.layer} ${r.locator} ${r.handler}${r.asyncRewake ? ' [asyncRewake]' : ''}`));
      expect(Array.isArray(stops)).toBe(true);
    });
  },
);
