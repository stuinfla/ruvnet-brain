// tests/unit/grounding-identifier-recall.test.mjs — an identifier is not a synonym.
//
// THE MEASURED FAILURE (2026-09-11, ~/.cache/ruvnet-brain/kb builtUtc 2026-08-20T07:16:20.675Z,
// worktree HEAD 2eef2024): "Which is canonical: .swarm/memory.db or .swarm/agentdb-memory.db?"
// returned agentdb/ui/.claude/agents/hive-mind/swarm-memory-manager.md. The corpus contains the
// answer — ruflo/CHANGELOG.md #2786, which defines getAgentDbPath() and the basename
// agentdb-memory.db — and six targeted queries never surfaced it, because the card router read
// "agentdb" out of the middle of the identifier and never opened ruflo.
//
// These tests run on FIXTURES shaped like the installed corpus (a passage sidecar per store, the
// same JSONL records the real bundle ships), so they exercise the real scan, not a mock of it.
// Every one of them fails on the pre-fix behaviour: no scan, no widening, no boost.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  exactIdentifiers,
  identifierBoost,
  identifierCandidates,
  identifierEvidence,
  identifierExcerpt,
  identifierScan,
  scannableIdentifiers,
} from '../../kb/identifier-lane.mjs';
import {
  compareSemver,
  highestSemver,
  isReleaseDocument,
  versionIntent,
} from '../../kb/corpus-freshness.mjs';

// A store as the installed bundle ships one: <name>.rvf + <name>.passages.jsonl of {id,text,path,title}.
function bundle(stores) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ident-'));
  for (const [name, passages] of Object.entries(stores)) {
    fs.writeFileSync(path.join(dir, `${name}.rvf`), 'x');
    fs.writeFileSync(path.join(dir, `${name}.passages.jsonl`), `${passages
      .map((p, i) => JSON.stringify({ id: `chunk:${name}:${i}`, ...p }))
      .join('\n')}\n`);
  }
  return dir;
}

const DEFINING = [
  '- **#2786** — AgentDB no longer silently fails to initialize. Added `getAgentDbPath()` which',
  'returns the same directory as `getDbPath()` but with basename `agentdb-memory.db`, so the',
  "ControllerRegistry opens a distinct file from the sql.js CRUD writer's `memory.db`.",
].join('\n');

// The adversarial case: a chunk that merely REPEATS the question's words and identifiers.
const ECHO = 'Which is canonical: .swarm/memory.db or .swarm/agentdb-memory.db? '
  + 'People ask about memory.db and agentdb-memory.db a lot. memory.db, agentdb-memory.db.';

describe('exactIdentifiers — only rare, exact tokens, because each one costs a corpus scan', () => {
  it('preserves explicit short, hidden and extensionless paths without broadening bare prose', () => {
    for (const file of ['src/a.ts', 'config/.gitignore', 'docker/Dockerfile', 'docs/README.md']) {
      expect(exactIdentifiers(`Find ${file}`)).toContain(file.toLowerCase());
    }
    expect(exactIdentifiers('Read the README.md')).toEqual([]);
    expect(exactIdentifiers('Use client/server and/or service prose')).toEqual([]);
    expect(exactIdentifiers('Find ../kb/a.mjs')).toContain('kb/a.mjs');
    expect(exactIdentifiers('Find /fork-delta/.claude-flow/CAPABILITIES.md')).toContain('fork-delta/.claude-flow/capabilities.md');
  });
  it('lifts file basenames out of a path, including the one with a dot in it', () => {
    expect(exactIdentifiers('Which is canonical: .swarm/memory.db or .swarm/agentdb-memory.db?'))
      .toEqual(expect.arrayContaining(['memory.db', 'agentdb-memory.db']));
  });
  it('preserves a slash-separated path alongside its basename', () => {
    expect(exactIdentifiers('Which file is .claude-flow/CAPABILITIES.md?'))
      .toEqual(expect.arrayContaining(['.claude-flow/capabilities.md', 'capabilities.md']));
    expect(exactIdentifiers('Which file is fork-delta/.claude-flow/CAPABILITIES.md?'))
      .toContain('fork-delta/.claude-flow/capabilities.md');
  });
  it('normalizes Windows separators before extracting a path identifier', () => {
    expect(exactIdentifiers(String.raw`Which file is .claude-flow\CAPABILITIES.md?`))
      .toContain('.claude-flow/capabilities.md');
  });
  it('finds camelCase symbols and issue references', () => {
    const ids = exactIdentifiers('Does getAgentDbPath change after #2786?');
    expect(ids).toEqual(expect.arrayContaining(['getagentdbpath', '#2786']));
  });
  it('finds nothing in ordinary prose — no scan, no cost', () => {
    expect(exactIdentifiers('How do I make my agents cheaper without losing quality?')).toEqual([]);
    expect(scannableIdentifiers('what is the latest version of ruflo and what changed recently')).toEqual([]);
  });
  it('keeps scoped packages OUT of the scan set — the ownership registry already answers those', () => {
    const q = 'What is the latest version of @claude-flow/aidefence?';
    expect(exactIdentifiers(q)).toContain('@claude-flow/aidefence');
    expect(scannableIdentifiers(q)).toEqual([]);
  });
});

