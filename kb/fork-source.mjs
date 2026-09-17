// fork-source.mjs — deterministic, delta-only source materialization for admitted forks.
// A fork is never fed through buildCorpus(): that would attribute upstream files to the fork.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { chunkText, FORGE_CHUNKER_VERSION } from './forge-corpus.mjs';
import { stableChunkId } from './incremental-refresh.mjs';
export const FORK_DELTA_VERSION = 'fork-delta/1';
let validatorPromise;
async function validator() {
  if (!validatorPromise) {
    const local = path.join(path.dirname(fileURLToPath(import.meta.url)), 'coverage-integrity.mjs');
    const installed = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'scripts', 'coverage-integrity.mjs');
    validatorPromise = import(pathToFileURL(fs.existsSync(local) ? local : installed).href);
  }
  return validatorPromise;
}
const TRUSTED_VALIDATOR = await validator();
export function validateForkDeltaIdentity(value) {
  if (typeof TRUSTED_VALIDATOR.validateForkDeltaIdentity !== 'function') {
    throw new Error('trusted coverage validator does not expose validateForkDeltaIdentity');
  }
  return TRUSTED_VALIDATOR.validateForkDeltaIdentity(value);
}
export function isIngestibleDisposition(value) {
  if (typeof TRUSTED_VALIDATOR.isIngestibleDisposition !== 'function') {
    throw new Error('trusted coverage validator does not expose isIngestibleDisposition');
  }
  return TRUSTED_VALIDATOR.isIngestibleDisposition(value);
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const git = (repo, args, encoding = 'utf8') => execFileSync('git', ['-C', repo, ...args], {
  encoding, maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_EXTERNAL_DIFF: 'false', GIT_ATTR_NOSYSTEM: '1' },
});
const validSha = (v) => /^[0-9a-f]{40}$/i.test(String(v || ''));
const utf8 = new TextDecoder('utf-8', { fatal: true });

function identity(meta) {
  const id = meta?.forkDelta || meta;
  validateForkDeltaIdentity(id);
  for (const key of ['forkRepository', 'upstream', 'upstreamHeadSha', 'forkHeadSha', 'mergeBaseSha']) {
    if (typeof id[key] !== 'string' || !id[key].trim()) throw new Error(`fork delta missing ${key}`);
  }
  for (const key of ['upstreamHeadSha', 'forkHeadSha', 'mergeBaseSha']) {
    if (!validSha(id[key])) throw new Error(`fork delta ${key} is not an immutable commit SHA`);
  }
  for (const key of ['aheadBy', 'behindBy']) {
    if (!Number.isInteger(id[key]) || id[key] < 0) throw new Error(`fork delta ${key} must be a nonnegative integer`);
  }
  return {
    version: FORK_DELTA_VERSION,
    forkRepository: id.forkRepository,
    upstream: id.upstream,
    upstreamDefaultBranch: id.upstreamDefaultBranch || null,
    upstreamHeadSha: id.upstreamHeadSha.toLowerCase(),
    forkHeadSha: id.forkHeadSha.toLowerCase(),
    mergeBaseSha: id.mergeBaseSha.toLowerCase(),
    aheadBy: id.aheadBy,
    behindBy: id.behindBy,
    status: id.status || null,
  };
}

export function validateForkDeltaRepository(meta, { repo } = {}) {
  const id = identity(meta);
  if (!repo) return id;
  const remote = String(git(repo, ['config', '--get', 'remote.origin.url'])).trim();
  const canonical = (v) => String(v).replace(/^git@github\.com:/i, '').replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
  if (canonical(remote) !== canonical(id.forkRepository)) throw new Error(`fork remote ${remote} does not match ${id.forkRepository}`);
  const head = String(git(repo, ['rev-parse', `${id.forkHeadSha}^{commit}`])).trim().toLowerCase();
  if (head !== id.forkHeadSha) throw new Error('fork head object does not match pinned forkHeadSha');
  const upstream = String(git(repo, ['rev-parse', `${id.upstreamHeadSha}^{commit}`])).trim().toLowerCase();
  if (upstream !== id.upstreamHeadSha) throw new Error('upstream head object does not match pinned upstreamHeadSha');
  const bases = String(git(repo, ['merge-base', '--all', id.upstreamHeadSha, id.forkHeadSha])).trim().split(/\s+/).filter(Boolean).map((v) => v.toLowerCase());
  if (bases.length !== 1) throw new Error(`fork delta merge base is ambiguous (${bases.length} candidates)`);
  const base = bases[0];
  if (base !== id.mergeBaseSha) throw new Error('computed merge base does not match pinned mergeBaseSha');
  const ahead = Number(git(repo, ['rev-list', '--count', `${id.mergeBaseSha}..${id.forkHeadSha}`]));
  const behind = Number(git(repo, ['rev-list', '--count', `${id.mergeBaseSha}..${id.upstreamHeadSha}`]));
  if (ahead !== id.aheadBy || behind !== id.behindBy) throw new Error(`fork delta graph counts ${ahead}/${behind} do not match pinned ${id.aheadBy}/${id.behindBy}`);
  return id;
}

