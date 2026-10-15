import { policyContext } from '../../plugin/scripts/decision-gate.mjs';
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BUDGET_MS, MIN_HEADROOM_MS, decide, policiesFor, skipReason } from '../../plugin/scripts/decision-gate.mjs';
import { continuityRegistrations } from '../../plugin/scripts/continuity-hook-policy.mjs';
import { actionKey } from '../../plugin/scripts/decision-outcomes.mjs';

/**
 * ADR-067 — EXACTLY ONE HOOK MAY REFUSE A GIVEN TOOL CALL.
 *
 * Measured from hooks.json's own matchers on 2026-08-10, before this landed:
 *
 *     Write | Edit  →  hijack-ruvnet · ground-before-write · protect-state · unprompted-speech
 *     Bash          →  hijack-ruvnet · design-wall · unprompted-speech
 *
 * Four independent processes could refuse the same Write. No precedence, no shared context, no way
 * for any to know what the others thought — whichever exited 2 first won, and the user got that one's
 * reason with no hint that a second wall was standing behind it. That is the concrete form of
 * "constraints that break and collapse on each other".
 *
 * The structural test is the LAST one in this file: it reads hooks.json and fails if any event ever
 * regains a second refuser. Everything above it tests the composition rule that makes one refuser
 * sufficient.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const GATE = path.join(ROOT, 'plugin', 'scripts', 'decision-gate.mjs');
const HOOKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'hooks.json'), 'utf8'));

const verdict = (id, code, stderr = '') => ({ id, code, stderr, stdout: '' });

/**
 * Fire the real gate the way PreToolUse does: argv sub-event, JSON on stdin, no tty.
 *
 * spawnSync, not execFileSync. The execFileSync version returned a HARDCODED `stderr: ''` on its
 * success branch — execFileSync forwards a child's stderr to the parent rather than capturing it
 * unless `stdio` says otherwise — so `expect(r.stderr).toBe('')` on the allow case below was
 * asserting a string literal against itself and could not fail on any gate, however noisy. A test
 * that cannot fail on broken code is not a test; spawnSync captures both streams on both paths and
 * makes that assertion load-bearing, which matters now that a blown budget writes to stderr.
 */
function fire(event, toolInput, toolName = 'Write', env = {}) {
  const payload = JSON.stringify({
    session_id: `dg-${Math.round(Number(process.env.VITEST_WORKER_ID || 1))}`,
    hook_event_name: 'PreToolUse', tool_name: toolName, cwd: ROOT, tool_input: toolInput,
  });
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [GATE, event], {
    input: payload, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), ms: Date.now() - t0,
    session: JSON.parse(payload).session_id };
}

describe('ADR-067 — one decision, composed from many policies', () => {
  it('allows when no policy refuses', () => {
    expect(decide([verdict('a', 0), verdict('b', 0)])).toEqual({ allow: true, refusals: [] });
  });

  it('refuses with the winning policy\'s OWN words, not a summary of them', () => {
    // A policy wrote its message for exactly this moment. Replacing it with our own paraphrase loses
    // the specific instruction the user needs in order to proceed.
    const d = decide([verdict('protect-state', 2, '⛔ BLOCKED — that file is the user\'s own record.')]);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/that file is the user's own record/);
  });

  it('TEETH: names EVERY other policy that also refused', () => {
    // This is the user-visible payoff. Under four racing hooks you fixed the first refusal, re-ran,
    // and hit the second — one round-trip per wall, with no way to see them coming.
    const d = decide([
      verdict('protect-state', 2, 'consent boundary'),
      verdict('ground-before-write', 2, 'no fresh grounding stamp\nsecond line'),
      verdict('design-wall', 2, 'no design grade'),
    ]);
    expect(d.refusals).toEqual(['protect-state', 'ground-before-write', 'design-wall']);
    expect(d.reason).toMatch(/consent boundary/);
    expect(d.reason, 'the others must be named').toMatch(/Also refusing/);
    expect(d.reason).toMatch(/ground-before-write: no fresh grounding stamp/);
    expect(d.reason).toMatch(/design-wall: no design grade/);
    expect(d.reason, 'only the FIRST line of each secondary reason — the rest is noise here')
      .not.toMatch(/second line/);
  });

  it('TEETH: a non-zero code that is not 2 is an ERROR, never a refusal', () => {
    // lesson-gate.mjs had to learn this twice: exit 1 is a non-blocking hook error. Treating any
    // failure as a refusal would let a crashing policy block all work.
    expect(decide([verdict('broken', 1, 'stack trace')]).allow).toBe(true);
    expect(decide([verdict('broken', 127, 'command not found')]).allow).toBe(true);
  });

  it('precedence is a property of the policy, not of registry order', () => {
    // A future edit that lists policies in a different order in the registry must not silently
    // reorder which reason a user sees first.
    const scrambled = { write: ['ground-before-write', 'protect-state', 'hijack-ruvnet'] };
    expect(policiesFor('write', scrambled).map((p) => p.id))
      .toEqual(['protect-state', 'hijack-ruvnet', 'ground-before-write']);
  });

  it('an unknown event selects no policies', () => {
    expect(policiesFor('nonsense')).toEqual([]);
  });

  it('H5: the dead \'bash\' route is gone — "bash" now selects nothing, same as any unregistered event (RED on pre-fix code)', () => {
    // REGISTRY['bash'] used to list protect-state/identifier-preflight/spend-guard/degradation-watch/
    // hijack-ruvnet/design-wall, and nothing in plugin/hooks/hooks.json or codex-hooks.json ever
    // dispatched decision-gate.mjs with this event — continuity-hook-policy.mjs's own header names
    // it explicitly: "decision-gate's BASH route ... remains reachable through hook-shim's dispatch
    // table by explicit invocation" only. Removed as dead routing (2026-09-26 dead-code audit).
    expect(policiesFor('bash')).toEqual([]);
  });
});

