// ADR-105 §8 / ADR-106: decision records are consulted before a decision and recorded after it.
// Every guard here was first run against a deliberately broken input and seen to fail.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DECISION_SCHEMA, auditDecisionTurn, buildDecisionRecord, decisionKey, freshConsultReceipt,
  isAdrPath, main, storeDecision, supersededKeys, validateDecisionRecord, writeConsultReceipt,
} from '../../plugin/scripts/decision-record.mjs';
import { adrDecisionIn } from '../../plugin/scripts/decision-recall-gate.mjs';
import { resolveRuflo } from '../../plugin/scripts/ruflo-bin.mjs';
import { adoptedProject, cleanup, rows, tmp } from '../helpers/continuity-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE = path.join(ROOT, 'plugin', 'scripts', 'decision-gate.mjs');
const AT = Date.parse('2026-10-11T12:34:56.789Z');
const base = { projectRoot: '/p/app', projectIdentity: 'git-sha256:abc', now: AT };
const ratified = { what: 'Use one store', why: 'two stores split history', shape: 'ruflo memory store --path ABS', evidence: [{ kind: 'adr', ref: 'docs/adr/0105.md' }] };

describe('decision record contract (ADR-105 §8)', () => {
  it('keys are decision-<slug ≤48>-<YYYYMMDDTHHMMSSmmmZ>', () => {
    expect(decisionKey('Use ONE store, via --path!', AT)).toBe('decision-use-one-store-via-path-20261011T123456789Z');
    const long = decisionKey('x'.repeat(30) + ' ' + 'y'.repeat(40), AT);
    expect(long.length).toBeLessThanOrEqual('decision-'.length + 48 + 1 + 19);
    expect(decisionKey('!!!', AT)).toBe('decision-decision-20261011T123456789Z');
  });

  it('a ratified record needs why, shape and evidence; a detected one does not', () => {
    expect(buildDecisionRecord(ratified, base).errors).toEqual([]);
    const missing = buildDecisionRecord({ what: 'Use one store' }, base).errors.join('; ');
    expect(missing).toMatch(/why required/);
    expect(missing).toMatch(/shape required/);
    expect(missing).toMatch(/evidence item required/);
    expect(buildDecisionRecord({ what: 'Use one store', status: 'detected-unconfirmed' }, base).errors).toEqual([]);
    expect(buildDecisionRecord({ ...ratified, evidence: [{ kind: 'rumor', ref: 'x' }] }, base).errors.join()).toMatch(/evidence item/);
  });

  it('redacts before bounding, and bounds every field and the whole value', () => {
    const secret = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    const { record, value } = buildDecisionRecord({ ...ratified, why: `key ${secret} leaked; ` + 'w'.repeat(2000) }, base);
    expect(value).not.toContain(secret);
    expect(record.why.length).toBe(800);
    expect(record.what.length).toBeLessThanOrEqual(400);
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(4096);
    expect(record).toMatchObject({ schema: DECISION_SCHEMA, schemaVersion: 1, project: '/p/app', at: '2026-10-11T12:34:56.789Z', status: 'ratified' });
  });

  it('supersession is computed from NEWER ratified records only', () => {
    const old = decisionKey('old', AT - 1000);
    const newer = buildDecisionRecord({ ...ratified, supersedes: [old] }, base).record;
    const detected = buildDecisionRecord({ what: 'x', status: 'detected-unconfirmed', supersedes: [decisionKey('other', AT)] }, base).record;
    const set = supersededKeys([newer, detected, null, { junk: true }]);
    expect([...set]).toEqual([old]);
    expect(validateDecisionRecord({ ...newer, supersedes: ['not-a-key'] }).join()).toMatch(/supersedes/);
  });
});

