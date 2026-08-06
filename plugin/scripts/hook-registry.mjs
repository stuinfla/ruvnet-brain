#!/usr/bin/env node
/**
 * hook-registry.mjs — the MERGED hook registry census (ADR-055 §7 M1, build item #1).
 *
 * WHY THIS EXISTS. Every hook test in this repo before today read exactly ONE file:
 * `plugin/hooks/hooks.json` (hook-contract.test.mjs:43). That is not the mesh. On this machine a
 * live session loads **six** registries, and the five it could not see are where the defects were:
 * an untimed blocking `Task|Agent` wall in the user layer, a stale project-level Stop override whose
 * own `_note` says delete me, thirteen third-party handlers with no timeout at all, and a
 * third-party `SessionStart` carrying `timeout: 180`. ADR-055 F16 names this precisely — "the test
 * suite cannot see the merged registry" — and a suite that cannot see a layer cannot go red on it.
 *
 * WHAT IT DOES. Enumerates EVERY hook registration a session actually loads and normalizes each one
 * to a single flat record, so an invariant can be stated once and evaluated over all layers:
 *
 *   { layer, file, locator, event, matcher, command, timeout, mode, offBehavior, reachesStrangers }
 *
 * plus the derived fields the lint needs (`handler`, `shimId`, `codeRoot`, `hasFailsafe`,
 * `declaredMode`, `tools`, `anchored`, `asyncRewake`, `contractSource`).
 *
 * THE SIX REGISTRIES (ADR-055 appendix A), and one deliberate split:
 *
 *   layer                | file                                                    | inMesh
 *   ---------------------|---------------------------------------------------------|-------
 *   plugin               | <repo>/plugin/hooks/hooks.json                          | yes
 *   user                 | ~/.claude/settings.json                                 | yes
 *   project              | <repo>/.claude/settings.json                            | yes
 *   third-party:<name>   | <plugin install>/hooks/hooks.json (enabled plugins only)| yes
 *   plugin-installed     | ~/.claude/plugins/cache/ruvnet-brain/<v>/hooks/hooks.json | NO (mirror)
 *   marketplace-clone    | ~/.claude/plugins/marketplaces/ruvnet-brain/…/hooks.json | NO (mirror)
 *
 * The last two are the SAME registrations as `plugin`, delivered as different code copies — the
 * repo copy is the preimage, the cache copy is what Claude Code booted, the marketplace clone is
 * what the user layer's own commands execute from. Counting all three in the mesh would invent 30
 * phantom duplicates and make M1 fire on itself. They are enumerated (you cannot reason about
 * "which code copy" without seeing them), reported, and DRIFT-checked — but excluded from the
 * duplicate analysis, which asks a different question: is one HANDLER registered twice, from two
 * different code roots, on an overlapping (event, tool) pair? That is F3 (route-dispatch: plugin
 * shim + user layer's marketplace-clone copy) and F6 (continuation-gate: plugin + project).
 *
 * CI vs THIS MACHINE. `plugin` and `project` live in the repo and exist everywhere. The other four
 * are machine-local and simply absent in CI — `discoverSources()` reports them as `present: false`
 * rather than throwing, and the caller decides what that means. `--machine=0` (or CI=true) drops
 * them explicitly, which is how the lint keeps CI green while still biting on this laptop.
 *
 * MODE IS DERIVED FROM CONTRACTS, NOT FROM VIBES. `declaredMode`/`offBehavior` come from exactly two
 * authorities: `plugin/scripts/hook-shim.mjs`'s dispatch TABLE (parsed — it IS the authority, same
 * approach wired-check.mjs already takes) and the checked-in `plugin/hooks/hook-contracts.json` for
 * everything outside the shim. When neither declares one, `declaredMode` is null — that is M6's
 * finding, not something to paper over with a guess. `effectiveMode` is separate and honest about
 * being an inference: a command with no `|| true` tail CAN return a non-zero status to the harness,
 * so it is blocking-CAPABLE whatever anyone intended. M1 uses that, because the harness does.
 *
 *   node scripts/hook-registry.mjs              # census table
 *   node scripts/hook-registry.mjs --json       # every normalized record
 *   node scripts/hook-registry.mjs --machine=0  # repo-owned layers only (what CI sees)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * THE DEFAULT ROOT, RESOLVED BY PROBE — because this file now lives inside the payload, and `..`
 * means two different things there (2026-08-06, the L4 payload-boundary move).
 *
 * This was `path.resolve(HERE, '..')` when the module sat at `<src>/scripts/`, where that expression
 * gave the repo root. Moving the file to `<src>/plugin/scripts/` — so the Stable Spine and the Codex
 * install carry it at all — silently REDEFINED it to `<src>/plugin`, and every default-argument
 * consumer below (discoverSources's `plugin`/`project` layers, shimTable, loadContracts,
 * capability-registry's dispatchGateWiring) would then look for `plugin/hooks/hooks.json` under
 * `<src>/plugin/` and find nothing. None of them throw on a missing file: they return present:false
 * / {} / no contracts. The census would have gone QUIET rather than red — the same shape of failure
 * as the inert hook this move exists to fix.
 *
 * So ask the filesystem instead of asserting, the same discipline shimTable()/loadContracts() below
 * already apply per call. `plugin/hooks/hooks.json` exists only under a source checkout's ROOT; in a
 * flattened install the payload IS the root and carries `hooks/hooks.json`. Measured layouts:
 *
 *   <src>/plugin/scripts/hook-registry.mjs             → ../.. = <src>       holds plugin/hooks/  ✓
 *   ~/.cache/ruvnet-brain/versions/<gen>/scripts/…      → ../.. = …/versions  does not             → ..
 *   ~/.claude/plugins/cache/…/<ver>/scripts/…           → ../.. = …/ruvnet-brain does not          → ..
 */