/**
 * THE REAL-GATE CASES NEED BASH, and Windows CI does not have it.
 *
 * Every refusal policy is a `.sh` file. `resolveBash()` returns nothing on a runner without Git
 * Bash, so `runPolicy` contributes no verdict, nothing can refuse, and the gate correctly FAILS OPEN
 * — the same behaviour those four walls always had on a bashless host, where hook-shim already
 * declines to run bash hooks and says so once.
 *
 * So the product is right and the assertion was wrong: it demanded a refusal that cannot occur.
 * Skipped explicitly rather than left red, and the pure `decide()` / `policiesFor()` cases above —
 * which carry the precedence rule and the composition contract — still run on EVERY platform.
 */
const hasBash = process.platform !== 'win32' || Boolean(process.env.CLAUDE_CODE_GIT_BASH_PATH || process.env.RUVNET_BRAIN_BASH);
const withBash = hasBash ? describe : describe.skip;

withBash('ADR-067 — the real gate, fired the way the host fires it', () => {
  it('refuses a write to the user\'s protected settings, with byte-empty stdout', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-session-proof-'));
    try {
      const ledger = path.join(dir, 'outcomes.jsonl');
      const input = { file_path: path.join(os.homedir(), '.config', 'ruvnet-brain', 'settings.json'), content: '{}' };
      const r = fire('write', input, 'Write', { RUVNET_DECISION_LEDGER: ledger,
        RUVNET_DECISION_PENDING: path.join(dir, 'pending.json') });
      expect(r.code, 'exit 2 is the only code the host reads as a refusal').toBe(2);
      expect(r.stdout, 'on a refusal the host ignores stdout — emitting any is a protocol violation').toBe('');
      expect(r.stderr).toMatch(/BLOCKED/);
      const rows = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows).toContainEqual(expect.objectContaining({ kind: 'refused', session: r.session,
        key: actionKey('Write', input), policies: expect.arrayContaining(['protect-state']) }));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 40_000);

  it('TEETH: allows an ordinary write, and never writes to stderr while doing so', () => {
    // Without this the suite would pass on a gate that refused everything.
    const r = fire('write', { file_path: path.join(os.tmpdir(), 'ordinary.txt'), content: 'x' });
    expect(r.code).toBe(0);
    expect(r.stderr, 'stderr on an allow would surface as a spurious error to the user').toBe('');
  }, 40_000);

  it('an unknown sub-event allows rather than guessing', () => {
    expect(fire('nonsense', { file_path: '/tmp/x' }).code).toBe(0);
  }, 40_000);

  it('H5: "bash" allows immediately, exactly like any other unregistered event — the dead route never runs a policy', () => {
    const r = fire('bash', { command: 'git push' });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
  }, 40_000);
});

