import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { DualWorkflowStore } from '../../scripts/dual-workflow-store.mjs';
import { runExecutionPreflight } from '../../scripts/execution-preflight.mjs';
import { workflowFixture } from '../helpers/dual-workflow-fixture.mjs';
import { digest } from '../../scripts/coverage-integrity.mjs';

const fixtures = [];
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));

describe('Dual durable execution ownership', () => {
  it('retains legacy history while refusing its execution and permitting fresh append-only reapproval', async () => {
    const f=workflowFixture(); fixtures.push(f);
    const store=new DualWorkflowStore(f.root), legacy=structuredClone(f.workflow);
    legacy.brief.schemaVersion=1; legacy.approval.workflow.brief.schemaVersion=1;
    const content=Buffer.from(JSON.stringify(legacy)).toString('base64'), chunk=digest(content);
    const header={schemaVersion:1,previous:null,status:'active',workflowRef:{digest:digest(legacy),chunks:[chunk]}};
    await store.locked(()=> {
      store.writeExact('dual-workflow-content',chunk,content);
      store.writeExact('dual-workflow','event-0000000001',JSON.stringify(header));
    });
    expect(store.current().workflow.brief.schemaVersion).toBe(1);
    expect(()=>store.preflight({jobId:'first',changedFiles:['first.txt']})).toThrow(/v2/);
    await expect(store.verifyJob('first')).rejects.toThrow(/v2/);
    await store.activate(f.workflow.approval,{replaceActive:true});
    const history=store.history();
    expect(history).toHaveLength(2);
    expect(history[0].value.workflow).toEqual(legacy);
    expect(history[1].value.workflow.completed).toEqual([]);
    expect(store.preflight({jobId:'first',changedFiles:['first.txt']}).managed).toBe(true);
  },120000);
  it('recovers a proven exited local owner and refuses recovery of a live owner', async () => {
    const f = workflowFixture(); fixtures.push(f);
    const store = new DualWorkflowStore(f.root);
    await store.locked(() => expect(() => store.recoverLock()).toThrow(/still running/));
    const child = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
    expect(child.status).toBe(0);
    fs.mkdirSync(store.lock);
    fs.writeFileSync(path.join(store.lock, 'owner.json'), JSON.stringify({ pid: Number(child.stdout.trim()), host: os.hostname(), token: 'fixture-exited-owner' }));
    expect(store.recoverLock()).toMatchObject({ recovered: true, workflowUnchanged: true });
    expect(fs.existsSync(store.lock)).toBe(false);
    // An interrupted preparation never publishes an ownerless held lock.
    fs.mkdirSync(`${store.lock}.preparing-orphan`);
    await store.locked(() => expect(fs.existsSync(path.join(store.lock, 'owner.json'))).toBe(true));
    // Legacy initialization/recovery interruptions need explicit stopped-controller maintenance.
    fs.mkdirSync(store.lock);
    expect(() => store.recoverLock()).toThrow(/ownerless/);
    fs.mkdirSync(`${store.lock}.recovery`);
    expect(() => store.recoverLock()).toThrow(/active/);
    expect(store.recoverLock({ controllersStopped: true }).recovered).toBe(true);
    expect(fs.existsSync(`${store.lock}.recovery`)).toBe(false);
  });
  it('persists approval and completion in canonical AgentDB and refuses omitted or skipped jobs', async () => {
    const f = workflowFixture(); fixtures.push(f);
    const store = new DualWorkflowStore(f.root);
    await store.activate(f.workflow.approval);
    expect(store.current().status).toBe('active');
    expect(() => store.preflight({ jobId: 'first', changedFiles: [] })).toThrow(/nonempty/);
    expect(() => store.preflight({ changedFiles: ['first.txt'] })).toThrow(/next unfinished/);
    expect(() => store.preflight({ jobId: 'second', changedFiles: ['second.txt'] })).toThrow(/next unfinished/);
    await expect(store.activate(f.workflow.approval)).rejects.toThrow(/already active/);
    const now = Date.now();
    const input = { cwd: f.root, action: 'write', jobId: 'first', changedFiles: ['first.txt'], now,
      groundingReceipt: { status: 'success', observedAt: new Date(now).toISOString(), sourceIdentity: 'a'.repeat(64) },
      memoryReceipt: { status: 'retrieved', observedAt: new Date(now).toISOString(), path: store.db,
        key: `project-state-current-${now}`, valueDigest: 'b'.repeat(64) } };
    const preflight = value => runExecutionPreflight(value, { cwd: f.root });
    expect(preflight(input).verdict, JSON.stringify(preflight(input))).toBe('ALLOW');
    expect(preflight({ ...input, cwd: '/tmp/another-project', jobId: undefined }).verdict).toBe('REFUSE');
    expect(preflight({ ...input, changedFiles: [] }).verdict).toBe('REFUSE');
    expect(preflight({ ...input, changedFiles: ['second.txt'] }).verdict).toBe('REFUSE');
    fs.mkdirSync(store.lock);
    expect(preflight(input).verdict).toBe('REFUSE');
    fs.rmdirSync(store.lock);
    await store.verifyJob('first');
    expect(new DualWorkflowStore(f.root).current().workflow.completed).toHaveLength(1);
    await expect(store.verifyJob('first')).rejects.toThrow(/next unfinished/);
    await store.verifyJob('second');
    expect((await store.complete()).status).toBe('complete');
    expect(store.current().status).toBe('complete');
    expect(preflight({ ...input, jobId: 'second' }).verdict).toBe('REFUSE');
    expect(fs.existsSync(path.join(f.root, '.swarm/memory.db'))).toBe(true);
  }, 120000);
});
