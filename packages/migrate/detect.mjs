// Reads a 4.7 installation and reports what migration needs to know. It only reads: file names and
// sizes, two small registries (which stores are private), one preference file and one switch file.
// It never opens a knowledge store, never starts a program (no launchctl, crontab or schtasks: those
// would read the real account whatever HOME says), and never writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refuseProtected } from '../plugin/install.mjs';

export const L = JSON.parse(fs.readFileSync(new URL('./layout47.json', import.meta.url), 'utf8'));

const userHome = (env) => env.HOME || env.USERPROFILE || os.homedir();
const text = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
const json = (f) => {
  const t = text(f);
  if (t === null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The 4.7 home as configured (it may be a link to another disk) and its real folder. */
export function home47(env = process.env) {
  const home = env[L.homeEnv] ? path.resolve(env[L.homeEnv]) : path.join(userHome(env), ...L.homeDefault);
  let real = home;
  let linked = false;
  try {
    linked = fs.lstatSync(home).isSymbolicLink();
    real = fs.realpathSync(home);
  } catch {}
  return { home, real, linked };
}

/** The store a knowledge file belongs to, by the 4.7 suffixes (longest first), or null. */
function storeOf(name) {
  for (const s of [...L.storeSuffixes].sort((a, b) => b.length - a.length)) if (name.endsWith(s) && name.length > s.length) return name.slice(0, -s.length);
  return null;
}

function privateStores(kb) {
  const names = new Map();
  const reg = json(path.join(kb, L.privateRegistry));
  for (const n of Array.isArray(reg?.privateStores) ? reg.privateStores : []) if (typeof n === 'string' && n) names.set(n.toLowerCase(), { name: n, why: L.privateRegistry });
  const src = json(path.join(kb, L.sourceRegistry));
  const entries = Array.isArray(src?.stores) ? src.stores.map((s) => [s?.kbName, s]) : src?.stores && typeof src.stores === 'object' ? Object.entries(src.stores) : [];
  for (const [n, v] of entries) if (typeof n === 'string' && v?.updateManaged === false && !names.has(n.toLowerCase())) names.set(n.toLowerCase(), { name: n, why: `${L.sourceRegistry} updateManaged:false` });
  const files = new Map();
  let publicStores = 0;
  const seen = new Set();
  for (const f of isDir(kb) ? fs.readdirSync(kb) : []) {
    const s = storeOf(f);
    if (!s) continue;
    const key = s.toLowerCase();
    if (names.has(key)) {
      const st = fs.lstatSync(path.join(kb, f));
      const e = files.get(key) ?? { files: [], bytes: 0 };
      e.files.push(f);
      e.bytes += st.size;
      files.set(key, e);
    } else if (!seen.has(key)) {
      seen.add(key);
      publicStores++;
    }
  }
  const list = [...names.entries()].map(([k, v]) => ({ ...v, files: files.get(k)?.files.sort() ?? [], bytes: files.get(k)?.bytes ?? 0 }));
  return { list: list.sort((a, b) => a.name.localeCompare(b.name)), publicStores };
}

function hostEntries(env) {
  const user = userHome(env);
  const claude = env.CLAUDE_CONFIG_DIR || path.join(user, '.claude');
  const codex = env.CODEX_HOME || path.join(user, '.codex');
  const out = [];
  const plugins = path.join(claude, ...L.claudeInstalledPlugins);
  // Every host file read here gets the same test guard as the 4.7 home (review F06).
  refuseProtected([plugins, path.join(claude, 'settings.json'), path.join(codex, 'config.toml')], env);
  if (json(plugins)?.plugins?.[L.claudePluginKey]) out.push({ host: 'Claude Code', file: plugins, what: `plug-in ${L.claudePluginKey}` });
  const settings = path.join(claude, 'settings.json');
  if (json(settings)?.enabledPlugins?.[L.claudePluginKey]) out.push({ host: 'Claude Code', file: settings, what: `enabledPlugins ${L.claudePluginKey}` });
  const toml = path.join(codex, 'config.toml');
  if (text(toml)?.includes(L.codexBlockStart)) out.push({ host: 'Codex', file: toml, what: '4.7 managed block with [mcp_servers.ruvnet-brain]' });
  return out;
}

function nightlyJobs(env, real) {
  const out = [];
  const plist = path.join(userHome(env), ...L.launchAgentsDir, `${L.nightlyLabel}.plist`);
  refuseProtected([plist], env);
  if (fs.existsSync(plist)) out.push({ kind: 'launchd', path: plist });
  const sched = path.join(real, L.schedulerDir);
  for (const f of isDir(sched) ? fs.readdirSync(sched).sort() : []) if (f.includes(L.nightlyLabel)) out.push({ kind: 'registration record', path: path.join(sched, f) });
  return out;
}

/** Everything migration needs from a 4.7 installation, or { found: false, why }. Reads only. */
export function detect47(env = process.env) {
  const h = home47(env);
  refuseProtected([h.home, h.real], env);
  const kb = path.join(h.real, L.knowledgeDir);
  if (!isDir(h.real)) return { found: false, ...h, why: `no 4.7 installation at ${h.home}` };
  if (!isDir(kb)) return { found: false, ...h, why: `${h.home} has no ${L.knowledgeDir} folder, so there is no 4.7 knowledge to keep` };
  const version = L.versionFiles.map((f) => text(path.join(h.real, f))?.trim()).find(Boolean) ?? 'unknown';
  const pref = text(path.join(h.real, L.autoUpdatePrefFile))?.trim().toLowerCase() ?? null;
  const stateDir = env[L.stateDirEnv] ? path.resolve(env[L.stateDirEnv]) : path.join(userHome(env), ...L.stateDirDefault);
  refuseProtected([stateDir], env);
  const priv = privateStores(kb);
  return {
    found: true,
    ...h,
    kb,
    version,
    autoUpdate: pref === 'no' ? 'no' : pref === 'yes' ? 'yes' : null,
    brainOff: fs.existsSync(path.join(stateDir, L.brainOffFile)) ? path.join(stateDir, L.brainOffFile) : null,
    privateStores: priv.list,
    publicStores: priv.publicStores,
    nightly: nightlyJobs(env, h.real),
    hosts: hostEntries(env),
    // Everything else 4.7 keeps (logs, models, turn capture, console files, router): listed, never used or removed.
    otherEntries: fs.readdirSync(h.real).filter((n) => n !== L.knowledgeDir).length,
    otherOwned: L.otherOwned.map((o) => ({ ...o, path: path.join(userHome(env), ...o.path) })).filter((o) => fs.existsSync(o.path)),
  };
}

/** Is 4.7 still there to serve? Its knowledge folder holds stores and a host still names it. */
export function usable47(env = process.env) {
  const d = detect47(env);
  if (!d.found) return { ok: false, why: d.why, d };
  if (!d.publicStores) return { ok: false, why: `${d.kb} holds no public knowledge store`, d };
  if (!d.hosts.length) return { ok: false, why: 'no host (Claude Code or Codex) is registered to run 4.7', d };
  if (d.brainOff) return { ok: false, why: `4.7 is switched off by its own switch file ${d.brainOff}`, d };
  return { ok: true, d };
}
