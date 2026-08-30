#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const digest = (value) => crypto.createHash('sha256')
  .update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');

const sha256File = (file) => {
  const hash = crypto.createHash('sha256');
  const bytes = fs.readFileSync(file);
  hash.update(bytes);
  return { sha256: hash.digest('hex'), bytes: bytes.length };
};

function gitInventory(root) {
  const result = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`repository inventory failed: ${String(result.stderr || '').trim()}`);
  return result.stdout.toString('utf8').split('\0').filter(Boolean).sort();
}

function validateRelativeFile(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
    || relative.split(/[\\/]/).includes('..')) throw new Error(`unsafe source path: ${relative || '(missing)'}`);
  const absolute = path.join(root, relative);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`source path is not a regular file: ${relative}`);
  return absolute;
}

function payload(receipt) {
  const { receiptSha256: _receiptSha256, ...rest } = receipt;
  return rest;
}

export function buildSourceScopeReceipt({ root, governedPaths, sourceSha = null, inventory = gitInventory } = {}) {
  const repositoryRoot = path.resolve(root || '.');
  const paths = inventory(repositoryRoot);
  if (!paths.length || new Set(paths).size !== paths.length) throw new Error('repository inventory is empty or duplicated');
  const files = paths.map((relative) => ({ path: relative, ...sha256File(validateRelativeFile(repositoryRoot, relative)) }));
  const governed = [...new Set(governedPaths || [])].sort();
  if (!governed.length) throw new Error('governed source scope is empty');
  const inventorySet = new Set(paths);
  const missing = governed.filter((relative) => !inventorySet.has(relative));
  if (missing.length) throw new Error(`governed source is outside repository inventory: ${missing.join(', ')}`);
  const byPath = new Map(files.map((row) => [row.path, row]));
  const governedFiles = governed.map((relative) => ({ ...byPath.get(relative), readComplete: true }));
  const body = {
    schemaVersion: 1,
    kind: 'ruvnet-brain-source-scope-receipt',
    sourceSha,
    repository: { fileCount: files.length, inventorySha256: digest(files) },
    governed: { fileCount: governedFiles.length, files: governedFiles },
  };
  return { ...body, receiptSha256: digest(body) };
}

export function validateSourceScopeReceipt(receipt, { root, inventory = gitInventory } = {}) {
  if (receipt?.schemaVersion !== 1 || receipt?.kind !== 'ruvnet-brain-source-scope-receipt'
    || !Number.isInteger(receipt.repository?.fileCount) || !Array.isArray(receipt.governed?.files)
    || receipt.governed.files.some((row) => row.readComplete !== true)) throw new Error('source scope receipt is malformed');
  if (digest(payload(receipt)) !== receipt.receiptSha256) throw new Error('source scope receipt digest mismatch');
  const rebuilt = buildSourceScopeReceipt({ root, sourceSha: receipt.sourceSha,
    governedPaths: receipt.governed.files.map(({ path: relative }) => relative), inventory });
  if (canonicalJson(rebuilt.repository) !== canonicalJson(receipt.repository)
    || canonicalJson(rebuilt.governed) !== canonicalJson(receipt.governed)) {
    throw new Error('source scope receipt differs from the current complete repository inventory');
  }
  return receipt;
}
