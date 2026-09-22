#!/usr/bin/env node
// Public, no-token Git transport for complete gist snapshots. This reads Git objects only: it never
// checks out or executes gist content. API raw_url revisions are verified as real Git blob or
// commit objects; they are never inferred to be REST history.version values.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HEX40 = /^[a-f0-9]{40}$/i;
const OWNER_RE = /^[A-Za-z0-9-]{1,39}$/;
const GIST_RE = /^[a-f0-9]{20,64}$/i;
const MAX_FILES = 10_000;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export function buildSafeGitEnv(source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return {
  ...env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '/usr/bin/false',
  GIT_LFS_SKIP_SMUDGE: '1',
  };
}
const SAFE_GIT_ENV = buildSafeGitEnv();

function assertSafeFilename(filename) {
  if (typeof filename !== 'string' || !filename || filename.includes('\0') || filename.includes('\\')
    || filename.startsWith('/') || filename.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`gist file has an unsafe path: ${String(filename)}`);
  }
}

function runGit(args, { cwd, input, timeoutMs = 120_000, maxBuffer = MAX_TOTAL_BYTES + 1024 * 1024 } = {}) {
  const result = spawnSync('git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, input, env: SAFE_GIT_ENV, encoding: null, timeout: timeoutMs, maxBuffer, windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`gist Git transport failed (${result.error?.message || `exit ${result.status}`}): ${Buffer.from(result.stderr || '').toString('utf8').slice(-1000)}`);
  }
  return Buffer.from(result.stdout || '');
}

function scalarGit(args, options) { return runGit(args, options).toString('ascii').trim(); }

function decodeTree(treeBytes) {
  const entries = [];
  for (const record of treeBytes.toString('utf8').split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    if (tab < 0) throw new Error('gist Git tree contains a malformed entry');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    const filename = record.slice(tab + 1);
    assertSafeFilename(filename);
    if (type !== 'blob' || !['100644', '100755'].includes(mode) || !HEX40.test(oid)) {
      throw new Error(`gist Git tree contains an unsupported object or mode for ${filename}`);
    }
    entries.push({ filename, mode, blobSha: oid.toLowerCase() });
  }
  entries.sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0);
  if (entries.length > MAX_FILES || new Set(entries.map(({ filename }) => filename)).size !== entries.length) {
    throw new Error('gist Git tree has too many or duplicate file paths');
  }
  return entries;
}

function readBlobs(repository, entries) {
  const oids = [...new Set(entries.map(({ blobSha }) => blobSha))];
  const response = runGit(['cat-file', '--batch'], { cwd: repository, input: `${oids.join('\n')}\n` });
  const blobs = new Map();
  let offset = 0;
  for (const oid of oids) {
    const newline = response.indexOf(0x0a, offset);
    if (newline < 0) throw new Error(`gist Git object response for ${oid} is incomplete`);
    const header = response.subarray(offset, newline).toString('ascii').split(' ');
    if (header.length !== 3 || header[0] !== oid || header[1] !== 'blob' || !/^\d+$/.test(header[2])) {
      throw new Error(`gist Git object ${oid} is missing or is not a blob`);
    }
    const size = Number(header[2]);
    if (!Number.isSafeInteger(size) || size < 0 || newline + 1 + size >= response.length
      || response[newline + 1 + size] !== 0x0a) throw new Error(`gist Git blob ${oid} has an invalid framed size`);
    blobs.set(oid, response.subarray(newline + 1, newline + 1 + size));
    offset = newline + 2 + size;
  }
  if (offset !== response.length) throw new Error('gist Git object response has unexpected trailing bytes');
  return blobs;
}

function parseObservedRawUrl(file, owner, gistId, filename) {
  const rawUrl = new URL(file?.raw_url || '');
  if (rawUrl.protocol !== 'https:' || rawUrl.hostname !== 'gist.githubusercontent.com'
    || rawUrl.username || rawUrl.password || rawUrl.port || rawUrl.search || rawUrl.hash) {
    throw new Error(`gist observed raw URL is unsafe for ${filename}`);
  }
  const parts = rawUrl.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts.length < 5 || parts[0] !== owner || parts[1] !== gistId || parts[2] !== 'raw'
    || !HEX40.test(parts[3]) || parts.slice(4).join('/') !== filename) {
    throw new Error(`gist observed raw URL identity does not match ${filename}`);
  }
  return parts[3].toLowerCase();
}

function bindObservedRevision(repository, revisionSha, filename, headBlobSha) {
  const objectType = scalarGit(['cat-file', '-t', revisionSha], { cwd: repository });
  let rawBlobSha;
  if (objectType === 'blob') rawBlobSha = revisionSha;
  else if (objectType === 'commit') {
    const resolvedCommit = scalarGit(['rev-parse', '--verify', `${revisionSha}^{commit}`], { cwd: repository }).toLowerCase();
    if (resolvedCommit !== revisionSha) throw new Error(`gist raw revision ${revisionSha} did not resolve to the pinned commit`);
    rawBlobSha = scalarGit(['rev-parse', '--verify', `${revisionSha}:${filename}`], { cwd: repository }).toLowerCase();
    if (scalarGit(['cat-file', '-t', rawBlobSha], { cwd: repository }) !== 'blob') {
      throw new Error(`gist raw commit ${revisionSha} does not contain ${filename} as a blob`);
    }
  } else {
    throw new Error(`gist raw revision ${revisionSha} is neither an actual Git blob nor commit`);
  }
  if (rawBlobSha !== headBlobSha) throw new Error(`gist raw revision for ${filename} does not resolve to the verified Git HEAD blob`);
  return { kind: objectType, blobSha: rawBlobSha };
}

