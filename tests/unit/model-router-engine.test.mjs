// tests/unit/model-router-engine.test.mjs — locks the model-router-engine's contract.
// End-to-end through the REAL CLI, but fully HERMETIC: a fixture catalog (MODEL_ROUTER_CATALOG),
// the repo's own shipped default policy (--policy config/model-router/policy.default.mjs), a
// fixture profile (MODEL_ROUTER_PROFILE), and a temp decision log. The first version of this file
// silently depended on ~/.claude/model-router existing on the dev machine — CI runners have no
// such directory, so the engine fell back to no-policy/cheapest and three assertions failed on
// every runner from the moment the file landed (2026-07-12). Never again: everything the engine
// reads is pinned to fixtures here. Vitest, like the rest of tests/unit — node:test files make
// vitest error "No test suite found in file".
import { test, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENGINE = path.join(ROOT, 'scripts', 'model-router-engine.mjs');
const POLICY = path.join(ROOT, 'config', 'model-router', 'policy.default.mjs'); // the SHIPPED policy
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'router-test-'));
const CATALOG = path.join(TMP, 'catalog.json');
const PROFILE = path.join(TMP, 'profile.json');
const LOG = path.join(TMP, 'decisions.jsonl');
const SELECTION = path.join(TMP, 'routing-policy.json');

// Fixture catalog: the shapes the contract cares about — subscription-covered models on both
// harnesses, billed OpenRouter models, tier spread. Prices are fixture values, not claims.
const FIXTURE = {
  updated: 'fixture',
  candidates: [
    { id: 'claude-haiku-fixture', provider: 'anthropic', harness: ['claude-code'], subscription: ['claude-code'], tier: 'cheap', costPerMTok: null, verified: null },
    { id: 'claude-sonnet-fixture', provider: 'anthropic', harness: ['claude-code'], subscription: ['claude-code'], tier: 'mid', costPerMTok: null, verified: null },
    { id: 'claude-opus-fixture', provider: 'anthropic', harness: ['claude-code'], subscription: ['claude-code'], tier: 'frontier', costPerMTok: { in: 5, out: 25 }, verified: 'fixture' },
    { id: 'gpt-frontier-fixture', provider: 'openai', harness: ['codex'], subscription: ['codex'], tier: 'frontier', costPerMTok: null, verified: null },
    { id: 'or/cheap-fixture', provider: 'openrouter', harness: ['claude-code', 'codex'], subscription: [], tier: 'cheap', costPerMTok: { in: 0.1, out: 0.2 }, verified: 'fixture' },
    { id: 'or/mid-fixture', provider: 'openrouter', harness: ['claude-code', 'codex'], subscription: [], tier: 'mid', costPerMTok: { in: 0.5, out: 1.5 }, verified: 'fixture' },
  ],
};

beforeAll(() => {
  fs.writeFileSync(CATALOG, JSON.stringify(FIXTURE));
  fs.writeFileSync(SELECTION, JSON.stringify({schemaVersion:1,reviewedAt:new Date().toISOString(),routes:{
    codex:{fast:{model:'gpt-frontier-fixture',effort:'low'},medium:{model:'gpt-frontier-fixture',effort:'medium'},hard:{model:'gpt-frontier-fixture',effort:'high'}},
    'claude-code':{fast:{model:'claude-haiku-fixture',effort:'low'},medium:{model:'claude-sonnet-fixture',effort:'medium'},hard:{model:'claude-opus-fixture',effort:'high'},codingEffort:'high'},
  }}));
  fs.writeFileSync(PROFILE, JSON.stringify({
    harnesses: {
      'claude-code': { available: true, subscription: true, basis: 'fixture' },
      codex: { available: true, subscription: true, basis: 'fixture' },
    },
  }));
});
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

const run = (args, extraEnv = {}) =>
  JSON.parse(
    execFileSync(process.execPath, [ENGINE, ...args, '--policy', POLICY, '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MODEL_ROUTER_CATALOG: CATALOG,
        MODEL_ROUTER_PROFILE: PROFILE,
        MODEL_ROUTER_DECISIONS: LOG,
        MODEL_ROUTER_SELECTION: SELECTION,
        ...extraEnv,
      },
    })
  );

test('claude-code narrow summary -> fast allocation, a subscription model is chosen', () => {
  const d = run(['--harness', 'claude-code', '--prompt', 'summarize HNSW in one sentence']);
  expect(d.harness).toBe('claude-code');
  expect(d.tier).toBe('cheap');
  expect(d.model).toBe('claude-haiku-fixture');
});

test('codex gets a codex-capable model (never a claude-only model)', () => {
  const d = run(['--harness', 'codex', '--prompt', 'summarize this article']);
  expect(d.harness).toBe('codex');
  expect(d.model).not.toMatch(/^claude-/);
});

test('security + code escalates above the cheap tier', () => {
  const d = run([
    '--harness', 'codex', '--prompt',
    'Refactor and fix the SQL injection security vulnerability in this auth module; prove correctness. ```js\nq="SELECT..."+id\n```',
  ]);
  expect(d.tier).not.toBe('cheap');
});

test('$1,600 floor: claude-code prefers the $0 subscription model over a billed one in-tier', () => {
  const d = run(['--harness', 'claude-code', '--prompt', 'summarize notes']); // trivial -> cheap tier
  expect(d.provider).toBe('anthropic');
  expect(d.est_input_cost_usd).toBe(0);
});

