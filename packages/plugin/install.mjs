// Host shims, installed and registered (work package 7).
//
// installShim copies the shim from an installed app into one stable folder, <home>/shim (laid out as
// in the app: plugin/, contract/, health/, so its relative imports resolve), stamps the plug-in
// manifest with that app's version (the one version source is packages/version.json), writes the
// hook and server entries naming the launcher by absolute path, and records an absolute Node path for
// the launcher, which checks it again on every start. Host entries point at this folder, so they
// survive app updates and prunes; every install refreshes it.
//
// registerHosts / unregisterHosts add or remove exactly one prompt hook and one search server per
// host (and, in Claude Code, the optional write guard's tool-use hook, a no-op until the user turns
// the guard on), in the host files the caller names (nothing here guesses a host folder; hostFiles(env)
// is the explicit helper for the installer). Everything else in those files is left as it was; a file
// that cannot be read refuses the whole call before anything is written.
//
// Wave 3: the search server is registered as SERVER ("ruvnet-brain-5"), not 4.7's "ruvnet-brain", for
// the side-by-side period, so both can serve one host. A host whose server entry is refused (another
// program already holds that name) gets no hook either, and is reported as not served. Uninstall puts
// each shared host file back byte for byte from its pre-registration copy (host-backup.mjs) while the
// file is still what registration wrote; otherwise it removes only version 5's entries.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { keepBackup, restoreBackup, dropBackup } from './host-backup.mjs';

const WIN = process.platform === 'win32';
const NAME = 'ruvnet-brain';
/** The search server's name in every host during the side-by-side period with 4.7 (cutover renames it). */
export const SERVER = 'ruvnet-brain-5';
const EVENTS = ['UserPromptSubmit', 'PreToolUse'];
const PARTS = ['plugin', 'contract', 'health'];
const TEMPLATE = '"${CLAUDE_PLUGIN_ROOT}/bin/rb5"';
const BLOCK = ['# --- ruvnet-brain 5 (managed block; the installer rewrites it, everything outside it is yours) ---', '# --- end ruvnet-brain 5 ---'];

export class HostRefused extends Error {}

/** A path with every symbolic link resolved, through its nearest folder that exists. */
function resolved(p) {
  let dir = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...rest);
    } catch {
      const up = path.dirname(dir);
      if (up === dir) return path.join(dir, ...rest);
      rest.unshift(path.basename(dir));
      dir = up;
    }
  }
}

/**
 * The test guard. Under the test marker (RUVNET_BRAIN5_TEST=1, set by the shared test harness) no
 * host file and no brain home may lie under the real user's home folder: the one in the account
 * database, not $HOME (tests point $HOME elsewhere), plus any extra root a test names in
 * RUVNET_BRAIN5_PROTECTED_HOME (it can only add roots). Throws before anything is read or written.
 */
export function refuseProtected(files, env = process.env) {
  if (env.RUVNET_BRAIN5_TEST !== '1') return;
  const roots = [os.userInfo().homedir, env.RUVNET_BRAIN5_PROTECTED_HOME].filter(Boolean).map(resolved);
  for (const f of files) {
    const r = resolved(f);
    const root = roots.find((x) => r === x || r.startsWith(x.endsWith(path.sep) ? x : x + path.sep));
    if (root) throw new HostRefused(`test run (RUVNET_BRAIN5_TEST=1): ${f} is under the protected home ${root}; nothing was read or written`);
  }
}

export function shimPaths(home) {
  const shim = path.join(home, 'shim');
  const plugin = path.join(shim, 'plugin', 'claude');
  return { shim, plugin, runtime: path.join(shim, 'node-runtime'), launcher: path.join(plugin, 'bin', WIN ? 'rb5.cmd' : 'rb5') };
}

