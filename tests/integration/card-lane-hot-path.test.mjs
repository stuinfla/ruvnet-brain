// tests/integration/card-lane-hot-path.test.mjs — proves the card lane is a REAL first responder
// on the ACTUAL hot path (kb/forge-mcp-all.mjs's search_ruvnet tools/call), not merely a fast
// function that exists somewhere in the tree. Everything here runs the real, unmodified MCP
// server as a subprocess (same shape as tests/unit/brain-off.test.mjs's gate 6, which already
// spawns kb/forge-mcp-all.mjs this way) — no mocking of the dispatch logic.
//
// RED FIRST — recorded, verbatim, run against the tree BEFORE kb/forge-mcp-all.mjs imported
// card-lane.mjs:
//
//   $ npx vitest run tests/integration/card-lane-hot-path.test.mjs -t "first responder"
//   AssertionError: expected undefined to be 'rulake' // Object.is equality
//     (structuredContent.cardLane was undefined — nothing answered from the card lane at all;
//      the request instead ran the full heavy search_ruvnet path)
//
// FOUR invariants, each with a reason it cannot pass by accident:
//   1. FIRST RESPONDER, real hot path, real stores present: a card-covered question returns via
//      the card lane, fast, even though the heavy path COULD run (the stores are right there).
//   2. Decoupled from the heavy path entirely: the SAME card hit still works with zero .rvf
//      stores in the bundle dir — proving this is an independent code path, not a lucky fast
//      heavy-path result.
//   3. HONEST FALLTHROUGH: a card-miss reaches the real, unmodified heavy path and returns its
//      honest "(no results)" answer — never a fabricated card citation standing in for a real one.
//   4. WIRED, not just benchmarked (the wired-check.mjs discipline, applied here since kb/ sits
//      outside that gate's own inventory roots): forge-mcp-all.mjs's source contains a REAL
//      invocation-shaped import of card-lane.mjs, and the card-lane check textually precedes the
//      searchAll(...) call it is meant to intercept — a lane nothing calls, or one wired AFTER the
//      thing it should pre-empt, is exactly what this guards against.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FORGE_MCP = path.join(REPO, 'kb/forge-mcp-all.mjs');
const REAL_KB = path.join(REPO, 'kb');

let tmp;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'card-lane-hot-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** A scratch HOME with no brain-off sentinel anywhere it could be found — the brain is ON. */
function childEnv(extra = {}) {
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    RUVNET_BRAIN_STATE_DIR: stateDir,
    RUVNET_BRAIN_METER: '0', // don't pollute the real token ledger
    ...extra,
  };
}

/** Spawn forge-mcp-all.mjs, send one tools/call, resolve with { response, elapsedMs }.
 *  serverPath defaults to the real, unmodified kb/forge-mcp-all.mjs; the "BREAK IT" test below
 *  points it at a DELIBERATELY INCOMPLETE copy so the relative "./card-lane.mjs" import resolves
 *  against that copy's own directory, not the real kb/ next door. */