function resolveRoot(here) {
  const checkout = path.resolve(here, '..', '..');
  if (fs.existsSync(path.join(checkout, 'plugin', 'hooks', 'hooks.json'))) return checkout;
  return path.resolve(here, '..');
}
export const REPO = resolveRoot(HERE);

/** Events whose matcher selects a TOOL. Everything else matches a lifecycle source, not a tool. */
export const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

/**
 * The tool names a matcher can select. Not exhaustive of Claude Code's surface and not meant to be:
 * it is the set this repo's walls actually reason about, plus the two names that caused real
 * accidents — `NotebookEdit` (caught by the unanchored `Write|Edit|MultiEdit` substring, F4) and
 * `TaskStop` (caught by the unanchored `Task`, F3). A tool missing from this list can only make the
 * duplicate analysis MISS a pair, never invent one, so the list is safe to extend.
 */
export const TOOLS = Object.freeze([
  'Task', 'TaskStop', 'Agent', 'Bash', 'BashOutput', 'Read', 'Write', 'Edit', 'MultiEdit',
  'NotebookEdit', 'NotebookRead', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'Skill',
]);

/** `*` and `.*` and `` are Claude Code's "everything" spellings; `*` is not a legal regex. */
const WILDCARDS = new Set(['', '*', '.*']);

/**
 * Which tools a matcher selects. Claude Code SEARCHES the tool name with the matcher as a regex
 * (not a full match) — which is exactly why `Task` also hits `TaskStop` and `Edit` also hits
 * `MultiEdit`/`NotebookEdit`. Modelling it as `.test()` reproduces the real semantics, including
 * the accidents. An unparseable matcher returns `['?']` so it lands in its own bucket instead of
 * silently colliding with everything.
 */
export function matchedTools(matcher, event) {
  if (!TOOL_EVENTS.has(event)) return ['*'];
  const m = (matcher ?? '').trim();
  if (WILDCARDS.has(m)) return ['*'];
  let re;
  try { re = new RegExp(m); } catch { return ['?']; }
  const hits = TOOLS.filter((t) => re.test(t));
  return hits.length ? hits : ['?'];
}

/** Anchored = pinned at both ends. `^(Write|Edit)$` yes; `Write|Edit` no; `Task` no. */
export function isAnchored(matcher) {
  const m = (matcher ?? '').trim();
  return m.startsWith('^') && m.endsWith('$');
}