/** The hook commands and the server entry every host gets: first word, the absolute launcher. */
export function hostCommands(home, plugin = shimPaths(home).plugin) {
  const { launcher } = shimPaths(home);
  if (/["$`%!\r\n]/.test(launcher)) throw new HostRefused(`the brain home ${home} has a character a host command cannot quote safely; install to another folder`);
  const hooks = JSON.parse(fs.readFileSync(path.join(plugin, 'hooks', 'hooks.json'), 'utf8'));
  const hook = hooks.hooks.UserPromptSubmit[0].hooks[0];
  const g = hooks.hooks.PreToolUse[0];
  const guard = { matcher: g.matcher, hooks: [{ ...g.hooks[0], command: g.hooks[0].command.replace(TEMPLATE, `"${launcher}"`) }] };
  return { hook: { ...hook, command: hook.command.replace(TEMPLATE, `"${launcher}"`) }, guard, server: { command: launcher, args: ['server'] } };
}

/** The Node to record: the PATH entry that is the running Node (stable across upgrades), else itself. */
export function recordNode(execPath = process.execPath, env = process.env) {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  };
  const want = real(execPath);
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  for (const d of String(key ? env[key] : '').split(path.delimiter)) {
    if (!d || !path.isAbsolute(d)) continue;
    const c = path.join(d, WIN ? 'node.exe' : 'node');
    if (want && real(c) === want) return c;
  }
  return execPath;
}

const writeJson = (file, v) => fs.writeFileSync(file, JSON.stringify(v, null, 2) + '\n');

/** Copies the shim of the active (or named) app to <home>/shim. Returns what was written. */
export function installShim({ home, appDir = null, node = process.execPath, env = process.env }) {
  refuseProtected([home]);
  if (!appDir) {
    const ptr = JSON.parse(fs.readFileSync(path.join(home, 'current.json'), 'utf8'));
    appDir = path.join(home, 'app', ptr.app);
  }
  const p = shimPaths(home);
  const tmp = `${p.shim}.partial`;
  const old = `${p.shim}.old`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const part of PARTS) fs.cpSync(path.join(appDir, part), path.join(tmp, part), { recursive: true });
  const plugin = path.join(tmp, 'plugin', 'claude');
  fs.chmodSync(path.join(plugin, 'bin', 'rb5'), 0o755);
  const manifest = path.join(plugin, '.claude-plugin', 'plugin.json');
  writeJson(manifest, { ...JSON.parse(fs.readFileSync(manifest, 'utf8')), version: path.basename(appDir) });
  const cmds = hostCommands(home, plugin);
  writeJson(path.join(plugin, 'hooks', 'hooks.json'), { ...JSON.parse(fs.readFileSync(path.join(plugin, 'hooks', 'hooks.json'), 'utf8')), hooks: { UserPromptSubmit: [{ hooks: [cmds.hook] }], PreToolUse: [cmds.guard] } });
  writeJson(path.join(plugin, '.mcp.json'), { mcpServers: { [SERVER]: cmds.server } });
  fs.writeFileSync(path.join(tmp, 'node-runtime'), recordNode(node, env) + os.EOL);
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(p.shim)) fs.renameSync(p.shim, old);
  fs.renameSync(tmp, p.shim);
  fs.rmSync(old, { recursive: true, force: true });
  return { ...p, commands: cmds, written: ['shim/**'] };
}

/** Host files found under the user's folders named in env (the installer's helper; tests pass their own). */
export function hostFiles(env) {
  const user = env.HOME || env.USERPROFILE;
  if (!user) return {};
  const claude = env.CLAUDE_CONFIG_DIR || path.join(user, '.claude');
  const codex = env.CODEX_HOME || path.join(user, '.codex');
  const out = {};
  if (fs.existsSync(claude)) {
    out.claude = { settings: path.join(claude, 'settings.json'), state: env.CLAUDE_CONFIG_DIR ? path.join(claude, '.claude.json') : path.join(user, '.claude.json'), skills: path.join(claude, 'skills'), commands: path.join(claude, 'commands') };
  }
  if (fs.existsSync(codex)) out.codex = { config: path.join(codex, 'config.toml'), hooks: path.join(codex, 'hooks.json') };
  return out;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new HostRefused(`${file} could not be read (${e.code}); nothing was changed`);
  }
}

