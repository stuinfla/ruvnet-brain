#!/usr/bin/env node
// rebuild-gists-from-receipts.mjs — a thin staging/replay wrapper over the canonical gist renderer
// (renderGistPassages) and the full aggregate builder (buildGistAggregate), both in gist-receipts.mjs.
//
// This file owns exactly two things gist-receipts.mjs deliberately does not: (1) accepting a
// possibly-LEGACY (schema 1/2/3) receipt read from disk and replaying it deterministically from raw
// gist content alone — no GitHub detail-endpoint auth, no vector build, no publication — and
// (2) resolving WHICH installed receipt to replay. Rendering itself (the banner/chunk/JSONL
// assembly) is never reimplemented here; renderGistPassages is the sole implementation.
//
//   node scripts/rebuild-gists-from-receipts.mjs [--sources <file>] [--out-dir <dir>] [--concurrency N]

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './coverage-integrity.mjs';
import {
  buildGistAggregate,
  paragraphChunks,
  provenanceBanner,
  rawUrlFor,
  renderGistPassages,
  sealGistReceipt,
  sealGistReceiptSet,
} from './gist-receipts.mjs';

export { buildGistAggregate, paragraphChunks, provenanceBanner, rawUrlFor };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'ruv-gists';
const HEX_GIST = /^[a-f0-9]{20,64}$/;
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(`[rebuild-gists-from-receipts] ${message}`);
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function validateFilename(filename, label) {
  if (typeof filename !== 'string' || !filename || filename.includes('\0')
    || filename.split(/[\\/]/).some((segment) => !segment || segment === '.' || segment === '..')) {
    fail(`${label} has an unsafe or missing filename`);
  }
}

// Accepts a receipt read from disk, which may be an OLDER schema than anything buildGistAggregate
// produces today (schema 1/2 predate the source-byte binding this pipeline now requires for every
// NEW write). This is a raw-input structural sanity check on a file this tool does not control the
// production of, not the "one shared validator" (validateGistReceipt) — that validator always
// requires real, already-rendered passage bytes on disk, which do not exist yet at this point in the
// replay. Schema 3 gets ONE extra guard on top of the shape checks below: the receipt must re-seal
// to itself byte-for-byte (sealGistReceipt/sealGistReceiptSet round-trip), which is exactly the
// internal-consistency half of what the shared validator checks — the half that needs no live
// observation and no passages file to prove.
export function validateSourceReceipts(source) {
  if (source?.schemaVersion === 3) {
    if (source?.kind !== 'ruvnet-brain-gist-source-receipts') fail('schema-3 source receipt has the wrong kind');
    const resealed = sealGistReceiptSet({ ...source, gists: Object.fromEntries(
      Object.entries(source.gists || {}).map(([id, row]) => [id, sealGistReceipt(row)]),
    ) });
    if (canonicalJson(resealed) !== canonicalJson(source)) fail('schema-3 source receipt does not re-seal to itself');
    return source;
  }
  if (![1, 2].includes(source?.schemaVersion)) fail('source receipt schemaVersion must be 1 or 2');
  if (!/^[A-Za-z0-9-]{1,39}$/.test(String(source.owner || ''))) fail('source receipt owner is malformed');
  if (!validDate(source.generated)) fail('source receipt generated timestamp is malformed');
  if (!source.gists || typeof source.gists !== 'object' || Array.isArray(source.gists)) {
    fail('source receipt gists must be an object');
  }
  if (Object.keys(source.gists).length === 0) fail('source receipt has no gist receipts');

  for (const [gistId, receipt] of Object.entries(source.gists)) {
    const label = `gist ${gistId}`;
    if (!HEX_GIST.test(gistId)) fail(`${label} id is malformed`);
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) fail(`${label} receipt is malformed`);
    if (receipt.complete !== true) fail(`${label} receipt is incomplete`);
    if (!HEX40.test(String(receipt.versionSha || ''))) fail(`${label} versionSha is malformed`);
    if (!validDate(receipt.updatedAt) || !validDate(receipt.ingestedAt)) fail(`${label} timestamps are malformed`);
    if (!Array.isArray(receipt.files) || receipt.files.length === 0) fail(`${label} has no complete file inventory`);
    const filenames = new Set();
    for (const file of receipt.files) {
      validateFilename(file?.filename, label);
      if (filenames.has(file.filename)) fail(`${label} has duplicate filename ${file.filename}`);
      filenames.add(file.filename);
      if (file.included === true) {
        if (!HEX64.test(String(file.sha256 || '')) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
          fail(`${label}/${file.filename} has malformed included-file identity`);
        }
      } else if (file.included !== false || typeof file.reason !== 'string' || !file.reason
        || !(file.size === null || (Number.isSafeInteger(file.size) && file.size >= 0))) {
        fail(`${label}/${file.filename} has malformed exclusion evidence`);
      }
    }
    const expectedDigest = sha256(JSON.stringify(receipt.files));
    if (!HEX64.test(String(receipt.contentDigest || '')) || receipt.contentDigest !== expectedDigest) {
      fail(`${label} contentDigest does not match its file inventory`);
    }
  }
  return source;
}

