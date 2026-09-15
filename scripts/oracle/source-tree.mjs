#!/usr/bin/env node
/**
 * scripts/oracle/source-tree.mjs — the PINNED GIT TREE a C3 unit inventory is enumerated from.
 *
 * ADR-086 C3, per the EXTEND_FIRST Dual verdict (2026-09-14): "Enumerate the pinned Git tree and read its
 * bound objects. A commit label on a filesystem walk is insufficient." A filesystem walk sees whatever
 * happens to be checked out — ignored files, build output, a dirty worktree, LFS-smudged content — and
 * cannot prove it describes the commit it is labelled with. This module reads the tree object itself.
 *
 * Every tracked entry gets exactly one PRIMARY entry kind, so nothing is silently skipped:
 *   file | executable | symlink | gitlink (submodule pointer, content NOT imported) | lfs-pointer | binary
 * Emptiness can never be inferred from what this module could not read: symlinks, gitlinks, LFS pointers
 * and binaries are recorded explicitly, never dropped.
 *
 * Deterministic and model-free. The manifest carries its own sha256 over a canonical encoding, so two
 * enumerations of the same commit are byte-identical across process boundaries.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SOURCE_TREE_VERSION = 'oracle-source-tree/1';
export const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';
// git's own binary heuristic looks for a NUL in the first 8000 bytes; use the same boundary.
export const BINARY_SNIFF_BYTES = 8000;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function git(repoDir, args, { input, maxBuffer = 1024 * 1024 * 1024 } = {}) {
  const r = spawnSync('git', ['-C', repoDir, ...args], { input, maxBuffer });
  if (r.error) throw new Error(`git ${args[0]} failed to start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${String(r.stderr).trim().slice(0, 300)}`);
  return r.stdout;
}

/** Resolve a commit-ish to its exact commit and root tree. Refuses anything that is not a commit. */
export function resolveCommit({ repoDir, commit }) {
  const commitSha = String(git(repoDir, ['rev-parse', '--verify', `${commit}^{commit}`])).trim();
  const treeSha = String(git(repoDir, ['rev-parse', '--verify', `${commitSha}^{tree}`])).trim();
  return { commitSha, treeSha };
}

/**
 * Every entry in the commit's tree, recursively, from the tree OBJECT. Output format of
 * `git ls-tree -r -l -z --full-tree`: "<mode> SP <type> SP <object> SP+ <size>\t<path>\0".
 */
export function listTree({ repoDir, commit }) {
  const raw = git(repoDir, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit]);
  const entries = [];
  for (const record of raw.toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) throw new Error(`unparseable ls-tree record: ${record.slice(0, 120)}`);
    const [mode, type, objectSha, sizeField] = record.slice(0, tab).trim().split(/\s+/);
    entries.push({
      path: record.slice(tab + 1),
      mode,
      type,
      objectSha,
      size: sizeField === '-' ? null : Number(sizeField),
    });
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Read many blob objects in one `git cat-file --batch` round trip. */
export function readBlobs({ repoDir, shas }) {
  const unique = [...new Set(shas)];
  const out = new Map();
  if (!unique.length) return out;
  const buf = git(repoDir, ['cat-file', '--batch'], { input: `${unique.join('\n')}\n` });
  let offset = 0;
  while (offset < buf.length) {
    const newline = buf.indexOf(0x0a, offset);
    const header = buf.subarray(offset, newline).toString('utf8');
    const [sha, kind, sizeText] = header.split(' ');
    if (kind === 'missing') throw new Error(`blob ${sha} is missing from the object store`);
    const size = Number(sizeText);
    const start = newline + 1;
    out.set(sha, buf.subarray(start, start + size));
    offset = start + size + 1; // content is followed by a single LF
  }
  return out;
}

/** The single primary kind of a tree entry. Content is consulted only for regular blobs. */
export function classifyEntry(entry, bytes) {
  if (entry.type === 'commit' || entry.mode === '160000') return 'gitlink';
  if (entry.mode === '120000') return 'symlink';
  if (!bytes) throw new Error(`classifyEntry(${entry.path}) needs the blob bytes`);
  if (bytes.subarray(0, LFS_POINTER_PREFIX.length).toString('utf8') === LFS_POINTER_PREFIX) return 'lfs-pointer';
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return 'binary';
  return entry.mode === '100755' ? 'executable' : 'file';
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * The snapshot manifest: one row per tracked entry, each with its exact object identity, content digest
 * (regular blobs only) and primary kind. Returns `{ manifest, blobs }` so an enumerator can reuse the
 * bytes it already read instead of touching the filesystem.
 */
export function snapshotManifest({ repoDir, commit, repo }) {
  const { commitSha, treeSha } = resolveCommit({ repoDir, commit });
  const entries = listTree({ repoDir, commit: commitSha });
  const blobShas = entries.filter((e) => e.type === 'blob' && e.mode !== '120000').map((e) => e.objectSha);
  const blobs = readBlobs({ repoDir, shas: blobShas });
  const rows = entries.map((e) => {
    const bytes = e.type === 'blob' && e.mode !== '120000' ? blobs.get(e.objectSha) : null;
    const entryKind = classifyEntry(e, bytes);
    return {
      path: e.path,
      mode: e.mode,
      objectSha: e.objectSha,
      size: e.size,
      entryKind,
      contentSha256: bytes ? sha256(bytes) : null,
    };
  });
  const body = { version: SOURCE_TREE_VERSION, repo, commitSha, treeSha, entries: rows };
  return { manifest: { ...body, manifestSha256: sha256(Buffer.from(canonical(body), 'utf8')) }, blobs };
}

function arg(argv, flag) { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; }

export function main(argv = process.argv.slice(2)) {
  const repoDir = arg(argv, '--repo-dir');
  const commit = arg(argv, '--commit');
  const repo = arg(argv, '--repo');
  const out = arg(argv, '--out');
  if (!repoDir || !commit || !repo) {
    process.stderr.write('Usage: source-tree.mjs --repo-dir <git dir> --commit <sha> --repo <name> [--out <manifest.json>]\n');
    return 64;
  }
  const { manifest } = snapshotManifest({ repoDir: path.resolve(repoDir), commit, repo });
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  if (out) fs.writeFileSync(out, json); else process.stdout.write(json);
  const kinds = manifest.entries.reduce((acc, e) => ({ ...acc, [e.entryKind]: (acc[e.entryKind] || 0) + 1 }), {});
  process.stderr.write(`[source-tree] ${repo}@${manifest.commitSha.slice(0, 12)} tree ${manifest.treeSha.slice(0, 12)}: ${manifest.entries.length} entries ${JSON.stringify(kinds)}\n`);
  return 0;
}

// Entry-point guard. Compares REALPATHS on both sides: path.resolve() normalizes a path but does
// NOT follow symlinks, while import.meta.url IS symlink-resolved by Node. Through a symlink (npm bin
// shims, wrapper scripts, and every os.tmpdir() path on macOS) the two sides disagree, so main()
// never runs -- and because nothing throws, the process exits 0. Pinned by
// tests/unit/entrypoint-symlink.test.mjs.
function isDirectInvocation() {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) process.exitCode = main();