function readObj(file) {
  const text = readText(file);
  if (text === null || !text.trim()) return { text, obj: {} };
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return { text, obj };
  } catch {}
  throw new HostRefused(`${file} is not valid JSON, so no host was registered; fix or remove that file and run the installer again`);
}

/** Adds (groups given: { event: group }) or removes (null) our hook groups, found by their launcher. */
function setHooks(obj, launcher, groups) {
  const out = structuredClone(obj);
  const mine = (g) => (g?.hooks ?? []).some((h) => typeof h?.command === 'string' && h.command.startsWith(`"${launcher}"`));
  for (const event of EVENTS) {
    const list = (out.hooks?.[event] ?? []).filter((g) => !mine(g));
    if (groups?.[event]) list.push(groups[event]);
    if (list.length) (out.hooks ??= {})[event] = list;
    else if (out.hooks?.[event]) delete out.hooks[event];
  }
  if (out.hooks && !Object.keys(out.hooks).length && !groups) delete out.hooks;
  // Nothing of ours to add or remove: leave the file's own bytes alone (no reformatting).
  return JSON.stringify(out) === JSON.stringify(obj) ? null : out;
}

const SERVER_TABLE = new RegExp(`^[ \\t]*\\[mcp_servers\\.(?:${SERVER}|"${SERVER}"|'${SERVER}')\\]`, 'm');

function codexBlock(text, server) {
  const t = text ?? '';
  const s = t.indexOf(BLOCK[0]);
  const e = s < 0 ? -1 : t.indexOf(BLOCK[1], s);
  let before = s < 0 ? t : t.slice(0, s);
  let after = e < 0 ? '' : t.slice(e + BLOCK[1].length);
  if (s >= 0) {
    if (before.endsWith('\n\n')) before = before.slice(0, -1);
    if (after.startsWith('\n')) after = after.slice(1);
  }
  const rest = before + after;
  if (!server) return { text: rest };
  if (SERVER_TABLE.test(rest)) return { text: t, conflict: `a [mcp_servers.${SERVER}] table outside the managed block` };
  const block = [BLOCK[0], `[mcp_servers.${SERVER}]`, `command = ${JSON.stringify(server.command)}`, `args = ${JSON.stringify(server.args)}`, 'startup_timeout_sec = 30', BLOCK[1]].join('\n');
  const sep = !before ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  return { text: `${before}${sep}${block}\n${after}` };
}

const SKILL = ['skills', NAME, 'SKILL.md'];
const COMMAND = ['commands', 'brain.md'];