test('cross-tier $0 floor: codex never pays a billed model while a subscription model can do the job', () => {
  const d = run(['--harness', 'codex', '--prompt', 'summarize this article in one line']);
  const paysWhileSubscriptionExists = d.provider === 'openrouter' && d.est_input_cost_usd > 0;
  expect(paysWhileSubscriptionExists).toBe(false);
});

test('per-user profile: no subscription fails closed instead of spending', () => {
  const noSub = path.join(TMP, 'no-sub.json');
  fs.writeFileSync(noSub, JSON.stringify({harnesses:{codex:{available:true,subscription:false}}}));
  expect(() => run(['--harness','codex','--prompt','summarize'], {MODEL_ROUTER_PROFILE:noSub})).toThrow();
});

test('per-user profile: unavailable host fails closed', () => {
  const unavailable = path.join(TMP, 'unavailable.json');
  fs.writeFileSync(unavailable, JSON.stringify({harnesses:{codex:{available:false,subscription:true}}}));
  expect(() => run(['--harness','codex','--prompt','hello'], {MODEL_ROUTER_PROFILE:unavailable})).toThrow();
});

test('pluggable policy overrides selection (the core requirement)', () => {
  const forced = path.join(TMP, 'forced-policy.mjs');
  fs.writeFileSync(forced,
    "export function choose(){ return { model:'gpt-frontier-fixture', provider:'openai', taskClass:'medium', effort:'medium', tier:'frontier', reason:'forced by test policy', confidence:1 }; }");
  const out = JSON.parse(
    execFileSync(process.execPath, [ENGINE, '--harness', 'codex', '--policy', forced, '--prompt', 'anything', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, MODEL_ROUTER_CATALOG: CATALOG, MODEL_ROUTER_PROFILE: PROFILE, MODEL_ROUTER_DECISIONS: LOG, MODEL_ROUTER_SELECTION: SELECTION },
    })
  );
  expect(out.model).toBe('gpt-frontier-fixture');
  expect(out.reason).toMatch(/forced by test policy/);
});

test('decision receipt excludes raw prompt and custom reason',()=>{
  const prompt='summarize PRIVATE_TOKEN_876';
  run(['--harness','codex','--prompt',prompt]);
  expect(fs.readFileSync(LOG,'utf8')).not.toContain('PRIVATE_TOKEN_876');
});

test('structured request travels through actual engine stdin and selects substantial qualified effort',()=>{
  const selected=path.join(TMP,'substantial-policy.json');
  const fixture=JSON.parse(fs.readFileSync(SELECTION,'utf8'));
  fixture.routes.codex.substantial={model:'gpt-frontier-fixture',effort:'high'};
  fs.writeFileSync(selected,JSON.stringify(fixture));
  const raw=execFileSync(process.execPath,[ENGINE,'--harness','codex','--request-json','--policy-only','--policy',POLICY,'--json'],{
    input:JSON.stringify({prompt:'implement PRIVATE_STRUCTURED_WORK',taskFacts:{taskType:'coding',scope:'substantial'}}),encoding:'utf8',
    env:{...process.env,MODEL_ROUTER_CATALOG:CATALOG,MODEL_ROUTER_PROFILE:PROFILE,MODEL_ROUTER_SELECTION:selected,MODEL_ROUTER_DECISIONS:LOG},
  });
  expect(JSON.parse(raw)).toMatchObject({taskClass:'substantial',model:'gpt-frontier-fixture',effort:'high',classificationSource:'caller-task-facts'});
  expect(fs.readFileSync(LOG,'utf8')).not.toContain('PRIVATE_STRUCTURED_WORK');
});

test('installed layout with preserved legacy default cannot silently disable mandatory classification floor',()=>{
  const home=path.join(TMP,'installed-router');const bin=path.join(home,'bin');
  fs.mkdirSync(bin,{recursive:true});
  fs.mkdirSync(path.join(home,'plugin','scripts'),{recursive:true});
  for(const file of ['model-router-engine.mjs','route-cheap.mjs']) fs.copyFileSync(path.join(ROOT,'scripts',file),path.join(bin,file));
  // Installed preferences resolve canonical project identity through their shipped dependency.
  for(const file of ['runtime-preferences.mjs','project-identity.mjs','project-store-resolver.mjs'])
    fs.copyFileSync(path.join(ROOT,'plugin','scripts',file),path.join(home,'plugin','scripts',file));
  fs.writeFileSync(path.join(home,'policy.default.mjs'),"export function choose(){return {model:'gpt-frontier-fixture',taskClass:'medium',effort:'medium'}}");
  const custom=path.join(home,'policy.mjs');fs.writeFileSync(custom,"export function choose(){return {model:'gpt-frontier-fixture',taskClass:'medium',effort:'medium'}}");
  const execute=()=>execFileSync(process.execPath,[fs.realpathSync(path.join(bin,'model-router-engine.mjs')),'--harness','codex','--policy-only','--json'],{
    input:'substantial implementation across modules',encoding:'utf8',stdio:['pipe','pipe','pipe'],
    env:{...process.env,MODEL_ROUTER_CONFIG_DIR:home,MODEL_ROUTER_CATALOG:CATALOG,MODEL_ROUTER_PROFILE:PROFILE,MODEL_ROUTER_SELECTION:SELECTION,MODEL_ROUTER_DECISIONS:LOG},
  });
  expect(execute).toThrow(/classifier missing required exports/);
});
