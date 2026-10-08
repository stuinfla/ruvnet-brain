/** Known literal raw writes only. Dynamic programs are not a universal SQL classifier. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandOf, knownRawStoreWrites } from './hook-input.mjs';
import { resolveProjectStoreGuard } from './project-store-resolver.mjs';
import { loadRuntimePreferences } from './runtime-preferences.mjs';

function brainOff(env) {
  if (env.RUVNET_BRAIN_OFF === '1') return true;
  const state = env.RUVNET_BRAIN_STATE_DIR || path.join(env.HOME || os.homedir(), '.config', 'ruvnet-brain');
  try { fs.statSync(path.join(state, 'brain-off')); return true; }
  catch (e) { return !['ENOENT', 'ENOTDIR'].includes(e.code); }
}
function prospectiveReal(file) {
  try { return fs.realpathSync(file); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    return path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  }
}
/** Caller JSON supplies tool data, never preference, ownership or OFF authority. */
export function evaluateManagedStoreWrite(event, { env = process.env, deadlineAt = Infinity,
  resolveStore = resolveProjectStoreGuard } = {}) {
  const allow = status => ({ decision: 'allow', status });
  if (brainOff(env)) return allow('brain-off');
  const command = commandOf(event);
  const cwd = typeof event.cwd === 'string' ? event.cwd : process.cwd();
  const paths = knownRawStoreWrites(command, { cwd, home: env.HOME || os.homedir() });
  if (!paths.length) return allow('not-known-write');
  const localCandidate = paths.includes(path.join(cwd, '.swarm', 'memory.db'));
  const deny = status => ({ decision: 'deny', status,
    reason: 'Raw writes to the canonical Ruflo-managed store are refused. Use global ruflo memory store with the canonical --path; no raw SQL or schema improvisation.' });
  try {
    const resolved = resolveStore({ projectDir: cwd, deadlineAt });
    const canonical = prospectiveReal(resolved.canonicalAgentDbPath);
    const owned = paths.some(file => prospectiveReal(file) === canonical);
    if (!owned) return allow('foreign-or-unmanaged');
    let stat; try { stat = fs.statSync(canonical); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return allow('unadopted'); throw error; }
    if (!stat.isFile() || stat.nlink > 1 || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))
      return deny('known-write-unavailable');
    // Read existing trusted preferences; advise never authorizes this mandatory write.
    loadRuntimePreferences({ cwd, env });
    if (Date.now() >= deadlineAt) return deny('known-write-unavailable');
    return deny('known-managed-write');
  } catch { return localCandidate ? deny('known-write-unavailable') : allow('unresolved-nonlocal'); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let event; try { event = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  const result = evaluateManagedStoreWrite(event, { deadlineAt: Number(process.env.RUVNET_DECISION_DEADLINE) || Infinity });
  if (result.decision === 'deny') { process.stderr.write(result.reason + '\n'); process.exit(2); }
}
