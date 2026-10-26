// tests/unit/grounding-freshness.test.mjs — a snapshot must say it is a snapshot, on every surface.
//
// Measured 2026-09-11 at worktree HEAD 2eef2024: forge-ask-all.mjs computed `corpusAge` on every
// query (corpusAgeFor, called from searchAll) and main() printed NONE of it, while the MCP server
// printed both the age and the verify-live warning. Same brain, same question, two different
// honesty levels depending on which door you came in through. And asked "what is the latest version
// of X" for eight rUv packages, the CLI returned a current version for zero of them.
//
// The live probe is the part that must NOT be trusted blindly, so most of what follows is about
// what it refuses to do: no network under a hook or in plan mode, no network in CI, a hard 1-second
// bound, no retries, and silence rather than an assertion when it fails.
import { describe, it, expect, vi } from 'vitest';

import {
  LIVE_LOOKUP_PACKAGES,
  corpusSnapshotDate,
  freshnessAdvisory,
  liveLookupDisabledReason,
  probeLiveVersions,
  stalenessNotice,
  versionIntent,
} from '../../kb/corpus-freshness.mjs';
import { MANAGED_CLI_TOOLS } from '../../plugin/mcp/managed-cli-interface.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const bundleAt = (source) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-'));
  if (source) fs.writeFileSync(path.join(dir, 'SOURCE.json'), JSON.stringify(source));
  return dir;
};

describe('the mirrored live-lookup allow-list cannot drift from the managed boundary', () => {
  it('never names a package outside the managed-CLI registry surface', () => {
    // kb/ ships as its own bundle and must not import plugin/, so the list is mirrored. This is the
    // test that makes the mirror safe: the managed boundary is the authority, and anything this
    // module would look up must be something that boundary already reads from the public registry.
    const managed = MANAGED_CLI_TOOLS.find((tool) => tool.name === 'ruvnet_registry_latest');
    expect(managed).toBeTruthy();
    expect(LIVE_LOOKUP_PACKAGES.length).toBe(7);
    expect(new Set(LIVE_LOOKUP_PACKAGES).size).toBe(7);
    expect(LIVE_LOOKUP_PACKAGES).toContain('@claude-flow/cli');
  });
});

describe('stalenessNotice — one wording, so two surfaces cannot disagree', () => {
  it('names both ages, the oldest store, and the instruction to verify live', () => {
    const line = stalenessNotice({ newestDays: 3.6, oldestDays: 22.1, oldestRepo: '2bottalk' });
    expect(line).toContain('newest store 3.6d old');
    expect(line).toContain('oldest 22.1d (2bottalk)');
    expect(line).toMatch(/verify against the live registry before asserting/);
  });
  it('says nothing at all when the age is unknown — silence, never a guessed date', () => {
    expect(stalenessNotice(null)).toBe('');
  });
});

describe('corpusSnapshotDate — the builder\'s recorded date, then mtimes, then nothing', () => {
  it('prefers SOURCE.json builtUtc', () => {
    const dir = bundleAt({ builtUtc: '2026-08-20T07:16:20.675Z' });
    expect(corpusSnapshotDate(dir)).toBe('2026-08-20');
  });
  it('falls back to the newest store age when there is no SOURCE.json', () => {
    const dir = bundleAt(null);
    const expected = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    expect(corpusSnapshotDate(dir, { newestDays: 3, oldestDays: 9, oldestRepo: 'x' })).toBe(expected);
  });
  it('returns null rather than today when it knows neither', () => {
    expect(corpusSnapshotDate(bundleAt(null), null)).toBeNull();
  });
});

describe('freshnessAdvisory — the version question gets the live-verification line', () => {
  const dir = bundleAt({ builtUtc: '2026-08-20T07:16:20.675Z' });
  it('carries the literal fallback sentence, the date, and the exact command', () => {
    const line = freshnessAdvisory({
      query: 'What is the latest version of @claude-flow/aidefence and what changed in it recently?',
      dir, corpusAge: { newestDays: 3.6, oldestDays: 3.6, oldestRepo: 'x' },
    });
    expect(line).toContain('corpus snapshot dated 2026-08-20; verify on npm');
    expect(line).toContain('npm view @claude-flow/aidefence version');
  });
  it('surfaces a live version alongside it when one was actually fetched', () => {
    const line = freshnessAdvisory({
      query: 'What is the latest version of ruflo?', dir, corpusAge: null,
      liveVersions: [{ pkg: 'ruflo', version: '3.33.0' }],
    });
    expect(line).toMatch(/LIVE REGISTRY \(checked just now\): ruflo@3\.33\.0/);
  });
  it('says nothing on a question that is not about a version', () => {
    expect(freshnessAdvisory({ query: 'How does RVF store vectors on disk?', dir, corpusAge: null })).toBe('');
  });
});

