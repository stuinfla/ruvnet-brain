// A configured coordinator owns automatic mutation. Its immutable scheduler module is the real door.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function developerCoordinatorOwner({ home = os.homedir(), brainHome = process.env.RUVNET_BRAIN_HOME || path.join(home, '.cache/ruvnet-brain') } = {}) {
  const config = path.join(brainHome, 'developer-update-config.json'), registration = path.join(brainHome, 'scheduler/registration.json');
  let record;
  try { record = JSON.parse(fs.readFileSync(registration, 'utf8')); } catch { /* handled below */ }
  const configured = fs.existsSync(config) || record?.mode === 'developer-suite';
  if (!configured) return { active: false, ready: false };
  const entry = record?.updateModules?.['developer-update.mjs'];
  try {
    if (record?.mode !== 'developer-suite' || !path.isAbsolute(entry?.path || '') || !/^[a-f0-9]{64}$/.test(entry?.sha256 || '')
      || hash(entry.path) !== entry.sha256 || hash(record.runnerPath) !== record.runnerSha256) throw Error('registered source is absent or changed');
    for (const module of Object.values(record.updateModules)) if (hash(module.path) !== module.sha256) throw Error('registered module closure changed');
    return { active: true, ready: true, entry: entry.path, node: record.nodePath, registration, sourceSha256: entry.sha256 };
  } catch (error) { return { active: true, ready: false, reason: error.message }; }
}
