// Only closed, attributed npx installer entries qualify. Unknown/project/app/runtime trees never do.
import fs from 'node:fs';
import path from 'node:path';
const INSTALLERS = new Set(['ruvnet-brain', 'ruflo']);
export function cleanupNpxDuplicates({ home, globalRoot, enabled = false, run, active = null }) {
  const root = path.join(home, '.npm/_npx'), result = { enabled, removed: [], retained: [] };
  if (!fs.existsSync(root)) return result;
  if (fs.realpathSync(root) !== path.resolve(root)) { result.retained.push({ directory: root, reason: 'cache root alias is unclassified' }); return result; }
  for (const name of fs.readdirSync(root)) {
    const directory = path.join(root, name);
    if (!/^[a-f0-9]{16,64}$/.test(name) || !fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) continue;
    if (fs.readdirSync(directory).some(entry => !['package.json', 'package-lock.json', 'node_modules'].includes(entry))) { result.retained.push({ directory, reason: 'unknown cache content' }); continue; }
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')); } catch { result.retained.push({ directory, reason: 'unknown installer identity' }); continue; }
    const dependencies = Object.keys(manifest.dependencies || {});
    if (!dependencies.length || dependencies.some(pkg => !INSTALLERS.has(pkg) || !fs.existsSync(path.join(globalRoot, pkg, 'package.json')))) continue;
    if (!enabled) { result.retained.push({ directory, reason: 'cleanup disabled' }); continue; }
    let busy = true;
    try {
      if (active) busy = active(directory);
      else {
        const processes = run('ps', ['-axo', 'command='], { timeout: 15_000 });
        if (processes.includes(directory)) busy = true;
        else {
          // lsof exit 1 means no files; any other failure is unknown and retains the tree.
          const opened = run('lsof', ['-nP', '+D', directory], { timeout: 15_000, allowed: [0, 1] });
          busy = opened.trim().length > 0;
        }
      }
    } catch { busy = true; }
    if (busy) { result.retained.push({ directory, reason: 'live or unknown process/open-file owner' }); continue; }
    // Recheck exact directory type and manifest bytes at the removal boundary.
    const second = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (JSON.stringify(second) !== JSON.stringify(manifest) || fs.lstatSync(directory).isSymbolicLink()) throw Error('npx cleanup identity changed');
    fs.rmSync(directory, { recursive: true }); result.removed.push({ directory, installers: dependencies });
  }
  return result;
}
