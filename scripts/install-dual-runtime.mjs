import fs from 'node:fs';
import path from 'node:path';

// Preserve the repository layout: compatibility facades import canonical plugin owners.
// Installed import tests exercise this complete runtime, not just entrypoint presence.
const scripts = ['dual-host-deliberation', 'dual-deliberation-contract', 'dual-host-suggest', 'dual-workflow', 'dual-workflow-contract',
  'dual-workflow-store', 'subscription-hosts', 'native-review-evidence', 'native-host-process',
  'coverage-integrity', 'qa-contract', 'execution-preflight', 'execution-policy'];
const plugin = ['coverage-integrity', 'native-host-process', 'project-store-resolver',
  'project-progression-reader', 'ruflo-bin'];

export function installDualRuntime({ packageRoot, routerRoot }) {
  const files = [...scripts.map(name => `scripts/${name}.mjs`), ...plugin.map(name => `plugin/scripts/${name}.mjs`)];
  // Read everything before replacing anything, so a missing dependency cannot leave half an update.
  const payloads = files.map(relative => ({ relative, bytes: fs.readFileSync(path.join(packageRoot, relative)) }));
  const runtime = path.join(routerRoot, 'dual-runtime');
  fs.mkdirSync(path.join(routerRoot, 'bin'), { recursive: true });
  for (const { relative, bytes } of payloads) {
    const target = path.join(runtime, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(`${target}.tmp`, bytes);
    fs.renameSync(`${target}.tmp`, target);
  }
  for (const entry of ['dual-host-deliberation', 'dual-host-suggest', 'execution-preflight']) {
    const target = path.join(routerRoot, 'bin', `${entry}.mjs`);
    const specifier = `../dual-runtime/scripts/${entry}.mjs`;
    const wrapper = `#!/usr/bin/env node\nimport fs from 'node:fs';\nimport { fileURLToPath } from 'node:url';\nimport { main } from '${specifier}';\nexport * from '${specifier}';\nif (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));\n`;
    fs.writeFileSync(`${target}.tmp`, wrapper, { mode: 0o755 });
    fs.renameSync(`${target}.tmp`, target);
  }
  return { runtime, files: files.length, entrypoints: 3 };
}