describe('versionIntent — a sentence-ending period is a boundary, not part of the package name', () => {
  // Measured 2026-09-21: a version question ending "...version of ruflo." (a completely ordinary
  // sentence) returned `packages: []` — the bare-name boundary regex treated the trailing "." as
  // still part of the token, so neither the "boundary char" alternative nor the end-of-string
  // alternative matched. The scoped-package regex had the opposite failure: it has no requirement
  // that a match END on an identifier character, so it happily absorbed the period INTO the name,
  // turning "@claude-flow/cli." into the npm-invalid package string "@claude-flow/cli.".
  it('still names a bare package when the question ends in a period', () => {
    expect(versionIntent('What is the latest version of ruflo.').packages).toEqual(['ruflo']);
    expect(versionIntent('Current release of ruvector.').packages).toEqual(['ruvector']);
  });
  it('strips the sentence period from a scoped package instead of absorbing it', () => {
    expect(versionIntent('What is the latest version of @claude-flow/cli.').packages)
      .toEqual(['@claude-flow/cli']);
  });
  it('still matches with no trailing punctuation at all (unchanged behavior)', () => {
    expect(versionIntent('What is the latest version of ruflo').packages).toEqual(['ruflo']);
    expect(versionIntent('What is the latest version of @claude-flow/cli').packages)
      .toEqual(['@claude-flow/cli']);
  });
  it('a period immediately followed by another identifier char is still NOT a boundary', () => {
    // Guards against the fix over-correcting: "ruflo.config.js" must not read as a mention of the
    // package "ruflo" — the period here is a filename separator, not sentence punctuation.
    expect(versionIntent('what changed in ruflo.config.js recently').packages).toEqual([]);
  });
  it('a mid-sentence period followed by whitespace is also a boundary', () => {
    expect(versionIntent('latest version of ruflo. Also check agentic-qe').packages)
      .toEqual(['ruflo', 'agentic-qe']);
  });
  it('an ellipsis (multiple dots) is a boundary too, not just a single period', () => {
    // Caught by an independent adversarial critic pass: the first fix only recognized a SINGLE
    // trailing ".", so "...version of ruflo..." repeated the exact failure the fix was meant to
    // close, just with three dots instead of one.
    expect(versionIntent('What is the latest version of ruflo...').packages).toEqual(['ruflo']);
  });
});

describe('probeLiveVersions — bounded, refusable, and silent when it fails', () => {
  it('refuses to touch the network under a hook, in plan mode, in CI, or offline', () => {
    expect(liveLookupDisabledReason({ CLAUDE_HOOK_EVENT: 'PreToolUse' })).toBe('running under a hook');
    expect(liveLookupDisabledReason({ CLAUDE_PLAN_MODE: '1' })).toBe('plan mode');
    expect(liveLookupDisabledReason({ CI: 'true' })).toBe('CI');
    expect(liveLookupDisabledReason({ RUVNET_BRAIN_NO_NETWORK: '1' })).toBe('offline mode');
    expect(liveLookupDisabledReason({ RUVNET_BRAIN_LIVE_VERSIONS: '0' })).toBe('disabled by RUVNET_BRAIN_LIVE_VERSIONS=0');
    expect(liveLookupDisabledReason({})).toBeNull();
  });

  it('makes NO request at all when it is disabled', async () => {
    const fetchImpl = vi.fn();
    await probeLiveVersions(['ruflo'], { env: { CLAUDE_HOOK_EVENT: 'PreToolUse' }, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('looks up only packages the managed boundary already reads', async () => {
    const asked = [];
    const fetchImpl = vi.fn(async (url) => {
      asked.push(url);
      return { ok: true, json: async () => ({ version: '9.9.9' }) };
    });
    const out = await probeLiveVersions(['ruflo', '@claude-flow/aidefence', 'agentdb'], { env: {}, fetchImpl });
    expect(out).toEqual([{ pkg: 'ruflo', version: '9.9.9' }]);
    expect(asked).toEqual(['https://registry.npmjs.org/ruflo/latest']);
  });

  it('passes a hard abort signal and never retries', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push(init?.signal);
      return { ok: true, json: async () => ({ version: '1.0.0' }) };
    });
    await probeLiveVersions(['ruflo'], { env: {}, fetchImpl, timeoutMs: 1000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls[0]).toBeInstanceOf(AbortSignal);
  });

  it('returns nothing — never an assertion — when the registry fails or times out', async () => {
    const thrower = vi.fn(async () => { throw new Error('aborted'); });
    await expect(probeLiveVersions(['ruflo'], { env: {}, fetchImpl: thrower })).resolves.toEqual([]);
    const notOk = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await expect(probeLiveVersions(['ruflo'], { env: {}, fetchImpl: notOk })).resolves.toEqual([]);
  });

  it('actually observes its own deadline rather than waiting on a slow registry', async () => {
    const slow = vi.fn((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const started = Date.now();
    await expect(probeLiveVersions(['ruflo'], { env: {}, fetchImpl: slow, timeoutMs: 200 })).resolves.toEqual([]);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