function callSearchRuvnet(kbDir, query, { timeoutMs = 15_000, serverPath = FORGE_MCP } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [serverPath], {
      env: childEnv({ KB_DIR: kbDir }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timed out after ${timeoutMs}ms; stderr: ${err}`)); }, timeoutMs);
    const req = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_ruvnet', arguments: { query } } };
    child.stdout.on('data', (d) => {
      out += d.toString();
      const nl = out.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      const elapsedMs = performance.now() - t0;
      child.kill();
      try { resolve({ response: JSON.parse(out.slice(0, nl)), elapsedMs }); }
      catch (e) { reject(e); }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    // A child that exits WITHOUT ever writing a full line (e.g. a MODULE_NOT_FOUND crash at
    // import time) must fail fast, not sit out the full timeout — mirrors
    // tests/integration/forge-mcp-server.test.mjs's callOnce().
    child.on('exit', (code) => {
      if (out.indexOf('\n') < 0) { clearTimeout(timer); reject(new Error(`child exited ${code} with no response; stderr: ${err}`)); }
    });
    child.stdin.write(`${JSON.stringify(req)}\n`);
  });
}

// A latency bound that is FAR below any realistic heavy-path result (measured 2026-07-27:
// ~19,620ms warm / ~72,970ms cold — see kb/card-lane.mjs's header) yet generous enough to absorb
// node startup + module-graph parse under real CI/sandbox load. A wiring regression that falls
// through to the heavy path fails this by 1-2 orders of magnitude, never by a close margin.
const FAST_LANE_BOUND_MS = 3000;

describe('card lane — FIRST RESPONDER on the real hot path (subprocess, unmodified server)', () => {
  it('a card-covered question answers via the card lane, fast, with real stores present', async () => {
    const { response, elapsedMs } = await callSearchRuvnet(REAL_KB, 'Which RuvNet tool should I use to cache repeated vector queries?');
    const r = response.result;
    expect(r.isError).toBe(false);
    expect(r.structuredContent?.cardLane?.repo).toBe('rulake');
    expect(r.content[0].text).toMatch(/FAST LANE/);
    // Proves this is genuinely the card lane, not a coincidentally-fast heavy-path hit: the heavy
    // path's own header phrase never appears in a card-lane answer.
    expect(r.content[0].text).not.toMatch(/Searched \d+ RuvNet repos/);
    expect(elapsedMs, `card-lane hit took ${elapsedMs.toFixed(0)}ms — should be far under the heavy-path floor`).toBeLessThan(FAST_LANE_BOUND_MS);
  }, 20_000);

  it('the same card hit works with ZERO .rvf stores in the bundle — decoupled from the heavy path entirely', async () => {
    fs.copyFileSync(path.join(REAL_KB, 'capability-cards.md'), path.join(tmp, 'capability-cards.md'));
    const { response, elapsedMs } = await callSearchRuvnet(tmp, 'Which RuvNet tool should I use for a self-aware feedback loop?');
    const r = response.result;
    expect(r.structuredContent?.cardLane?.repo).toBe('safla');
    expect(elapsedMs).toBeLessThan(FAST_LANE_BOUND_MS);
  }, 20_000);

  it('a card MISS falls through to the real heavy path and returns its honest "no results" — never a fabricated card', async () => {
    fs.copyFileSync(path.join(REAL_KB, 'capability-cards.md'), path.join(tmp, 'capability-cards.md'));
    const { response } = await callSearchRuvnet(
      tmp,
      'Does RuvNet ship a repo called zephyr-quantum-blockchain for supply chain logistics?',
      { timeoutMs: 15_000 },
    );
    const r = response.result;
    expect(r.structuredContent?.cardLane).toBeUndefined();
    expect(r.content[0].text).not.toMatch(/FAST LANE/);
    expect(r.content[0].text).toMatch(/no results/i); // the real, unchanged heavy-path miss text
  }, 20_000);

  it('BREAK IT: with card-lane.mjs deleted from a copy of the bundle, the same query gets NO fast-lane hit', async () => {
    // The counterfactual proving the wiring tests above are not vacuous. Copy just enough of the
    // real kb/ tree to run forge-mcp-all.mjs stand-alone, but WITHOUT card-lane.mjs itself, and
    // confirm the exact same query that hit above now genuinely cannot.
    const files = ['forge-mcp-all.mjs', 'forge-ask-all.mjs', 'forge-ask.mjs', 'forge-rerank.mjs',
      'forge-guard-injection.mjs', 'forge-hybrid.mjs', 'resolve-deps.mjs', 'capability-cards.md'];
    for (const f of files) {
      const src = path.join(REAL_KB, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
    }
    // card-lane.mjs is deliberately NOT copied — the copy's own "./card-lane.mjs" import must fail.
    await expect(callSearchRuvnet(tmp, 'Which RuvNet tool should I use for a self-aware feedback loop?', {
      timeoutMs: 8000, serverPath: path.join(tmp, 'forge-mcp-all.mjs'),
    })).rejects.toThrow();
  }, 15_000);
});

describe('card lane — a REAL caller in invocation shape, and consulted BEFORE the heavy path (source-level, wired-check style)', () => {
  const src = fs.readFileSync(FORGE_MCP, 'utf8');

  it('forge-mcp-all.mjs imports card-lane.mjs in invocation shape (not a comment, not a string mention)', () => {
    // Mirrors scripts/wired-check.mjs's own predicate: a caller must reference the module inside a
    // quoted string after `import`/`from` — prose mentions do not count (that predicate is the
    // entire reason wired-check.mjs exists, per its own header).
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(stripped).toMatch(/\bimport\s*\{[^}]*\}\s*from\s*['"]\.\/card-lane\.mjs['"]/);
  });

  it('the card-lane check appears BEFORE searchAll( in source order — the pre-empt is real, not cosmetic', () => {
    const cardIdx = src.indexOf('answerFromCards(query, KB_DIR');
    const searchAllIdx = src.indexOf('} = await searchAll({');
    expect(cardIdx).toBeGreaterThan(-1);
    expect(searchAllIdx).toBeGreaterThan(-1);
    expect(cardIdx).toBeLessThan(searchAllIdx);
  });

  it('bypasses the card lane only when a configured identity resolves to a deployed RVF family', () => {
    const familyIdx = src.indexOf('deployedFamilyReposFromQuery(query, KB_DIR, repoList)');
    const cardIdx = src.indexOf('answerFromCards(query, KB_DIR');
    expect(familyIdx).toBeGreaterThan(-1);
    expect(familyIdx).toBeLessThan(cardIdx);
    expect(src.slice(familyIdx, cardIdx)).toMatch(/namedFamilyRepos\.length/);
  });

  it('a card hit RETURNS before reaching searchAll — no fall-through path can run both', () => {
    // Between the card-hit branch's opening brace and its own return statement there must be a
    // `return` and NO reachable call to searchAll — i.e. the branch is a real early-exit, not a
    // side-effecting log that still falls through underneath it.
    const branchStart = src.indexOf('if (cardHit.hit) {');
    const branchEnd = src.indexOf('\n        }', branchStart);
    const branch = src.slice(branchStart, branchEnd);
    expect(branch).toMatch(/return ok\(/);
    expect(branch).not.toContain('searchAll(');
  });
});
