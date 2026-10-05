// Operator containment only (#390 B). No store, checkpoint, event, turn or search is disabled here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const suspendedResults = new WeakSet();
export function progressionSuspensionFile(env = process.env) {
  return path.join(env.RUVNET_BRAIN_STATE_DIR || path.join(env.HOME || os.homedir(), '.config', 'ruvnet-brain'), 'brain-progression-suspension');
}
export function operatorProgressionSuspension(env = process.env) {
  if (env.RUVNET_BRAIN_PROGRESSION_SUSPENDED === '1') return { source: 'environment' };
  if (env.RUVNET_BRAIN_PROGRESSION_SUSPENDED && env.RUVNET_BRAIN_PROGRESSION_SUSPENDED !== '0') {
    throw new Error('invalid automatic progression suspension environment setting');
  }
  let value;
  try { value = JSON.parse(fs.readFileSync(progressionSuspensionFile(env), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('automatic progression suspension policy unreadable or invalid'); }
  if (value?.schemaVersion !== 1 || typeof value.suspended !== 'boolean') {
    throw new Error('automatic progression suspension policy unreadable or invalid');
  }
  return value.suspended ? { source: 'operator-state' } : null;
}
export function automaticProgressionSuspensionResult(env = process.env, fields = {}) {
  const control = operatorProgressionSuspension(env);
  if (!control) return null;
  const result = Object.freeze({ ...fields, progressionSuspended: true, progressionCaptured: false,
    receipt: null, skipped: 'operator suspended automatic project progression', suspensionSource: control.source });
  suspendedResults.add(result);
  return result;
}
// A look-alike public flag is never authority to bypass an unexpected capture failure.
export const isAutomaticProgressionSuspension = (result) => Boolean(result && suspendedResults.has(result));

/** Explicit operator configuration: replacing this control file never touches evidence or queues. */
export function setOperatorProgressionSuspension(suspended, { env = process.env } = {}) {
  if (typeof suspended !== 'boolean') throw new TypeError('suspended must be a boolean');
  const file = progressionSuspensionFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, suspended }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch { /* renamed or not created */ } }
  return operatorProgressionSuspension(env);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    if (argv.length !== 1 || !['--suspend', '--resume', '--status'].includes(argv[0])) {
      throw new Error('usage: project-progression-suspension.mjs --suspend | --resume | --status');
    }
    if (argv[0] !== '--status') setOperatorProgressionSuspension(argv[0] === '--suspend');
    const control = operatorProgressionSuspension();
    console.log(JSON.stringify({ automaticProgression: control ? 'operator-suspended' : 'enabled', source: control?.source || null,
      evidencePreserved: true, explicitCheckpointsAvailable: true }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
