// fork-source.mjs — deterministic, delta-only source materialization for admitted forks.
// A fork is never fed through buildCorpus(): that would attribute upstream files to the fork.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chunkText, FORGE_CHUNKER_VERSION } from './forge-corpus.mjs';
import { stableChunkId } from './incremental-refresh.mjs';
import { isIngestibleDisposition, validateForkDeltaIdentity as validatePolicyIdentity } from '../plugin/scripts/coverage-integrity.mjs';

export { isIngestibleDisposition, validatePolicyIdentity as validateForkDeltaIdentity };
export const FORK_DELTA_VERSION = 'fork-delta/1';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const git = (repo, args, encoding = 'utf8') => execFileSync('git', ['-C', repo, ...args], {
  encoding, maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_EXTERNAL_DIFF: 'false', GIT_ATTR_NOSYSTEM: '1' },
});
const validSha = (v) => /^[0-9a-f]{40}$/i.test(String(v || ''));

function identity(meta) {
  const id = meta?.forkDelta || meta;
  validatePolicyIdentity(id);
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
  const base = String(git(repo, ['merge-base', id.upstreamHeadSha, id.forkHeadSha])).trim().toLowerCase();
  if (base !== id.mergeBaseSha) throw new Error('computed merge base does not match pinned mergeBaseSha');
  return id;
}

function parseRawNameStatus(buffer) {
  const fields = buffer.toString('utf8').split('\0');
  if (fields.at(-1) === '') fields.pop();
  const out = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (!/^[ACDMRTUXB][0-9]*$/.test(status)) throw new Error(`unsupported git delta status ${status}`);
    const kind = status[0];
    const paths = kind === 'R' || kind === 'C' ? [fields[i++], fields[i++]] : [fields[i++]];
    if (paths.some((p) => typeof p !== 'string')) throw new Error('truncated git delta path record');
    out.push({ status, kind, paths });
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
  try { diff = git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--unified=3', id.mergeBaseSha, id.forkHeadSha, ...pathArgs]); }
  catch { diff = ''; }
  const label = op.kind === 'R' ? `rename ${op.paths[0]} → ${op.paths[1]}`
    : op.kind === 'C' ? `copy ${op.paths[0]} → ${op.paths[1]}` : `${op.status} ${op.paths[0]}`;
  return `Fork delta ${id.forkRepository} relative to upstream ${id.upstream} at ${id.mergeBaseSha}\nOperation: ${label}\nPinned fork head: ${id.forkHeadSha}\n\n${diff || '(no textual payload; see typed operation above)'}`;
}

/** Materialize only changed operations into a temporary corpus-shaped directory. */
export function buildForkDeltaCorpus({ repo, name, metadata, outputDir } = {}) {
  const id = validateForkDeltaRepository(metadata, { repo });
  const raw = git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--find-renames', '--find-copies', id.mergeBaseSha, id.forkHeadSha], 'buffer');
  const operations = parseRawNameStatus(raw);
  const inventory = JSON.stringify({ version: FORK_DELTA_VERSION, identity: id, operations }, null, 2) + '\n';
  const inventorySha256 = sha256(inventory);
  const dir = outputDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-fork-delta-'));
  fs.mkdirSync(dir, { recursive: true });
  const docs = [];
  for (const op of operations) {
    const sourcePath = op.paths.at(-1).split('\\').join('/');
    const text = operationText(repo, id, op);
    for (const [index, content] of chunkText(text).entries()) docs.push({
      id: stableChunkId({ repo: name, sourcePath: `fork-delta/${sourcePath}`, chunkerVersion: FORGE_CHUNKER_VERSION, ordinal: index, content }),
      path: `fork-delta/${sourcePath}`, kind: 'fork-delta', title: `Fork delta ${sourcePath}`,
      chunk: index + 1, of: chunkText(text).length, text, embedText: content, preview: content.slice(0, 200),
    });
  }
  fs.writeFileSync(path.join(dir, 'fork-delta.inventory.json'), inventory);
  const passages = docs.map((d) => JSON.stringify({ id: d.id, text: d.text, path: d.path, title: d.title })).join('\n') + (docs.length ? '\n' : '');
  fs.writeFileSync(path.join(dir, 'fork-delta.passages.jsonl'), passages);
  return { ...id, sourceMode: 'fork-delta', operations, chunks: docs, inventorySha256, passagesSha256: sha256(passages), outputDir: dir };
}