/** Read and bind an already-cloned bare gist repository to one REST list observation. */
export function inspectGistGitSnapshot({ owner, stub, repository }) {
  if (!OWNER_RE.test(String(owner || '')) || !GIST_RE.test(String(stub?.id || '')) || !repository) {
    throw new Error('gist Git snapshot identity is invalid');
  }
  const gistId = String(stub.id).toLowerCase();
  const headSha = scalarGit(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: repository }).toLowerCase();
  if (!HEX40.test(headSha)) throw new Error(`gist ${gistId} did not resolve to a verified Git commit`);
  const treeSha = scalarGit(['rev-parse', '--verify', `${headSha}^{tree}`], { cwd: repository }).toLowerCase();
  if (!HEX40.test(treeSha)) throw new Error(`gist ${gistId} did not resolve to a verified Git tree`);
  if (scalarGit(['cat-file', '-t', headSha], { cwd: repository }) !== 'commit'
    || scalarGit(['cat-file', '-t', treeSha], { cwd: repository }) !== 'tree') {
    throw new Error(`gist ${gistId} Git HEAD/tree objects are unavailable`);
  }
  const entries = decodeTree(runGit(['ls-tree', '-r', '-z', '--full-tree', headSha], { cwd: repository }));
  const blobs = readBlobs(repository, entries);
  const entryByName = new Map(entries.map((entry) => [entry.filename, entry]));
  const observedFiles = stub.files && typeof stub.files === 'object' ? stub.files : {};
  const observedNames = Object.keys(observedFiles).sort();
  const truncated = stub.truncated === true;
  if (stub.truncated !== false && stub.truncated !== true) throw new Error(`gist ${gistId} has unknown top-level file inventory completeness`);
  if (truncated) throw new Error(`gist ${gistId} API file inventory is truncated; Git-tree enrichment is not yet bound into the source observation`);
  if (observedNames.length > 300 && !truncated) throw new Error(`gist ${gistId} reports more than 300 files without the truncation flag`);
  if (!truncated && (observedNames.length !== entries.length || observedNames.some((name, i) => name !== entries[i]?.filename))) {
    throw new Error(`gist ${gistId} complete API file inventory differs from the verified Git tree`);
  }

  let totalBytes = 0;
  const files = entries.map((entry) => {
    const body = blobs.get(entry.blobSha);
    const size = body?.length;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`gist ${gistId}/${entry.filename} has an invalid Git blob size`);
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`gist ${gistId} Git tree exceeds the ${MAX_TOTAL_BYTES}-byte capture limit`);
    const observed = Object.hasOwn(observedFiles, entry.filename);
    const apiFile = observedFiles[entry.filename];
    let rawBlobSha = null;
    let rawRevisionSha = null;
    let rawRevisionKind = null;
    if (observed) {
      if (apiFile?.filename !== entry.filename || !Number.isSafeInteger(apiFile.size) || apiFile.size !== size) {
        throw new Error(`gist ${gistId}/${entry.filename} size or filename differs between API observation and Git HEAD`);
      }
      rawRevisionSha = parseObservedRawUrl(apiFile, owner, gistId, entry.filename);
      const rawBinding = bindObservedRevision(repository, rawRevisionSha, entry.filename, entry.blobSha);
      rawBlobSha = rawBinding.blobSha;
      rawRevisionKind = rawBinding.kind;
    } else if (!truncated) {
      throw new Error(`gist ${gistId}/${entry.filename} is absent from a supposedly complete API inventory`);
    }
    return {
      ...entry,
      size,
      body,
      observed,
      observedRawBlobSha: rawBlobSha,
      observedRawRevisionSha: rawRevisionSha,
      observedRawRevisionKind: rawRevisionKind,
      sourceGit: { headSha, treeSha, treeFileCount: entries.length, observedFileCount: observedNames.length,
        observedTruncated: truncated, blobSha: entry.blobSha, observed, observedRawBlobSha: rawBlobSha,
        observedRawRevisionSha: rawRevisionSha, observedRawRevisionKind: rawRevisionKind },
    };
  });
  return {
    gistId,
    headSha,
    treeSha,
    treeFileCount: entries.length,
    totalBytes,
    observedFileCount: observedNames.length,
    observedTruncated: truncated,
    files,
  };
}

/** Clone the public gist without credentials or checkout and inspect its immutable Git snapshot. */
export async function fetchGistGitSnapshot({ owner, stub, signal, tempRoot = os.tmpdir() } = {}) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('gist capture aborted');
  if (!OWNER_RE.test(String(owner || '')) || !GIST_RE.test(String(stub?.id || ''))) throw new Error('gist Git clone identity is invalid');
  const gistId = String(stub.id).toLowerCase();
  const remoteUrl = `https://gist.github.com/${gistId}.git`;
  const stage = fs.mkdtempSync(path.join(tempRoot, 'ruvnet-gist-git-'));
  const repository = path.join(stage, 'repo.git');
  try {
    // A public remote HEAD before and after clone detects movement while the tree is being captured.
    const before = scalarGit(['ls-remote', remoteUrl, 'HEAD'], { cwd: stage }).split(/\s+/)[0]?.toLowerCase();
    if (!HEX40.test(before || '')) throw new Error(`gist ${gistId} has no public Git HEAD`);
    runGit(['clone', '--bare', '--no-tags', '--no-recurse-submodules', remoteUrl, repository], { cwd: stage });
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('gist capture aborted');
    const snapshot = inspectGistGitSnapshot({ owner, stub, repository });
    const after = scalarGit(['ls-remote', remoteUrl, 'HEAD'], { cwd: stage }).split(/\s+/)[0]?.toLowerCase();
    if (before !== after || snapshot.headSha !== before) throw new Error(`gist ${gistId} moved while Git snapshot was captured`);
    return snapshot;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
