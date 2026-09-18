// Public Git transport for a frozen gist observation. This verifies the complete Git tree;
// copying the list's metadata into the returned snapshot is not the content proof.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const HEX40 = /^[a-f0-9]{40}$/;
const MAX_BYTES = 64 * 1024 * 1024;
const TRANSIENT = /ETIMEDOUT|timed out|timeout|TLS|SSL|connection reset|could not resolve host|HTTP (?:5\d\d|429)|requested URL returned error: (?:5\d\d|429)|RPC failed|early EOF/i;
const text = (bytes) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

function moved(id, check, filename, expected, actual) {
  const error = new Error(`gist ${id} Git inventory differs from the observation: ${check} ${filename || ''}`);
  Object.assign(error, { code: 'GIST_OBSERVATION_MOVED', gistId: id,
    detail: { check, filename, expected, actual } });
  throw error;
}

function expectedInventory(id, stub, owner) {
  if (!/^[a-f0-9]{20,64}$/.test(id) || !/^[A-Za-z0-9-]{1,39}$/.test(owner || '')
    || stub?.id !== id || stub.public === false || (stub.owner && stub.owner.login !== owner)
    || stub.truncated === true || !Number.isFinite(Date.parse(stub.updated_at))) {
    throw new Error('public Git capture requires a complete public gist observation');
  }
  // canonicalGistRows deliberately omits REST owner/public fields. The sealed observation
  // supplies owner; each immutable raw URL and the anonymously fetched Git tree bind it below.
  const files = Object.entries(stub.files || {});
  if (!files.length || Array.isArray(stub.files)) throw new Error('gist observation has no file inventory');
  let total = 0;
  return files.map(([name, file]) => {
    if (!name || /[\\/\0]/.test(name) || ['.', '..'].includes(name) || file?.filename !== name
      || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('gist file identity is malformed');
    const url = new URL(file.raw_url);
    const parts = url.pathname.split('/');
    if (url.protocol !== 'https:' || url.hostname !== 'gist.githubusercontent.com' || url.port
      || url.username || url.password || url.search || url.hash || parts.length !== 6
      || parts[1] !== owner || parts[2] !== id || parts[3] !== 'raw' || !HEX40.test(parts[4])
      || decodeURIComponent(parts[5]) !== name) throw new Error(`gist ${id}/${name} raw identity is malformed`);
    total += file.size;
    if (total > MAX_BYTES) throw new Error(`gist ${id} exceeds the capture byte limit`);
    return { name, oid: parts[4], size: file.size, file };
  });
}

export function gistGitEnvironment() {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'http_proxy', 'https_proxy', 'no_proxy',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' };
}

export function verifyGistGitTree(id, expected, bytes) {
  const rows = text(bytes).split('\0').filter(Boolean).map((row) => {
    const match = /^(100644|100755) blob ([a-f0-9]{40}) +(\d+)\t([^\0]+)$/.exec(row);
    if (!match || /[\\/]/.test(match[4])) moved(id, 'unsupported-tree-entry', null, 'flat regular blob', row);
    return { name: match[4], oid: match[2], size: Number(match[3]) };
  });
  const actual = new Map(rows.map((row) => [row.name, row]));
  if (rows.length !== actual.size || rows.length !== expected.length) {
    moved(id, 'file-set', null, expected.map((f) => f.name).sort(), rows.map((f) => f.name).sort());
  }
  for (const file of expected) {
    const row = actual.get(file.name);
    if (!row) moved(id, 'missing-file', file.name, file.name, null);
    for (const field of ['oid', 'size']) {
      if (row[field] !== file[field]) moved(id, field, file.name, file[field], row[field]);
    }
  }
  return rows;
}

// gitExec is a programmatic fixture seam only. No CLI, environment variable or production
// defaultFetchDetail option can replace it. All production remotes are fixed public HTTPS URLs.
export async function fetchPublicGistGit(id, { stub, owner, includeFile, signal,
  gitExec = execute, timeoutMs = 60_000 } = {}) {
  const expected = expectedInventory(id, stub, owner);
  if (typeof includeFile !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('invalid public Git capture configuration');
  }
  signal?.throwIfAborted();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-gist-capture-'));
  const deadline = Date.now() + timeoutMs;
  const env = gistGitEnvironment();
  const prefix = ['-c', 'credential.helper=', '-c', `core.hooksPath=${os.devNull}`,
    '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'http.followRedirects=false',
    '-c', 'http.lowSpeedLimit=1', '-c', 'http.lowSpeedTime=15', '-C', directory];
  const git = async (...args) => {
    signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`gist ${id} Git capture timed out`);
    const result = await gitExec('git', [...prefix, ...args], { env, encoding: 'buffer',
      maxBuffer: MAX_BYTES, timeout: remaining, killSignal: 'SIGKILL', signal });
    return result.stdout;
  };
  try {
    const template = path.join(directory, 'empty-template');
    fs.mkdirSync(template);
    await git('init', '--quiet', '--bare', `--template=${template}`);
    for (let attempt = 1; ; attempt++) {
      try {
        await git('fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--depth=1',
          `https://gist.github.com/${id}.git`, 'HEAD');
        break;
      } catch (error) {
        if (signal?.aborted || attempt === 3 || Date.now() >= deadline
          || !TRANSIENT.test(`${error.code || ''} ${error.message} ${error.stderr || ''}`)) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(300 * attempt, Math.max(0, deadline - Date.now()))));
      }
    }
    const commit = text(await git('rev-parse', 'FETCH_HEAD^{commit}')).trim();
    if (!HEX40.test(commit)) throw new Error(`gist ${id} resolved an invalid Git commit`);
    const tree = verifyGistGitTree(id, expected, await git('ls-tree', '-r', '-z', '-l', commit));
    const files = {};
    for (const file of expected) {
      let content;
      if (includeFile(file.name)) {
        const body = await git('cat-file', 'blob', file.oid);
        const oid = crypto.createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
        if (body.length !== file.size || oid !== file.oid) moved(id, 'blob-bytes', file.name, file.oid, oid);
        try { content = text(body); }
        catch { throw new Error(`gist ${id}/${file.name} is not valid UTF-8 text`); }
      }
      Object.defineProperty(files, file.name, { value: { ...file.file, truncated: false,
        ...(content !== undefined ? { content } : {}) }, enumerable: true });
    }
    return { id, public: true, owner: { login: owner }, updated_at: stub.updated_at,
      history: [{ version: commit }], files,
      captureEvidence: { kind: 'git-tree-matched-observation', commit, tree,
        metadataAuthority: 'frozen-list-observation' } };
  } finally {
    // execFile bounds and kills the parent. A terminated fetch can leave a short-lived
    // git-remote-https helper; low-speed bounds and removal of its temp repo constrain it.
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
