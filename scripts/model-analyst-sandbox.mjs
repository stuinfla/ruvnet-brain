// DISTINCT-FROM: native-subscription-usage.mjs — isolated child tool-denial trust, never an inference turn.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const TOOL_DENIAL = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Weekly analyst tools are prohibited; analyse supplied evidence only.' } };
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
export function createAnalystHome(runDir) {
  const requestedHome = path.join(runDir, 'native-home'); fs.mkdirSync(requestedHome, { mode: 0o700 }); const home = fs.realpathSync(requestedHome);
  const source = path.join(os.homedir(), '.codex');
  const auth = fs.realpathSync(path.join(source, 'auth.json'));
  if (!fs.statSync(auth).isFile()) throw new Error('Canonical native OAuth file unavailable');
  fs.symlinkSync(auth, path.join(home, 'auth.json'));
  fs.copyFileSync(path.join(source, 'models_cache.json'), path.join(home, 'models_cache.json')); fs.chmodSync(path.join(home, 'models_cache.json'), 0o600);
  fs.writeFileSync(path.join(home, 'config.toml'), '', { mode: 0o600 });
  const command = `${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} --deny`;
  fs.writeFileSync(path.join(home, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command, timeout: 5 }] }] } }), { mode: 0o600 });
  return { home, command };
}
export function sameNativeConfigPath(actual, expected, platform = process.platform) {
  if (typeof actual !== 'string' || !actual) return false;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const normalize = value => { const resolved = paths.resolve(value); return platform === 'win32' ? resolved.toLowerCase() : resolved; };
  return normalize(actual) === normalize(expected);
}
export async function trustAnalystDenial({ home, command, env = process.env, spawnHost = spawn, timeoutMs = 8000 }) {
  const child = spawnHost('codex', ['app-server', '--strict-config', '-c', 'features.plugins=false', '-c', 'service_tier="default"', '--listen', 'stdio://'], { cwd: home, env: { ...env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  let id = 0, buffer = ''; const pending = new Map(); let failure;
  const fail = () => { failure = new Error('Private native hook metadata transport failed'); for (const p of pending.values()) p.reject(failure); pending.clear(); };
  child.on('error', fail); child.on('exit', fail); child.stderr.on('data', () => {}); child.stdin.on('error', fail);
  child.stdout.on('data', (chunk) => { buffer += chunk; if (buffer.length > 1048576) return fail(); let split;
    while ((split = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, split); buffer = buffer.slice(split + 1); let r; try { r = JSON.parse(line); } catch { continue; }
      const p = pending.get(r.id); if (!p) continue; pending.delete(r.id); r.error ? p.reject(new Error('Private native hook metadata request rejected')) : p.resolve(r.result);
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => { if (failure) return reject(failure); const n = ++id; pending.set(n, { resolve, reject }); child.stdin.write(JSON.stringify({ id: n, method, params }) + '\n'); });
  const timer = setTimeout(() => { fail(); child.kill(); }, timeoutMs);
  const oneHook = (result) => { const entries = result?.data ?? []; const hooks = entries.flatMap((e) => e.hooks ?? []);
    if (entries.some((e) => e.errors?.length) || hooks.length !== 1 || hooks[0].eventName !== 'preToolUse' || hooks[0].matcher !== '.*' || hooks[0].command !== command || !hooks[0].enabled || !/^sha256:[a-f0-9]{64}$/.test(hooks[0].currentHash)) throw new Error('Private deny hook is not the sole enabled hook'); return hooks[0]; };
  try {
    await request('initialize', { clientInfo: { name: 'weekly_analyst_sandbox', version: '1' }, capabilities: { experimentalApi: true } }); child.stdin.write('{"method":"initialized"}\n');
    const first = oneHook(await request('hooks/list', { cwds: [home] }));
    const config = await request('config/read', { cwd: home, includeLayers: true });
    const layer = config.layers?.find((l) => sameNativeConfigPath(l.name?.file, path.join(home, 'config.toml')));
    if (!layer?.version) throw new Error('Private native config version missing');
    await request('config/batchWrite', { filePath: path.join(home, 'config.toml'), expectedVersion: layer.version, reloadUserConfig: true,
      edits: [{ keyPath: `hooks.state.${JSON.stringify(first.key)}.trusted_hash`, value: first.currentHash, mergeStrategy: 'replace' }] });
    const final = oneHook(await request('hooks/list', { cwds: [home] }));
    if (final.trustStatus !== 'trusted' || final.currentHash !== first.currentHash) throw new Error('Private deny hook trust not accepted');
    return { trusted: true, hookKey: final.key, currentHash: final.currentHash, inferenceStarted: false };
  } finally { clearTimeout(timer); child.stdin.end(); child.kill(); }
}
if (process.argv.includes('--deny')) console.log(JSON.stringify(TOOL_DENIAL));
