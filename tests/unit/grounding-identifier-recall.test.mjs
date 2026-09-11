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
  it('lifts file basenames out of a path, including the one with a dot in it', () => {
    expect(exactIdentifiers('Which is canonical: .swarm/memory.db or .swarm/agentdb-memory.db?'))
      .toEqual(expect.arrayContaining(['memory.db', 'agentdb-memory.db']));
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
  it('scores nothing when the identifier is absent', () => {
    expect(identifierBoost(identifierEvidence({ path: 'x.md', text: 'unrelated prose' }, ids))).toBe(0);
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
