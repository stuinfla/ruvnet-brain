// Evidence from a fresh native metadata process; Codex may refresh its own marketplace cache.
// No configuration write or hook-body execution is requested by this probe. It does not
// prove MCP readiness or declarations frozen in existing windows.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { codexHookIdentities, codexHookHash } from './codex-hook-trust.mjs';
import { obtainVerifiedPublishedHookIdentity } from './codex-hook-trust-reconcile.mjs';

const OWNER = 'ruvnet-brain@ruvnet-brain';
const FILES = ['.codex-plugin/plugin.json', 'hooks/codex-hooks.json'];
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const failed = (reason) => ({ ok: false, state: 'fresh-declarations-unproven', scope: 'fresh-codex-hook-declarations', reason,
  hookBodiesExecuted: false, mcpReadiness: 'unknown', existingWindows: 'unproven', inferenceRequests: 0, nativeCacheRefresh: 'possible' });

function readSurface(root) {
  const bytes = FILES.map((file) => {
    const target = path.join(root, file); const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Plugin source is unavailable or unsafe');
    return fs.readFileSync(target);
  });
  return { manifest: JSON.parse(bytes[0]), hooks: JSON.parse(bytes[1]), hashes: Object.fromEntries(FILES.map((file, i) => [file, sha256(bytes[i])])) };
}

