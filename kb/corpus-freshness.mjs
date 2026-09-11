// corpus-freshness.mjs — ONE place that decides what this brain is allowed to say about "latest".
//
// THE FAILURE THIS EXISTS FOR (measured 2026-09-11 against ~/.cache/ruvnet-brain/kb,
// SOURCE.json builtUtc 2026-08-20T07:16:20.675Z, worktree HEAD 2eef2024):
//
//   • The CLI COMPUTED the corpus age on every query (`corpusAgeFor`, forge-ask-all.mjs) and then
//     printed none of it. The MCP server printed both the age and the verify-live warning. Same
//     brain, same question, two different honesty levels depending on which door you came in.
//   • Asked "what is the latest version of X" for eight rUv packages, the CLI answered 0/8 with a
//     current version. agentdb came back with a "v3.0.0-alpha.6 Publishing Guide" while the live
//     registry was at 3.0.0-alpha.20; agentic-qe came back with v3.9.11 release notes while the
//     CORPUS ITSELF CONTAINS the v3.13.2 changelog — a ranking miss, not a coverage gap.
//
// Two rules follow, and they are the whole module:
//
//   1. A SNAPSHOT MUST SAY IT IS A SNAPSHOT, in the same words on every surface. `stalenessNotice`
//      is that sentence, and both the CLI and the MCP server call it rather than each writing
//      their own — two copies of a warning are two warnings free to drift.
//   2. WHEN THE QUESTION IS ABOUT A VERSION, THE SNAPSHOT IS NOT AN ANSWER. `versionIntent` spots
//      that question class, and `freshnessAdvisory` returns the line that tells the reader exactly
//      where the live truth is, naming the package and the command.
//
// ZERO NETWORK BY DEFAULT ON THE ANSWER PATH. `probeLiveVersions` is opt-outable, hard-bounded at
// one second, never retried, and covers ONLY the seven executables the managed-CLI boundary
// already reads from the public registry. Every other package gets the honest fallback line
// instead of a lookup this layer is not entitled to make.

import fs from 'node:fs';
import path from 'node:path';

// The npm names of the seven managed executables, mirrored from
// plugin/mcp/managed-cli-interface.mjs's REGISTRY_PACKAGES. Mirrored rather than imported because
// kb/ ships as its own bundle and must not depend on plugin/; tests/unit/grounding-freshness.test.mjs
// asserts this set stays a subset of the real boundary, so the mirror cannot drift silently.
export const LIVE_LOOKUP_PACKAGES = Object.freeze([
  'ruflo',
  '@claude-flow/cli',
  'agentic-flow',
  'agentic-qe',
  'ruvector',
  'agent-browser',
  'ruv-swarm',
]);

const LIVE_SET = new Set(LIVE_LOOKUP_PACKAGES);

/** The staleness sentence. ONE wording, used by the CLI and the MCP server alike. */
export function stalenessNotice(corpusAge) {
  if (!corpusAge) return '';
  return `Corpus snapshot ages: newest store ${corpusAge.newestDays}d old, oldest ${corpusAge.oldestDays}d `
    + `(${corpusAge.oldestRepo}). Version/"latest" facts may trail live npm/GitHub — for currency claims, `
    + `verify against the live registry before asserting.`;
}

/**
 * The snapshot's own date, preferred from the bundle's SOURCE.json (the builder's recorded fact)
 * and falling back to the newest store's mtime (always present). Returns an ISO date string or null
 * — never a guess, and never "today".
 */
export function corpusSnapshotDate(dir, corpusAge = null) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'SOURCE.json'), 'utf8'));
    const built = raw?.builtUtc || raw?.generatedAt;
    if (built && !Number.isNaN(Date.parse(built))) return new Date(built).toISOString().slice(0, 10);
  } catch { /* older bundles carry no SOURCE.json — mtimes still answer */ }
  if (corpusAge && Number.isFinite(corpusAge.newestDays)) {
    return new Date(Date.now() - corpusAge.newestDays * 86_400_000).toISOString().slice(0, 10);
  }
  return null;
}

const SCOPED_PACKAGE = /@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*/gi;

