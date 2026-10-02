/**
 * package-recommender-semantic.test.mjs — the warm-worker semantic lane (ADR-093 rev 2).
 *
 * The endpoint is exercised for real (a real Unix socket / named pipe, a real token, real timeouts);
 * only the card index behind it is a fake, because loading bge-base in a unit test would make it slow
 * and network-shaped. The real embedder path is measured by scripts/recommendation-e2e.mjs.
 * Each guard has a `red:` twin that breaks it and watches the property fail.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as kbEndpoint from '../../kb/recommend-endpoint.mjs';
import { openCardIndex } from '../../kb/package-cards-index.mjs';
import * as client from '../../plugin/scripts/package-recommender-client.mjs';
import * as rec from '../../plugin/scripts/package-recommender.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = path.join(ROOT, 'plugin', 'scripts');
const PROMPT = 'so I need to sort incoming support emails into billing, bug report or feature request, ideally locally';

let home;
let ep;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-')); });
afterEach(() => { try { ep?.close(); } catch { /* closed */ } ep = null; fs.rmSync(home, { recursive: true, force: true }); });

const fakeIndex = (hits, delayMs = 0) => async () => ({
  size: hits.length,
  query: async () => { if (delayMs) await new Promise((r) => setTimeout(r, delayMs)); return hits; },
});
const card = (id, similarity = 0.7) => ({ card: { id }, similarity });
const env = () => ({ RUVNET_BRAIN_HOME: home, RUVNET_PACKAGE_RECOMMENDER: '1' });

describe('parity between the plugin and kb copies (they cannot import each other, issue #32)', () => {
  it('brain home and the flag rule agree on every input', () => {
    const cases = [{ RUVNET_BRAIN_HOME: '/x' }, { XDG_CACHE_HOME: '/c', HOME: '/h' }, { HOME: '/h' }, { USERPROFILE: 'C:\\u' }];
    for (const e of cases) expect(client.brainHomeFromEnv(e)).toBe(kbEndpoint.brainHomeFromEnv(e));
    for (const v of ['1', 'on', 'TRUE', ' yes ', '0', 'off', '', 'maybe']) {
      expect(rec.packageRecommenderEnabled({ RUVNET_PACKAGE_RECOMMENDER: v })).toBe(kbEndpoint.recommenderFlagOn({ RUVNET_PACKAGE_RECOMMENDER: v }));
    }
  });
});

