// tests/unit/ground-before-write.test.mjs — the gate that stops Claude writing rUv-domain code
// the brain has not seen.
//
// WHY (2026-07-13). Stuart, after losing a day: "The 100% entire reason we built RuvNet Brain
// was to prevent exactly this scenario... keep Claude Code from stepping in and overriding
// RuvNet-Brain." Twice in one week Claude hand-wrote code in a domain rUv already covers
// (agentdb capture vs ADR-174 distill; a fake router vs @metaharness/router) without asking
// the brain it was sitting on. rUv's ADR-G007: "prompts are advisory... The gate does not."
//
// The load-bearing test here is the first one: RE-INTRODUCE THE REAL BUG and watch it die.
// A check that passes on the bug it was written for is worse than no check.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GATE = path.resolve(import.meta.dirname, '../../plugin/scripts/ground-before-write.sh');
const STAMP = path.resolve(import.meta.dirname, '../../plugin/scripts/grounding-stamp.sh');
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

function freshHome({ optedIn = true } = {}) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'gbw-'));
  if (optedIn) {
    fs.mkdirSync(path.join(h, '.claude/model-router'), { recursive: true });
    fs.writeFileSync(path.join(h, '.claude/model-router/profile.json'), '{}');
  }
  return h;
}

function runGate(toolInput, { home, toolName = 'Write' } = {}) {
  const h = home || freshHome();
  const r = spawnSync('bash', [GATE], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    env: { ...process.env, HOME: h },
    encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr || '', home: h };
}

function ground(query, home) {
  return spawnSync('bash', [STAMP], {
    input: JSON.stringify({
      tool_name: 'mcp__plugin_ruvnet-brain_ruvnet-brain__search_ruvnet',
      tool_input: { query },
      // The result banner names EVERY repo — the stamp must ignore it or one search
      // grounds the world and the gate never fires again.
      tool_response: 'Searched 37 RuvNet repos (agentdb, metaharness, ruvector, ruflo, ...)',
    }),
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
}

describe.skipIf(!hasBash || process.platform === 'win32')('ground-before-write.sh — no rUv-domain code without the brain', () => {
  it('BLOCKS the EXACT bug this was written for: hand-rolling an agentdb capture hook, ungrounded', () => {
    const r = runGate({
      file_path: '/Users/x/.claude/hooks/agentdb-autocapture.mjs',
      content: '// capture session into agentdb\nconst summary = `RECENT USER ASKS: ${users.join(" ")}`;',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/BLOCKED/);
    expect(r.stderr).toMatch(/agentdb/);
    expect(r.stderr).toMatch(/search_ruvnet/); // it teaches the remedy, not just the refusal
  });

  // 4.5: Grok sends its own tool spelling (`write`, `search_replace`). The match is case-insensitive, so
  // the gate refuses the same ungrounded write whatever the host calls the tool — even invoked directly,
  // without decision-gate's normalisation in front of it.
  it.each(['write', 'WRITE', 'search_replace', 'edit'])('BLOCKS the same write under the host tool spelling %s', (toolName) => {
    const r = runGate({ file_path: '/tmp/a.mjs', content: 'agentdb glue' }, { toolName });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/BLOCKED/);
  });
  it('a non-write tool name is still ignored (case-insensitivity did not widen the gate)', () => {
    expect(runGate({ file_path: '/tmp/a.mjs', content: 'agentdb glue' }, { toolName: 'read_file' }).status).toBe(0);
  });

  it('BLOCKS the other real bug: a hand-rolled "metaharness" router, ungrounded', () => {
    const r = runGate({
      file_path: '/tmp/scripts/model-router-engine.mjs',
      content: 'export function route(prompt) { /* the MetaHarness router placeholder policy */ }',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/metaharness/i);
  });

  it('OPENS after a REAL grounding call stamps the term — the full stamp→gate seam, end to end', () => {
    const home = freshHome();
    expect(runGate({ file_path: '/tmp/a.mjs', content: 'agentdb glue' }, { home }).status).toBe(2);
    const g = ground('agentdb: how does rUv implement session capture?', home);
    expect(g.status).toBe(0);
    expect(runGate({ file_path: '/tmp/a.mjs', content: 'agentdb glue' }, { home }).status).toBe(0);
  });

  it('granularity matches the mistake: grounding agentdb does NOT unlock metaharness', () => {
    const home = freshHome();
    ground('agentdb internals', home);
    const r = runGate({ file_path: '/tmp/b.mjs', content: 'metaharness router work' }, { home });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/metaharness/);
    expect(r.stderr).not.toMatch(/blocked.*agentdb/i); // the grounded term is not re-blocked
  });

  it('the stamp reads ONLY the query — a result banner naming every repo must stamp nothing extra', () => {
    const home = freshHome();
    ground('agentdb only in this query', home); // response banner names metaharness etc.
    expect(runGate({ file_path: '/tmp/c.mjs', content: 'ruvector code' }, { home }).status).toBe(2);
  });

  it('does NOT tax ordinary work: non-rUv code, docs, JSON, and reads pass untouched', () => {
    expect(runGate({ file_path: '/tmp/utils.mjs', content: 'export const add = (a,b)=>a+b;' }).status).toBe(0);
    expect(runGate({ file_path: '/tmp/README.md', content: 'agentdb everywhere' }).status).toBe(0);
    expect(runGate({ file_path: '/tmp/pkg.json', content: '{"dep":"agentdb"}' }).status).toBe(0);
    expect(runGate({ file_path: '/tmp/x.mjs', content: 'agentdb' }, { toolName: 'Read' }).status).toBe(0);
  });

  it('never touches a user who did not opt in — consent is the default', () => {
    const home = freshHome({ optedIn: false });
    expect(runGate({ file_path: '/tmp/a.mjs', content: 'agentdb' }, { home }).status).toBe(0);
  });

  it('FAILS OPEN on garbage — a blocking hook must never brick a session', () => {
    const home = freshHome();
    const r = spawnSync('bash', [GATE], { input: 'not json', env: { ...process.env, HOME: home }, encoding: 'utf8' });
    expect(r.status).toBe(0);
  });

  it('stale stamps (>24h) do NOT open the gate — interfaces and designs move', () => {
    const home = freshHome();
    const dir = path.join(home, '.cache/ruvnet-brain/grounded');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agentdb'), '');
    const old = new Date(Date.now() - 25 * 3600 * 1000);
    fs.utimesSync(path.join(dir, 'agentdb'), old, old);
    expect(runGate({ file_path: '/tmp/a.mjs', content: 'agentdb glue' }, { home }).status).toBe(2);
  });

  it('uses BASH BUILTINS ONLY — a hook that can BLOCK must depend on nothing fragile', () => {
    for (const script of [GATE, STAMP]) {
      const src = fs.readFileSync(script, 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
      for (const bin of ['python3', 'jq', '$(cat', '| grep', '| sed']) {
        expect(src, `${path.basename(script)} must not depend on ${bin}`).not.toContain(bin);
      }
      expect(src).toMatch(/BASH_REMATCH/);
    }
  });
});