describe('ADR-067 — the structural invariant, read from hooks.json', () => {
  /** Hook ids registered as able to refuse. Derived from the shim table, not restated here. */
  const SHIM = fs.readFileSync(path.join(ROOT, 'plugin', 'scripts', 'hook-shim.mjs'), 'utf8');
  const blockingIds = new Set(
    [...SHIM.matchAll(/'([a-z-]+)':\s*\{[^}]*mode:\s*'blocking'/g)].map((m) => m[1]),
  );

  it('sanity: the shim still declares some blocking hooks', () => {
    expect(blockingIds.size, 'a parse failure here would make the invariant vacuous').toBeGreaterThan(0);
  });

  it('exactly one active blocking PreToolUse registration composes the mandatory policies', () => {
    const refusers = (HOOKS.hooks.PreToolUse || [])
      .flatMap((entry) => entry.hooks.map((h) => ({ matcher: entry.matcher, id: idOf(h.command) })))
      .filter((h) => blockingIds.has(h.id));
    const perMatcher = new Map();
    for (const r of refusers) perMatcher.set(r.matcher, [...(perMatcher.get(r.matcher) || []), r.id]);
    const doubled = [...perMatcher].filter(([, ids]) => ids.length > 1);
    expect(doubled, 'two hooks that can refuse the same call is the defect ADR-067 removed').toEqual([]);
    // ADR-067's rule is EXACTLY ONE refuser per call, not zero. `toEqual([])` encoded the Sep-7
    // plane in which decision-gate was absent ("not because it was retired" — its own
    // _notInThisPlane note); on 2026-09-11 the plane re-declared it (continuity-hook-policy
    // CONTINUITY_EVENTS + hook-contracts v5, ADR-040 amendment) as the one PreToolUse refuser.
    // Derive the allowed set from the policy module so manifest and policy are checked against
    // each other — a literal here is what kept this file red across a plane change.
    const declared = continuityRegistrations('claude')
      .filter((r) => r.event === 'PreToolUse' && blockingIds.has(r.id)).map((r) => r.id).sort();
    expect(declared, 'passive captures cannot substitute for the mandatory decision gate').toHaveLength(1);
    expect(refusers, 'the active plane must retain exactly one blocking registration').toHaveLength(1);
    expect(refusers.map((r) => r.id).sort(), 'the refusers registered in hooks.json must be exactly the PreToolUse handlers the plane declares')
      .toEqual(declared);
  });

  it('the policies the gate consults are no longer registered as hooks of their own', () => {
    // H5: design-wall dropped out of this list — it was only ever consulted via the dead 'bash'
    // route (REGISTRY['bash'], removed 2026-09-26 dead-code audit), never via 'write', so it is no
    // longer "a policy the gate consults" at all. Its own hook-shim.mjs TABLE entry is untouched
    // (still reachable by explicit invocation, per continuity-hook-policy.mjs's own design), which
    // is exactly what this assertion would catch if it ever regained a SEPARATE hooks.json entry.
    const registered = (HOOKS.hooks.PreToolUse || []).flatMap((e) => e.hooks.map((h) => idOf(h.command)));
    for (const owned of ['hijack-ruvnet', 'ground-before-write', 'protect-state']) {
      expect(registered, `${owned} must be consulted BY the gate, not race it`).not.toContain(owned);
    }
  });
});

/** `node "…/hook-shim.mjs" <id> [arg] || true` → `<id>` */
function idOf(command) {
  const m = /hook-shim\.mjs"\s+([a-z-]+)/.exec(String(command || ''));
  return m ? m[1] : '';
}


describe('policy advice transport', () => {
  it('preserves policy guidance and diagnostic gaps as native context without changing speech fields', () => {
    const speech = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'Existing context' } });
    const output = JSON.parse(policyContext([{ id: 'memory', code: 0, stdout: 'Managed-memory warning' }, { id: 'adr', skipped: 'budget', reason: 'Evaluation deadline exceeded' }], speech));
    expect(output.hookSpecificOutput.additionalContext).toContain('Managed-memory warning');
    expect(output.hookSpecificOutput.additionalContext).toContain('Policy adr did not obtain a verdict');
    expect(output.hookSpecificOutput.additionalContext).toContain('Evaluation deadline exceeded');
    expect(output.hookSpecificOutput.additionalContext).toContain('Existing context');
    expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(output).not.toHaveProperty('decision');
  });
  it('leaves an unchanged speech envelope byte-for-byte when there is no policy context', () => {
    const speech = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"hello"}}';
    expect(policyContext([], speech)).toBe(speech);
    expect(policyContext([{ id: 'deny', code: 2, stdout: 'not advice' }])).toBe('');
  });
});



