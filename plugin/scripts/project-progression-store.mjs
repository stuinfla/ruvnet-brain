import { spawnSync } from 'node:child_process';
import { ProgressionOutbox } from './project-progression-outbox.mjs';
import { digestCanonical, validateProgressionSnapshot } from './project-progression-contract.mjs';
import { resolveProjectStore } from './project-store-resolver.mjs';
import { resolveRuflo, RUFLO_MISSING } from './ruflo-bin.mjs';

const PROGRESSION_NAMESPACE = 'project-progression';

function defaultRunner(binary, args, options) {
  return spawnSync(binary, args, options);
}

function resultStatus(result) {
  return Number.isInteger(result?.status) ? result.status : 1;
}

function resultText(result, field) {
  const value = result?.[field];
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
}

export class ProjectProgressionStore {
  constructor({
    projectDir,
    requestedStorePath,
    rufloBinary = resolveRuflo(),
    runner = defaultRunner,
    clock = () => new Date().toISOString(),
    fsync,
  } = {}) {
    if (!rufloBinary) throw new Error(RUFLO_MISSING);
    this.resolution = resolveProjectStore({ projectDir, requestedStorePath });
    this.rufloBinary = rufloBinary;
    this.runner = runner;
    this.clock = clock;
    this.outbox = new ProgressionOutbox({ projectRoot: this.resolution.projectRoot, fsync });
  }

  run(args) {
    return this.runner(this.rufloBinary, args, {
      cwd: this.resolution.checkoutRoot,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' },
    });
  }

  validateSnapshot(snapshot) {
    const verdict = validateProgressionSnapshot(snapshot, {
      expectedProjectIdentity: this.resolution.projectIdentity,
    });
    if (!verdict.ok) throw new Error(`invalid progression snapshot: ${verdict.errors.join(', ')}`);
  }

  appendExact(snapshot, { onPhase = () => {} } = {}) {
    this.validateSnapshot(snapshot);
    const stored = this.run([
      'memory', 'store', '--key', snapshot.eventKey, '--value', JSON.stringify(snapshot),
      '--namespace', PROGRESSION_NAMESPACE, '--no-upsert', '--provenance', 'system_observation',
      '--path', this.resolution.canonicalAgentDbPath,
    ]);
    const alreadyStored = resultStatus(stored) !== 0;
    if (!alreadyStored) onPhase('stored');

    const retrieved = this.run([
      'memory', 'retrieve', '--key', snapshot.eventKey, '--namespace', PROGRESSION_NAMESPACE,
      '--value-only', '--path', this.resolution.canonicalAgentDbPath,
    ]);
    if (resultStatus(retrieved) !== 0) {
      const storeFailure = alreadyStored
        ? `; store failed: ${resultText(stored, 'stderr').trim() || 'unknown error'}`
        : '';
      throw new Error(`progression readback failed: ${resultText(retrieved, 'stderr').trim() || 'unknown error'}${storeFailure}`);
    }
    let readback;
    try { readback = JSON.parse(resultText(retrieved, 'stdout')); } catch { throw new Error('progression readback is not JSON'); }
    if (readback.payloadDigest !== snapshot.payloadDigest || digestCanonical(readback) !== digestCanonical(snapshot)) {
      throw new Error('progression readback digest mismatch');
    }
    onPhase('readback-verified');
    return {
      eventKey: snapshot.eventKey,
      payloadDigest: snapshot.payloadDigest,
      readbackDigest: readback.payloadDigest,
      alreadyStored,
      committedAt: this.clock(),
    };
  }

  capture(snapshot, { onPhase = () => {} } = {}) {
    this.validateSnapshot(snapshot);
    this.outbox.appendSnapshot(snapshot);
    onPhase('outbox-fsynced');
    const receipt = this.appendExact(snapshot, { onPhase });
    this.outbox.markCommitted(receipt);
    return receipt;
  }

  replay() {
    const receipts = [];
    for (const snapshot of this.outbox.pendingSnapshots()) {
      const receipt = this.appendExact(snapshot);
      this.outbox.markCommitted(receipt);
      receipts.push(receipt);
    }
    return receipts;
  }
}
