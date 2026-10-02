/**
 * package-recommender.test.mjs — the proactive package recommender (ADR-0093, status Proposed).
 *
 * Every guard here is proved by breaking what it guards: each `red:` case runs the mutation that
 * must make the guarded property fail, so a test that cannot go red on broken code is caught here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as rec from '../../plugin/scripts/package-recommender.mjs';
import { contentTokens, normalizeApostrophes } from '../../kb/card-lane.mjs';
import {
  parseManifestPassage, isShippablePath, isPlatformBinary, familyKey, buildCards, publicStoresFrom,
} from '../../scripts/package-cards.mjs';
import { evaluate } from '../../scripts/recommendation-eval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SNAPSHOT = path.join(ROOT, 'plugin', 'scripts', 'package-cards.json');
const ROUTE = path.join(ROOT, 'plugin', 'scripts', 'advocacy-route.mjs');
const RUNTIME = path.join(ROOT, 'plugin', 'scripts', 'unprompted-runtime.mjs');
const doc = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
const index = rec.indexCards(doc);
const evalItems = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'evals', f), 'utf8')).items;

const TYPESAFE_PROMPT = 'so I need to sort incoming support emails into billing, bug report or feature request, ideally locally without paying for an LLM call on every single one';

describe('tokenizer parity with the card lane (the plugin cannot import kb/, issue #32)', () => {
  const table = [
    'Hybrid sparse-dense search: BM25 + ANN + Reciprocal Rank Fusion for ruvector',
    'Local typed decisions (choice / score / noul) over sentence embeddings',
    'the agent’s memory is a single-file .rvf container with HNSW',
    'graph-database with Cypher queries; dspy.ts and cve-bench names stay whole',
  ];
  it('green: lexTokens equals card-lane contentTokens wherever the lane applies no phrase rewrite', () => {
    for (const s of table) {
      // Precondition: the lane's phrase rewrites are a no-op on this input, so the two must agree.
      expect(normalizeApostrophes(s).toLowerCase()).toBeTruthy();
      expect(rec.lexTokens(s).sort()).toEqual(contentTokens(s).sort());
    }
  });
  it('red: a drifted stopword list is detected by the same comparison', () => {
    const drifted = (t) => rec.lexTokens(t).filter((x) => x !== 'search');
    expect(drifted(table[0]).sort()).not.toEqual(contentTokens(table[0]).sort());
  });
});

describe('card generator: grounded, public, installable, de-duplicated', () => {
  const npm = (name, p, desc = 'A sufficiently long description of what this package does.', kw = '') =>
    `npm package: ${name}\nVersion: 1.0.0\nPath: ${p}\nDescription: ${desc}\nKeywords: ${kw}`;

  it('parses npm and crate manifests; rejects a nameless manifest', () => {
    expect(parseManifestPassage(npm('@ruvector/typesafe', 'npm/packages/typesafe/package.json', 'Local typed decisions over embeddings ok', 'a, B'), 'npm/packages/typesafe/package.json'))
      .toMatchObject({ kind: 'npm', name: '@ruvector/typesafe', keywords: ['a', 'b'] });
    expect(parseManifestPassage('Rust crate / manifest: ruvector-hybrid\nPath: crates/ruvector-hybrid/Cargo.toml\nDescription: Hybrid sparse-dense search', 'x'))
      .toMatchObject({ kind: 'crate', name: 'ruvector-hybrid' });
    expect(parseManifestPassage('npm package: v3/web/package.json\nDescription: ', 'v3/web/package.json')).toBeNull();
  });

  it('drops examples/tests/vendored paths and per-platform binaries', () => {
    expect(isShippablePath('npm/packages/router/package.json')).toBe(true);
    expect(isShippablePath('examples/edge-net/tests/package.json')).toBe(false);
    expect(isShippablePath('.agents/skills/ruflo/package.json')).toBe(false);
    expect(isPlatformBinary('@ruvector/router-linux-arm64-gnu')).toBe(true);
    expect(isPlatformBinary('@ruvector/tiny-dancer-win32-x64-msvc')).toBe(true);
    expect(isPlatformBinary('@ruvector/router')).toBe(false);
  });

  it('collapses a family to its npm lead and keeps siblings as variants', () => {
    expect(familyKey('@ruvector/gnn-wasm')).toBe(familyKey('ruvector-gnn-node'));
    const cards = buildCards([
      { store: 'ruvector', path: 'npm/packages/gnn/package.json', text: npm('@ruvector/gnn', 'npm/packages/gnn/package.json') },
      { store: 'ruvector', path: 'crates/ruvector-gnn-node/package.json', text: npm('ruvector-gnn-node', 'crates/ruvector-gnn-node/package.json') },
    ], { publicStores: new Set(['ruvector']) });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: '@ruvector/gnn', variants: ['ruvector-gnn-node'], source: 'ruvector/npm/packages/gnn/package.json' });
    expect(cards[0].sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('green: a private store never produces a card; red: without the allowlist it would', () => {
    const rows = [{ store: 'cognitum-seed', path: 'package.json', text: npm('@cognitum/secret', 'package.json') }];
    const allow = publicStoresFrom('## ruvector\nx\n## cognitum-seed\ny\n', ['cognitum-seed']);
    expect(allow.has('cognitum-seed')).toBe(false);
    expect(buildCards(rows, { publicStores: allow })).toHaveLength(0);
    expect(buildCards(rows, { publicStores: undefined })).toHaveLength(1);   // the mutation the guard exists for
  });

  it('prefers the scope owner over a vendored copy of the same package', () => {
    const rows = [
      { store: 'agentic-flow', path: 'p/package.json', text: npm('@ruvector/router', 'p/package.json') },
      { store: 'ruvector', path: 'npm/packages/router/package.json', text: npm('@ruvector/router', 'npm/packages/router/package.json') },
    ];
    const cards = buildCards(rows, { publicStores: new Set(['ruvector', 'agentic-flow']), owners: { '@ruvector/*': 'ruvector' } });
    expect(cards.find((c) => c.id === '@ruvector/router').store).toBe('ruvector');
  });
});

describe('the committed snapshot', () => {
  it('is schema-valid, cites a source for every card, and carries no private store', () => {
    expect(doc.schema).toBe(rec.SCHEMA);
    const priv = JSON.parse(fs.readFileSync(path.join(ROOT, 'kb', 'PRIVATE-STORES.json'), 'utf8')).privateStores;
    for (const c of doc.cards) {
      expect(c.source.startsWith(`${c.store}/`)).toBe(true);
      expect(c.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(priv).not.toContain(c.store);
    }
  });
  it('carries every package the 4.5 plan names', () => {
    const ids = new Set(doc.cards.map((c) => c.id));
    for (const id of ['@ruvector/typesafe', '@ruvector/router', '@ruvector/tiny-dancer', 'ruvector-hybrid',
      'ruvector-maxsim', 'ruvector-gnn-rerank', 'ruvector-query-cache']) expect(ids.has(id), id).toBe(true);
  });
  it('stores tokens equal to what this code computes (else TOKENIZER_VERSION must be bumped)', () => {
    expect(doc.tokenizer).toBe(rec.TOKENIZER_VERSION);
    for (const c of doc.cards.slice(0, 200)) {
      const fresh = rec.cardTokenSets(c);
      expect(c.t, c.id).toEqual(fresh.t);
      expect(c.s, c.id).toEqual(fresh.s);
    }
  });
  it('red: a card file with a foreign tokenizer stamp is re-tokenized, not trusted', () => {
    const poisoned = { ...doc, tokenizer: 'other/9', cards: doc.cards.map((c) => ({ ...c, t: ['zzz'], s: ['zzz'] })) };
    const idx = rec.indexCards(poisoned);
    expect(rec.rank(TYPESAFE_PROMPT, idx).decision?.card.id).toBe('@ruvector/typesafe');
    const trusted = rec.indexCards({ ...poisoned, tokenizer: rec.TOKENIZER_VERSION });
    expect(rec.rank(TYPESAFE_PROMPT, trusted).decision).toBeNull();
  });
});

describe('matcher', () => {
  it('names @ruvector/typesafe for the ticket-sorting need, citing its manifest', () => {
    const d = rec.recommend(TYPESAFE_PROMPT, { index });
    expect(d.card.id).toBe('@ruvector/typesafe');
    expect(d.card.source).toBe('ruvector/npm/packages/typesafe/package.json');
  });
  it('stays silent on off-topic, chores and no-fit build work', () => {
    for (const p of ['commit this and push it to the branch please', 'ok continue with the next step of the plan',
      'add a dark mode toggle to the settings page and remember the choice', 'help me plan a five day trip to lisbon in may']) {
      expect(rec.recommend(p, { index }), p).toBeNull();
    }
  });
  it('returns null (never throws) with no card index', () => {
    expect(rec.recommend(TYPESAFE_PROMPT, { index: null })).toBeNull();
    expect(rec.loadIndex([path.join(os.tmpdir(), 'no-such-cards.json')])).toBeNull();
  });
  it('red: removing the margin gate turns a refused near-tie into a firing', () => {
    const tie = 'combine bm25 with vector search and fuse the two rankings into one result set';
    expect(rec.rank(tie, index).decision).toBeNull();
    expect(rec.rank(tie, index, { ...rec.GATES, MARGIN: 1 }).decision).not.toBeNull();
  });
});

describe('the eval gate (frozen gates; numbers bound magnitude, not just direction)', () => {
  // Measured 2026-10-01 on snapshot corpus 2026-10-01T11:01:11Z: self-authored 32/47 recall, 1/26 false
  // firings; blind 5/24 recall, 0/16 false firings. Floors sit just under the measurement so a drop of
  // even one correct firing, or one extra false firing, fails.
  const selfSet = evalItems('recommendation-eval.v1.json');
  const blindSet = evalItems('recommendation-eval.blind.v1.json');
  it('meets the stated sizes: >= 60 self-authored prompts across all four categories', () => {
    expect(selfSet.length).toBeGreaterThanOrEqual(60);
    for (const c of ['design', 'diagnosis', 'off-topic', 'no-fit']) expect(selfSet.some((i) => i.category === c)).toBe(true);
  });
  it('green: precision, false firings and recall hold at the measured levels', () => {
    const a = evaluate(selfSet, index).overall;
    const b = evaluate(blindSet, index).overall;
    expect(a.missingAcceptIds ?? []).toEqual([]);
    expect(a.recall.k).toBeGreaterThanOrEqual(32);
    expect(a.falseFiring.k).toBeLessThanOrEqual(1);
    expect(a.wrongPackage).toBeLessThanOrEqual(1);
    expect(b.recall.k).toBeGreaterThanOrEqual(5);
    expect(b.falseFiring.k).toBe(0);
    expect(b.wrongPackage).toBe(0);
  });
  it('red: loosening every gate is caught by the false-firing bound', () => {
    const loose = { MIN_OVERLAP: 1, MIN_STRONG: 0, MIN_SCORE: 0, MIN_COVERAGE: 0, MARGIN: 1 };
    const rows = [...selfSet, ...blindSet].filter((i) => ['off-topic', 'no-fit'].includes(i.category));
    const fires = rows.filter((i) => rec.rank(i.prompt, index, loose).decision).length;
    expect(fires).toBeGreaterThan(1);
  });
});

// ── The flag and the real delivery path ──────────────────────────────────────────────────────────
describe('behind the flag, through advocacy-route and unprompted-runtime', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgrec-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  // Every path the producer or runtime could write is under `dir`; HOME included.
  const env = (extra = {}) => ({
    PATH: process.env.PATH,
    HOME: dir,
    USERPROFILE: dir,
    RUVNET_HOME_OVERRIDE: dir,
    RUVNET_ADVOCACY_ROUTE_STATE: path.join(dir, 'state.json'),
    RUVNET_ADVOCACY_OUTCOMES: path.join(dir, 'outcomes.jsonl'),
    RUVNET_ADVOCACY_ROUTE_ROOTS: path.join(dir, 'none'),
    RUVNET_PACKAGE_CARDS: SNAPSHOT,
    RUVNET_SETTINGS_FILE: path.join(dir, 'settings.json'),
    // These tests prove DELIVERY semantics (dial, ledger, cap), not timing: on a machine at load 130+
    // the producer measured 2.6 s and the runtime's 2 s deadline silenced it. Timing is measured by
    // scripts/recommendation-e2e.mjs and gated in the ADR; it is not asserted here.
    RUVNET_UNPROMPTED_TIMEOUT_MS: '15000',
    ...extra,
  });
  const payload = (prompt, sid = 's1') => JSON.stringify({ session_id: sid, cwd: dir, hook_event_name: 'UserPromptSubmit', prompt });
  const producer = (prompt, extra) => spawnSync(process.execPath, [ROUTE], { input: payload(prompt), env: env({ RUVNET_EMIT_CANDIDATES: '1', ...extra }), encoding: 'utf8', timeout: 20000 });
  // The runtime with ONLY the route registered as producer (anticipate/lesson would read the real machine).
  const runtime = (prompt, extra) => spawnSync(process.execPath, [RUNTIME, 'UserPromptSubmit'], {
    input: payload(prompt),
    env: env({ RUVNET_UNPROMPTED_PRODUCERS: JSON.stringify([{ argv: [process.execPath, ROUTE], feedStdin: true, channels: ['advocacy'] }]), ...extra }),
    encoding: 'utf8', timeout: 20000,
  });

  it('default OFF: the package lane is byte-silent and writes no state', () => {
    const r = producer(TYPESAFE_PROMPT, {});
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(fs.existsSync(path.join(dir, 'state.json'))).toBe(false);
  });

  it('red: any value other than an explicit opt-in stays off', () => {
    for (const v of ['0', 'off', 'false', '', 'maybe']) expect(producer(TYPESAFE_PROMPT, { RUVNET_PACKAGE_RECOMMENDER: v }).stdout, v).toBe('');
  });

  it('ON: one advocacy candidate, one line of copy, naming the package and its source path', () => {
    const r = producer(TYPESAFE_PROMPT, { RUVNET_PACKAGE_RECOMMENDER: '1' });
    expect(r.status).toBe(0);
    const c = JSON.parse(r.stdout.trim());
    expect(c).toMatchObject({ channel: 'advocacy', effect: 'advisory', findingId: 'recommend:pkg:@ruvector/typesafe', package: '@ruvector/typesafe', capability: 'typesafe' });
    expect(c.copy).toContain('ruvector/npm/packages/typesafe/package.json');
    expect(c.copy.split('\n')).toHaveLength(1);
  });

  it('ON: the closed catalogue keeps precedence for its measured intents', () => {
    const r = producer('tests are flaky and we don\'t know what\'s untested — trustworthy coverage and real quality gates', { RUVNET_PACKAGE_RECOMMENDER: '1' });
    expect(JSON.parse(r.stdout.trim()).findingId).toBe('recommend:agentic-qe');
  });

  it('ON through the runtime: delivered at the default dial, recorded as OFFERED, then capped for the session', () => {
    const r = runtime(TYPESAFE_PROMPT, { RUVNET_PACKAGE_RECOMMENDER: '1' });
    expect(r.status).toBe(0);
    const env1 = JSON.parse(r.stdout);
    expect(env1.hookSpecificOutput.additionalContext).toContain('@ruvector/typesafe');
    const ledger = fs.readFileSync(path.join(dir, 'outcomes.jsonl'), 'utf8');
    expect(ledger).toContain('recommend:pkg:@ruvector/typesafe');
    // Same session, a different matching need: MAX_PER_SESSION = 1 holds across both lanes.
    const again = runtime('long documents that cover lots of topics get averaged into one embedding, I want multi-vector late interaction search like colbert', { RUVNET_PACKAGE_RECOMMENDER: '1' });
    expect(again.stdout).toBe('');
  });

  it('ON: a package offer resolves through the shared lifecycle and is counted by --summary', () => {
    expect(runtime(TYPESAFE_PROMPT, { RUVNET_PACKAGE_RECOMMENDER: '1' }).stdout).toContain('@ruvector/typesafe');
    // The user declines by name on the next prompt of the same session.
    expect(producer('no, skip typesafe for now', { RUVNET_PACKAGE_RECOMMENDER: '1' }).status).toBe(0);
    const ledger = fs.readFileSync(path.join(dir, 'outcomes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(ledger.map((r) => `${r.id}:${r.action}`)).toEqual(expect.arrayContaining([
      'recommend:pkg:@ruvector/typesafe:offered', 'recommend:pkg:@ruvector/typesafe:dismissed']));
    const s = spawnSync(process.execPath, [ROUTE, '--summary'], { env: env(), encoding: 'utf8', timeout: 20000 });
    expect(JSON.parse(s.stdout).dismissed).toBe(1);
    // A dismissed package is not offered again, even in a fresh session.
    const fresh = spawnSync(process.execPath, [RUNTIME, 'UserPromptSubmit'], {
      input: payload(TYPESAFE_PROMPT, 's2'),
      env: env({ RUVNET_PACKAGE_RECOMMENDER: '1', RUVNET_UNPROMPTED_PRODUCERS: JSON.stringify([{ argv: [process.execPath, ROUTE], feedStdin: true, channels: ['advocacy'] }]) }),
      encoding: 'utf8', timeout: 20000,
    });
    expect(fresh.stdout).toBe('');
  });

  it('ON but dial at 1 (only when I ask): the runtime drops it — the flag never bypasses the dial', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ version: 1, updated: new Date().toISOString(), settings: { advocacy: 1 } }));
    const r = runtime(TYPESAFE_PROMPT, { RUVNET_PACKAGE_RECOMMENDER: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
