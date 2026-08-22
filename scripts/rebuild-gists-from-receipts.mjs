#!/usr/bin/env node
// Deterministically reconstruct gist passages from durable, exact-version source receipts.
// This intentionally does not call the GitHub API, build vectors, or publish artifacts.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'ruv-gists';
const HEX_GIST = /^[a-f0-9]{20,64}$/;
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(`[rebuild-gists-from-receipts] ${message}`);
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const jsonLine = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function validateFilename(filename, label) {
  if (typeof filename !== 'string' || !filename || filename.includes('\0')
    || filename.split(/[\\/]/).some((segment) => !segment || segment === '.' || segment === '..')) {
    fail(`${label} has an unsafe or missing filename`);
  }
}

export function validateSourceReceipts(source) {
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

export function rawUrlFor({ owner, gistId, versionSha, filename }) {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(String(owner || '')) || !HEX_GIST.test(String(gistId || ''))
    || !HEX40.test(String(versionSha || ''))) fail('cannot construct raw URL from malformed source identity');
  validateFilename(filename, `gist ${gistId}`);
  const encodedFile = filename.split('/').map(encodeURIComponent).join('/');
  return `https://gist.githubusercontent.com/${owner}/${gistId}/raw/${versionSha}/${encodedFile}`;
}

export function paragraphChunks(text, size = 3200) {
  if (typeof text !== 'string') fail('passage content must be text');
  if (!Number.isSafeInteger(size) || size < 1) fail('chunk size must be a positive integer');
  const out = [];
  let buffer = '';
  for (const paragraph of text.split(/\n\n+/)) {
    if (buffer && buffer.length + paragraph.length + 2 > size) {
      out.push(buffer);
      buffer = '';
    }
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  if (buffer.trim()) out.push(buffer);
  return out;
}

export function provenanceBanner({ owner, gistId, filename, updatedAt }) {
  return `SOURCE: GitHub gist by @${owner} — "${filename.replace(/\s+/g, ' ').trim().slice(0, 160)}"\n`
    + `GIST STATUS: rUv's own notes / release announcement — may describe PROPOSED or UNRELEASED work.\n`
    + `Treat as intent, not as confirmed shipped behavior: verify against repo source before asserting.\n`
    + `updated: ${updatedAt.slice(0, 10)} · https://gist.github.com/${owner}/${gistId}\n\n`;
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
    let body;
    try {
      body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      fail(`${gistId}/${file.filename} is not valid UTF-8 text`);
    }
    return body;
  });

  const passages = [];
  const entries = {};
  let bodyIndex = 0;
  let id = 0;
  for (const [gistId, receipt] of Object.entries(source.gists)) {
    for (const file of receipt.files) {
      if (!file.included) continue;
      const body = bodies[bodyIndex++];
      const chunks = paragraphChunks(body);
      const title = file.filename.replace(/\s+/g, ' ').trim().slice(0, 180) || file.filename;
      const banner = provenanceBanner({ owner: source.owner, gistId, filename: file.filename, updatedAt: receipt.updatedAt });
      for (const [chunkIndex, chunk] of chunks.entries()) {
        const passageId = String(id++);
        const passagePath = `${gistId.slice(0, 8)}/${file.filename}${chunks.length > 1 ? `#${chunkIndex}` : ''}`;
        const text = banner + chunk;
        passages.push({ id: passageId, text, path: passagePath, title });
        entries[passageId] = { path: passagePath, kind: 'doc', title, chunk: chunkIndex, preview: text.slice(0, 200) };
      }
    }
  }
  const passageBody = passages.map(jsonLine).join('\n') + '\n';
  const meta = {
    model: NAME,
    dimensions: 0,
    metric: 'cosine',
    name: NAME,
    generated: source.generated,
    repo: `gists/${source.owner}`,
    note: "rUv's public gists — announcements and thinking, PROPOSED unless confirmed in repo source.",
    entries,
  };
  return {
    passages,
    passageBody,
    meta,
    sources: { ...source, schemaVersion: 2, passagesSha256: sha256(passageBody), gists: source.gists },
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

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