describe('the endpoint and the hook client, over a real socket', () => {
  it('green: a warm endpoint answers with candidates inside the budget', async () => {
    ep = await kbEndpoint.startRecommendEndpoint({ brainHome: home, openIndex: fakeIndex([card('@ruvector/typesafe'), card('@ruvector/router')]), signals: false });
    expect(ep).not.toBeNull();
    const t = Date.now();
    const r = await client.askWarmWorker({ prompt: PROMPT, cardsDir: SCRIPTS, env: env() });
    expect(Date.now() - t).toBeLessThan(1000);
    expect(r.candidates.map((c) => c.id)).toEqual(['@ruvector/typesafe', '@ruvector/router']);
  });

  it('red: a request without the descriptor token is refused', async () => {
    ep = await kbEndpoint.startRecommendEndpoint({ brainHome: home, openIndex: fakeIndex([card('x')]), signals: false });
    const desc = path.join(home, 'run', `recommend-${process.pid}.json`);
    const d = JSON.parse(fs.readFileSync(desc, 'utf8'));
    fs.writeFileSync(desc, JSON.stringify({ ...d, token: crypto.randomBytes(24).toString('hex') }));
    const r = await client.askWarmWorker({ prompt: PROMPT, cardsDir: SCRIPTS, env: env() });
    expect(r.candidates).toBeNull();
    expect(r.reason).toBe('unauthorized');
  });

  it('descriptor and socket are private to the user', async () => {
    if (process.platform === 'win32') return;
    ep = await kbEndpoint.startRecommendEndpoint({ brainHome: home, openIndex: fakeIndex([card('x')]), signals: false });
    expect(fs.statSync(path.join(home, 'run')).mode & 0o077).toBe(0);
    expect(fs.statSync(path.join(home, 'run', `recommend-${process.pid}.json`)).mode & 0o077).toBe(0);
  });

  it('cold (no endpoint) is silent and immediate', async () => {
    const t = Date.now();
    const r = await client.askWarmWorker({ prompt: PROMPT, cardsDir: SCRIPTS, env: env() });
    expect(r).toEqual({ candidates: null, reason: 'no-warm-worker' });
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('a slow worker is abandoned at the budget — silent, never slow', async () => {
    ep = await kbEndpoint.startRecommendEndpoint({ brainHome: home, openIndex: fakeIndex([card('x')], 1500), signals: false });
    const t = Date.now();
    const r = await client.askWarmWorker({ prompt: PROMPT, cardsDir: SCRIPTS, budgetMs: 200, env: env() });
    const ms = Date.now() - t;
    expect(r.candidates).toBeNull();
    expect(ms).toBeGreaterThanOrEqual(190);
    expect(ms).toBeLessThan(1000);   // the worker would have taken 1500 ms
  });

  it('a dead worker\'s descriptor is ignored by the client and swept by the next endpoint', async () => {
    const run = path.join(home, 'run');
    fs.mkdirSync(run, { recursive: true, mode: 0o700 });
    const deadPid = 2 ** 22 + 12345;   // above any default pid_max on macOS/Linux
    fs.writeFileSync(path.join(run, `recommend-${deadPid}.json`), JSON.stringify({ schema: kbEndpoint.SCHEMA, pid: deadPid, socket: path.join(run, `recommend-${deadPid}.sock`), token: 't'.repeat(48), startedAt: '2099-01-01' }), { mode: 0o600 });
    expect(client.liveEndpoints(env())).toEqual([]);
    expect(kbEndpoint.sweepStale(run)).toBe(1);
    expect(fs.existsSync(path.join(run, `recommend-${deadPid}.json`))).toBe(false);
  });

  it('semanticFor never touches a socket when the flag is off or the prompt is a chore', async () => {
    let asked = 0;
    ep = await kbEndpoint.startRecommendEndpoint({ brainHome: home, openIndex: fakeIndex([card('x', 0.9)]), signals: false, onActivity: () => { asked++; } });
    expect(await client.semanticFor(PROMPT, { env: { RUVNET_BRAIN_HOME: home } })).toBeNull();
    expect(await client.semanticFor('commit this and push it please', { env: env() })).toBeNull();
    expect(await client.semanticFor(PROMPT, { env: env(), catalogueMatched: true })).toBeNull();
    expect(asked).toBe(0);
    expect((await client.semanticFor(PROMPT, { env: env() })).candidates).toHaveLength(1);
    expect(asked).toBe(1);   // red twin: the spy does count a real ask
  });

  it('a planted descriptor is not trusted: foreign socket path, world-readable file, wrong schema', async () => {
    if (process.platform === 'win32') return;
    ep = await kbEndpoint.startRecommendEndpoint({ brainHome: home, openIndex: fakeIndex([card('x')]), signals: false });
    const desc = path.join(home, 'run', `recommend-${process.pid}.json`);
    const d = JSON.parse(fs.readFileSync(desc, 'utf8'));
    expect(client.liveEndpoints(env())).toHaveLength(1);
    fs.writeFileSync(desc, JSON.stringify({ ...d, socket: path.join(os.tmpdir(), 'elsewhere.sock') }));
    expect(client.liveEndpoints(env())).toHaveLength(0);
    fs.writeFileSync(desc, JSON.stringify({ ...d, schema: 'other/1' }));
    expect(client.liveEndpoints(env())).toHaveLength(0);
    fs.writeFileSync(desc, JSON.stringify(d));
    fs.chmodSync(desc, 0o644);
    expect(client.liveEndpoints(env())).toHaveLength(0);
  });

  // A Unix socket path is capped (macOS: 104 bytes, measured; 105 → listen EINVAL). A long HOME or
  // RUVNET_BRAIN_HOME made <brainHome>/run/recommend-<pid>.sock too long and the endpoint never started.
  it('a brain home too deep for a socket path still serves: the socket goes in the short private per-user dir', async () => {
    if (process.platform === 'win32') return;
    const deep = path.join(home, 'a'.repeat(60), 'b'.repeat(40));
    fs.mkdirSync(deep, { recursive: true });
    expect(Buffer.byteLength(path.join(deep, 'run', `recommend-${process.pid}.sock`))).toBeGreaterThan(kbEndpoint.SOCKET_PATH_MAX);
    const lines = [];
    ep = await kbEndpoint.startRecommendEndpoint({ brainHome: deep, openIndex: fakeIndex([card('@ruvector/typesafe')]), signals: false, log: (l) => lines.push(l) });
    expect(ep, lines.join('\n')).not.toBeNull();
    expect(ep.descriptor.socket).toBe(path.join(kbEndpoint.shortSocketDir(), `recommend-${process.pid}.sock`));
    expect(lines.some((l) => /bytes \(limit \d+\); listening in /.test(l))).toBe(true); // one diagnostic line
    expect(fs.lstatSync(kbEndpoint.shortSocketDir()).mode & 0o077).toBe(0);
    const r = await client.askWarmWorker({ prompt: PROMPT, cardsDir: SCRIPTS, env: { RUVNET_BRAIN_HOME: deep, RUVNET_PACKAGE_RECOMMENDER: '1' } });
    expect(r.candidates?.map((c) => c.id)).toEqual(['@ruvector/typesafe']);
    // red: the short dir is trusted only for THAT pid's socket name, never an arbitrary file in it.
    const desc = path.join(deep, 'run', `recommend-${process.pid}.json`);
    const d = JSON.parse(fs.readFileSync(desc, 'utf8'));
    fs.writeFileSync(desc, JSON.stringify({ ...d, socket: path.join(kbEndpoint.shortSocketDir(), 'recommend-1.sock') }));
    expect(client.liveEndpoints({ RUVNET_BRAIN_HOME: deep })).toHaveLength(0);
    fs.writeFileSync(desc, JSON.stringify(d));
    expect(client.liveEndpoints({ RUVNET_BRAIN_HOME: deep })).toHaveLength(1);
  });

  it('the plugin and kb copies agree on the short socket dir', () => {
    for (const uid of [0, 501, 1000, null]) expect(client.shortSocketDir(uid)).toBe(kbEndpoint.shortSocketDir(uid));
  });

  it('the endpoint refuses a directory that is not the card snapshot, and oversize requests', async () => {
    let opened = 0;
    ep = await kbEndpoint.startRecommendEndpoint({ brainHome: home, openIndex: async (dir) => { opened++; return fakeIndex([card('x')])(dir); }, signals: false });
    expect((await client.askWarmWorker({ prompt: PROMPT, cardsDir: home, env: env() })).reason).toBe('no-card-index');
    expect((await client.askWarmWorker({ prompt: PROMPT, cardsDir: 'relative/dir', env: env() })).reason).toBe('no-card-index');
    expect(opened).toBe(0);
    const d = client.liveEndpoints(env())[0];
    const reply = await new Promise((resolve) => {
      const sock = net.createConnection(d.socket);
      let got = ''; sock.on('data', (c) => { got += c; }); sock.on('close', () => resolve(got)); sock.on('error', () => resolve(got));
      sock.on('connect', () => sock.write('x'.repeat(20 * 1024)));
    });
    expect(reply).toBe('');   // destroyed, no answer
  });

  it('a failed index open is not cached: the next request retries', async () => {
    let calls = 0;
    ep = await kbEndpoint.startRecommendEndpoint({ brainHome: home, openIndex: async (dir) => { calls++; if (calls === 1) throw new Error('mid-update'); return fakeIndex([card('x')])(dir); }, signals: false });
    expect((await client.askWarmWorker({ prompt: PROMPT, cardsDir: SCRIPTS, env: env() })).candidates).toBeNull();
    expect((await client.askWarmWorker({ prompt: PROMPT, cardsDir: SCRIPTS, env: env() })).candidates).toHaveLength(1);
    expect(calls).toBe(2);
  });
});

describe('the semantic lane turns candidates into one hint', () => {
  const index = rec.loadIndex([path.join(SCRIPTS, 'package-cards.json')]);
  const semantic = { candidates: ['@ruvector/typesafe', '@ruvector/router', 'ruvector-hybrid', '@ruvector/kge', '@ruvector/diskann'].map((id) => ({ id, similarity: 0.6 })) };

  it('lists at most SEMANTIC_K cards with their source paths and the measured instruction', () => {
    const lane = rec.semanticLane({ prompt: PROMPT, semantic, index });
    const c = lane.build();
    expect(c.candidates).toHaveLength(rec.SEMANTIC_K);
    expect(c.copy).toContain('ruvector/npm/packages/typesafe/package.json');
    expect(c.copy).toContain('Never mention more than one');
    expect(lane.cap).toBe(rec.SEMANTIC_MAX_PER_SESSION);
  });

  it('drops dismissed and already-offered packages; empty after filtering is silence', () => {
    const lane = rec.semanticLane({ prompt: PROMPT, semantic, index, offered: new Set(['typesafe']), allowed: (id) => !id.endsWith('router') });
    expect(lane.build().candidates).toEqual(['ruvector-hybrid', '@ruvector/kge', '@ruvector/diskann']);
    expect(rec.semanticLane({ prompt: PROMPT, semantic, index, allowed: () => false })).toBeNull();
  });

  it('a nearest card below the similarity floor means no hint at all', () => {
    const far = { candidates: semantic.candidates.map((c) => ({ ...c, similarity: rec.SEMANTIC_MIN_SIMILARITY - 0.01 })) };
    expect(rec.semanticLane({ prompt: PROMPT, semantic: far, index })).toBeNull();
    expect(rec.semanticLane({ prompt: PROMPT, semantic: far, index, floor: 0 })).not.toBeNull();   // red twin
  });

  it('red: a chore prompt gets no hint even with candidates in hand', () => {
    expect(rec.semanticLane({ prompt: 'commit this and push it to the branch please', semantic, index })).toBeNull();
  });
});

describe('the real hook producer, warm and cold', () => {
  // Async spawn: the endpoint lives in THIS process, so a blocking spawnSync could never be answered.
  const produce = (prompt, extra = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS, 'advocacy-route.mjs')], {
      env: {
        PATH: process.env.PATH, HOME: home, RUVNET_HOME_OVERRIDE: home, RUVNET_BRAIN_HOME: home,
        RUVNET_EMIT_CANDIDATES: '1', RUVNET_PACKAGE_RECOMMENDER: '1',
        RUVNET_ADVOCACY_ROUTE_STATE: path.join(home, 'state.json'), RUVNET_ADVOCACY_OUTCOMES: path.join(home, 'o.jsonl'),
        RUVNET_ADVOCACY_ROUTE_ROOTS: path.join(home, 'none'), ...extra,
      },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, cand: out.trim() ? JSON.parse(out.trim()) : null }));
    child.stdin.end(JSON.stringify({ session_id: 's', prompt }));
  });

  it('warm: the hint is the candidate set from the worker, with the one-mention instruction', async () => {
    ep = await kbEndpoint.startRecommendEndpoint({ brainHome: home, openIndex: fakeIndex([card('@ruvector/typesafe'), card('ruvector-hybrid')]), signals: false });
    const { code, cand } = await produce(PROMPT);
    expect(code).toBe(0);
    expect(cand.candidates).toEqual(['@ruvector/typesafe', 'ruvector-hybrid']);
    expect(cand.copy).toContain('Never mention more than one');
  });

  it('cold: no worker → the lexical lane answers alone (never a wait)', async () => {
    const { cand } = await produce('so I need to sort incoming support emails into billing, bug report or feature request, ideally locally without paying for an LLM call on every single one');
    expect(cand.findingId).toBe('recommend:pkg:@ruvector/typesafe');
    expect(cand.candidates).toBeUndefined();
  });

  it('red: flag off → the endpoint is never asked and nothing is emitted', async () => {
    ep = await kbEndpoint.startRecommendEndpoint({ brainHome: home, openIndex: fakeIndex([card('@ruvector/typesafe')]), signals: false });
    const { cand } = await produce(PROMPT, { RUVNET_PACKAGE_RECOMMENDER: '0' });
    expect(cand).toBeNull();
  });
});