describe('the §3 door: committed only on exact readback; a refusal is loud and nothing is kept for replay', () => {
  const memory = () => {
    const rowsByKey = new Map(); let refusals = 0;
    return {
      rowsByKey, refuse(n) { refusals = n; },
      store: ({ key, value }) => {
        if (refusals > 0) { refusals -= 1; return { status: 1, output: 'refusing an unsafe sql.js whole-image write' }; }
        if (rowsByKey.has(key)) return { status: 1, output: 'immutable append rejected: logical key already exists' };
        rowsByKey.set(key, value); return { status: 0, output: '' };
      },
      readBack: ({ key }) => ({ content: rowsByKey.get(key) ?? null }),
    };
  };
  it('commits, reports already-stored, quarantines a different row, and records a refusal in the ledger only', () => {
    const dir = tmp('decision-door-'); const db = path.join(dir, '.swarm', 'memory.db');
    const brainHome = tmp('decision-door-bh-'); const priorHome = process.env.RUVNET_BRAIN_HOME; process.env.RUVNET_BRAIN_HOME = brainHome;
    fs.mkdirSync(path.dirname(db), { recursive: true }); fs.writeFileSync(db, '');
    const m = memory();
    const args = { ruflo: 'x', db, namespace: 'app', key: 'decision-a-20261011T123456789Z', value: '{"a":1}', store: m.store, readBack: m.readBack };
    expect(storeDecision(args).state).toBe('committed');
    expect(storeDecision(args).state).toBe('already-stored');
    expect(storeDecision({ ...args, value: '{"a":2}' }).state).toBe('quarantined');
    m.refuse(1);
    const refused = storeDecision({ ...args, key: 'decision-b-20261011T123456789Z' });
    if (priorHome === undefined) delete process.env.RUVNET_BRAIN_HOME; else process.env.RUVNET_BRAIN_HOME = priorHome;
    expect(refused.state).toBe('refused');
    expect(refused.reason).toMatch(/whole-image/);
    expect(m.rowsByKey.has('decision-b-20261011T123456789Z')).toBe(false);
    // Loud: exactly one hook-failures row naming the refusal; no private outbox/replay directory anywhere.
    const ledger = fs.readFileSync(path.join(brainHome, 'hook-failures.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ hook: 'decision-record', event: 'record' });
    expect(ledger[0].error).toMatch(/whole-image/);
    expect(fs.readdirSync(path.dirname(db)).sort()).toEqual(['memory.db']);
    cleanup();
  });
  it('a store that exits 0 but reads back nothing is NOT committed', () => {
    const dir = tmp('decision-door-'); const db = path.join(dir, '.swarm', 'memory.db');
    fs.mkdirSync(path.dirname(db), { recursive: true });
    const brainHome = tmp('decision-door-bh-'); const priorHome = process.env.RUVNET_BRAIN_HOME; process.env.RUVNET_BRAIN_HOME = brainHome;
    const r = storeDecision({ ruflo: 'x', db, namespace: 'n', key: 'decision-c-20261011T123456789Z', value: 'v',
      store: () => ({ status: 0, output: '[ERROR] silently failed' }), readBack: () => ({ content: null }) });
    if (priorHome === undefined) delete process.env.RUVNET_BRAIN_HOME; else process.env.RUVNET_BRAIN_HOME = priorHome;
    expect(r.state).toBe('refused');
    expect(fs.readFileSync(path.join(brainHome, 'hook-failures.jsonl'), 'utf8')).toMatch(/"hook":"decision-record"/);
    cleanup();
  });
});

describe('consult receipt', () => {
  it('is fresh for two hours, for this project only, whatever the outcome', () => {
    const home = tmp('decision-consult-');
    writeConsultReceipt({ projectRoot: '/p/app', brainHome: home, outcome: 'unavailable', topic: 't', now: AT });
    expect(freshConsultReceipt({ projectRoot: '/p/app', brainHome: home, now: AT + 3600_000 })?.outcome).toBe('unavailable');
    expect(freshConsultReceipt({ projectRoot: '/p/app', brainHome: home, now: AT + 2 * 3600_000 + 1 })).toBeNull();
    expect(freshConsultReceipt({ projectRoot: '/p/other', brainHome: home, now: AT })).toBeNull();
    cleanup();
  });
});

describe('transcript audit: an ADR created this turn needs a later --record', () => {
  const use = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const result = (id, extra = {}, isError = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'ok' }] }, toolUseResult: extra });
  const write = use('w', 'Write', { file_path: '/p/app/docs/adr/0107-x.md' });
  const rec = use('r', 'Bash', { command: 'node "/x/plugin/scripts/decision-record.mjs" --record --what a' });
  it('create then record → recorded; create alone → debt; record first → debt', () => {
    expect(auditDecisionTurn([write, result('w', { type: 'create' }), rec, result('r')])).toEqual({ created: ['/p/app/docs/adr/0107-x.md'], recorded: true });
    expect(auditDecisionTurn([write, result('w', { type: 'create' })])).toEqual({ created: ['/p/app/docs/adr/0107-x.md'], recorded: false });
    expect(auditDecisionTurn([rec, result('r'), write, result('w', { type: 'create' })]).recorded).toBe(false);
  });
  it('an update, a failed write, a failed record and a README are not decisions or records', () => {
    expect(auditDecisionTurn([write, result('w', { type: 'update' })]).created).toEqual([]);
    expect(auditDecisionTurn([write, result('w', { type: 'create' }, true)]).created).toEqual([]);
    expect(auditDecisionTurn([write, result('w', { type: 'create' }), rec, result('r', {}, true)]).recorded).toBe(false);
    expect(isAdrPath('docs/adr/README.md')).toBe(false);
    expect(isAdrPath('docs/adr/0106-hooks.md')).toBe(true);
    expect(isAdrPath('ruflo/v3/docs/adr/ADR-110-x.md')).toBe(true);
    expect(isAdrPath('docs/notes.md')).toBe(false);
  });
});