/** Works out every host file's new text, then writes the changed ones; nothing is written on a refusal. */
function apply({ home, hosts, add }) {
  const named = [hosts.claude?.settings, hosts.claude?.state, hosts.claude?.skills, hosts.claude?.commands, hosts.codex?.config, hosts.codex?.hooks];
  refuseProtected([home, ...named.filter(Boolean)]);
  const p = shimPaths(home);
  if (add && !fs.existsSync(p.launcher)) throw new HostRefused(`the shim is not installed in ${p.shim}; run installShim first`);
  const cmds = add ? hostCommands(home) : null;
  const plan = [];
  const conflicts = [];
  const json = (file, change) => {
    const { text, obj } = readObj(file);
    const next = change(obj);
    if (next) plan.push({ file, before: text, text: JSON.stringify(next, null, 2) + '\n' });
  };
  // A skill or command file is ours when it names our launcher (its @@LAUNCHER@@ line).
  const own = (file, src) => {
    const text = readText(file);
    const ours = text === null || text.includes(p.launcher);
    if (add && ours) plan.push({ file, before: text, text: fs.readFileSync(src, 'utf8').replaceAll('@@LAUNCHER@@', p.launcher) });
    else if (add) conflicts.push({ file, what: 'a file of the same name the installer did not write' });
    else if (text !== null && ours) plan.push({ file, before: text, text: null });
  };
  const hookFile = (file, groups) => json(file, (o) => setHooks(o, p.launcher, add && groups ? groups : null));
  const { claude, codex } = hosts;
  const unserved = [];
  // Each host's server entry is decided first: a host whose entry is refused gets no hook at all.
  let claudeServed = false;
  if (claude?.state) {
    const before = conflicts.length;
    json(claude.state, (o) => {
      const cur = o.mcpServers?.[SERVER];
      const legacy = o.mcpServers?.[NAME]?.command === p.launcher;
      if (cur && cur.command !== p.launcher) {
        if (add) conflicts.push({ file: claude.state, what: `a ${SERVER} server entry the installer did not write` });
        return null;
      }
      if (!add && !cur && !legacy) return null;
      const out = structuredClone(o);
      if (legacy) delete out.mcpServers[NAME];
      if (add) (out.mcpServers ??= {})[SERVER] = { type: 'stdio', ...cmds.server, env: {} };
      else delete out.mcpServers[SERVER];
      if (!Object.keys(out.mcpServers).length) delete out.mcpServers;
      return out;
    });
    claudeServed = add && conflicts.length === before;
  }
  if (add && claude && !claudeServed) unserved.push({ host: 'Claude Code', file: claude.state ?? null, why: conflicts.at(-1)?.file === claude.state ? conflicts.at(-1).what : 'no user-scope server list was named' });
  if (claude?.settings) hookFile(claude.settings, claudeServed && { UserPromptSubmit: { hooks: [cmds.hook] }, PreToolUse: cmds.guard });
  if (claude?.skills && (claudeServed || !add)) own(path.join(claude.skills, ...SKILL.slice(1)), path.join(p.plugin, ...SKILL));
  if (claude?.commands && (claudeServed || !add)) own(path.join(claude.commands, ...COMMAND.slice(1)), path.join(p.plugin, ...COMMAND));
  let codexServed = false;
  if (codex?.config) {
    const text = readText(codex.config);
    const r = codexBlock(text, add ? cmds.server : null);
    if (r.conflict) conflicts.push({ file: codex.config, what: r.conflict });
    else if (r.text !== (text ?? '')) plan.push({ file: codex.config, before: text, text: r.text });
    codexServed = add && !r.conflict;
  }
  if (add && codex && !codexServed) unserved.push({ host: 'Codex', file: codex.config ?? null, why: codex.config ? conflicts.at(-1).what : 'no config.toml was named' });
  // Codex gets the prompt hook only: the write guard reads Claude Code's tool input (packages/guard).
  if (codex?.hooks) hookFile(codex.hooks, codexServed && { UserPromptSubmit: { hooks: [cmds.hook] } });
  const shared = new Set([claude?.settings, claude?.state, codex?.config, codex?.hooks].filter(Boolean));
  const written = [];
  if (!add) {
    // Byte-exact uninstall: a shared file still exactly as registration left it gets its copy back.
    for (const file of shared) {
      if (!restoreBackup(home, file, readText(file)).restored) {
        dropBackup(home, file);
        continue;
      }
      written.push(file);
      for (let i = plan.length - 1; i >= 0; i--) if (plan[i].file === file) plan.splice(i, 1);
    }
  } else {
    for (const w of plan) if (shared.has(w.file) && w.text !== w.before) keepBackup(home, w.file, w.before, w.text, (w.before ?? '').includes(p.launcher));
  }
  for (const w of plan) {
    if (w.text === w.before) continue;
    if (w.text === null) {
      fs.rmSync(w.file, { force: true });
      const dir = path.dirname(w.file);
      if (path.basename(dir) === NAME && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
    } else {
      fs.mkdirSync(path.dirname(w.file), { recursive: true });
      const tmp = `${w.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, w.text);
      fs.renameSync(tmp, w.file);
    }
    written.push(w.file);
  }
  return { written, conflicts, unserved };
}

export const registerHosts = ({ home, hosts }) => apply({ home, hosts, add: true });
export const unregisterHosts = ({ home, hosts }) => apply({ home, hosts, add: false });