/** A trailing `|| true` (or `; true`) forces exit 0 — the harness can never see a refusal. */
export function hasFailsafe(command) {
  return /(\|\||;)\s*true\s*$/.test((command ?? '').trim());
}

/** Script basenames named literally in a command string, in order. */
export function basenamesIn(command) {
  return (command ?? '').match(/[\w.-]+\.(?:mjs|sh|py|cjs|js|cmd)\b/g) || [];
}

/** The hook-shim dispatch id, when this command routes through the shim. */
export function shimIdIn(command) {
  const m = (command ?? '').match(/hook-shim\.mjs["'`]?\s+([a-zA-Z][\w-]*)/);
  return m ? m[1] : null;
}

/**
 * hook-shim.mjs's dispatch TABLE, parsed rather than re-implemented — it is the authority for
 * `mode` and `offBehavior` on every shim-routed registration (ADR-054 §3: the OFF contract lives in
 * that table as DATA). Each entry is a single-line object literal by convention, which
 * brain-off.test.mjs already relies on.
 */
export function shimTable(repo = REPO) {
  let src = '';
  // TWO LAYOUTS, ONE PARSER. In the checkout the payload sits under `plugin/`; in a PACKED install
  // (~/.claude/plugins/cache/ruvnet-brain/ruvnet-brain/<v>/) the payload IS the root — `scripts/` and
  // `hooks/` hang directly off it. The self-check reads the INSTALLED tree on a stranger's machine,
  // so the authority-parser has to resolve both or it silently returns {} there and every mode/
  // offBehavior assertion degrades to "undeclared" — a hand-copied list by omission.
  for (const rel of ['plugin/scripts/hook-shim.mjs', 'scripts/hook-shim.mjs']) {
    try { src = fs.readFileSync(path.join(repo, rel), 'utf8'); break; } catch { /* try next layout */ }
  }
  if (!src) return {};
  const table = {};
  const re = /'([\w-]+)':\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(src))) {
    const [, id, body] = m;
    const field = (name) => body.match(new RegExp(`${name}:\\s*'([\\w.-]+)'`))?.[1] ?? null;
    if (!field('file')) continue; // not a dispatch entry
    table[id] = {
      file: field('file'),
      interpreter: field('interpreter'),
      mode: field('mode'),
      offBehavior: field('offBehavior'),
    };
  }
  return table;
}

/** The checked-in out-of-shim contract file (ADR-055 §6). Missing file → no contracts, not a throw. */
export function loadContracts(repo = REPO) {
  // Same two-layout rule as shimTable() above — checkout (`plugin/hooks/`) or packed install
  // (`hooks/`). Absence stays a non-throw empty result: on a packed install that predates this file
  // the honest answer is "no out-of-shim contracts shipped here", not a crash and not an invention.
  const candidates = ['plugin/hooks/hook-contracts.json', 'hooks/hook-contracts.json']
    .map((rel) => path.join(repo, rel));
  const file = candidates.find((f) => fs.existsSync(f)) ?? candidates[0];
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      file,
      contracts: Array.isArray(doc.contracts) ? doc.contracts : [],
      matcherAllowlist: Array.isArray(doc.matcherAllowlist) ? doc.matcherAllowlist : [],
    };
  } catch {
    return { file, contracts: [], matcherAllowlist: [] };
  }
}

/** Does a contract entry describe this registration? All declared fields must match. */
export function contractMatches(contract, rec) {
  if (contract.layer && contract.layer !== rec.layer) return false;
  if (contract.event && contract.event !== rec.event) return false;
  if (contract.matcher !== undefined && contract.matcher !== (rec.matcher ?? '')) return false;
  if (contract.commandIncludes && !rec.command.includes(contract.commandIncludes)) return false;
  return Boolean(contract.commandIncludes || contract.event);
}

/** 1-based line of the `occurrence`-th literal appearance of a JSON string value. 0 if not found. */
function lineOfValue(raw, value, occurrence) {
  const needle = JSON.stringify(value);
  let idx = -1;
  for (let i = 0; i <= occurrence; i += 1) {
    idx = raw.indexOf(needle, idx + 1);
    if (idx === -1) return 0;
  }
  return raw.slice(0, idx).split('\n').length;
}