describe('snapshot staleness (the cards ship as a snapshot, not in the sealed corpus)', () => {
  it('age is measured from the source corpus build; unknown is null, never zero', async () => {
    const { snapshotAgeDays } = await import('../../scripts/package-cards.mjs');
    const now = Date.parse('2026-10-15T00:00:00Z');
    expect(snapshotAgeDays({ derivedFrom: { builtUtc: '2026-10-01T00:00:00Z' } }, now)).toBe(14);
    expect(snapshotAgeDays({ derivedFrom: {} }, now)).toBeNull();
    expect(snapshotAgeDays(null, now)).toBeNull();
  });
});

describe('the shipped card index is bound to the shipped cards', () => {
  it('green: package-cards.rvf.meta.json carries the sha of package-cards.json and the bge model', () => {
    const meta = JSON.parse(fs.readFileSync(path.join(SCRIPTS, 'package-cards.rvf.meta.json'), 'utf8'));
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(SCRIPTS, 'package-cards.json'))).digest('hex');
    expect(meta.cardsSha256).toBe(sha);
    expect(meta.embed.model).toBe('Xenova/bge-base-en-v1.5');
    expect(meta.tiers).toEqual(['T0', 'T1']);
  });
  it('red: a card file that drifted from its vectors is refused, not mis-mapped', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pci-'));
    try {
      for (const f of ['package-cards.json', 'package-cards.rvf', 'package-cards.rvf.meta.json']) fs.copyFileSync(path.join(SCRIPTS, f), path.join(dir, f));
      fs.appendFileSync(path.join(dir, 'package-cards.json'), ' ');
      expect(await openCardIndex(dir)).toBeNull();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('candidate-set offers and the outcome ledger (adversarial review H2)', () => {
  const { offerNames } = rec;
  const setOffer = { candidates: ['typesafe', 'router', 'memory', 'ruvector-hybrid'], packages: ['@ruvector/typesafe', '@ruvector/router', 'memory', 'ruvector-hybrid'] };
  it('a set answers to full ids and distinctive short names, never to common words', () => {
    const { set, names } = offerNames(setOffer);
    expect(set).toBe(true);
    expect(names).toEqual(expect.arrayContaining(['@ruvector/typesafe', 'typesafe', 'ruvector-hybrid']));
    expect(names).not.toContain('router');
    expect(names).not.toContain('memory');
  });
  it('a single (catalogue/lexical) offer keeps its one capability name', () => {
    expect(offerNames({ capability: 'agentic-qe' })).toEqual({ set: false, names: ['agentic-qe'] });
  });
  it('through the real lifecycle: bare "ok" does not resolve a set; "use @ruvector/typesafe" does', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-led-'));
    const file = path.join(dir, 'o.jsonl');
    const prevS = process.env.RUVNET_ADVOCACY_ROUTE_STATE; const prevO = process.env.RUVNET_ADVOCACY_OUTCOMES;
    process.env.RUVNET_ADVOCACY_ROUTE_STATE = path.join(dir, 's.json');
    process.env.RUVNET_ADVOCACY_OUTCOMES = file;
    try {
      const route = await import(`${path.join(SCRIPTS, 'advocacy-route.mjs')}?l=${Date.now()}`);
      const outcomes = await import('../../plugin/scripts/advocacy-outcomes.mjs');
      const id = 'recommend:pkg:@ruvector/typesafe';
      const state = { version: 1, sessions: { s: { ts: Date.now(), offers: [{ id, capability: 'typesafe', ...setOffer, at: new Date().toISOString(), resolved: null }] } } };
      outcomes.record({ id, action: outcomes.ACTIONS.OFFERED, severity: 'normal' }, { file });
      expect(route.resolvePriorOffers('ok', 's', { file, state })).toEqual({ applied: [], dismissed: [] });
      expect(route.resolvePriorOffers("don't touch the memory layout", 's', { file, state })).toEqual({ applied: [], dismissed: [] });
      expect(route.resolvePriorOffers('yes, use @ruvector/typesafe for that', 's', { file, state }).applied).toEqual([id]);
    } finally {
      if (prevS === undefined) delete process.env.RUVNET_ADVOCACY_ROUTE_STATE; else process.env.RUVNET_ADVOCACY_ROUTE_STATE = prevS;
      if (prevO === undefined) delete process.env.RUVNET_ADVOCACY_OUTCOMES; else process.env.RUVNET_ADVOCACY_OUTCOMES = prevO;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the committed quality evidence (adversarial review T4)', () => {
  const Q = path.join(ROOT, 'evals', 'runs', '2026-10-01-recommender-4.6', 'semantic-quality');
  const load = (f) => JSON.parse(fs.readFileSync(path.join(Q, f), 'utf8'));
  const cards = () => JSON.parse(fs.readFileSync(path.join(SCRIPTS, 'package-cards.json'), 'utf8')).cards;
  it('score.json is exactly what the scorer computes from the committed key and picks', async () => {
    const { judgeScore } = await import('../../scripts/recommendation-judge-score.mjs');
    const r = judgeScore(load('judge-key.json'), load('judge-picks.json').picks, cards());
    expect(r).toEqual(load('score.json'));
    expect([r.blinds.recall.k, r.blinds.recall.n, r.blinds.precision.k, r.blinds.precision.n, r.blinds.falseFiring.k, r.blinds.falseFiring.n])
      .toEqual([27, 52, 27, 31, 0, 36]);
  });
  it('red: one flipped pick changes the bound numbers', async () => {
    const { judgeScore } = await import('../../scripts/recommendation-judge-score.mjs');
    const key = load('judge-key.json');
    const picks = { ...load('judge-picks.json').picks };
    const neg = key.find((k) => /blind/.test(k.set) && !['design', 'diagnosis'].includes(k.category) && k.lane);
    picks[neg.qid] = '@ruvector/typesafe';
    expect(judgeScore(key, picks, cards()).blinds.falseFiring.k).toBe(1);
  });
});

describe('a swapped .rvf is refused before the native reader sees it', () => {
  it('rvfSha256 in the meta must match the .rvf bytes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pci-rvf-'));
    try {
      for (const f of ['package-cards.json', 'package-cards.rvf', 'package-cards.rvf.meta.json']) fs.copyFileSync(path.join(SCRIPTS, f), path.join(dir, f));
      fs.appendFileSync(path.join(dir, 'package-cards.rvf'), Buffer.from([0]));
      expect(await openCardIndex(dir)).toBeNull();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('products derived from repo + manifest facts (ADR-093 rev 3)', () => {
  const mk = (id, store, source, kind = 'npm') => ({ id, store, source: `${store}/${source}`, kind });
  const derive = async (cards, names = []) => (await import('../../scripts/package-cards.mjs')).deriveProducts(cards, { productNames: new Set(names) });
  it('R1 flagship + R2 scope CLI: ruflo, root claude-flow and @claude-flow/cli are one product, installed as ruflo', async () => {
    const out = await derive([mk('ruflo', 'ruflo', 'ruflo/package.json'), mk('claude-flow', 'ruflo', 'package.json'), mk('@claude-flow/cli', 'ruflo', 'v3/@claude-flow/cli/package.json'), mk('@claude-flow/memory', 'ruflo', 'v3/@claude-flow/memory/package.json')]);
    const p = Object.fromEntries(out.map((c) => [c.id, c]));
    expect(new Set([p.ruflo.product, p['claude-flow'].product, p['@claude-flow/cli'].product]).size).toBe(1);
    expect(p['@claude-flow/cli'].canonical).toBe('ruflo');
    expect(p['@claude-flow/memory'].product).not.toBe(p.ruflo.product);
  });
  it('R3: a corpus-named key joins repos (npm canonical); a common word never does', async () => {
    const cards = [mk('@claude-flow/aidefence', 'ruflo', 'v3/@claude-flow/aidefence/package.json'), mk('aidefence-core', 'midstream', 'crates/aidefence-core/Cargo.toml', 'crate'),
      mk('@claude-flow/deployment', 'ruflo', 'v3/@claude-flow/deployment/package.json'), mk('deployment', 'autogenous', 'deployment/package.json')];
    const p = Object.fromEntries((await derive(cards, ['aidefence'])).map((c) => [c.id, c]));
    expect(p['aidefence-core'].product).toBe(p['@claude-flow/aidefence'].product);
    expect(p['aidefence-core'].canonical).toBe('@claude-flow/aidefence');
    expect(p.deployment.product).not.toBe(p['@claude-flow/deployment'].product);
    // red twin: without the corpus naming the product, the cross-repo merge does not happen
    const q = Object.fromEntries((await derive(cards, [])).map((c) => [c.id, c]));
    expect(q['aidefence-core'].product).not.toBe(q['@claude-flow/aidefence'].product);
  });
  it('the shipped snapshot carries a product and a canonical install on every card', () => {
    const doc = JSON.parse(fs.readFileSync(path.join(SCRIPTS, 'package-cards.json'), 'utf8'));
    const ids = new Set(doc.cards.map((c) => c.id));
    for (const c of doc.cards) { expect(typeof c.product).toBe('string'); expect(ids.has(c.canonical)).toBe(true); }
    const by = Object.fromEntries(doc.cards.map((c) => [c.id, c]));
    expect(by['aidefence-core'].canonical).toBe('@claude-flow/aidefence');
    expect(by['@claude-flow/cli'].canonical).toBe('ruflo');
    expect(by.agenticow.tier).toBe('T1');   // promoted in data/registry.tiers.json (published on npm)
  });
});

describe('the hint names one canonical install per product', () => {
  const index = rec.loadIndex([path.join(SCRIPTS, 'package-cards.json')]);
  it('sibling packages of one product collapse to its canonical install', () => {
    const byId = new Map(index.entries.map((e) => [e.card.id, e.card]));
    const picks = rec.canonicalPicks([{ id: 'aidefence-core', similarity: 0.7 }, { id: '@claude-flow/aidefence', similarity: 0.69 }, { id: '@claude-flow/cli', similarity: 0.6 }], byId);
    expect(picks.map((p) => p.card.id)).toEqual(['@claude-flow/aidefence', 'ruflo']);
    expect(picks[0].matchedVia).toBe('aidefence-core');
  });
});

describe('family-aware scoring and the frozen floor', () => {
  const cards = JSON.parse(fs.readFileSync(path.join(SCRIPTS, 'package-cards.json'), 'utf8')).cards;
  const key = [
    { qid: 'Q1', set: 'b.json', category: 'design', accept: ['@claude-flow/aidefence'], acceptStores: [], lane: 'semantic', topSimilarity: 0.7 },
    { qid: 'Q2', set: 'b.json', category: 'no-fit', accept: [], acceptStores: [], lane: 'semantic', topSimilarity: 0.4 },
  ];
  it('a sibling of an accepted package counts only when family-aware', async () => {
    const { judgeScore } = await import('../../scripts/recommendation-judge-score.mjs');
    const picks = { Q1: 'aidefence-core', Q2: null };
    expect(judgeScore(key, picks, cards).bySet['b.json'].recall.k).toBe(0);
    expect(judgeScore(key, picks, cards, { familyAware: true }).bySet['b.json'].recall.k).toBe(1);
  });
  it('the floor voids a pick whose hint would not have been injected', async () => {
    const { applyFloor, deriveFloor } = await import('../../scripts/recommendation-floor.mjs');
    expect(applyFloor(key, { Q1: 'x', Q2: 'y' }, 0.5)).toEqual({ Q1: 'x', Q2: null });
    const tune = [0.52, 0.6, 0.7, 0.8].map((s, i) => ({ qid: `T${i}`, set: 't', category: 'design', accept: ['ruflo'], lane: 'semantic', topSimilarity: s }));
    expect(deriveFloor(tune, Object.fromEntries(tune.map((k) => [k.qid, 'ruflo'])), cards, 't')).toBe(0.52);
    expect(deriveFloor(tune, {}, cards, 't')).toBeNull();
  });
});

describe('the real-host harness reads what the model said', () => {
  it('mentioned() finds an offered package by full id or distinctive short name, not by a substring', async () => {
    const { mentioned } = await import('../../scripts/recommendation-real-host.mjs');
    expect(mentioned('rUv ships @ruvector/typesafe — local classifier', ['@ruvector/typesafe'])).toBe('@ruvector/typesafe');
    expect(mentioned('I would reach for rUv\'s typesafe here.', ['@ruvector/typesafe'])).toBe('@ruvector/typesafe');
    // measured false positive (real-host Q157): an ordinary word that is also a package short name
    expect(mentioned('Add the field and write the migration. Then run it.', ['@claude-flow/migration'])).toBeNull();
    expect(mentioned('rUv ships @claude-flow/migration for this.', ['@claude-flow/migration'])).toBe('@claude-flow/migration');
    expect(mentioned('a typesafety concern', ['@ruvector/typesafe'])).toBeNull();
    expect(mentioned('nothing relevant', ['@ruvector/typesafe'])).toBeNull();
  });
});