describe('decision-recall policy, through the real decision-gate process', () => {
  const fire = (payload, env) => spawnSync(process.execPath, [GATE, 'write'], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 20_000, env });
  const setup = () => {
    const p = adoptedProject();
    const brainHome = tmp('decision-bh-'); const stateDir = tmp('decision-state-');
    const env = { ...p.env, RUVNET_BRAIN_HOME: brainHome, RUVNET_BRAIN_STATE_DIR: stateDir, RUVNET_DUPLICATE_GATE: 'off', RUVNET_DECISION_BUDGET_MS: '8000' };
    fs.mkdirSync(path.join(p.dir, 'docs', 'adr'), { recursive: true });
    return { ...p, env, brainHome };
  };
  const newAdr = (p, session = 's1') => ({ session_id: session, hook_event_name: 'PreToolUse', cwd: p.dir, tool_name: 'Write',
    tool_input: { file_path: path.join(p.dir, 'docs', 'adr', '0001-choice.md'), content: '# ADR-001\nstatus: Accepted\n' } });

  it('refuses a new ADR once per session without a consult, then allows the retry', () => {
    const p = setup();
    const first = fire(newAdr(p), p.env);
    expect(first.status, first.stderr).toBe(2);
    expect(first.stderr).toMatch(/BLOCKED \(once\).*new ADR/);
    expect(first.stderr).toMatch(/decision-record\.mjs" --consult/);
    expect(fire(newAdr(p), p.env).status).toBe(0);
    expect(fire(newAdr(p, 's2'), p.env).status).toBe(2); // a new session is asked again
    cleanup();
  }, 60_000);

  it('allows with a fresh consult receipt, and says so when history was unavailable', () => {
    const p = setup();
    writeConsultReceipt({ projectRoot: p.dir, brainHome: p.brainHome, outcome: 'timed-out', topic: 't' });
    const r = fire(newAdr(p), p.env);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/timed-out.*UNKNOWN/);
    cleanup();
  }, 60_000);

  it('never looks at ordinary ADR edits, other files, unadopted projects, or when switched off', () => {
    const p = setup();
    const adr = path.join(p.dir, 'docs', 'adr', '0001-choice.md');
    fs.writeFileSync(adr, '# ADR\nstatus: Proposed\n');
    const edit = (o, n) => ({ session_id: 's', cwd: p.dir, tool_name: 'Edit', tool_input: { file_path: adr, old_string: o, new_string: n } });
    expect(fire(edit('wording', 'better wording'), p.env).status).toBe(0);
    expect(fire({ ...newAdr(p), tool_input: { file_path: path.join(p.dir, 'notes.md'), content: 'x' } }, p.env).status).toBe(0);
    expect(fire(newAdr(p), { ...p.env, RUVNET_DECISION_RECALL_GATE: 'off' }).status).toBe(0);
    const status = fire(edit('status: Proposed', 'status: Accepted'), p.env);
    expect(status.status, status.stderr).toBe(2);
    expect(status.stderr).toMatch(/ADR status change/);
    fs.rmSync(path.join(p.dir, '.swarm', 'memory.db'));
    expect(fire(newAdr(p, 's9'), p.env).status).toBe(0);
    cleanup();
  }, 90_000);

  it('sees a whole-file Write that flips an existing ADR status, and ignores status: lines inside code fences (review 5, 6)', () => {
    const p = setup();
    const adr = path.join(p.dir, 'docs', 'adr', '0001-choice.md');
    fs.writeFileSync(adr, '---\nstatus: Proposed\n---\n# ADR\n');
    const write = (content, session) => ({ session_id: session, cwd: p.dir, tool_name: 'Write', tool_input: { file_path: adr, content } });
    expect(fire(write('---\nstatus: Proposed\n---\n# ADR reworded\n', 'w1'), p.env).status).toBe(0);
    const flip = fire(write('---\nstatus: Accepted\n---\n# ADR\n', 'w2'), p.env);
    expect(flip.status, flip.stderr).toBe(2);
    expect(flip.stderr).toMatch(/ADR status change/);
    const fenced = { session_id: 'e1', cwd: p.dir, tool_name: 'Edit', tool_input: { file_path: adr, old_string: '# ADR\n', new_string: '# ADR\n```yaml\nstatus: Rejected\n```\n' } };
    expect(fire(fenced, p.env).status).toBe(0);
    const bare = path.join(p.dir, 'docs', 'adr', '0002-no-status.md');
    fs.writeFileSync(bare, '# ADR without a status line\n');
    const example = { session_id: 'e2', cwd: p.dir, tool_name: 'Edit', tool_input: { file_path: bare, old_string: 'line\n', new_string: 'line\n```yaml\nstatus: Accepted\n```\n' } };
    expect(fire(example, p.env).status).toBe(0); // a fenced example is not the document's status
    cleanup();
  }, 90_000);

  it('sees a Codex apply_patch status update and a body **Status** change (re-review R4)', () => {
    const dir = tmp('decision-r4-'); const adr = path.join(dir, 'docs', 'adr', '0003-x.md');
    fs.mkdirSync(path.dirname(adr), { recursive: true });
    fs.writeFileSync(adr, '---\nstatus: Accepted\n---\n# X\n\n**Status**: Accepted\n');
    const patch = '*** Begin Patch\n*** Update File: docs/adr/0003-x.md\n@@\n-status: Accepted\n+status: Superseded\n*** End Patch\n';
    expect(adrDecisionIn({ tool_name: 'apply_patch', cwd: dir, tool_input: { input: patch } })).toEqual({ path: 'docs/adr/0003-x.md', kind: 'ADR status change' });
    const wording = '*** Begin Patch\n*** Update File: docs/adr/0003-x.md\n@@\n-# X\n+# X, reworded\n*** End Patch\n';
    expect(adrDecisionIn({ tool_name: 'apply_patch', cwd: dir, tool_input: { input: wording } })).toBeNull();
    const body = { tool_name: 'Edit', cwd: dir, tool_input: { file_path: adr, old_string: '**Status**: Accepted', new_string: '**Status**: Rejected' } };
    expect(adrDecisionIn(body)).toEqual({ path: adr, kind: 'ADR status change' });
    cleanup();
  });

  it('recognizes a Codex apply_patch that adds an ADR', () => {
    expect(adrDecisionIn({ tool_name: 'apply_patch', cwd: '/p', tool_input: { input: '*** Begin Patch\n*** Add File: docs/adr/0002-x.md\n+# x\n' } }))
      .toEqual({ path: 'docs/adr/0002-x.md', kind: 'new ADR' });
  });
});

