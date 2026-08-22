#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, digest } from './coverage-integrity.mjs';
import { HOST_MODES, MODE_HOSTS } from './host-install-matrix.mjs';

export const HOST_ADAPTER_FILES = Object.freeze([
  'plugin/host-adapters/claude.json',
  'plugin/host-adapters/codex.json',
]);
export const HOST_OPERATING_SYSTEMS = Object.freeze(['linux', 'macos', 'windows']);

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ordered = (values) => [...values].sort((a, b) => a.localeCompare(b));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function trackedFile(root, relative, label) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
    || relative.split(/[\\/]/).includes('..')) throw new Error(`${label} is not a safe tracked file`);
  const absolute = path.resolve(root, relative);
  let stat;
  try { stat = fs.lstatSync(absolute); } catch { throw new Error(`${label} is not a tracked file: ${relative}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a tracked file: ${relative}`);
  return absolute;
}

function expectedModes(id) {
  return HOST_MODES.filter((mode) => MODE_HOSTS[mode].includes(id));
}

function readAdapter(root, descriptorFile) {
  const absolute = trackedFile(root, descriptorFile, 'host adapter descriptor');
  const bytes = fs.readFileSync(absolute);
  let value;
  try { value = JSON.parse(bytes); } catch (error) { throw new Error(`host adapter descriptor is invalid JSON: ${error.message}`); }
  const expectedKeys = ['displayName', 'hooks', 'id', 'kind', 'loader', 'manifest', 'modes', 'os', 'schemaVersion'];
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson(expectedKeys)
    || value.schemaVersion !== 1 || value.kind !== 'ruvnet-brain-host-adapter'
    || !['claude', 'codex'].includes(value.id) || typeof value.displayName !== 'string' || !value.displayName
    || canonicalJson(value.os) !== canonicalJson(HOST_OPERATING_SYSTEMS)
    || canonicalJson(value.modes) !== canonicalJson(expectedModes(value.id))) {
    throw new Error(`${descriptorFile} host adapter identity, OS, or mode ownership is invalid`);
  }
  for (const field of ['manifest', 'hooks', 'loader']) trackedFile(root, value[field], `${value.id} ${field}`);
  return { ...value, descriptorFile, descriptorSha256: sha256(bytes) };
}

function assemble(root) {
  const adapters = HOST_ADAPTER_FILES.map((file) => readAdapter(root, file))
    .sort((a, b) => a.id.localeCompare(b.id));
  const payload = {
    schemaVersion: 1,
    kind: 'ruvnet-brain-host-registry',
    os: [...HOST_OPERATING_SYSTEMS],
    modes: [...HOST_MODES],
    adapters,
  };
  return { ...payload, registrySha256: digest(payload) };
}

export function validateHostRegistry(registry, { root = ROOT } = {}) {
  if (registry?.schemaVersion !== 1 || registry?.kind !== 'ruvnet-brain-host-registry') {
    throw new Error('host registry identity is invalid');
  }
  if (canonicalJson(registry.os) !== canonicalJson(HOST_OPERATING_SYSTEMS)) {
    throw new Error('host registry operating systems are incomplete');
  }
  if (canonicalJson(registry.modes) !== canonicalJson(HOST_MODES)) {
    throw new Error('host registry modes are incomplete');
  }
  if (!Array.isArray(registry.adapters)
    || canonicalJson(registry.adapters.map(({ id }) => id)) !== canonicalJson(['claude', 'codex'])) {
    throw new Error('host registry adapter set is incomplete');
  }
  for (const adapter of registry.adapters) {
    if (canonicalJson(adapter.modes) !== canonicalJson(expectedModes(adapter.id))) {
      throw new Error(`${adapter.id} host mode ownership is invalid`);
    }
    for (const field of ['manifest', 'hooks', 'loader']) trackedFile(root, adapter[field], `${adapter.id} ${field}`);
  }
  const expected = assemble(root);
  const { registrySha256: _registrySha256, ...payload } = registry;
  if (registry.registrySha256 !== digest(payload)) throw new Error('host registry digest mismatch');
  if (canonicalJson(registry) !== canonicalJson(expected)) throw new Error('host registry differs from tracked descriptors');
  return registry;
}

export function buildHostRegistry({ root = ROOT } = {}) {
  return validateHostRegistry(assemble(path.resolve(root)), { root: path.resolve(root) });
}

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

export function main(args = process.argv.slice(2)) {
  try {
    const out = argument(args, '--out');
    if (!out) throw new Error('--out is required');
    const output = path.resolve(out);
    if (fs.existsSync(output)) throw new Error(`refusing to overwrite existing host registry: ${output}`);
    const registry = buildHostRegistry({ root: process.cwd() });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(registry, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ ok: true, registrySha256: registry.registrySha256 })}\n`);
    return 0;
  } catch (error) {
    console.error(`host-registry: ${error.message}`);
    return 1;
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) process.exitCode = main();
