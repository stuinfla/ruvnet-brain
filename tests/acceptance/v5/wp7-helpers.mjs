// Work package 7 (host shims) test helpers. Importing wp4-helpers points HOME and the XDG folders of
// this process at a fresh temporary folder, so nothing here can reach a real host setting. Host
// "settings" in these tests are temporary files that stand in for a host's own files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { FAKE_HOME } from './wp4-helpers.mjs';

export { FAKE_HOME };
export const POSIX = process.platform !== 'win32';
export const NOT_POSIX = POSIX ? false : 'POSIX launcher; the Windows launcher is checked by wp7-07 (static) only';

/** A program named `node` that leaves a mark when it runs and fails. */
export function plantNode(dir, mark, name = 'node') {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\necho ran >> '${mark}'\nexit 1\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

/** A `node` that is the real program reporting version 20.1.0 (older than the 22.13 minimum). */
export function oldNode(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'node');
  const gate = 'data:text/javascript,Object.defineProperty(process.versions,"node",{value:"20.1.0"})';
  fs.writeFileSync(file, `#!/bin/sh\nexec '${process.execPath}' --import '${gate}' "$@"\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

/** Runs a host command string through /bin/sh, as a host does, with exactly the PATH given. */
export function runHost(command, { cwd, env = {}, PATH, input = '{}' } = {}) {
  const full = { ...process.env, NODE_NO_WARNINGS: '1', ...env };
  for (const k of Object.keys(full)) if (k.toLowerCase() === 'path') delete full[k];
  full.PATH = PATH ?? process.env.PATH;
  const r = spawnSync(command, { shell: '/bin/sh', cwd, env: full, input, encoding: 'utf8', timeout: 30_000 });
  return { line: (r.stdout ?? '').trim(), status: r.status, stderr: r.stderr ?? '' };
}

export const nodeDir = () => path.dirname(process.execPath);
export const marked = (mark) => fs.existsSync(mark);
export const DOWN = /^\[RuvNet Brain\] DOWN: Node could not run\. Search is unavailable\./;
export const VERDICT = /^\[RuvNet Brain (OK|DEGRADED|DOWN|NOT RUNNING|NOT INSTALLED|UNKNOWN)[ \]·]/;

/** The plug-in package's install module from the scratch tree (so a break applied there is seen). */
export const pluginApi = (tree) => import(pathToFileURL(path.join(tree.root, 'packages', 'plugin', 'install.mjs')).href);

/** Installs the fixture release into a fresh home, then the shim from that installed app. */
export async function installedShim(ctx, tree) {
  const { home } = ctx.installed(tree);
  const api = await pluginApi(tree);
  const shim = api.installShim({ home });
  assert.ok(fs.existsSync(shim.launcher), 'the launcher is installed under the brain home');
  return { home, api, shim };
}

/** Temporary files standing in for each host's own settings, with some content of the user's. */
export function fakeHosts(dir, { content = true } = {}) {
  const f = {
    claude: { settings: path.join(dir, 'claude', 'settings.json'), state: path.join(dir, 'claude.json'), skills: path.join(dir, 'claude', 'skills'), commands: path.join(dir, 'claude', 'commands') },
    codex: { config: path.join(dir, 'codex', 'config.toml'), hooks: path.join(dir, 'codex', 'hooks.json') },
  };
  fs.mkdirSync(path.join(dir, 'claude'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'codex'), { recursive: true });
  if (content) {
    const json = (file, v) => fs.writeFileSync(file, JSON.stringify(v, null, 2) + '\n');
    json(f.claude.settings, { model: 'x', hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/usr/local/bin/users-own-hook', timeout: 3 }] }], Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] }, permissions: { allow: ['Bash(ls)'] } });
    json(f.claude.state, { numStartups: 7, mcpServers: { other: { type: 'stdio', command: '/opt/other/server', args: [] } }, projects: { '/x': { allowedTools: [] } } });
    fs.writeFileSync(f.codex.config, 'model = "gpt-x"\n\n[mcp_servers.other]\ncommand = "/opt/other/server"\nargs = []\n');
    json(f.codex.hooks, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } });
  }
  return f;
}

/** Every file under dir with its bytes, for byte-for-byte comparison. */
export function bytesOf(dir) {
  const out = {};
  (function walk(rel) {
    let ents = [];
    try {
      ents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out[r] = fs.readFileSync(path.join(dir, r), 'utf8');
    }
  })('');
  return out;
}
