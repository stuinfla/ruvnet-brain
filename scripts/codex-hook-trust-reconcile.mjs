// Metadata-only repair. releaseIdentity is an independently verified release input owned by the
// installer, NOT a hash/boolean synthesized from the installed file. No artifact discovery/inference.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
import { codexHookIdentities, codexPluginContentHash } from './codex-hook-trust.mjs';

/**
 * sha256 of every regular file under package/plugin/ in a verified npm tarball, read in memory (ustar with pax `path`
 * records; nothing is extracted or written). Strict: a bad header checksum, a non-octal size, a body past the end, or
 * any entry type other than file, directory or pax is refused rather than guessed (review 2026-10-24).
 */
export function publishedPluginFiles(archive) {
  const tar = zlib.gunzipSync(archive);
  const files = new Map();
  const field = (b) => { const i = b.indexOf(0); return (i < 0 ? b : b.subarray(0, i)).toString('utf8'); };
  const octal = (b, what) => { const t = field(b).trim(); if (!/^[0-7]+$/.test(t)) throw new Error(`Published archive has a non-octal ${what}`); return parseInt(t, 8); };
  const paxRecords = (body) => {
    const out = {}; let i = 0;
    while (i < body.length) {
      const space = body.indexOf(0x20, i);
      if (space < 0) throw new Error('Published archive has a malformed pax record');
      const len = Number(body.subarray(i, space).toString('ascii'));
      if (!Number.isSafeInteger(len) || len <= space - i || i + len > body.length || body[i + len - 1] !== 0x0a) throw new Error('Published archive has a malformed pax record');
      const rec = body.subarray(space + 1, i + len - 1).toString('utf8');
      const eq = rec.indexOf('=');
      if (eq < 1) throw new Error('Published archive has a malformed pax record');
      out[rec.slice(0, eq)] = rec.slice(eq + 1);
      i += len;
    }
    return out;
  };
  let pax = null; let off = 0;
  for (; off + 512 <= tar.length;) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const sum = header.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
    if (octal(header.subarray(148, 156), 'checksum') !== sum) throw new Error('Published archive header checksum mismatch');
    const size = octal(header.subarray(124, 136), 'size');
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const prefix = field(header.subarray(345, 500));
    const name = pax?.path ?? (prefix ? `${prefix}/${field(header.subarray(0, 100))}` : field(header.subarray(0, 100)));
    if (off + 512 + size > tar.length) throw new Error('Published archive entry runs past the end');
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { pax = paxRecords(body); continue; }
    if (type === 'g') { pax = null; continue; }
    pax = null;
    if (type === '5') continue;
    if (type !== '0') throw new Error(`Published archive has an unsupported entry type ${JSON.stringify(type)}`);
    if (name.startsWith('package/plugin/')) files.set(name.slice('package/plugin/'.length), digest(body));
  }
  if (!files.size) throw new Error('Published archive carries no plugin files');
  return files;
}

// Codex writes this under the installed plugin itself: one SKILL.md per migrated slash command (openai/codex
// rust-v0.164.0 codex-rs/core-plugins/src/command_migration.rs render_command_skill). It is not release bytes, so it is
// accepted only when every byte is what that template renders from the release's own verified command file.
const CODEX_GENERATED = 'migrated-command-skills';
function commandParts(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!m) return null;
  const d = /^description:\s*"((?:[^"\\]|\\.)*)"\s*$/m.exec(m[1]);
  return d ? { description: JSON.parse(`"${d[1]}"`).trim(), body: m[2] } : null;
}
function expectedGeneratedSkill(skillName, sourceName, commandText) {
  const parts = commandParts(commandText);
  if (!parts || !parts.description) return null;
  const body = parts.body.trim() || 'No command template body was found.';
  return `---\nname: ${JSON.stringify(skillName)}\ndescription: ${JSON.stringify(parts.description)}\n---\n\n# ${skillName}\n\n`
    + `Use this skill when the user asks to run the migrated source command \`${sourceName}\`.\n\n## Command Template\n\n${body}\n`;
}

/**
 * ONE pass over the installed plugin: each file's bytes are checked against the verified release (or, for Codex's own
 * generated skills, against the template rendered from the verified command file) and the SAME bytes feed the content
 * fingerprint returned. Throws on any changed, extra or missing file, link, or generated file that is not exactly
 * Codex's rendering.
 */