// Bare rUv npm names a user actually asks "what version" about. Deliberately a closed list: a free
// regex over "latest version of <word>" would name half the English language as a package.
const BARE_PACKAGES = Object.freeze([
  'agentdb', 'ruflo', 'ruvector', 'rulake', 'ruview', 'agentic-flow', 'agentic-qe',
  'agentic-payments', 'agent-browser', 'ruv-swarm', 'ruv-fann', 'claude-flow', 'ruvnet-brain',
  'synaptic-mesh', 'qudag', 'safla', 'sublinear-time-solver', 'flow-nexus',
]);

/**
 * Is this a "what is the current version / what changed" question, and about which packages?
 *
 * Narrow on purpose. It must fire on "latest version of @claude-flow/aidefence", "what changed in
 * agentic-qe recently", "current release of ruflo" — and NOT on "which version control approach
 * does X use" or any ordinary capability question, because everything downstream of this predicate
 * re-ranks results.
 */
export function versionIntent(query) {
  const q = String(query || '');
  // "version control", "version history", "versioning" are about PRACTICE, not about which release
  // is current. Stripping them first keeps "Which version control approach does ruflo use?" out of
  // a lane that re-ranks every result toward changelogs.
  const stripped = q.replace(/\bversion(?:s)?\s+(?:control|history|management)\b/gi, ' ');
  const asksVersion = /\b(?:latest|newest|current|most\s+recent)\s+(?:stable\s+)?(?:version|release|tag)\b/i.test(stripped)
    || /\bversion\s+(?:is|of)\b[\s\S]{0,40}\b(?:latest|current|now|shipping)\b/i.test(stripped)
    || /\bwhat\s+version\b/i.test(stripped)
    || /\bwhich\s+version\b/i.test(stripped);
  const asksChange = /\bwhat(?:'s|\s+is|\s+has)?\s+changed\b/i.test(q)
    || /\b(?:changelog|release\s+notes?|what's\s+new)\b/i.test(q)
    || /\bshipped\s+(?:recently|lately)\b/i.test(q);
  if (!asksVersion && !asksChange) return { intent: false, packages: [], kind: null };

  const packages = [...new Set([
    ...(q.match(SCOPED_PACKAGE) || []).map((s) => s.toLowerCase()),
    ...BARE_PACKAGES.filter((name) =>
      new RegExp(`(?:^|[^a-z0-9@/_-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9._/-]|$)`, 'i').test(q)),
  ])];
  return {
    intent: true,
    packages,
    kind: asksVersion && asksChange ? 'version+changes' : asksVersion ? 'version' : 'changes',
  };
}

/** Semver-ish tokens in a passage, newest first. Prerelease tags are kept — rUv ships on them. */
const SEMVER = /\bv?(\d{1,4})\.(\d{1,4})\.(\d{1,5})(?:-([0-9a-z.-]+))?\b/gi;

export function semversIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(SEMVER)) {
    out.push({
      raw: m[0].replace(/^v/i, ''),
      major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]),
      pre: m[4] ? String(m[4]).toLowerCase() : null,
    });
  }
  return out;
}

/** Compare two parsed semvers. A release outranks its own prerelease (npm's rule), as does a
 *  numerically higher prerelease of the same triple (alpha.20 > alpha.6 — the agentdb miss). */
export function compareSemver(a, b) {
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  const ap = a.pre.split('.'), bp = b.pre.split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i], y = bp[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x), ny = Number(y);
    const bothNumeric = Number.isFinite(nx) && Number.isFinite(ny);
    if (bothNumeric) { if (nx !== ny) return nx - ny; continue; }
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** The highest semver a passage mentions, or null. */
export function highestSemver(text) {
  let best = null;
  for (const v of semversIn(text)) if (compareSemver(v, best) > 0) best = v;
  return best;
}

// A path/title that IS a release record, not prose about one.
//
// THE FALSE POSITIVE THIS SHAPE EXISTS TO EXCLUDE, caught on the CLI 2026-09-11: an earlier version
// allowed a bare `release` stem with any suffix, so
// `ruflo/v3/@claude-flow/cli/.claude/agents/github/release-swarm.md` — an AGENT DEFINITION — read
// as a release note and took #1 from `@claude-flow/aidefence`'s own package.json on its own
// version question. A boost that promotes the wrong document is worse than no boost.
//
// So: the stems that accept a suffix are the ones that only ever name release records
// (CHANGELOG-ALPHA-2.7.md must still match), a bare `RELEASES.md` must match EXACTLY, and a
// `releases/` or `release-notes/` DIRECTORY counts because that is where a repo files them.
const RELEASE_STEM = /^(?:changelog|changes|history|release[-_ ]?notes?)(?:[-_.][a-z0-9][a-z0-9.-]*)?(?:\.(?:md|markdown|txt|rst))?$/i;
const RELEASE_EXACT = /^releases?(?:\.(?:md|markdown|txt|rst))?$/i;
const RELEASE_DIR = /(?:^|[\\/])(?:releases?|release[-_]notes?|changelogs?)[\\/]/i;