describe('identifierScan — the store that CONTAINS the identifier, not the one whose name it spells', () => {
  it('matches decoded Windows and repeated-separator paths without a basename fallback', () => {
    const dir = bundle({ sample: [
      { path: 'docs\\README.md', text: 'Windows record' },
      { path: 'mirror/docs//README.md', text: 'Repeated separators' },
    ] });
    const ids = exactIdentifiers('Find docs/README.md');
    const scan = identifierScan(dir, ids);
    expect(scan.byRepo.get('sample')).toHaveLength(2);
  });
  it('carries source kind and truncation metadata through the rescue lane', () => {
    const dir = bundle({ sample: [
      { path: 'src/package.json', text: 'manifest entry', kind: 'manifest', truncated: true },
    ] });
    const ids = exactIdentifiers('Find src/package.json');
    const [row] = identifierCandidates(identifierScan(dir, ids), 'sample', ids);
    expect(row).toMatchObject({ path: 'src/package.json', kind: 'manifest', truncated: true });
  });
  it('finds an exact path suffix case-insensitively and outranks a basename-only sibling', () => {
    const dir = bundle({ agentbbs: [
      ...Array.from({ length: 60 }, (_, index) => ({
        path: `docs/archive-${index}/CAPABILITIES.md`, title: 'Other capabilities', text: 'other capabilities.md mention',
      })),
      { path: 'fork-delta/.claude-flow/CAPABILITIES.md', title: 'Capabilities', text: 'Topology and agent groups.' },
      { path: 'fork-delta/.claude-flow/.gitignore', title: 'Ignore', text: 'ignore capabilities.md mention' },
      { path: 'docs/CAPABILITIES.md', title: 'Other capabilities', text: 'other capabilities.md mention' },
    ] });
    const ids = exactIdentifiers('What does .claude-flow/CAPABILITIES.md document?');
    const scan = identifierScan(dir, ids, { maxRepos: 1 });
    const candidates = identifierCandidates(scan, 'agentbbs', ids, 8);
    expect(candidates[0].path).toBe('fork-delta/.claude-flow/CAPABILITIES.md');
    expect(candidates[0]._exactIdentifier.exactPathNamed).toBe(1);
  });
  it('does not treat near-miss directory names as the requested path', () => {
    const dir = bundle({ agentbbs: [
      { path: 'fork-delta/.claude-flowx/CAPABILITIES.md', title: 'Wrong', text: 'wrong' },
      { path: 'x.claude-flow/CAPABILITIES.md', title: 'Wrong', text: 'wrong' },
    ] });
    const ids = exactIdentifiers('What does .claude-flow/CAPABILITIES.md document?');
    const scan = identifierScan(dir, ids, { maxRepos: 1 });
    const candidates = identifierCandidates(scan, 'agentbbs', ids, 8);
    expect(candidates.every((candidate) => candidate._exactIdentifier.exactPathNamed === 0)).toBe(true);
  });
  it('routes to the store holding the literal, not the substring match in the identifier itself', () => {
    const dir = bundle({
      agentdb: [{ path: 'ui/agents/swarm-memory-manager.md', title: 'Swarm memory manager', text: 'A swarm memory manager for agent coordination and hive-mind state.' }],
      ruflo: [{ path: 'CHANGELOG.md', title: 'Changelog', text: DEFINING }],
      unrelated: [{ path: 'README.md', title: 'Unrelated', text: 'Nothing to do with the question.' }],
    });
    const scan = identifierScan(dir, ['memory.db', 'agentdb-memory.db'], { maxRepos: 2 });
    expect(scan.repos[0]).toBe('ruflo');
    expect(scan.repos).not.toContain('unrelated');
  });

  it('shapes the hits as exempt rescue-lane candidates carrying their evidence', () => {
    const dir = bundle({ ruflo: [{ path: 'CHANGELOG.md', title: 'Changelog', text: DEFINING }] });
    const ids = ['memory.db', 'agentdb-memory.db', 'getagentdbpath'];
    const scan = identifierScan(dir, ids, { maxRepos: 2 });
    const [candidate] = identifierCandidates(scan, 'ruflo', ids);
    expect(candidate.path).toBe('CHANGELOG.md');
    expect(candidate._lane).toBe('rescue');
    expect(candidate._exactIdentifier.defining).toBeGreaterThan(0);
  });
});