export function verifiedPluginContentHash(root, pluginFiles, { platform = process.platform } = {}) {
  const seen = new Set(); const commands = new Map(); const generated = new Map();
  const genPrefix = `.codex-plugin/${CODEX_GENERATED}/`;
  const hash = codexPluginContentHash(root, { platform, onFile: (rel, bytes) => {
    if (rel.startsWith(genPrefix)) { generated.set(rel.slice(genPrefix.length), bytes); return; }
    if (pluginFiles.get(rel) !== digest(bytes)) throw new Error(`Installed plugin file differs from the verified release: ${rel}`);
    seen.add(rel);
    if (/^commands\/[^/]+\.md$/.test(rel)) commands.set(rel.slice('commands/'.length, -3), bytes.toString('utf8'));
  } });
  const missing = [...pluginFiles.keys()].filter((k) => !seen.has(k));
  if (missing.length) throw new Error(`Installed plugin lacks ${missing.length} released file(s), e.g. ${missing[0]}`);
  for (const [rel, bytes] of generated) {
    const m = /^source-command-([a-z0-9-]+)\/SKILL\.md$/.exec(rel);
    const source = m && commands.get(m[1]);
    const expected = source && expectedGeneratedSkill(`source-command-${m[1]}`, m[1], source);
    if (!expected || bytes.toString('utf8') !== expected) throw new Error(`Codex-generated file is not the rendering of a verified release command: ${rel}`);
  }
  return hash;
}
/** Kept for callers that only need the yes/no: the installed plugin is the verified release. */
export function installedPluginMatchesRelease(root, pluginFiles) { verifiedPluginContentHash(root, pluginFiles); return true; }

/** Authenticate exact published package bytes before reading one archive member. No extraction/install. */
export async function obtainVerifiedPublishedHookIdentity({ version, fetch: fetcher = globalThis.fetch,
  timeoutMs = 10000, maxTarballBytes = 32 * 1024 * 1024, tarBinary = '/usr/bin/tar' } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '') || typeof fetcher !== 'function') return blocked('Exact released version and HTTPS fetch required');
  const deadline = Date.now() + timeoutMs;
  const get = async (url, limit) => {
    const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error('Published artifact fetch deadline exceeded');
    const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(remaining) });
    if (!response.ok || !response.body) throw new Error('Published artifact HTTPS fetch failed');
    if (Number(response.headers.get('content-length')) > limit) throw new Error('Published artifact exceeds size bound');
    const reader = response.body.getReader(); const chunks = []; let length = 0;
    try {
      while (true) {
        if (Date.now() >= deadline) throw new Error('Published artifact fetch deadline exceeded');
        const { done, value } = await reader.read(); if (done) break;
        length += value.byteLength; if (length > limit) throw new Error('Published artifact exceeds size bound');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks);
  };
  try {
    const metadataUrl = `https://registry.npmjs.org/ruvnet-brain/${version}`;
    const metadata = JSON.parse((await get(metadataUrl, 2 * 1024 * 1024)).toString('utf8'));
    const tarballUrl = `https://registry.npmjs.org/ruvnet-brain/-/ruvnet-brain-${version}.tgz`;
    if (metadata.name !== 'ruvnet-brain' || metadata.version !== version || metadata.dist?.tarball !== tarballUrl
      || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(metadata.dist?.integrity || '')) throw new Error('Published version/path/integrity mismatch');
    const archive = await get(tarballUrl, maxTarballBytes);
    const integrity = `sha512-${crypto.createHash('sha512').update(archive).digest('base64')}`;
    if (integrity !== metadata.dist.integrity) throw new Error('Published archive integrity mismatch');
    const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error('Published artifact deadline exceeded');
    // stdout-only exact member: no archive paths are ever written to disk or traversed.
    const result = spawnSync(tarBinary, ['-xzOf', '-', 'package/plugin/hooks/codex-hooks.json'],
      { input: archive, timeout: Math.min(remaining, 3000), maxBuffer: 256 * 1024 });
    if (result.error || result.status !== 0 || !result.stdout?.length) throw new Error('Platform tar cannot read exact published hooks entry');
    if (!codexHookIdentities(JSON.parse(result.stdout)).size) throw new Error('Published native hooks are invalid');
    let pluginFiles = null;
    try { pluginFiles = publishedPluginFiles(archive); } catch { pluginFiles = null; /* content trust is then refused, never guessed */ }
    return { state: 'verified', releaseIdentity: { version, integrity, hooksSha256: digest(result.stdout), pluginFiles },
      metadataUrl, tarballUrl, archiveBytes: archive.length };
  } catch (error) { return blocked(error.message); }
}