/**
 * Every `{ hooks: { <Event>: [ { matcher, hooks: [ {command, timeout, ...} ] } ] } }` document —
 * the shape plugin hooks.json and every settings.json share. Returns raw registration tuples.
 */
function readRegistrations(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const doc = JSON.parse(raw);
  const node = doc.hooks ?? doc; // settings.json nests under .hooks; a bare hooks map is accepted too
  const out = [];
  const seen = new Map(); // command → how many times already located, so repeats get distinct lines
  for (const [event, entries] of Object.entries(node)) {
    if (!Array.isArray(entries)) continue;
    for (const group of entries) {
      for (const h of group?.hooks ?? []) {
        if (typeof h?.command !== 'string') continue;
        const n = seen.get(h.command) ?? 0;
        seen.set(h.command, n + 1);
        out.push({
          event,
          matcher: group.matcher ?? '',
          command: h.command,
          timeout: typeof h.timeout === 'number' ? h.timeout : null,
          asyncRewake: h.asyncRewake === true,
          async: h.async === true,
          if: typeof h.if === 'string' ? h.if : null,
          line: lineOfValue(raw, h.command, n),
        });
      }
    }
  }
  return out;
}

/**
 * The ruvnet-brain plugin copy Claude Code actually booted, if this machine has one installed.
 * Exported because the post-install self-check (scripts/selfcheck.mjs) must read the INSTALLED
 * hooks.json rather than the repo's — a stranger's machine has no checkout, and a self-check that
 * reads the preimage instead of the booted copy is the adjacent-door defect ADR-055 F16 names.
 */