it.each(['timeout', 'early-exit', 'outer-timeout'])('the registered decision retires evaluator and grandchild on %s', async (mode) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'registered-decision-tree-'));
  const brainHome = path.join(fixture, 'brain');
  const runtime = path.join(brainHome, 'versions', 'fixture');
  const scripts = path.join(runtime, 'scripts');
  const edited = path.join(fixture, 'edited');
  const pidFile = path.join(fixture, 'owned-descendants.json');
  process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
  const { serverDependencies } = await import('../../bin/install.mjs');
  try {
    fs.mkdirSync(scripts, {recursive:true});fs.mkdirSync(path.join(brainHome,'versions','scripts'));
    fs.mkdirSync(path.join(edited,'docs/adr'),{recursive:true});spawnSync('git',['init','-q',edited]);
    const entries = [GATE,path.join(ROOT,'plugin/scripts/codex-hook-adapter.mjs'),path.join(ROOT,'plugin/scripts/hook-shim.mjs'),path.join(ROOT,'plugin/scripts/codex-hook-wrapper.mjs')];
    for (const source of entries) {
      fs.copyFileSync(source,path.join(scripts,path.basename(source)));
      for (const entry of serverDependencies(source)) {const target=path.resolve(scripts,entry.spec);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(entry.from,target);}
    }
    fs.copyFileSync(path.join(ROOT,'plugin/scripts/adr-currency-gate.mjs'),path.join(scripts,'adr-currency-gate.mjs'));
    for (const name of ['protect-brain-state.sh','hijack-ruvnet.sh','ground-before-write.sh']) fs.writeFileSync(path.join(scripts,name),'exit 0\n');
    for (const name of ['duplicate-gate.mjs','unprompted-runtime.mjs']) fs.writeFileSync(path.join(scripts,name),'process.exit(0);');
    const setup=`import {spawn} from 'node:child_process';import fs from 'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.env.OWNED_CHILD_PID,JSON.stringify({evaluator:process.pid,grandchild:child.pid}));`;
    const finish=mode==='early-exit'?`child.unref();export const DEFAULT_DIRS=[];export const isGitRepo=()=>true;export const listDocs=()=>[];`:`await new Promise(()=>setInterval(()=>{},1000));`;
    fs.writeFileSync(path.join(scripts,'doc-currency.mjs'),setup+finish);
    fs.writeFileSync(path.join(brainHome,'active.json'),JSON.stringify({codeRoot:runtime,version:'fixture'}));
    const outer=mode==='outer-timeout';
    const entry=outer?path.join(scripts,'codex-hook-wrapper.mjs'):path.join(scripts,'decision-gate.mjs');
    const args=outer?['decision-gate','write']:['write'];
    const input=outer?{session_id:'tree-fixture',cwd:edited,hook_event_name:'PreToolUse',tool_name:'apply_patch',tool_input:'*** Begin Patch\n*** Update File: owned.mjs\n@@\n-a\n+b\n*** End Patch'}:{session_id:'tree-fixture',cwd:edited,tool_name:'Edit',tool_input:{file_path:'owned.mjs'}};
    const run=spawnSync(process.execPath,[entry,...args],{input:JSON.stringify(input),encoding:'utf8',timeout:5000,env:{...process.env,HOME:fixture,RUVNET_BRAIN_HOME:brainHome,OWNED_CHILD_PID:pidFile,RUVNET_DECISION_BUDGET_MS:'1500',...(outer?{RUVNET_CODEX_HOOK_TIMEOUT_MS:'1800'}:{})}});
    expect(fs.existsSync(pidFile)).toBe(true);
    const pids=Object.values(JSON.parse(fs.readFileSync(pidFile,'utf8')));
    for(const pid of pids){let alive=true;for(let attempt=0;attempt<30;attempt++){try{process.kill(pid,0);}catch{alive=false;break;}await new Promise(resolve=>setTimeout(resolve,20));}expect(alive,`owned descendant ${pid} must be retired`).toBe(false);}
    expect(run.status).toBe(0);
    if(mode!=='early-exit')expect(JSON.parse(run.stdout).hookSpecificOutput.additionalContext).toMatch(/did not obtain a verdict/);
  } finally {
    if(fs.existsSync(pidFile))for(const pid of Object.values(JSON.parse(fs.readFileSync(pidFile,'utf8')))){try{process.kill(pid,'SIGKILL');}catch{}}
    fs.rmSync(fixture,{recursive:true,force:true});
  }
});