export function isReleaseDocument({ path: docPath = '', title = '' } = {}) {
  const full = String(docPath || '');
  const base = full.split(/[\\/]/).pop() || '';
  return RELEASE_STEM.test(base)
    || RELEASE_EXACT.test(base)
    || RELEASE_DIR.test(full)
    || /\bchange\s?log\b|\brelease notes?\b|\bwhat'?s new\b/i.test(String(title || ''));
}

/**
 * The line that replaces a confident-sounding stale version with a usable instruction.
 * `liveVersions` is whatever a bounded probe actually returned — [] is normal and must read as
 * "not checked", never as "there is none".
 */
export function freshnessAdvisory({ query, dir, corpusAge, liveVersions = [] }) {
  const intent = versionIntent(query);
  if (!intent.intent) return '';
  const date = corpusSnapshotDate(dir, corpusAge);
  const named = intent.packages.length ? intent.packages.join(', ') : 'the named package';
  const lines = [];
  if (liveVersions.length) {
    lines.push(`🔎 LIVE REGISTRY (checked just now): ${liveVersions.map((v) => `${v.pkg}@${v.version}`).join(', ')}`);
  }
  // The exact fallback sentence, kept literal and greppable so a reader (and a test) can find it:
  // "corpus snapshot dated <date>; verify on npm".
  lines.push(
    `⚠ VERSION QUESTION — corpus snapshot dated ${date || 'unknown'}; verify on npm `
    + `(\`npm view ${intent.packages[0] || '<package>'} version\`) before stating a current version for ${named}. `
    + `Any version quoted from the documents below is the version AS OF THAT SNAPSHOT, not today's.`,
  );
  return lines.join('\n');
}

/**
 * Bounded, cancellable live lookup for the seven packages the managed-CLI boundary already reads.
 * Anything else returns nothing, on purpose — this layer is not entitled to a wider registry read,
 * and `freshnessAdvisory` names the command the caller can run instead.
 *
 * Off whenever the process is a hook, a plan-mode probe, CI, or explicitly offline: a hot path must
 * never depend on the network being there.
 */
export function liveLookupDisabledReason(env = process.env) {
  if (env.RUVNET_BRAIN_LIVE_VERSIONS === '0') return 'disabled by RUVNET_BRAIN_LIVE_VERSIONS=0';
  if (env.RUVNET_BRAIN_NO_NETWORK || env.RUVNET_BRAIN_OFFLINE) return 'offline mode';
  if (env.CLAUDE_HOOK_EVENT || env.CLAUDE_CODE_HOOK || env.CLAUDE_PLUGIN_HOOK_EVENT) return 'running under a hook';
  if (env.CLAUDE_PLAN_MODE || env.RUVNET_BRAIN_PLAN_MODE) return 'plan mode';
  if (env.CI) return 'CI';
  return null;
}

export async function probeLiveVersions(packages, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 1000,
} = {}) {
  if (liveLookupDisabledReason(env)) return [];
  if (typeof fetchImpl !== 'function') return [];
  const wanted = [...new Set((packages || []).map((p) => String(p).toLowerCase()))]
    .filter((p) => LIVE_SET.has(p))
    .slice(0, 3);
  if (!wanted.length) return [];
  const deadlineSignal = () => (typeof AbortSignal?.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined);
  const results = await Promise.all(wanted.map(async (pkg) => {
    try {
      const res = await fetchImpl(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`, {
        headers: { accept: 'application/json' },
        signal: deadlineSignal(),
      });
      if (!res?.ok) return null;
      const meta = await res.json();
      return typeof meta?.version === 'string' ? { pkg, version: meta.version } : null;
    } catch {
      // A miss is silence, never an assertion. The advisory line already tells the reader how to
      // check; a failed probe must not turn into "no such package".
      return null;
    }
  }));
  return results.filter(Boolean);
}