describe('real global ruflo round trip (skipped where absent)', () => {
  const ruflo = resolveRuflo();
  (ruflo ? it : it.skip)('--record commits through the CLI, reads back by exact key, and recall drops a superseded record', async () => {
    const p = adoptedProject();
    const env = { ...p.env, RUFLO_BIN: ruflo, RUVNET_BRAIN_HOME: tmp('decision-bh-') };
    const out = []; const err = [];
    const io = { env, out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) } };
    const first = await main(['--project', p.dir, '--record', '--what', 'Adopt the first store layout', '--why', 'measured', '--shape', 'one path',
      '--evidence', 'adr:docs/adr/0001.md'], io);
    expect(first, err.join('')).toBe(0);
    const key1 = /committed (decision-\S+)/.exec(out.join(''))[1];
    const second = await main(['--project', p.dir, '--record', '--what', 'Replace the first store layout', '--why', 'measured again', '--shape', 'one path v2',
      '--evidence', 'adr:docs/adr/0002.md', '--supersedes', key1], io);
    expect(second, err.join('')).toBe(0);
    const all = rows(path.join(p.dir, '.swarm', 'memory.db'), path.basename(p.dir));
    expect(all.filter((r) => r.key === `supersession-${key1}`)).toHaveLength(1); // the tombstone
    const stored = all.filter((r) => r.key.startsWith('decision-')).map((r) => JSON.parse(r.content));
    expect(stored.map((r) => r.what).sort()).toEqual(['Adopt the first store layout', 'Replace the first store layout']);
    expect([...supersededKeys(stored)]).toEqual([key1]);
    const { recall } = await import('../../plugin/scripts/agentdb-recall.mjs');
    const r = await recall({ prompt: 'what is the store layout decision', projectDir: p.dir, env, consequential: true, deadlineMs: 1900 });
    const keys = (r.picks || []).map((x) => x.key);
    const key2 = [...out.join('').matchAll(/committed (decision-\S+)/g)].at(-1)[1];
    expect(r.outcome, JSON.stringify(r.categories)).toBe('ok-with-results');
    expect(keys).toContain(key2);   // not vacuous: the decision category was read and delivered
    expect(keys).not.toContain(key1);
    cleanup();
  }, 240_000);
});