function parseRawRecords(buffer) {
  const fields = [];
  let start = 0;
  for (let end = 0; end < buffer.length; end += 1) {
    if (buffer[end] === 0) { fields.push(buffer.subarray(start, end)); start = end + 1; }
  }
  if (start !== buffer.length) throw new Error('truncated raw Git delta record');
  const out = [];
  for (let i = 0; i < fields.length;) {
    const header = fields[i++].toString('ascii');
    const match = header.match(/^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([ACDMRTUXB])(\d*)$/i);
    if (!match) throw new Error(`unsupported raw Git delta record ${header}`);
    const [, oldMode, newMode, oldObject, newObject, kind, score] = match;
    const status = `${kind}${score}`;
    const rawPaths = kind === 'R' || kind === 'C' ? [fields[i++], fields[i++]] : [fields[i++]];
    if (rawPaths.some((value) => !value)) throw new Error('truncated git delta path record');
    let paths;
    try { paths = rawPaths.map((value) => utf8.decode(value)); }
    catch (error) { throw new Error(`fork delta path is not valid UTF-8: ${error.message}`); }
    out.push({ status, kind, similarity: score ? Number(score) : null, paths,
      oldMode, newMode, oldObject: oldObject.toLowerCase(), newObject: newObject.toLowerCase(),
      typed: oldMode === '160000' || newMode === '160000' ? 'submodule'
        : oldMode === '120000' || newMode === '120000' ? 'symlink' : null });
  }
  return out.sort((a, b) => {
    const left = `${a.kind}\0${a.paths.join('\0')}`;
    const right = `${b.kind}\0${b.paths.join('\0')}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function operationText(repo, id, op) {
  const pathArgs = ['--', ...op.paths];
  let diff = '';
  try { diff = git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--unified=0', id.mergeBaseSha, id.forkHeadSha, ...pathArgs]); }
  catch (error) { throw new Error(`fork delta diff failed for ${op.paths.join(' → ')}: ${error.message}`); }
  if (/^Binary files /m.test(diff)) op.typed ||= 'binary';
  if (!op.typed && op.oldMode !== op.newMode) op.typed = 'mode-change';
  const label = op.kind === 'R' ? `rename ${op.paths[0]} → ${op.paths[1]}`
    : op.kind === 'C' ? `copy ${op.paths[0]} → ${op.paths[1]}` : `${op.status} ${op.paths[0]}`;
  const hunks = [...diff.matchAll(/^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@/gm)]
    .map((m) => ({ oldLine: Number(m[1]), oldCount: Number(m[2] || 1), newLine: Number(m[3]), newCount: Number(m[4] || 1) }));
  const typed = JSON.stringify({ status: op.status, kind: op.kind, paths: op.paths, oldMode: op.oldMode,
    newMode: op.newMode, oldObject: op.oldObject, newObject: op.newObject, typed: op.typed, hunks });
  return `Fork delta ${id.forkRepository} relative to upstream ${id.upstream} at ${id.mergeBaseSha}\nOperation: ${label}\nOperation metadata: ${typed}\nPinned fork head: ${id.forkHeadSha}\n\n${diff || '(no textual payload; see typed operation above)'}`;
}

/** Materialize only changed operations into a temporary corpus-shaped directory. */
export async function buildForkDeltaCorpus({ repo, name, metadata, outputDir } = {}) {
  const id = validateForkDeltaRepository(metadata, { repo });
  const raw = git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--raw', '-z', '--no-abbrev', '--find-renames', '--find-copies', id.mergeBaseSha, id.forkHeadSha], 'buffer');
  const operations = parseRawRecords(raw);
  const inventory = JSON.stringify({ version: FORK_DELTA_VERSION, identity: id, operations }, null, 2) + '\n';
  const inventorySha256 = sha256(inventory);
  const dir = outputDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-fork-delta-'));
  fs.mkdirSync(dir, { recursive: true });
  const docs = [];
  for (const op of operations.length ? operations : [{ kind: 'N', status: 'NETZERO', paths: ['(no changed paths)'] }]) {
    const sourcePath = op.paths.at(-1);
    const text = op.kind === 'N'
      ? `Fork delta ${id.forkRepository} has no net changed paths relative to ${id.mergeBaseSha}; ${id.aheadBy} ahead commit(s) were observed.`
      : operationText(repo, id, op);
    const pieces = chunkText(text);
    for (const [index, content] of pieces.entries()) docs.push({
      id: stableChunkId({ repo: name, sourcePath: `fork-delta/${sourcePath}`, chunkerVersion: FORGE_CHUNKER_VERSION, ordinal: index, content }),
      path: `fork-delta/${sourcePath}`, kind: 'fork-delta', title: `Fork delta ${sourcePath}`,
      chunk: index + 1, of: pieces.length, text: content, embedText: content, preview: content.slice(0, 200),
      operation: { status: op.status, kind: op.kind, paths: op.paths, oldMode: op.oldMode, newMode: op.newMode,
        oldObject: op.oldObject, newObject: op.newObject, similarity: op.similarity, typed: op.typed },
    });
  }
  fs.writeFileSync(path.join(dir, 'fork-delta.inventory.json'), inventory);
  const passages = docs.map((d) => JSON.stringify({
    id: d.id, text: d.text, path: d.path, title: d.title, operation: d.operation,
  })).join('\n') + (docs.length ? '\n' : '');
  fs.writeFileSync(path.join(dir, 'fork-delta.passages.jsonl'), passages);
  return { ...id, sourceMode: 'fork-delta', operations, chunks: docs, inventorySha256, passagesSha256: sha256(passages), outputDir: dir };
}