export function classifyFreshCodexDeclarations({ plugin, listed, target, expectedVersion, codexHome, cwd }) {
  if (!plugin?.installed || plugin.enabled !== true || plugin.version !== expectedVersion) return failed('Current Codex plugin is missing, disabled, or stale');
  if (target?.manifest?.name !== 'ruvnet-brain' || target.manifest.version !== expectedVersion) return failed('Released target version is unavailable');
  let root;
  try {
    root = fs.realpathSync(path.join(codexHome, 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain', expectedVersion));
    if (plugin.installPath && fs.realpathSync(plugin.installPath) !== root) return failed('Native plugin source differs from the managed version');
    const cache = fs.realpathSync(path.join(codexHome, 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain'));
    if (!root.startsWith(`${cache}${path.sep}`)) return failed('Native plugin source is outside the managed cache');
    if (JSON.stringify(readSurface(root).hashes) !== JSON.stringify(target.hashes)) return failed('Installed declarations differ from the independent released target');
  } catch { return failed('Native plugin source cannot be verified'); }
  const groups = listed?.data;
  if (!Array.isArray(groups) || groups.length !== 1 || groups[0]?.cwd !== cwd
    || !Array.isArray(groups[0]?.hooks) || !Array.isArray(groups[0]?.errors) || !Array.isArray(groups[0]?.warnings)) return failed('Native registry shape or project scope is unproven');
  if (groups[0].errors.length || groups[0].warnings.length) return failed('Native registry reports errors or warnings');
  const rows = groups[0].hooks.filter((row) => row?.pluginId === OWNER);
  const identities = codexHookIdentities(target.hooks);
  if (!identities.size || rows.length !== identities.size || new Set(rows.map((row) => row.key)).size !== identities.size) return failed('Brain hook declarations are missing, duplicated, or unexpected');
  for (const row of rows) {
    if (row.source !== 'plugin' || row.sourcePath !== path.join(root, FILES[1]) || row.enabled !== true
      || !['trusted', 'managed'].includes(row.trustStatus)) return failed('Brain hook source, enabled state, or trust is unproven');
    // Verify the metadata itself, as well as the native currentHash. Foreign owner hooks are untouched.
    const event = Object.keys(target.hooks.hooks).find((name) => `${name[0].toLowerCase()}${name.slice(1)}` === row.eventName);
    const metadataHash = codexHookHash(event, { matcher: row.matcher }, {
      type: row.handlerType, command: row.command, timeout: row.timeoutSec, async: row.async,
      statusMessage: row.statusMessage, additionalContextLimit: row.additionalContextLimit,
    });
    if (!identities.has(row.key) || identities.get(row.key) !== row.currentHash || metadataHash !== row.currentHash) return failed('Brain hook metadata differs from released declarations');
  }
  return { ok: true, state: 'fresh-declarations-ready', scope: 'fresh-codex-hook-declarations', expectedVersion,
    pluginRoot: root, sourceHashes: target.hashes, hookCount: rows.length, hookBodiesExecuted: false,
    mcpReadiness: 'unknown', existingWindows: 'unproven', inferenceRequests: 0 };
}

function nativeBinary(binary, env) {
  const names = path.isAbsolute(binary) ? [binary] : String(env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, binary));
  for (const name of names) {
    try {
      const real = fs.realpathSync(name); const stat = fs.statSync(real);
      if (!stat.isFile() || stat.size > 256 * 1024 * 1024) continue;
      fs.accessSync(real, fs.constants.X_OK);
      const bytes = fs.readFileSync(real); const magic = bytes.subarray(0, 4).toString('hex');
      if (!['cffaedfe', 'feedfacf', 'cefaedfe', 'feedface', 'cafebabe', 'bebafeca', '7f454c46'].includes(magic) && bytes.subarray(0, 2).toString() !== 'MZ') continue;
      return { path: real, sha256: sha256(bytes) };
    } catch { /* try the next executable */ }
  }
  throw new Error('Actual native Codex binary is unavailable');
}

/** One deadline and cumulative stdout/stderr budget across every owned native process. No API turns. */
export async function probeFreshCodexDeclarations({ binary = 'codex', codexHome, cwd, releasedPluginRoot,
  expectedVersion, timeoutMs = 12_000, publishedIdentity, verifyPublished = obtainVerifiedPublishedHookIdentity, maxBytes = 2 * 1024 * 1024, env = process.env, spawnChild = spawn } = {}) {
  const children = new Map(); let totalBytes = 0; let deadline; let identity; let target;
  const nativeEnv = { ...env };
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'CODEX_API_KEY']) delete nativeEnv[key];
  const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) throw new Error('Fresh declaration proof deadline exceeded'); return ms; };
  const consume = (chunk) => { totalBytes += chunk.length; if (totalBytes > maxBytes) throw new Error('Fresh declaration proof output exceeds bound'); };
  const own = (args) => {
    remaining();
    const child = spawnChild(identity.path, args, { cwd, env: { ...nativeEnv, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const exited = new Promise((resolve) => { child.once('exit', resolve); child.once('error', () => { if (!child.pid) resolve(); }); });
    children.set(child, exited); child.stdin.on('error', () => {}); return child;
  };
  const command = (args) => new Promise((resolve, reject) => {
    const child = own(args); let stdout = ''; let done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error('Fresh declaration proof deadline exceeded')), remaining());
    child.on('error', () => finish(new Error('Native metadata command failed')));
    child.stdout.on('data', (chunk) => { try { consume(chunk); stdout += chunk; } catch (error) { finish(error); } });
    child.stderr.on('data', (chunk) => { try { consume(chunk); } catch (error) { finish(error); } });
    child.once('exit', (code) => finish(code === 0 ? null : new Error('Native metadata command refused'), stdout)); child.stdin.end();
  });
  try {
    if (![codexHome, cwd, releasedPluginRoot].every((value) => typeof value === 'string' && path.isAbsolute(value))
      || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 12_000
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw new Error('Fresh declaration proof boundaries are invalid');
    deadline = Date.now() + timeoutMs;
    codexHome = fs.realpathSync(codexHome); cwd = fs.realpathSync(cwd); releasedPluginRoot = fs.realpathSync(releasedPluginRoot);
    target = readSurface(releasedPluginRoot); identity = nativeBinary(binary, env); remaining();
    const published = publishedIdentity || await verifyPublished({ version: expectedVersion, timeoutMs: remaining() });
    const anchor = published.releaseIdentity;
    if (published.state !== 'verified' || anchor?.version !== expectedVersion
      || anchor.hooksSha256 !== target.hashes['hooks/codex-hooks.json']) throw new Error('Released hook declarations are not independently verified');
    const managedRoot = path.join(codexHome, 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain', expectedVersion);
    const nativeVersion = (await command(['--version'])).trim();
    if (!/^codex-cli \S+$/.test(nativeVersion)) throw new Error('Native Codex version is unavailable');
    const inventory = async () => {
      const listed = JSON.parse(await command(['plugin', 'list', '--json']));
      if (!Array.isArray(listed?.installed)) throw new Error('Native plugin inventory is unavailable');
      const rows = listed.installed.filter((row) => row?.pluginId === OWNER);
      if (rows.length !== 1) throw new Error('Brain plugin inventory is missing or duplicated');
      return rows[0];
    };
    const before = await inventory();
    const beforeSurface = readSurface(fs.realpathSync(managedRoot));
    if (JSON.stringify(beforeSurface.hashes) !== JSON.stringify(target.hashes)) throw new Error('Installed declarations differ from the independent released target');
    const listed = await new Promise((resolve, reject) => {
      const child = own(['app-server', '--listen', 'stdio://']); let buffer = ''; let done = false; let phase = 1; let observed;
      const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => finish(new Error('Fresh declaration proof deadline exceeded')), remaining());
      const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
      child.on('error', () => finish(new Error('Fresh native metadata process failed')));
      child.once('exit', () => finish(new Error('Fresh native metadata process exited before proof')));
      child.stderr.on('data', (chunk) => { try { consume(chunk); } catch (error) { finish(error); } });
      child.stdout.on('data', (chunk) => {
        try {
          consume(chunk); buffer += chunk;
          while (!done && buffer.includes('\n')) {
            const end = buffer.indexOf('\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            const row = JSON.parse(line); if (row.id !== phase) continue;
            if (row.error) throw new Error('Native metadata proof was refused');
            if (phase === 1) { phase = 2; send({ method: 'initialized' }); send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } }); }
            else if (phase === 2) { observed = row.result; phase = 3; send({ id: 3, method: 'hooks/list', params: { cwds: [cwd] } }); }
            else if (JSON.stringify(observed) !== JSON.stringify(row.result)) throw new Error('Native registry changed during proof');
            else finish(null, row.result);
          }
        } catch (error) { finish(error); }
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'rnb_fresh_declarations_doctor', version: '1' }, capabilities: { experimentalApi: true } } });
    });
    const after = await inventory();
    if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(readSurface(managedRoot).hashes) !== JSON.stringify(beforeSurface.hashes)
      || JSON.stringify(readSurface(releasedPluginRoot).hashes) !== JSON.stringify(target.hashes)
      || nativeBinary(identity.path, env).sha256 !== identity.sha256 || (await command(['--version'])).trim() !== nativeVersion) throw new Error('Plugin, native binary, or released source changed during proof');
    remaining();
    return { ...classifyFreshCodexDeclarations({ plugin: after, listed, target, expectedVersion, codexHome, cwd }),
      publishedRelease: anchor, nativeBinary: identity.path, nativeBinarySha256: identity.sha256, nativeVersion, codexHome, cwd, totalOutputBytes: totalBytes };
  } catch (error) { return failed(error instanceof SyntaxError ? 'Native metadata or released source is malformed' : error.message); }
  finally {
    // Never contact or terminate a shared daemon. Retire only children created by this proof.
    const retired = await Promise.all([...children].map(async ([child, exited]) => {
      const stopped = () => child.exitCode !== null || child.signalCode !== null;
      if (stopped()) return true;
      const wait = async () => {
        let timer;
        try { await Promise.race([exited, new Promise((resolve) => {
          timer = setTimeout(resolve, Math.max(0, Math.min(250, deadline - Date.now())));
        })]); } finally { clearTimeout(timer); }
      };
      child.stdin.destroy();
      try { child.kill('SIGTERM'); } catch { /* bounded second attempt below */ }
      await wait();
      if (!stopped()) { try { child.kill('SIGKILL'); } catch { /* report unverified retirement */ } await wait(); }
      if (!stopped()) {
        // A referenced ChildProcess or pipe can keep the doctor CLI alive after this promise returns.
        child.stdout.destroy(); child.stderr.destroy(); child.unref?.();
        return false;
      }
      return true;
    }));
    if (retired.includes(false)) return { ...failed('Owned native proof child retirement is unverified'),
      unverifiedOwnedChildPids: [...children.keys()].filter((_child, index) => retired[index] === false).map((child) => child.pid).filter(Number.isSafeInteger) };
  }
}
