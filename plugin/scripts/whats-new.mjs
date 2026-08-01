#!/usr/bin/env node
// Installed What's New boundary. The executable, manifest and curated notes live in the same
// immutable plugin payload, so a Stable Spine generation can never report another version's notes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const notesPath = path.join(pluginRoot, 'docs', 'RELEASE-NOTES-4.0.md');
const manifestCandidates = [
  path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
  path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
];

function fail(message) {
  process.stderr.write(`RuvNet Brain What's New failed: ${message}\n`);
  process.exitCode = 1;
}

let manifest = null;
for (const candidate of manifestCandidates) {
  try {
    manifest = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    if (manifest?.version) break;
  } catch { /* try the other installed host manifest */ }
}

if (!manifest?.version) {
  fail(`installed version metadata is missing from ${pluginRoot}`);
} else if (!fs.existsSync(notesPath)) {
  fail(`installed release notes are missing at ${notesPath}`);
} else {
  let notes = '';
  try { notes = fs.readFileSync(notesPath, 'utf8'); }
  catch (error) { fail(`installed release notes could not be read at ${notesPath}: ${error.message}`); }
  if (notes) {
    process.stdout.write(`RuvNet Brain ${manifest.version}\n\n`);
    process.stdout.write(notes);
    if (!notes.endsWith('\n')) process.stdout.write('\n');
  }
}