describe('the boost is EARNED — a chunk that repeats the question must not outrank the definition', () => {
  const ids = ['memory.db', 'agentdb-memory.db'];
  it('separates a defining source from an echo by a wide, numeric margin', () => {
    const defining = identifierBoost(identifierEvidence({ path: 'CHANGELOG.md', text: DEFINING }, ids));
    const echo = identifierBoost(identifierEvidence({ path: 'faq.md', text: ECHO }, ids));
    expect(defining).toBeGreaterThanOrEqual(12);
    expect(echo).toBeLessThanOrEqual(2);
    // Magnitude, not direction: an echo may never come within 5 logits of a definition, because the
    // cross-encoder's own gap between them was measured at less than that.
    expect(defining - echo).toBeGreaterThanOrEqual(5);
  });
  it('gives a mention the floor and nothing more', () => {
    const mention = identifierEvidence({ path: 'notes.md', text: 'we store things in memory.db somewhere' }, ids);
    expect(identifierBoost(mention)).toBe(1);
  });
  it('credits a document named after the identifier', () => {
    const named = identifierEvidence({ path: 'src/memory.db', text: 'binary' }, ['memory.db']);
    expect(named.pathNamed).toBe(1);
  });
  it('gives an exact path suffix stronger evidence than a basename-only match', () => {
    const exact = identifierEvidence(
      { path: 'fork-delta/.claude-flow/CAPABILITIES.md', text: 'binary' },
      ['.claude-flow/capabilities.md', 'capabilities.md'],
    );
    const basename = identifierEvidence({ path: 'docs/CAPABILITIES.md', text: 'binary' }, ['capabilities.md']);
    expect(exact.exactPathNamed).toBe(1);
    expect(identifierBoost(exact)).toBeGreaterThan(identifierBoost(basename));
    expect(identifierBoost({ matched: true, distinct: 1, defining: 0, pathNamed: 0 })).toBe(1);
  });
  it('scores nothing when the identifier is absent', () => {
    expect(identifierBoost(identifierEvidence({ path: 'x.md', text: 'unrelated prose' }, ids))).toBe(0);
  });
});

// Issue #286 root cause 3 (photonlayer): TWO independent path-attribution false positives, found
// live against the real release-candidate bundle. Both fixed in identifierEvidence; both fixtures
// below are reconstructed from the real measured data (repo=ruvector, path=
// crates/photonlayer-bench/src/bin/bench.rs, ce=-3.804 raw; repo=ruvector, path=
// docs/research/photonlayer/ASSESSMENT.md, ce=1.795 post-boost) so this is not a synthetic case.
describe('pathNamed is a whole PATH SEGMENT, never a directory-name prefix (issue #286 RC3)', () => {
  const ids = ['photonlayer'];
  it('does NOT credit a sibling directory that merely STARTS WITH the identifier', () => {
    // crates/photonlayer-bench/... contains the literal substring "/photonlayer" (the start of
    // "photonlayer-bench"), which is what let ruvector's own, unrelated photonlayer-bench subtree
    // earn the same "named after this" credit as the real photonlayer repo's own files.
    const evidence = identifierEvidence(
      { path: 'crates/photonlayer-bench/src/bin/bench.rs', text: 'use photonlayer_bench::baselines;' },
      ids,
    );
    expect(evidence.pathNamed).toBe(0);
    // The body text does still literally contain "photonlayer" (via "photonlayer_bench"), so a
    // mention is still earned — just not the stronger, path-based "this document IS the thing" credit.
    expect(evidence.matched).toBe(true);
    expect(identifierBoost(evidence)).toBe(1);
  });
  it('still credits a document living in a directory EXACTLY named after the identifier', () => {
    const evidence = identifierEvidence({ path: 'crates/photonlayer/README.md', text: 'binary' }, ids);
    expect(evidence.pathNamed).toBe(1);
  });
});

