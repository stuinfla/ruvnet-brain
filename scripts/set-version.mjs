#!/usr/bin/env node
// One release version command. The plugin manifest is the only editable source of truth;
// propagation and verification happen in the same process so a package-only bump cannot drift.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: npm run version:set -- X.Y.Z[-channel]');
  process.exit(2);
}
const manifest = path.join(root, 'plugin/.claude-plugin/plugin.json');
const doc = JSON.parse(fs.readFileSync(manifest, 'utf8'));
const previous = doc.version;
doc.version = version;
fs.writeFileSync(manifest, `${JSON.stringify(doc, null, 2)}\n`);
const sync = spawnSync(process.execPath, [path.join(root, 'scripts/sync-version.mjs')], {
  cwd: root, encoding: 'utf8', stdio: 'inherit',
});
if (sync.status !== 0) {
  console.error(`[version:set] propagation failed; source changed ${previous} -> ${version}, run version:sync after fixing the reported error`);
  process.exit(sync.status || 1);
}
const check = spawnSync(process.execPath, [path.join(root, 'scripts/sync-version.mjs'), '--check'], {
  cwd: root, encoding: 'utf8', stdio: 'inherit',
});
if (check.status !== 0) process.exit(check.status || 1);
console.log(`[version:set] ${previous} -> ${version}; all release surfaces agree`);
