// Independently published npm bytes bind the execution closure. The caller must authenticate
// workerSha256 from its signed public bundle receipt; a local manifest is never a release anchor.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export const proofDigest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export function proofFile(file, limit = 2 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('Proof input is not a bounded regular file');
  return fs.readFileSync(file);
}
export function publishedTarFiles(archive) {
  const tar = gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 }); const files = new Map();
  let offset = 0; let paxPath;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every((byte) => byte === 0)) break;
    const field = (start, end) => header.subarray(start, end).toString().replace(/\0.*$/s, '');
    const octal = (value) => /^[\s0-7]+\0?$/.test(value) ? parseInt(value.trim(), 8) : NaN;
    const size = octal(field(124, 136)); const checksum = octal(field(148, 156));
    const sum = [...header].reduce((total, byte, i) => total + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > tar.length || sum !== checksum) throw new Error('Published archive header is invalid');
    const body = tar.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
    const type = field(156, 157);
    if (type === 'x') {
      let cursor = 0;
      while (cursor < body.length) {
        const space = body.indexOf(32, cursor); const length = Number(body.subarray(cursor, space).toString());
        if (space < cursor || !Number.isSafeInteger(length) || length < 3 || cursor + length > body.length) throw new Error('Published archive metadata is invalid');
        const entry = body.subarray(space + 1, cursor + length - 1).toString();
        if (entry.startsWith('path=')) paxPath = entry.slice(5);
        cursor += length;
      }
      continue;
    }
    const name = paxPath || [field(345, 500), field(0, 100)].filter(Boolean).join('/'); paxPath = undefined;
    if (type === '5') continue;
    if (type !== '' && type !== '0') throw new Error('Published archive contains a non-regular member');
    if (!name.startsWith('package/') || path.posix.normalize(name) !== name || name.split('/').includes('..') || files.has(name)) throw new Error('Published archive member is unsafe or duplicated');
    files.set(name, body);
  }
  return files;
}

export async function verifyReleasedHostRuntime({ version, packageArchive, packageSha256, workerSha256,
  brainHome, pluginRoot, mcpShell, timeoutMs, fetch: fetcher = globalThis.fetch }) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '') || ![packageSha256, workerSha256].every((hash) => /^[a-f0-9]{64}$/.test(hash || ''))
    || ![packageArchive, brainHome, pluginRoot, mcpShell].every((file) => path.isAbsolute(file || ''))) throw new Error('Authenticated release inputs and absolute runtime paths required');
  const archive = proofFile(packageArchive, 32 * 1024 * 1024);
  if (proofDigest(archive) !== packageSha256) throw new Error('Public package digest mismatch');
  const response = await fetcher(`https://registry.npmjs.org/ruvnet-brain/${version}`, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error('Published package identity unavailable');
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break;
    length += value.byteLength; if (length > 2 * 1024 * 1024) throw new Error('Published metadata exceeds bound'); chunks.push(Buffer.from(value));
  } } finally { await reader.cancel().catch(() => {}); }
  const bytes = Buffer.concat(chunks);
  const metadata = JSON.parse(bytes);
  if (metadata.name !== 'ruvnet-brain' || metadata.version !== version
    || metadata.dist?.tarball !== `https://registry.npmjs.org/ruvnet-brain/-/ruvnet-brain-${version}.tgz`
    || metadata.dist?.integrity !== `sha512-${crypto.createHash('sha512').update(archive).digest('base64')}`) throw new Error('Published package integrity mismatch');
  const published = publishedTarFiles(archive);
  const activeBytes = proofFile(path.join(brainHome, 'active.json')); const active = JSON.parse(activeBytes);
  const codeRoot = fs.realpathSync(path.isAbsolute(active.codeRoot || '') ? active.codeRoot : path.join(brainHome, active.codeRoot || ''));
  if (active.version !== version || !Number.isSafeInteger(active.generation) || active.generation < 1
    || codeRoot !== fs.realpathSync(path.join(brainHome, 'versions', version))
    || fs.existsSync(path.join(brainHome, 'dev.json')) || fs.existsSync(path.join(brainHome, '.kb.refresh-run.lock'))) throw new Error('Active released generation is unstable or unproven');
  const bindings = [];
  const bind = (file, member) => {
    const expected = published.get(member); if (!expected || !proofFile(file).equals(expected)) throw new Error('Loaded host runtime differs from independent published bytes');
    bindings.push({ path: file, sha256: proofDigest(expected) });
  };
  for (const [name] of published) {
    if (/^package\/plugin\/(scripts|mcp)\/.*\.(mjs|sh)$/.test(name)) bind(path.join(codeRoot, name.slice('package/plugin/'.length)), name);
  }
  if (!bindings.some((row) => row.path === path.join(codeRoot, 'scripts/session-start-proof.mjs'))) throw new Error('Released startup diagnostic is unavailable');
  bind(path.join(brainHome, 'codex-hook.mjs'), 'package/plugin/scripts/codex-hook-wrapper.mjs');
  // The managed wrapper selects activeRoot/scripts/codex-hook-adapter.mjs; that adapter's shim
  // is its immutable sibling, already bound above. There is no brainHome/scripts shim tree.
  const optionalHelper = path.join(brainHome, 'development-maintenance.mjs'); const absent = [];
  if (fs.existsSync(optionalHelper)) bind(optionalHelper, 'package/plugin/scripts/development-maintenance.mjs');
  else absent.push(optionalHelper);
  const visited = new Set(); const bindImports = (file, member) => {
    if (visited.has(file)) return; visited.add(file); bind(file, member);
    for (const match of published.get(member).toString().matchAll(/(?:from\s*|import\s*|import\(\s*)['"](\.[^'"]+)['"]/g)) {
      bindImports(path.resolve(path.dirname(file), match[1]), path.posix.normalize(path.posix.join(path.posix.dirname(member), match[1])));
    }
  };
  bindImports(mcpShell, 'package/plugin/mcp/server.mjs');
  for (const member of ['.codex-plugin/plugin.json', 'hooks/codex-hooks.json']) bind(path.join(pluginRoot, member), `package/plugin/${member}`);
  const worker = path.join(brainHome, 'kb/forge-mcp-all.mjs');
  if (proofDigest(proofFile(worker, 32 * 1024 * 1024)) !== workerSha256) throw new Error('KB worker differs from authenticated public bundle');
  bindings.push({ path: worker, sha256: workerSha256 });
  return { version, generation: active.generation, codeRoot, activeSha256: proofDigest(activeBytes),
    packageSha256, integrity: metadata.dist.integrity, worker, mcpShell, bindings, absent };
}

export function assertHostRuntimeUnchanged(runtime, brainHome) {
  if (proofDigest(proofFile(path.join(brainHome, 'active.json'))) !== runtime.activeSha256
    || runtime.bindings.some((row) => proofDigest(proofFile(row.path, 32 * 1024 * 1024)) !== row.sha256)
    || runtime.absent?.some((file) => fs.existsSync(file))) throw new Error('Active generation or loaded source changed during proof');
}
