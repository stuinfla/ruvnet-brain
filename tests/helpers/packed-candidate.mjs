import fs from 'node:fs';
import path from 'node:path';

// Local diagnostics may pack once. Release evidence must consume the already sealed bytes.
export function packedCandidate({ sealedPackage, root, destination, run }) {
  if (sealedPackage) {
    const archive = path.resolve(sealedPackage);
    const stat = fs.lstatSync(archive);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw new Error('sealed candidate must be a nonempty regular archive');
    return archive;
  }
  const result = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination],
    { cwd: root, timeout: 120_000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'local package creation failed');
  return path.join(destination, JSON.parse(result.stdout)[0].filename);
}
