// Work package 9 (migration) test helpers: a synthetic 4.7 installation in a temporary user folder,
// laid out by the names the 4.7.28 code uses (packages/migrate/layout47.json), with a public store, two
// private stores whose text carries a random canary, a recorded "no" to automatic updates, the 03:30
// job's files, and the 4.7 host entries for Claude Code and Codex. Nothing here touches a real home.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { HOME_ENV } from './helpers.mjs';

const L = JSON.parse(fs.readFileSync(new URL('../../../packages/migrate/layout47.json', import.meta.url), 'utf8'));
const w = (f, text) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const j = (v) => JSON.stringify(v, null, 2) + '\n';

/** A user folder with a 4.7 installation. Returns its paths, the canary and the env to run under. */
export function make47(ctx, { autoUpdate = 'no', brainOff = false, linked = false } = {}) {
  const user = ctx.tmp('rb5-user47-');
  const canary = `PRIVATE-CANARY-${crypto.randomBytes(8).toString('hex')}`;
  const defaultHome = path.join(user, ...L.homeDefault);
  const real = linked ? path.join(ctx.tmp('rb5-disk-'), 'ruvnet-brain') : defaultHome;
  const kb = path.join(real, L.knowledgeDir);
  w(path.join(real, '.running-version'), '4.7.28\n');
  if (autoUpdate) w(path.join(real, L.autoUpdatePrefFile), `${autoUpdate}\n`);
  w(path.join(kb, L.sourceRegistry), j({ stores: { 'alpha-vectors': { kbName: 'alpha-vectors' }, 'owner-notes': { kbName: 'owner-notes', updateManaged: false } } }));
  w(path.join(kb, L.privateRegistry), j({ privateStores: ['client-meetings'] }));
  for (const s of ['.big.rvf', '.passages.jsonl', '.meta.json']) w(path.join(kb, `alpha-vectors${s}`), `public bytes of alpha-vectors${s}\n`);
  for (const name of ['owner-notes', 'client-meetings']) {
    w(path.join(kb, `${name}.passages.jsonl`), `${JSON.stringify({ text: `${canary} ${name} confidential minutes` })}\n`);
    w(path.join(kb, `${name}.big.rvf`), `${canary} vectors of ${name}\n`);
    w(path.join(kb, `${name}.meta.json`), j({ name, note: canary }));
  }
  w(path.join(real, L.schedulerDir, `${L.nightlyLabel}.json`), j({ identity: L.nightlyLabel }));
  w(path.join(real, 'models', 'model.onnx'), 'model bytes\n');
  w(path.join(real, 'turn-capture', 'turns.jsonl'), '{"turn":1}\n');
  w(path.join(user, '.claude', 'model-router', 'profile.json'), j({ subscription: 'x' }));
  w(path.join(user, ...L.launchAgentsDir, `${L.nightlyLabel}.plist`), `<plist><dict><key>Label</key><string>${L.nightlyLabel}</string></dict></plist>\n`);
  if (linked) {
    fs.mkdirSync(path.dirname(defaultHome), { recursive: true });
    fs.symlinkSync(real, defaultHome, process.platform === 'win32' ? 'junction' : 'dir');
  }
  const claude = path.join(user, '.claude');
  w(path.join(claude, ...L.claudeInstalledPlugins), j({ version: 2, plugins: { [L.claudePluginKey]: [{ scope: 'user', installPath: path.join(claude, 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain', '4.7.28'), version: '4.7.28' }] } })); // sync-version-ignore: the synthetic 4.7 installation's own recorded version (a test fixture, not the product version)
  w(path.join(claude, '.claude.json'), j({ numStartups: 3 }));
  w(path.join(claude, 'settings.json'), j({ enabledPlugins: { [L.claudePluginKey]: true }, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /x/4.7/session-hook.mjs' }] }] } }));
  w(path.join(user, '.codex', 'config.toml'), `model = "x"\n\n${L.codexBlockStart}\n[mcp_servers.ruvnet-brain]\ncommand = "node"\nargs = ["/x/4.7/server.mjs"]\n# --- end ruvnet-brain ---\n`);
  w(path.join(user, '.codex', 'hooks.json'), j({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /x/4.7/codex-hook.mjs' }] }] } }));
  const offFile = path.join(user, ...L.stateDirDefault, L.brainOffFile);
  if (brainOff) w(offFile, 'off\n');
  const home5 = path.join(user, '.cache', L.v5HomeName);
  // The 4.7 home is always named explicitly: under the test marker migrate --apply reads no other.
  const env = { HOME: user, USERPROFILE: user, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: path.join(user, '.codex'), [HOME_ENV]: home5, [L.homeEnv]: defaultHome };
  return { user, real, defaultHome, kb, canary, home5, env, offFile, claude, codexToml: path.join(user, '.codex', 'config.toml') };
}

/** sha256 of every file under dir (links listed by target), path-sorted: the "untouched" witness. */
export function hashTree(dir) {
  const out = {};
  (function walk(rel) {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, r);
      if (e.isSymbolicLink()) out[r] = `link:${fs.readlinkSync(abs)}`;
      else if (e.isDirectory()) walk(r);
      else out[r] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  })('');
  return out;
}

/** Files under dir (links followed) whose bytes contain needle. */
export function filesContaining(dir, needle) {
  const hits = [];
  if (!fs.existsSync(dir)) return hits;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (fs.readFileSync(abs).includes(needle)) hits.push(abs);
    }
  })(dir);
  return hits;
}

/** The whole 4.7 world a test must leave untouched: the 4.7 home, its job file and the 4.7 switch folder. */
export function world47(s) {
  return { home: hashTree(s.real), agents: hashTree(path.join(s.user, ...L.launchAgentsDir)), link: fs.existsSync(s.defaultHome) && fs.lstatSync(s.defaultHome).isSymbolicLink() ? fs.readlinkSync(s.defaultHome) : null };
}

/** One search through the installed version 5 server, as a host would start it (the shim launcher). */
export async function searchV5(ctx, tree, home, query) {
  const s = await ctx.server(tree, home);
  try {
    return await s.search(query);
  } finally {
    await s.close();
  }
}

export const runCli = (tree, s, args, extra = {}) => tree.cli(s.home5, args, { env: { ...s.env, ...extra } });
export const sh = (cmd, args, opts) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
