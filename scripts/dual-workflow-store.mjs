// Append-only generic Dual implementation state in the project's existing AgentDB.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { digest } from './coverage-integrity.mjs';
import { resolveProjectStore } from '../plugin/scripts/project-store-resolver.mjs';
import { withProgressionReader } from '../plugin/scripts/project-progression-reader.mjs';
import { resolveRuflo, rufloInvocation } from '../plugin/scripts/ruflo-bin.mjs';
import { assertDualBriefCurrent, assertDualJob, verifyDualJob, verifyDualCompletion, assertNativePlanApproval } from './dual-workflow.mjs';
import { validateDualProgress } from './dual-workflow-contract.mjs';

const namespace = 'dual-workflow';

export class DualWorkflowStore {
  constructor(root = process.cwd()) {
    this.root = fs.realpathSync(root);
    this.resolution = resolveProjectStore({ projectDir: this.root });
    this.db = this.resolution.canonicalAgentDbPath;
    this.lock = path.join(path.dirname(this.db), 'dual-workflow.lock');
  }

  cli(args) {
    const binary = resolveRuflo();
    if (!binary) throw new Error('global Ruflo is required for Dual state');
    const invocation = rufloInvocation(binary, ['memory', ...args, '--path', this.db]);
    const result = spawnSync(invocation.executable, invocation.args, { cwd: path.dirname(this.db),
      encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' } });
    const stdout = String(result.stdout || '').replace(/^Transformers\.js loaded: [^\n]*\n/, '').trim();
    if (result.status !== 0) {
      if (args[0] === 'retrieve' && /\[WARN\] Key not found/.test(stdout)) return null;
      throw new Error('Ruflo could not read canonical Dual state');
    }
    return stdout;
  }

  read(work) {
    const fast = withProgressionReader(this.db, work);
    if (fast.ok) return fast;
    // Schema evolution is owned by Ruflo. Its exact CLI read is the canonical fallback.
    const reader = {
      listKeys: target => {
        const rows = JSON.parse(this.cli(['list', '--namespace', target, '--format', 'json', '--limit', '10000']));
        if (!Array.isArray(rows) || rows.length >= 10000 || rows.some(row => typeof row.key !== 'string' || row.namespace !== target)
          || new Set(rows.map(row => row.key)).size !== rows.length) throw new Error('Dual enumeration is incomplete or malformed');
        return rows.map(row => row.key).sort();
      },
      readContent: (target, key) => this.cli(['retrieve', '--namespace', target, '--key', key, '--value-only']),
    };
    return { ok: true, value: work(reader) };
  }

  history() {
    if (!fs.existsSync(this.db)) return [];
    const result = this.read(reader => reader.listKeys(namespace).map(key => {
      const value = JSON.parse(reader.readContent(namespace, key));
      const ref = value.workflowRef;
      if (!ref || !Array.isArray(ref.chunks) || !ref.chunks.length) throw new Error('Dual state has no immutable workflow content');
      const bytes = Buffer.concat(ref.chunks.map(key => {
        const content = reader.readContent(`${namespace}-content`, key);
        if (typeof content !== 'string' || digest(content) !== key) throw new Error('Dual workflow content is missing or changed');
        return Buffer.from(content, 'base64');
      }));
      const workflow = JSON.parse(bytes.toString('utf8'));
      if (digest(workflow) !== ref.digest) throw new Error('Dual workflow content digest mismatch');
      delete value.workflowRef;
      return { key, value: { ...value, workflow } };
    }));
    if (!result.ok) throw new Error(`Dual state is unavailable: ${result.reason}`);
    let previous = null;
    for (const [index, row] of result.value.entries()) {
      if (row.key !== `event-${String(index + 1).padStart(10, '0')}` || row.value.previous !== (previous ? digest(previous) : null)) {
        throw new Error('Dual history is forked, truncated, or out of order');
      }
      if (row.value.schemaVersion !== 1) throw new Error('unknown Dual history envelope');
      // Legacy records remain immutable readable history, never current execution
      // approval. Execution validates v2; explicit reapproval appends without credit.
      if (row.value.workflow?.brief?.schemaVersion !== 1) validateDualProgress(row.value.workflow);
      if (!['active', 'complete'].includes(row.value.status)) throw new Error('Dual history has an unknown state');
      previous = row.value;
    }
    return result.value;
  }

  current() { return this.history().at(-1)?.value ?? null; }

  async locked(work) {
    fs.mkdirSync(path.dirname(this.db), { recursive: true });
    this.acquireLock(this.lock);
    const owner = path.join(this.lock, 'owner.json');
    try {
      return await work();
    } finally { fs.rmSync(owner, { force: true }); fs.rmdirSync(this.lock); }
  }

  acquireLock(target) {
    const staging = fs.mkdtempSync(`${target}.preparing-`);
    try {
      fs.writeFileSync(path.join(staging, 'owner.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), token: randomUUID(), startedAt: new Date().toISOString() }), { flag: 'wx' });
      // Publish the owner and lock together; a crash preparing it cannot block transitions.
      if (fs.existsSync(target)) throw new Error('another Dual transition is active; do not start dependent work');
      fs.renameSync(staging, target);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw new Error('another Dual transition is active; do not start dependent work');
      throw error;
    }
  }

  recoverLock({ controllersStopped = false } = {}) {
    // Operator-invoked local recovery only. Never reclaim a lock by age or by a timeout.
    // A live/reused PID or an unverifiable remote owner conservatively prevents recovery.
    const recovery = `${this.lock}.recovery`;
    // Maintenance acknowledgement is explicit; it is never inferred from age or failed retries.
    // This repairs interruptions in older lock initialization/recovery after operators stop
    // controllers. Even maintenance refuses a recorded live owner.
    if (controllersStopped && fs.existsSync(recovery)) this.removeExitedLock(recovery, true);
    this.acquireLock(recovery);
    try {
      const ownerToken = fs.existsSync(this.lock) ? this.removeExitedLock(this.lock, controllersStopped) : null;
      return { recovered: true, ownerToken, workflowUnchanged: true };
    } finally { fs.unlinkSync(path.join(recovery, 'owner.json')); fs.rmdirSync(recovery); }
  }

  removeExitedLock(target, controllersStopped) {
    const ownerFile = path.join(target, 'owner.json');
    if (!fs.existsSync(ownerFile)) {
      if (!controllersStopped) throw new Error('ownerless lock requires stopped-controller maintenance acknowledgement');
      fs.rmdirSync(target); // Empty only: never recursively erase unknown data.
      return null;
    }
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    if (owner.host !== os.hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string') throw new Error('lock owner cannot be verified locally');
    try { process.kill(owner.pid, 0); throw new Error('Dual lock owner is still running'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    fs.unlinkSync(ownerFile);
    fs.rmdirSync(target);
    return owner.token;
  }

  append(workflow, status, expectedPrevious) {
    validateDualProgress(workflow);
    const rows = this.history();
    const previous = rows.at(-1)?.value ?? null;
    if (digest(previous) !== digest(expectedPrevious)) throw new Error('Dual state changed during transition');
    const value = { schemaVersion: 1, previous: previous ? digest(previous) : null, status, workflow };
    const key = `event-${String(rows.length + 1).padStart(10, '0')}`;
    // Ruflo accepts values in argv. Content-addressed chunks avoid macOS ARG_MAX truncation
    // for whole-repository review ledgers, without creating another operational store.
    const chunks = [], bytes = Buffer.from(JSON.stringify(workflow));
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      const content = bytes.subarray(offset, offset + 32768).toString('base64');
      const chunkKey = digest(content);
      this.writeExact(`${namespace}-content`, chunkKey, content);
      chunks.push(chunkKey);
    }
    const { workflow: _workflow, ...header } = value;
    this.writeExact(namespace, key, JSON.stringify({ ...header, workflowRef: { digest: digest(workflow), chunks } }));
    const observed = this.current();
    if (digest(observed) !== digest(value)) throw new Error('Dual exact AgentDB read-back failed');
    return value;
  }

  writeExact(targetNamespace, key, content) {
    const existing = fs.existsSync(this.db)
      ? this.read(reader => reader.readContent(targetNamespace, key)) : { ok: true, value: null };
    if (!existing.ok) throw new Error('Dual exact AgentDB read is unavailable');
    if (existing.value !== null) {
      if (existing.value !== content) throw new Error('Dual immutable record conflicts');
      return;
    }
    const binary = resolveRuflo();
    if (!binary) throw new Error('global Ruflo is required to persist Dual state');
    const invocation = rufloInvocation(binary, ['memory', 'store', '--key', key, '--value', content,
      '--namespace', targetNamespace, '--no-upsert', '--path', this.db]);
    const run = spawnSync(invocation.executable, invocation.args, {
      cwd: path.dirname(this.db), encoding: 'utf8', timeout: 120000, env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' },
    });
    if (run.status !== 0) throw new Error('Dual state was not persisted; execution must not advance');
    const observed = this.read(reader => reader.readContent(targetNamespace, key));
    if (!observed.ok || observed.value !== content) throw new Error('Dual exact AgentDB read-back failed');
  }

  activate(approval, { replaceActive = false } = {}) {
    return this.locked(() => {
      const previous = this.current();
      if (previous?.status === 'active' && !replaceActive) throw new Error('an approved Dual plan is already active; explicit reapproval is required');
      const workflow = { brief: approval.workflow?.brief, approval, completed: [] };
      validateDualProgress(workflow);
      assertNativePlanApproval(workflow.brief,approval);
      assertDualBriefCurrent(workflow.brief, this.root, { plan:approval.artifact.artifact });
      // A new approved plan invalidates old completion credit; no automatic carry-forward.
      return this.append(workflow, 'active', previous);
    });
  }

  preflight({ jobId, changedFiles } = {}) {
    if (fs.existsSync(this.lock)) throw new Error('Dual is verifying a transition; writes must wait');
    const current = this.current();
    if (!current) return { managed: false };
    if (current.status === 'complete') throw new Error('Dual plan is complete; new implementation needs a new approved plan');
    if (!Array.isArray(changedFiles) || !changedFiles.length) throw new Error('managed Dual execution requires exact nonempty changedFiles');
    const result = assertDualJob(current.workflow, { root: this.root, jobId, changedFiles });
    return { managed: true, jobId: result.nextJob.id, planDigest: digest(result.plan) };
  }

  verifyJob(jobId) {
    return this.locked(async () => {
      const current = this.current();
      if (current?.status !== 'active') throw new Error('no active approved Dual plan');
      const receipt = await verifyDualJob(current.workflow, { root: this.root, jobId });
      const workflow = { ...current.workflow, completed: [...current.workflow.completed, receipt] };
      return this.append(workflow, 'active', current);
    });
  }

  complete() {
    return this.locked(() => {
      const current = this.current();
      if (!current) throw new Error('no approved Dual plan');
      const evidence = verifyDualCompletion(current.workflow, { root: this.root });
      if (current.status === 'active') this.append(current.workflow, 'complete', current);
      return evidence;
    });
  }
}