const activeMetadataChildren = new Map();
async function shutdownMetadataChild(child) {
  const entry = activeMetadataChildren.get(child); if (!entry) return;
  if (entry.closing) return entry.closing;
  entry.closing = (async () => {
    const wait = async () => {
      let timer;
      try { await Promise.race([entry.exited, new Promise((resolve) => { timer = setTimeout(resolve, 350); })]); }
      finally { clearTimeout(timer); }
    };
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM'); await wait();
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await wait(); }
    }
    if (child.pid && child.exitCode === null && child.signalCode === null) throw new Error('Native metadata child exit unverified');
    activeMetadataChildren.delete(child);
  })();
  return entry.closing;
}

const OWNER = 'ruvnet-brain@ruvnet-brain';
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const blocked = (reason) => ({ state: 'blocked', changed: false, reason });
function privateBackup(configPath, bytes, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(backupDir).isSymbolicLink()) throw new Error('Backup directory symlink refused');
  const file = path.join(backupDir, `rnb-hook-trust-${new Date().toISOString().replaceAll(':', '-')}-${crypto.randomUUID()}.toml`);
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const dir = fs.openSync(backupDir, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  return file;
}

export function resolveNativeBinary(binary, { env = process.env, platform = process.platform } = {}) {
  if (typeof binary !== 'string' || !binary) throw new Error('Native executable required');
  const candidates = path.isAbsolute(binary) ? [binary] : /^[A-Za-z0-9._-]+$/.test(binary)
    ? String(env.PATH || '').split(platform === 'win32' ? ';' : path.delimiter).filter(Boolean).flatMap((dir) => {
      const suffixes = platform === 'win32' && !path.extname(binary) ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
      return suffixes.map((suffix) => path.resolve(dir, binary + suffix));
    }) : [];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      if (!fs.statSync(candidate).isFile()) continue;
      const resolved = fs.realpathSync(candidate);
      if (resolved === fs.realpathSync(fileURLToPath(import.meta.url))) throw new Error('Recursive native gateway refused');
      return resolved;
    } catch (error) { if (error.message === 'Recursive native gateway refused') throw error; }
  }
  throw new Error('Native executable unavailable on configured PATH');
}