export function installedPluginHooks(home = os.homedir()) {
  const base = path.join(home, '.claude', 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain');
  let versions = [];
  try { versions = fs.readdirSync(base); } catch { return null; }
  const hits = versions
    .map((v) => path.join(base, v, 'hooks', 'hooks.json'))
    .filter((p) => fs.existsSync(p));
  if (!hits.length) return null;
  // Newest mtime wins — several generations can sit in the cache at once.
  hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return hits[0];
}

/** Enabled third-party plugins that register hooks, read from the machine's own plugin state. */
function thirdPartySources(home) {
  const settings = readJsonSafe(path.join(home, '.claude', 'settings.json')) ?? {};
  const enabled = settings.enabledPlugins ?? {};
  const installed = readJsonSafe(path.join(home, '.claude', 'plugins', 'installed_plugins.json'));
  if (!installed?.plugins) return [];
  const out = [];
  for (const [key, entries] of Object.entries(installed.plugins)) {
    if (enabled[key] !== true) continue;                // CC only loads enabled plugins
    if (key.startsWith('ruvnet-brain@')) continue;      // ours — enumerated as `plugin` + mirrors
    for (const e of entries) {
      if (e.scope !== 'user') continue;                 // project-scoped installs belong to that project
      const file = path.join(e.installPath ?? '', 'hooks', 'hooks.json');
      if (!fs.existsSync(file)) continue;
      out.push({ layer: `third-party:${key.split('@')[0]}`, file, role: 'active', inMesh: true, reachesStrangers: false, machineLocal: true });
      break;
    }
  }
  return out.sort((a, b) => a.layer.localeCompare(b.layer));
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Every registry a session on this machine loads, plus the two code-copy mirrors of our own plugin.
 * `includeMachine: false` returns only the two the repo owns — exactly what a CI runner has.
 */
export function discoverSources({ repo = REPO, home = os.homedir(), includeMachine = true } = {}) {
  // TWO LAYOUTS, ONE CENSUS — the identical rule shimTable() and loadContracts() above already state,
  // which this function was the only one of the three NOT to apply. In a checkout the payload sits
  // under `plugin/`; in a packed install (the Spine's versions/<gen>/, the plugin cache's <ver>/) the
  // payload IS the root and `hooks/` hangs directly off it. Resolving only the first form made the
  // `plugin` layer — the one row that `reachesStrangers` — report present:false on every real install,
  // so the mesh census silently described a machine with no shipped hooks at all.
  const pluginHooks = ['plugin/hooks/hooks.json', 'hooks/hooks.json']
    .map((rel) => path.join(repo, rel));
  const sources = [
    { layer: 'plugin', file: pluginHooks.find((f) => fs.existsSync(f)) ?? pluginHooks[0], role: 'shipped', inMesh: true, reachesStrangers: true, machineLocal: false },
    { layer: 'project', file: path.join(repo, '.claude/settings.json'), role: 'active', inMesh: true, reachesStrangers: false, machineLocal: false },
  ];
  if (includeMachine) {
    sources.push({ layer: 'user', file: path.join(home, '.claude/settings.json'), role: 'active', inMesh: true, reachesStrangers: false, machineLocal: true });
    sources.push(...thirdPartySources(home));
    const installed = installedPluginHooks(home);
    if (installed) sources.push({ layer: 'plugin-installed', file: installed, role: 'mirror', inMesh: false, reachesStrangers: false, machineLocal: true });
    sources.push({ layer: 'marketplace-clone', file: path.join(home, '.claude/plugins/marketplaces/ruvnet-brain/plugin/hooks/hooks.json'), role: 'mirror', inMesh: false, reachesStrangers: false, machineLocal: true });
  }
  return sources.map((s) => ({ ...s, present: fs.existsSync(s.file) }));
}

/**
 * The census. One normalized record per registration, across every present source.
 * Returns { records, sources, errors } — a malformed registry is an `errors` row, never a throw:
 * a census that dies on one bad file tells you nothing about the other five.
 */
export function buildRegistry({ repo = REPO, home = os.homedir(), includeMachine = true } = {}) {
  const sources = discoverSources({ repo, home, includeMachine });
  const table = shimTable(repo);
  const { contracts, matcherAllowlist, file: contractsFile } = loadContracts(repo);
  const records = [];
  const errors = [];

  for (const src of sources) {
    if (!src.present) continue;
    let regs;
    try { regs = readRegistrations(src.file); } catch (e) { errors.push({ file: src.file, layer: src.layer, error: String(e.message ?? e) }); continue; }
    for (const r of regs) {
      const shimId = shimIdIn(r.command);
      const shim = shimId ? table[shimId] : null;
      const base = {
        layer: src.layer,
        file: src.file,
        locator: `${path.basename(src.file)}:${r.line}`,
        event: r.event,
        matcher: r.matcher,
        command: r.command,
        timeout: r.timeout,
        reachesStrangers: src.reachesStrangers,
      };
      const rec = {
        ...base,
        // ── derived, in the order the lint reads them ──
        role: src.role,
        inMesh: src.inMesh,
        machineLocal: src.machineLocal,
        shimId,
        handler: shim?.file ?? basenamesIn(r.command).filter((b) => b !== 'hook-shim.mjs').pop() ?? null,
        hasFailsafe: hasFailsafe(r.command),
        anchored: isAnchored(r.matcher),
        tools: matchedTools(r.matcher, r.event),
        asyncRewake: r.asyncRewake,
        if: r.if,
        mode: null,
        offBehavior: null,
        contractSource: null,
      };
      if (shim) {
        rec.mode = shim.mode;
        rec.offBehavior = shim.offBehavior;
        rec.contractSource = 'shim-table';
      } else {
        const c = contracts.find((x) => contractMatches(x, rec));
        if (c) {
          rec.mode = c.mode ?? null;
          rec.offBehavior = c.offBehavior ?? null;
          rec.contractSource = 'hook-contracts.json';
          rec.contract = c;
        }
      }
      // The harness's own view, independent of what anyone declared: no failsafe → the exit code
      // reaches Claude Code, so this registration CAN block whatever its author meant.
      rec.effectiveMode = rec.mode ?? (rec.hasFailsafe ? 'advisory' : 'blocking-capable');
      // Which code copy the body comes from — the axis F3/F6 are about.
      rec.codeRoot = codeRootOf(rec, repo, home);
      records.push(rec);
    }
  }
  return { records, sources, errors, contractsFile, matcherAllowlist, shimTable: table };
}

/**
 * The code copy a registration executes from. This is the axis that makes a duplicate a DEFECT
 * rather than a harmless repeat: two registrations of the same handler from ONE root are one
 * behavior; from TWO roots they are two behaviors that can disagree the moment one copy updates.
 */
export function codeRootOf(rec, repo = REPO, home = os.homedir()) {
  const c = rec.command;
  if (c.includes('${CLAUDE_PLUGIN_ROOT}')) {
    // Shim-routed commands resolve their BODY from the active spine generation, not from the
    // plugin root — that indirection is the whole point of ADR-023.
    return rec.shimId ? 'spine' : 'plugin-root';
  }
  // The SCRIPT path, not the interpreter's: `/bin/bash "/Users/…/route-dispatch.sh"` names two
  // absolute paths and only the second one says which copy of the code runs. Taking the first
  // reported every user-layer hook as living in /bin, which would have hidden F3's whole point.
  const paths = c.match(/\/[^\s"']+/g) ?? [];
  const p = paths.find((x) => /\.(?:mjs|sh|py|cjs|js|cmd)$/.test(x)) ?? paths[0];
  if (!p) return 'unknown';
  if (p.startsWith(path.join(home, '.claude/plugins/marketplaces'))) return 'marketplace-clone';
  if (p.startsWith(path.join(home, '.claude/plugins/cache'))) return 'plugin-cache';
  if (p.startsWith(path.join(home, '.claude/hooks'))) return 'user-hooks';
  if (p.startsWith(path.join(home, '.claude/skills'))) return 'user-skills';
  if (p.startsWith(repo)) return 'repo-checkout';
  // No guessing beyond this point: the owning directory IS the identity of the code copy, and
  // naming it verbatim keeps "two roots" an exact comparison instead of a bucketing heuristic.
  return `dir:${path.dirname(p)}`;
}

/** Per-layer totals, in the shape ADR-055 appendix A states them. */
export function census(reg) {
  const byLayer = new Map();
  for (const s of reg.sources) byLayer.set(s.layer, { layer: s.layer, file: s.file, present: s.present, inMesh: s.inMesh, count: 0 });
  for (const r of reg.records) byLayer.get(r.layer).count += 1;
  const rows = [...byLayer.values()];
  return {
    rows,
    mesh: rows.filter((r) => r.inMesh).reduce((n, r) => n + r.count, 0),
    mirrors: rows.filter((r) => !r.inMesh).reduce((n, r) => n + r.count, 0),
    total: reg.records.length,
  };
}

// ── THE MESH INVARIANTS (ADR-055 §7) ────────────────────────────────────────────────────────────
//
// Each is a PURE function from records → findings, for three reasons that all matter:
//   1. one implementation, shared by the vitest lint and by any future pre-push/CI gate — the
//      "adjacent door" defect (F16) is exactly what happens when a gate and its test are two
//      different code paths;
//   2. a finding carries its own evidence (layer, locator, what was expected) so a refusal is
//      actionable rather than a boolean;
//   3. they can be fed SYNTHETIC records, which is how §7.15 falsifiability is proven — break the
//      input, watch the invariant go red. An invariant that has never been shown to fail is a
//      claim, not a check.
// `mesh(records)` is the shared filter: the mirrors are the same registrations delivered twice, and
// counting them would make every invariant fire on itself.

export const mesh = (records) => records.filter((r) => r.inMesh);

/**
 * M1 — no HANDLER is registered twice, on an overlapping (event, tool), FROM TWO DIFFERENT CODE
 * ROOTS. Two registrations of one handler from one root are one behavior. From two roots they are
 * two behaviors that diverge the instant one copy updates — and one of them is invisible to the
 * other's tests. Live instances (ADR-055 F3, F6): route-dispatch.sh registered by the plugin
 * (body resolved from the spine) AND by the user layer (body from the marketplace clone);
 * continuation-gate.mjs registered by the plugin AND by this repo's own project settings.
 * `blocking: true` marks the severe class — two walls that can both refuse the same call.
 */
export function lintM1(records) {
  const groups = new Map();
  for (const r of mesh(records)) {
    if (!r.handler) continue;
    for (const tool of r.tools) {
      const key = `${r.event}::${tool}::${r.handler}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
  }
  const findings = [];
  for (const [key, rs] of groups) {
    const roots = [...new Set(rs.map((r) => r.codeRoot))];
    if (roots.length < 2) continue;
    findings.push({
      invariant: 'M1',
      key,
      roots,
      blocking: rs.some((r) => r.effectiveMode !== 'advisory'),
      where: rs.map((r) => `${r.layer} ${r.locator} [${r.codeRoot}] ${r.effectiveMode}`),
    });
  }
  return findings.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * M3 — TIMEOUT TOTALITY. Two failures, one invariant, because they are the same defect seen from
 * either side: a MISSING timeout is Claude Code's default (600s outside the prompt path) silently
 * applied to a stranger's session, and a value >60 is a milliseconds-intent number in a seconds
 * field — "any timeout over 60 is a wrong-unit bug by fiat" (ADR-055 §7.5, Fable's rule). The user
 * layer's whole 2000/3000/5000/30000 schism (F1) and its untimed blocking `Task|Agent` wall (F2)
 * were both this, and both are now regression fixtures rather than open findings.
 */
export function lintM3(records) {
  const findings = [];
  for (const r of mesh(records)) {
    if (typeof r.timeout !== 'number') findings.push({ invariant: 'M3', kind: 'missing', layer: r.layer, locator: r.locator, event: r.event, handler: r.handler, detail: 'no explicit timeout — the host default applies' });
    else if (r.timeout > 60) findings.push({ invariant: 'M3', kind: 'wrong-unit', layer: r.layer, locator: r.locator, event: r.event, handler: r.handler, detail: `timeout ${r.timeout} > 60 — a seconds field holding a milliseconds-intent value` });
  }
  return findings;
}

/**
 * M5 — ANCHORED MATCHERS on the two events whose matcher names a TOOL. Claude Code SEARCHES the
 * tool name, so `Task` also selects TaskStop and `Write|Edit|MultiEdit` also selects NotebookEdit
 * (F3, F4) — a wall silently guarding a tool nobody chose to guard. Anchoring is meaningless for
 * SessionStart/Stop/SessionEnd/UserPromptSubmit, whose matcher selects a lifecycle source, so they
 * are out of scope rather than allowlisted en masse.
 *
 * The allowlist is a RATCHET, not an amnesty: each entry names one exact registration and the ADR
 * item that retires it, stale entries are themselves a failure (see `lintAllowlistStale`), and a
 * NEW unanchored matcher is red on arrival. ADR-055's own build order puts registration changes at
 * item 3 behind battery v2 at item 2 — so today's anchoring debt is recorded, not hidden, and not
 * fixed out of order.
 */
export function lintM5(records, allowlist = []) {
  const findings = [];
  for (const r of mesh(records)) {
    if (!TOOL_EVENTS.has(r.event)) continue;
    if (r.anchored) continue;
    if (allowlist.some((a) => allowlistMatches(a, r))) continue;
    findings.push({ invariant: 'M5', layer: r.layer, locator: r.locator, event: r.event, matcher: r.matcher, handler: r.handler, tools: r.tools });
  }
  return findings;
}

const allowlistMatches = (a, r) => a.layer === r.layer && a.event === r.event && a.matcher === (r.matcher ?? '')
  && (!a.handler || a.handler === r.handler);

/** An allowlist entry matching no live registration is fiction. Fiction rots into permission. */
export function lintAllowlistStale(records, allowlist = []) {
  const active = mesh(records);
  return allowlist
    .filter((a) => !active.some((r) => allowlistMatches(a, r)))
    .map((a) => ({ invariant: 'M5-stale', entry: `${a.layer} ${a.event} ${JSON.stringify(a.matcher)} ${a.handler ?? ''}`, reason: a.reason }));
}

/**
 * M6 — OFF-BEHAVIOR TOTALITY (ADR-055 §7.4, closing F14/F5). ADR-054 made brain-OFF a per-hook
 * contract carried as DATA — but only for the shim's eleven table entries. Every other
 * registration on this machine, INCLUDING the plugin's own Stop hook, had no declared answer at
 * all: nobody could say whether it runs, goes silent, or splits when the user switches the brain
 * off, which means "off" was never a testable state for two thirds of the mesh. A registration
 * must resolve to `silence | run | partial` through the shim table or through the checked-in
 * hook-contracts.json; absent from both is the finding.
 */
export const OFF_BEHAVIORS = Object.freeze(['silence', 'run', 'partial']);

export function lintM6(records) {
  return mesh(records)
    .filter((r) => !OFF_BEHAVIORS.includes(r.offBehavior))
    .map((r) => ({ invariant: 'M6', layer: r.layer, locator: r.locator, event: r.event, matcher: r.matcher, handler: r.handler, declared: r.offBehavior, contractSource: r.contractSource }));
}

/** Every invariant at once, keyed by name — the shape a report or a gate wants. */
export function lintAll(reg) {
  return {
    M1: lintM1(reg.records),
    M3: lintM3(reg.records),
    M5: lintM5(reg.records, reg.matcherAllowlist),
    'M5-stale': lintAllowlistStale(reg.records, reg.matcherAllowlist),
    M6: lintM6(reg.records),
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────
// BASENAME, not path identity. The strict `realpathSync(argv[1]) === realpathSync(self)` form this
// replaced stopped firing the moment `scripts/hook-registry.mjs` became a re-export shim over the
// payload copy: `node scripts/hook-registry.mjs --lint` (the invocation this file's own header and
// ADR-055 both document) loads a DIFFERENT file URL than argv[1] names, so the whole CLI became a
// no-op that exits 0 — a dead command, silently. The basename test is the idiom four of this file's
// siblings already use (capability-registry, user-settings, memory-doctor, lesson-promote) and it is
// true through the shim and at the payload path alike.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).endsWith(`${path.sep}hook-registry.mjs`);
if (invokedDirectly) {
  const includeMachine = !process.argv.includes('--machine=0') && process.env.CI !== 'true';
  const reg = buildRegistry({ includeMachine });
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(reg.records, null, 2)}\n`);
  } else if (process.argv.includes('--lint')) {
    const found = lintAll(reg);
    let n = 0;
    for (const [name, findings] of Object.entries(found)) {
      process.stdout.write(`\n${name}: ${findings.length ? `${findings.length} FINDING(S)` : 'clean'}\n`);
      for (const f of findings) { n += 1; process.stdout.write(`   ${JSON.stringify(f)}\n`); }
    }
    process.stdout.write(`\n${n} finding(s) over ${mesh(reg.records).length} mesh registrations${includeMachine ? '' : ' (repo-owned layers only)'}\n`);
    process.exit(n ? 1 : 0);
  } else {
    const c = census(reg);
    process.stdout.write(`Merged hook registry — ${c.mesh} active registrations in the mesh, ${c.mirrors} in code-copy mirrors\n\n`);
    for (const row of c.rows) {
      const tag = row.present ? String(row.count).padStart(3) : ' --';
      process.stdout.write(`${tag}  ${row.inMesh ? ' ' : '~'} ${row.layer.padEnd(20)} ${row.present ? row.file : '(absent on this machine)'}\n`);
    }
    process.stdout.write('\n');
    for (const r of reg.records) {
      process.stdout.write(
        `${r.layer.padEnd(20)} ${r.locator.padEnd(20)} ${r.event.padEnd(17)} ${String(r.matcher || '*').padEnd(34)} `
        + `t=${String(r.timeout ?? 'NONE').padEnd(5)} ${String(r.mode ?? r.effectiveMode).padEnd(16)} `
        + `off=${String(r.offBehavior ?? 'UNDECLARED').padEnd(11)} ${r.reachesStrangers ? 'ships' : 'local'}  ${r.handler ?? r.command}\n`,
      );
    }
    for (const e of reg.errors) process.stdout.write(`\nERROR ${e.layer}: ${e.file}: ${e.error}\n`);
  }
}