describe('supersession survives ranking and refuses unknown keys (review findings 1, 2)', () => {
  const ruflo = resolveRuflo();
  const io = (env, out, err) => ({ env, out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) } });
  (ruflo ? it : it.skip)('a superseded decision is withheld even when its superseder is NOT among the recalled rows', async () => {
    const p = adoptedProject();
    const env = { ...p.env, RUFLO_BIN: ruflo, RUVNET_BRAIN_HOME: tmp('decision-bh-') };
    const out = []; const err = [];
    expect(await main(['--project', p.dir, '--record', '--what', 'Adopt the store layout alpha', '--why', 'w', '--shape', 's', '--evidence', 'adr:a.md'], io(env, out, err)), err.join('')).toBe(0);
    const oldKey = /committed (decision-\S+)/.exec(out.join(''))[1];
    out.length = 0;
    expect(await main(['--project', p.dir, '--record', '--what', 'Unrelated wording entirely', '--why', 'w', '--shape', 's', '--evidence', 'adr:b.md', '--supersedes', oldKey], io(env, out, err)), err.join('')).toBe(0);
    const newKey = /committed (decision-\S+)/.exec(out.join(''))[1];
    const { recall, enumerateCanonicalKeys } = await import('../../plugin/scripts/agentdb-recall.mjs');
    // Simulate the superseder being ranked out / not retrieved: hide it from this recall entirely.
    const hiding = async (args) => { const r = await enumerateCanonicalKeys(args); if (r?.ok) for (const ns of Object.keys(r.value)) r.value[ns] = r.value[ns].filter((k) => k !== newKey); return r; };
    const r = await recall({ prompt: 'store layout alpha decision', projectDir: p.dir, env, consequential: true, deadlineMs: 1900, enumerateKeys: hiding });
    expect(r.outcome, JSON.stringify(r.categories)).not.toMatch(/unavailable|timed-out/);
    expect((r.picks || []).map((x) => x.key)).not.toContain(oldKey);
    expect(r.block).toMatch(/1 superseded decision\(s\) withheld/); // R3: never silent
    cleanup();
  }, 240_000);

  (ruflo ? it : it.skip)('a detected record cannot supersede: refused, no tombstone, the ratified decision is still recalled (re-review R1)', async () => {
    const p = adoptedProject();
    const env = { ...p.env, RUFLO_BIN: ruflo, RUVNET_BRAIN_HOME: tmp('decision-bh-') };
    const out = []; const err = [];
    expect(await main(['--project', p.dir, '--record', '--what', 'Adopt the store layout beta', '--why', 'w', '--shape', 's', '--evidence', 'adr:a.md'], io(env, out, err)), err.join('')).toBe(0);
    const oldKey = /committed (decision-\S+)/.exec(out.join(''))[1];
    const code = await main(['--project', p.dir, '--record', '--status', 'detected-unconfirmed', '--what', 'Maybe drop beta', '--supersedes', oldKey], io(env, out, err));
    expect(code).toBe(2);
    expect(err.join('')).toMatch(/only a ratified decision may supersede/);
    const all = rows(path.join(p.dir, '.swarm', 'memory.db'), path.basename(p.dir)).map((r) => r.key);
    expect(all).toEqual([oldKey]);
    const { recall } = await import('../../plugin/scripts/agentdb-recall.mjs');
    const r = await recall({ prompt: 'store layout beta decision', projectDir: p.dir, env, consequential: true, deadlineMs: 1900 });
    expect((r.picks || []).map((x) => x.key)).toContain(oldKey);
    cleanup();
  }, 240_000);

  (ruflo ? it : it.skip)('a second superseder of the same decision is not a conflict (re-review R2)', async () => {
    const p = adoptedProject();
    const env = { ...p.env, RUFLO_BIN: ruflo, RUVNET_BRAIN_HOME: tmp('decision-bh-') };
    const out = []; const err = [];
    const rec = (what, extra = []) => main(['--project', p.dir, '--record', '--what', what, '--why', 'w', '--shape', 's', '--evidence', 'adr:x.md', ...extra], io(env, out, err));
    expect(await rec('Adopt gamma')).toBe(0);
    const oldKey = /committed (decision-\S+)/.exec(out.join(''))[1];
    expect(await rec('Replace gamma one way', ['--supersedes', oldKey]), err.join('')).toBe(0);
    out.length = 0;
    expect(await rec('Replace gamma another way', ['--supersedes', oldKey]), err.join('')).toBe(0);
    expect(out.join('')).toMatch(/tombstone already-stored supersession-/);
    cleanup();
  }, 240_000);

  (ruflo ? it : it.skip)('--supersedes refuses a key that is not an existing decision record of this project, and writes nothing', async () => {
    const p = adoptedProject();
    const env = { ...p.env, RUFLO_BIN: ruflo, RUVNET_BRAIN_HOME: tmp('decision-bh-') };
    const out = []; const err = [];
    const code = await main(['--project', p.dir, '--record', '--what', 'Replace something', '--why', 'w', '--shape', 's', '--evidence', 'adr:c.md',
      '--supersedes', 'decision-never-recorded-20261011T000000000Z'], io(env, out, err));
    expect(code).toBe(2);
    expect(err.join('')).toMatch(/supersedes .*not an existing decision record/);
    expect(rows(path.join(p.dir, '.swarm', 'memory.db'), path.basename(p.dir))).toEqual([]);
    cleanup();
  }, 240_000);
});

describe('prompt-path recall block names withheld decisions (re-review R3)', () => {
  it('prints the count even when nothing else is delivered', async () => {
    const { formatBlock } = await import('../../plugin/scripts/agentdb-recall.mjs');
    expect(formatBlock({ picks: [], status: 'ok', withheld: 2 })).toMatch(/2 superseded decision\(s\) withheld/);
    expect(formatBlock({ picks: [], status: 'ok' })).toBe('');
  });
});