/** Only initialize/config/read/config/batchWrite/hooks/list are ever sent by this client. */
async function nativeClient(binary, cwd, deadlineAt, configPath) {
  binary = resolveNativeBinary(binary);
  const env = { ...process.env, CODEX_HOME: path.dirname(configPath) };
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'CODEX_API_KEY']) delete env[key];
  const child = spawn(binary, ['app-server', '--listen', 'stdio://'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = new Promise((resolve) => { child.once('exit', resolve); child.once('error', () => { if (!child.pid) resolve(); }); });
  activeMetadataChildren.set(child, { exited });
  let nextId = 1; let buffer = ''; const pending = new Map();
  const rejectAll = (message) => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(message)); } pending.clear(); };
  child.on('error', () => rejectAll('Native metadata process failed'));
  child.stdin.on('error', () => rejectAll('Native metadata input failed'));
  child.on('exit', () => rejectAll('Native metadata process exited'));
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { rejectAll('Native metadata output exceeds bound'); child.kill(); return; }
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let row; try { row = JSON.parse(line); } catch { continue; }
      const item = pending.get(row.id); if (!item) continue;
      pending.delete(row.id); clearTimeout(item.timer);
      // Do not include native error details: they may contain private config values.
      if (row.error) item.reject(new Error(`Native ${item.method} rejected`)); else item.resolve(row.result);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const remaining = deadlineAt - Date.now(); if (remaining <= 0) { reject(new Error('Native metadata deadline exceeded')); return; }
    const id = nextId++; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native ${method} timed out`)); }, remaining);
    pending.set(id, { resolve, reject, timer, method });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => { if (error) rejectAll('Native metadata input failed'); });
  });
  const close = async () => { rejectAll('Native metadata client closed'); child.stdin.destroy(); await shutdownMetadataChild(child); };
  try {
    await rpc('initialize', { clientInfo: { name: 'rnb_verified_hook_trust', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    return { rpc, close };
  } catch (error) { await close(); throw error; }
}
const rowsFor = (response) => {
  if (!Array.isArray(response?.data)) throw new Error('Native hook registry unavailable');
  return response.data.flatMap((r) => r.hooks || []).filter((r) => r.pluginId === OWNER);
};
// Codex <0.164: currentHash is the declaration hash. 0.164+: "<declaration hash>/<plugin content hash>" (discovery.rs).
const splitHash = (current) => { const [declaration, content = null] = String(current || '').split('/'); return { declaration, content }; };
function assertRegistry(rows, identities, contentHash = null) {
  if (rows.length !== identities.size || new Set(rows.map((r) => r.key)).size !== identities.size
    || rows.some((row) => identities.get(row.key) !== splitHash(row.currentHash).declaration)) throw new Error('Native registry differs from verified released artifact');
  if (rows.some((row) => splitHash(row.currentHash).content !== null && splitHash(row.currentHash).content !== contentHash)) {
    throw new Error('Native plugin content fingerprint differs from the verified installed plugin');
  }
}

function otherSettings(config, keys) {
  const clone = structuredClone(config);
  for (const key of keys) {
    const state = clone?.hooks?.state?.[key];
    if (state && typeof state === 'object') {
      delete state.trusted_hash;
      delete state.trusted_content_hash;
      if (!Object.keys(state).length) delete clone.hooks.state[key];
    }
  }
  if (clone?.hooks?.state && !Object.keys(clone.hooks.state).length) delete clone.hooks.state;
  if (clone?.hooks && !Object.keys(clone.hooks).length) delete clone.hooks;
  const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
  return JSON.stringify(canonical(clone));
}

/** Caller must authenticate releaseIdentity against its verified tarball/protected-release receipt.
 * The helper checks installed bytes/version and native identities; it cannot authenticate caller data.
 * rpc injection owns its own client lifetime. Default client never starts a thread, turn or account call.
 */
export async function reconcileVerifiedCodexHookTrust({ releaseIdentity, installedVersion, hooksPath,
  configPath, nativeBinary, cwd = process.cwd(), backupDir = path.join(path.dirname(configPath || ''), 'backups'),
  rpc: suppliedRpc, timeoutMs = 10000 } = {}) {
  let client; let wrote = false; let writeAttempted = false; let backupPath; let contentRefusal = 'Verified release plugin files unavailable';
  try {
    if (!releaseIdentity || !/^\d+\.\d+\.\d+$/.test(releaseIdentity.version || '')
      || installedVersion !== releaseIdentity.version || !/^[a-f0-9]{64}$/.test(releaseIdentity.hooksSha256 || '')
      || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(releaseIdentity.integrity || '')) return blocked('Verified released artifact identity required');
    if (![hooksPath, configPath, backupDir].every((p) => typeof p === 'string' && path.isAbsolute(p))) return blocked('Absolute owned paths required');
    if (fs.lstatSync(hooksPath).isSymbolicLink() || fs.lstatSync(configPath).isSymbolicLink()) return blocked('Source/config symlink refused');
    const bytes = fs.readFileSync(hooksPath);
    if (digest(bytes) !== releaseIdentity.hooksSha256) return blocked('Installed hooks differ from verified release');
    const identities = codexHookIdentities(JSON.parse(bytes));
    if (!identities.size) return blocked('Verified artifact has no native hooks');
    // Codex 0.164+ also pins the installed plugin folder. Approve that fingerprint only for a folder that holds exactly
    // the verified release's plugin/ bytes (Codex's own generated migrations aside); otherwise refuse, never guess.
    const pluginRoot = path.dirname(path.dirname(hooksPath));
    let contentHash = null;
    if (releaseIdentity.pluginFiles instanceof Map) {
      try { contentHash = verifiedPluginContentHash(pluginRoot, releaseIdentity.pluginFiles); }
      catch (error) { contentHash = null; contentRefusal = error.message; }
    }
    if (!suppliedRpc) client = await nativeClient(nativeBinary, cwd, Date.now() + Math.min(timeoutMs, 20000), configPath);
    const rpc = suppliedRpc || client.rpc;
    const before = rowsFor(await rpc('hooks/list', { cwds: [cwd] }));
    if (!contentHash && before.some((row) => splitHash(row.currentHash).content !== null)) return blocked(contentRefusal);
    assertRegistry(before, identities, contentHash);
    const disabled = before.filter((r) => r.enabled === false).map((r) => r.key).sort();
    if (before.some((r) => !['trusted', 'modified', 'untrusted', 'managed'].includes(r.trustStatus))) return blocked('Unknown native trust state');
    const pending = before.filter((r) => r.enabled === true && ['modified', 'untrusted'].includes(r.trustStatus));
    if (!pending.length) return { state: 'unchanged', changed: false, disabledPreserved: disabled };
    const read = await rpc('config/read', { includeLayers: true });
    const users = (read.layers || []).filter((r) => r.name?.type === 'user' && r.name.file === configPath);
    if (users.length !== 1 || typeof users[0].version !== 'string' || !users[0].version) return blocked('Current user config version unavailable');
    // Config stays memory-only except the private backup. No logging of effective config values.
    const prior = fs.readFileSync(configPath);
    backupPath = privateBackup(configPath, prior, backupDir);
    const edits = pending.flatMap((r) => [{ keyPath: `hooks.state.${JSON.stringify(r.key)}.trusted_hash`,
      value: identities.get(r.key), mergeStrategy: 'replace' },
      // The second approval Codex 0.164 stores separately (plugin_trust.rs matches_hash).
      ...(splitHash(r.currentHash).content !== null ? [{ keyPath: `hooks.state.${JSON.stringify(r.key)}.trusted_content_hash`,
        value: contentHash, mergeStrategy: 'replace' }] : [])]);
    writeAttempted = true;
    await rpc('config/batchWrite', { filePath: configPath, expectedVersion: users[0].version, reloadUserConfig: true, edits });
    wrote = true;
    const afterRead = await rpc('config/read', { includeLayers: true });
    const afterUsers = (afterRead.layers || []).filter((r) => r.name?.type === 'user' && r.name.file === configPath);
    if (afterUsers.length !== 1 || otherSettings(users[0].config, pending.map((r) => r.key))
      !== otherSettings(afterUsers[0].config, pending.map((r) => r.key))) throw new Error('Unrelated config changed; no whole-file rollback attempted');
    const after = rowsFor(await rpc('hooks/list', { cwds: [cwd] })); assertRegistry(after, identities, contentHash);
    if (JSON.stringify(after.filter((r) => r.enabled === false).map((r) => r.key).sort()) !== JSON.stringify(disabled)
      || after.some((r) => r.enabled === true && !['trusted', 'managed'].includes(r.trustStatus))) throw new Error('Native trust repair verification incomplete');
    return { state: 'registry-verified', changed: true, editedTrustHashes: edits.length,
      enabledBrainTrusted: after.filter((r) => r.enabled === true).length, disabledPreserved: disabled,
      artifactHooksSha256: releaseIdentity.hooksSha256, backupPath, otherSemanticSettingsUnchanged: true,
      priorConfigSha256: digest(prior), afterConfigSha256: digest(fs.readFileSync(configPath)), inferenceRequests: 0,
      executionAcceptance: 'not-run' };
  } catch (error) {
    // Never restore an entire backup over concurrent writers. A successful write followed by failed
    // verification is degraded, not "unchanged"; the installer must expose this outcome.
    return { state: wrote || writeAttempted ? 'degraded' : 'blocked', changed: wrote ? true : writeAttempted ? 'unknown' : false, reason: error.message, ...(backupPath ? { backupPath } : {}) };
  } finally { await client?.close(); }
}

// Explicit CLI only; importing the helper never starts a process or reads stdin.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  && process.argv[2] === '--reconcile-installed') {
  const started = Date.now(); let emitted = false; let reconcileStarted = false;
  const emit = (receipt) => { if (!emitted) { emitted = true; process.stdout.write(JSON.stringify(receipt) + '\n'); } };
  const guard = setTimeout(async () => {
    await Promise.allSettled([...activeMetadataChildren.keys()].map(shutdownMetadataChild));
    emit({ state: 'degraded', changed: 'unknown', reason: 'CLI deadline exceeded; verify native trust state', inferenceRequests: 0 });
    process.exit(1);
  }, 29000);
  (async () => {
    let input = ''; for await (const chunk of process.stdin) {
      input += chunk; if (Buffer.byteLength(input) > 16384) throw new Error('CLI input exceeds bound');
    }
    const args = JSON.parse(input);
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some((k) => !['installedVersion', 'hooksPath', 'configPath', 'nativeBinary', 'cwd'].includes(k))) throw new Error('Invalid CLI options');
    const proof = await obtainVerifiedPublishedHookIdentity({ version: args.installedVersion, timeoutMs: 10000 });
    if (proof.state !== 'verified') { emit(proof); return; }
    reconcileStarted = true;
    const result = await reconcileVerifiedCodexHookTrust({ ...args, releaseIdentity: proof.releaseIdentity,
      timeoutMs: Math.max(1, Math.min(20000, 28000 - (Date.now() - started))) });
    emit(result);
  })().catch(() => emit(reconcileStarted
    ? { state: 'degraded', changed: 'unknown', reason: 'Native reconciliation or shutdown failed; verify trust state', inferenceRequests: 0 }
    : blocked('CLI request or published artifact proof failed'))).finally(() => clearTimeout(guard));
}
