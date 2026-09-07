import fs from 'node:fs';
import path from 'node:path';

// Run the already installed npm CLI with Node, including on Windows where npm.cmd
// cannot be exec'd directly. Never install another npm or concatenate a shell command.
export function npmInvocation(args, { env = process.env, nodePath = process.execPath } = {}) {
  const candidates = [env.npm_execpath, path.join(path.dirname(nodePath), 'node_modules/npm/bin/npm-cli.js'),
    path.join(path.dirname(nodePath), 'npm')].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const entry = fs.realpathSync(candidate);
      const root = path.dirname(path.dirname(entry));
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      if (manifest.name !== 'npm' || typeof manifest.bin?.npm !== 'string'
        || fs.realpathSync(path.resolve(root, manifest.bin.npm)) !== entry || !fs.statSync(entry).isFile()) continue;
      return { executable: nodePath, args: [entry, ...args] };
    } catch { /* only a positively identified installed npm entry is accepted */ }
  }
  throw new Error('acceptance requires installed npm beside Node or an explicit npm_execpath pointing to its CLI');
}
