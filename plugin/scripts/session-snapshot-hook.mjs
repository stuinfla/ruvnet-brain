import fs from 'node:fs';
import path from 'node:path';
import { createSessionSnapshot } from './session-snapshot-contract.mjs';
import { projectDirectory } from './project-identity.mjs';

function regularOrAbsent(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

export function writeSessionSnapshot(projectDir, event) {
  const swarm = path.join(projectDir, '.swarm');
  const target = path.join(swarm, 'agentdb-sessions.jsonl');
  try {
    // WE DO NOT CREATE `.swarm` — WE ONLY WRITE INTO ONE THAT EXISTS.
    //
    // This hook runs machine-wide, so `mkdirSync(swarm)` planted a `.swarm/` directory in EVERY
    // repository the user opened, alongside a session receipt they never asked for. Measured
    // 2026-08-14 by the both-hosts conformance gate, in a temp project with no git and no brain
    // artifacts: PreCompact, PostToolUse and SessionEnd each left `.swarm` behind. ADR-058 D5 —
    // never touch what we do not own — and the owner's report was blunter: opening the plugin in
    // another project produced files and errors he did not ask for.
    //
    // `.swarm` is Ruflo's own convention and `ruflo init` creates it, so its PRESENCE is the
    // project's opt-in and its ABSENCE is a project that has not adopted the brain. Writing a
    // receipt into a store that exists is participation; conjuring the store is trespass.
    if (!fs.existsSync(swarm)) return false;
    const stat = fs.lstatSync(swarm);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (!regularOrAbsent(target)) return false;
    fs.appendFileSync(target, `${JSON.stringify(createSessionSnapshot({ event }))}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('session-snapshot-hook.mjs')) {
  // projectDirectory() is the SAME derivation the Console's detector uses. Deriving it here
  // independently is what let this hook write a receipt the Console then reported as missing (#85).
  writeSessionSnapshot(projectDirectory(), process.argv[2] || 'SessionEnd');
}