async function mapBounded(items, concurrency, operation) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await operation(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// Deterministically REPLAY passages from a durable, exact-version source receipt. Intentionally does
// not call the GitHub detail API, build vectors, or publish artifacts — every included file's raw
// bytes are fetched once (unauthenticated, versioned raw URL) and verified byte-for-byte and
// sha256-for-sha256 against the receipt already on disk; rendering itself is renderGistPassages, the
// same implementation buildGistAggregate uses.
export async function reconstructGists(source, { fetchFn = globalThis.fetch, concurrency = 6 } = {}) {
  validateSourceReceipts(source);
  if (typeof fetchFn !== 'function') fail('fetch implementation is unavailable');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    fail('concurrency must be an integer from 1 through 32');
  }

  const jobs = [];
  for (const [gistId, receipt] of Object.entries(source.gists)) {
    for (const file of receipt.files) {
      if (file.included) jobs.push({ gistId, receipt, file });
    }
  }
  const bodies = await mapBounded(jobs, concurrency, async ({ gistId, receipt, file }) => {
    const url = rawUrlFor({ owner: source.owner, gistId, versionSha: receipt.versionSha, filename: file.filename });
    const response = await fetchFn(url, {
      headers: { accept: 'text/plain', 'user-agent': 'ruvnet-brain-gist-receipt-rebuild' },
    });
    if (!response?.ok) fail(`${gistId}/${file.filename} raw fetch failed: HTTP ${response?.status ?? 'unknown'}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== file.bytes) fail(`${gistId}/${file.filename} byte count ${bytes.length} differs from receipt ${file.bytes}`);
    const digest = sha256(bytes);
    if (digest !== file.sha256) fail(`${gistId}/${file.filename} sha256 ${digest} differs from receipt ${file.sha256}`);
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      fail(`${gistId}/${file.filename} is not valid UTF-8 text`);
      return undefined; // unreachable; keeps linters happy about a missing return on every path
    }
  });

  let bodyIndex = 0;
  const capturedGists = {};
  for (const [gistId, receipt] of Object.entries(source.gists)) {
    capturedGists[gistId] = {
      gistId,
      versionSha: receipt.versionSha,
      updatedAt: receipt.updatedAt,
      files: receipt.files.map((file) => (file.included ? { ...file, body: bodies[bodyIndex++] } : file)),
    };
  }
  const { passageBytes, metadata } = renderGistPassages({
    captured: { owner: source.owner, gists: capturedGists }, generatedAt: source.generated,
  });
  const passageBody = passageBytes.toString('utf8');
  const passagesSha256 = sha256(passageBody);
  const trimmed = passageBody.trim();
  const passages = trimmed.length ? trimmed.split('\n').map((line) => JSON.parse(line)) : [];
  return {
    passages,
    passageBody,
    meta: metadata,
    sources: source.schemaVersion === 3
      ? sealGistReceiptSet({ ...source, passagesSha256 })
      : { ...source, schemaVersion: 2, passagesSha256, gists: source.gists },
  };
}

export function writeReconstruction(result, { outDir }) {
  const output = path.resolve(outDir || '');
  if (!result?.passageBody || !result.meta || !result.sources) fail('complete reconstruction result is required');
  fs.mkdirSync(output, { recursive: true });
  const files = {
    passagesFile: path.join(output, `${NAME}.passages.jsonl`),
    metaFile: path.join(output, `${NAME}.meta.json`),
    sourcesFile: path.join(output, `${NAME}.sources.json`),
  };
  const contents = new Map([
    [files.passagesFile, result.passageBody],
    [files.metaFile, `${JSON.stringify(result.meta, null, 2)}\n`],
    [files.sourcesFile, `${JSON.stringify(result.sources, null, 2)}\n`],
  ]);
  const staged = [];
  try {
    for (const [file, content] of contents) {
      const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      fs.writeFileSync(temporary, content, { flag: 'wx' });
      staged.push([temporary, file]);
    }
    for (const [temporary, file] of staged) fs.renameSync(temporary, file);
  } finally {
    for (const [temporary] of staged) fs.rmSync(temporary, { force: true });
  }
  return files;
}

function option(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback;
}

/**
 * The receipt belongs beside the installed brain, because a published npm package intentionally
 * does not contain the 300KB generated receipt. Prefer a source-checkout copy when one exists, then
 * honor the canonical brain-root overrides, then use the standard installed cache. Returning the
 * checkout candidate on a total miss preserves one precise error path instead of guessing.
 */
export function resolveSourcesFile({
  repoRoot = ROOT,
  env = process.env,
  home = os.homedir(),
  exists = fs.existsSync,
} = {}) {
  const local = path.join(repoRoot, 'kb', `${NAME}.sources.json`);
  const candidates = [
    local,
    env.RUVNET_BRAIN_KB && path.join(env.RUVNET_BRAIN_KB, `${NAME}.sources.json`),
    env.RUVNET_BRAIN_HOME && path.join(env.RUVNET_BRAIN_HOME, 'kb', `${NAME}.sources.json`),
    path.join(home, '.cache', 'ruvnet-brain', 'kb', `${NAME}.sources.json`),
  ].filter(Boolean).map((candidate) => path.resolve(candidate));
  return candidates.find((candidate) => exists(candidate)) || local;
}

export async function main(argv = process.argv.slice(2), {
  fetchFn = globalThis.fetch,
  repoRoot = ROOT,
  env = process.env,
  home = os.homedir(),
} = {}) {
  const allowed = new Set(['--sources', '--out-dir', '--concurrency']);
  for (let index = 0; index < argv.length; index += 2) {
    if (!allowed.has(argv[index]) || !argv[index + 1] || argv[index + 1].startsWith('--')) fail(`unknown or incomplete option ${argv[index] || '(missing)'}`);
  }
  const sourcesFile = path.resolve(option(argv, '--sources', resolveSourcesFile({ repoRoot, env, home })));
  const outDir = path.resolve(option(argv, '--out-dir', path.dirname(sourcesFile)));
  const concurrency = Number(option(argv, '--concurrency', '6'));
  let source;
  try {
    source = JSON.parse(fs.readFileSync(sourcesFile, 'utf8'));
  } catch (error) {
    fail(`cannot read source receipts ${sourcesFile}: ${error.message}`);
  }
  const result = await reconstructGists(source, { concurrency, fetchFn });
  const written = writeReconstruction(result, { outDir });
  process.stdout.write(`${JSON.stringify({ ok: true, passages: result.passages.length, passagesSha256: result.sources.passagesSha256, ...written }, null, 2)}\n`);
  return 0;
}

if (((() => { try { return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })())) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