describe('pathNamed defers to the identifier\'s OWN repo when it collides with a different, ' +
  'independently-indexed store (issue #286 RC3)', () => {
  const ids = ['photonlayer'];
  const knownRepos = new Set(['photonlayer', 'ruvector']);
  it('does not credit a foreign repo\'s own subtree that happens to share the identifier\'s name', () => {
    // ruvector's docs/research/photonlayer/ASSESSMENT.md is not a vendored copy of anything — it is
    // ruvector's own, genuine research note about PhotonLayer — but "photonlayer" already has an
    // authoritative home (the photonlayer store itself), so a same-named subtree in a DIFFERENT,
    // independently-indexed repo must not earn that repo's own "authoritatively named after this".
    const evidence = identifierEvidence(
      { path: 'docs/research/photonlayer/ASSESSMENT.md', text: 'PhotonLayer is a deterministic optical AI front end.' },
      ids,
      { repo: 'ruvector', knownRepos },
    );
    expect(evidence.pathNamed).toBe(0);
    // Still earns the mention floor — the fix removes false PATH attribution, not genuine content.
    expect(evidence.matched).toBe(true);
    expect(identifierBoost(evidence)).toBe(1);
  });
  it('still credits the identifier\'s OWN repo for the exact same path shape', () => {
    const evidence = identifierEvidence(
      { path: 'docs/research/photonlayer/ASSESSMENT.md', text: 'PhotonLayer is a deterministic optical AI front end.' },
      ids,
      { repo: 'photonlayer', knownRepos },
    );
    expect(evidence.pathNamed).toBe(1);
  });
  it('is a no-op when the identifier is not itself a known repo name (the founding memory.db case)', () => {
    // Every existing identifier-lane behavior — the whole reason this module exists — must be
    // untouched: filenames like memory.db are never repo names, so the guard never engages for them.
    const evidence = identifierEvidence(
      { path: 'src/memory.db', text: 'binary' },
      ['memory.db'],
      { repo: 'ruflo', knownRepos: new Set(['photonlayer', 'ruvector']) },
    );
    expect(evidence.pathNamed).toBe(1);
  });
});

describe('identifierExcerpt — the ranker reads the window around the identifier', () => {
  it('centres a long passage on the identifier instead of its first 512 tokens', () => {
    const noise = 'unrelated release entry. '.repeat(300);
    const text = `${noise}${DEFINING}${noise}`;
    const window = identifierExcerpt(text, ['agentdb-memory.db']);
    expect(window).toContain('agentdb-memory.db');
    expect(window.length).toBeLessThan(text.length);
  });
  it('leaves a short passage exactly as it is', () => {
    expect(identifierExcerpt('short text with memory.db', ['memory.db'])).toBe('short text with memory.db');
  });
});

describe('version intent — newest semver wins, and only for release records', () => {
  it('recognises the question class without firing on ordinary prose', () => {
    expect(versionIntent('What is the latest version of agentdb?').intent).toBe(true);
    expect(versionIntent('what changed in agentic-qe recently?').intent).toBe(true);
    expect(versionIntent('Which version control approach does ruflo use?').intent).toBe(false);
    expect(versionIntent('How does RVF store vectors?').intent).toBe(false);
  });
  it('names the packages the question is about', () => {
    expect(versionIntent('latest version of @claude-flow/aidefence?').packages).toContain('@claude-flow/aidefence');
    expect(versionIntent('what is the latest version of agentic-qe?').packages).toContain('agentic-qe');
  });
  it('orders conflicting versions across release notes, prereleases included', () => {
    expect(compareSemver(highestSemver('v3.0.0-alpha.20'), highestSemver('v3.0.0-alpha.6'))).toBeGreaterThan(0);
    expect(compareSemver(highestSemver('3.13.2'), highestSemver('3.9.11'))).toBeGreaterThan(0);
    expect(compareSemver(highestSemver('3.0.0'), highestSemver('3.0.0-alpha.20'))).toBeGreaterThan(0);
  });
  it('calls a changelog a release record and a blog post that mentions one not', () => {
    expect(isReleaseDocument({ path: 'CHANGELOG.md' })).toBe(true);
    expect(isReleaseDocument({ path: 'agentdb/docs/CHANGELOG-ALPHA-2.7.md' })).toBe(true);
    expect(isReleaseDocument({ path: 'docs/releases/v3.md', title: 'Release notes' })).toBe(true);
    expect(isReleaseDocument({ path: 'RELEASES.md' })).toBe(true);
    expect(isReleaseDocument({ path: 'docs/blog/why-we-shipped-3.13.2.md', title: 'Why we shipped' })).toBe(false);
  });

  it('refuses the false positive that took #1 from a package manifest on the CLI', () => {
    // Measured 2026-09-11: an earlier stem allowed a bare `release` plus any suffix, so this AGENT
    // DEFINITION read as a release note and outranked @claude-flow/aidefence's own package.json on
    // that package's own version question. A boost that promotes the wrong document is worse than
    // no boost at all.
    expect(isReleaseDocument({
      path: 'v3/@claude-flow/cli/.claude/agents/github/release-swarm.md',
      title: 'Release Swarm - Intelligent Release Automation',
    })).toBe(false);
    expect(isReleaseDocument({ path: 'v3/@claude-flow/aidefence/package.json' })).toBe(false);
  });
});
