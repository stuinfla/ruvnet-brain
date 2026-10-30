#!/usr/bin/env node
// One existing-install owner. Does not install schedulers or remove plugin generations.
// Over the 500-line guideline in 4.7.21 on purpose: a split needs a new module in EXECUTION_MODULES, which older registrations
// cannot stage. The split into a new closure module is planned for 4.7.22, with the runner-changed re-registration work.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cmpVersion as compare, selectTag, needsPublishTimes, normalizeNpmDistTags, wantedTag, FAMILY, PLUGIN_MARKETPLACES, REVIEWED_INSTALL_SCRIPTS, EXECUTION_MODULES } from './developer-update-policy.mjs';
import { acquireDeveloperLock, sharedLockStatus } from './developer-update-lock.mjs';
import { maintenance } from './developer-update-maintenance.mjs';
import { cleanupNpxDuplicates } from './developer-update-cleanup.mjs';
import { pinnedClaudeTarget, verifyClaudeArtifact } from './plugin-artifact-proof.mjs';
import { isDirectInvocation } from './entrypoint.mjs';
export { compare, selectTag, sharedLockStatus };
const HOME = os.homedir();
const PREFIX = path.join(HOME, '.npm-global');
const ROOT = path.join(PREFIX, 'lib/node_modules');
const NODE = process.execPath;
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const CACHE = path.join(HOME, '.cache/ruvnet-brain');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const exists = file => fs.existsSync(file);
const inside = (parent, child) => child.startsWith(`${parent}${path.sep}`);
export function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function invoke(command, args, { cwd = HOME, timeout = 600_000, allowed = [0], env = process.env, capture = false } = {}) {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024,
    env: { ...env, PATH: [...new Set([path.dirname(NODE), path.join(env.npm_config_prefix || PREFIX, process.platform === 'win32' ? '' : 'bin'), ...(env.PATH || '').split(path.delimiter)])].join(path.delimiter),
      CI: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_FLOW_AUTO_UPDATE: 'false', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GH_PROMPT_DISABLED: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1', HOMEBREW_NO_AUTO_UPDATE: '1', RUVNET_BRAIN_HOME: env.RUVNET_BRAIN_HOME || CACHE } });
  if (!capture && (r.error || !allowed.includes(r.status))) throw Error(`${path.basename(command)} ${args[0]}: ${r.error?.message || `exit ${r.status}`}: ${(r.stderr || r.stdout || '').trim().slice(-600)}`);
  return { stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), exitCode: r.status, error: r.error?.message || null };
}
const invokeText = (command, args, options) => invoke(command, args, options).stdout;
export function claudeProviderCommand(command, { prefix, run = invokeText, platform = process.platform, arch = process.arch } = {}) {
  const root = prefix && (exists(path.join(prefix, 'lib/node_modules')) ? path.join(prefix, 'lib/node_modules') : path.join(prefix, 'node_modules'));
  const owner = root && path.join(root, '@anthropic-ai/claude-code');
  if (!command || !owner) return { command };
  let ownerStat;
  try { ownerStat = fs.lstatSync(owner); } catch (error) { if (error.code === 'ENOENT') return { command }; throw error; }
  if (!ownerStat.isDirectory() || fs.realpathSync(owner) !== owner) throw Error('Claude npm package owner is aliased or unverified');
  const manifest = read(path.join(owner, 'package.json'));
  if (manifest.name !== '@anthropic-ai/claude-code' || manifest.bin?.claude !== 'bin/claude.exe') return { command };
  const canonicalEntry = path.join(owner, 'bin/claude.exe'), stat = fs.lstatSync(canonicalEntry);
  if (stat.size > 4096) return { command };
  const owned = !stat.isSymbolicLink() && stat.isFile() && fs.realpathSync(owner) === owner && fs.realpathSync(canonicalEntry) === canonicalEntry && fs.realpathSync(command) === canonicalEntry;
  const placeholderSha256 = owned && hash(fs.readFileSync(canonicalEntry));
  if (placeholderSha256 !== '6d7abae055d3b598281300a6c835086dec81bf3048f8a2294c5d3e50c8830d7b') throw Error('Claude canonical entry is an unrecognized or unowned placeholder');
  const name = `@anthropic-ai/claude-code-${platform}-${arch}`, nativeOwner = path.join(owner, 'node_modules', name);
  if (!fs.lstatSync(nativeOwner).isDirectory() || fs.realpathSync(nativeOwner) !== nativeOwner) throw Error('Claude existing native package owner mismatch');
  const native = read(path.join(nativeOwner, 'package.json'));
  if (manifest.optionalDependencies?.[name] !== manifest.version || native.name !== name || native.version !== manifest.version || !Array.isArray(native.os) || !native.os.includes(platform) || !Array.isArray(native.cpu) || !native.cpu.includes(arch) || fs.realpathSync(nativeOwner) !== nativeOwner) throw Error('Claude existing native owner/version mismatch');
  const nativePath = path.join(nativeOwner, platform === 'win32' ? 'claude.exe' : 'claude'), nativeStat = fs.lstatSync(nativePath);
  if (!nativeStat.isFile() || nativeStat.isSymbolicLink() || fs.realpathSync(nativePath) !== nativePath) throw Error('Claude existing native executable owner mismatch');
  fs.accessSync(nativePath, fs.constants.X_OK);
  const versionOutput = run(nativePath, ['--version'], { timeout: 30_000 }).trim();
  if (versionOutput !== `${manifest.version} (Claude Code)`) throw Error('Claude existing native version probe mismatch');
  return { command: nativePath, canonicalEntry, nativePath, version: manifest.version,
    reason: 'stock canonical placeholder; verified existing native binary in the same npm owner', proof: { placeholderSha256, nativeOwner, versionOutput } };
}
export function identity(location, prefix = PREFIX, { platform = process.platform } = {}) {
  const root = exists(path.join(prefix, 'lib/node_modules')) ? path.join(prefix, 'lib/node_modules') : path.join(prefix, 'node_modules');
  // Linked source checkouts may be unavailable to an unattended host. Never open their target.
  if (fs.lstatSync(location).isSymbolicLink()) {
    const name = path.relative(root, location).split(path.sep).join('/');
    if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name) || location !== path.join(root, name)) throw Error(`invalid global link identity: ${location}`);
    const rawLink = fs.readlinkSync(location);
    return { name, version: null, location, prefix, manifestSha256: null, realLocation: null,
      localSource: true, rawLink, linkTarget: path.resolve(path.dirname(location), rawLink), launchers: [] };
  }
  const manifestFile = path.join(location, 'package.json');
  const manifest = read(manifestFile);
  if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(manifest.name) || location !== path.join(root, manifest.name)) throw Error(`invalid global identity: ${location}`);
  const realLocation = fs.realpathSync(location);
  const localSource = realLocation !== location;
  const bins = typeof manifest.bin === 'string' ? { [manifest.name.split('/').at(-1)]: manifest.bin } : manifest.bin || {};
  const launchers = Object.entries(bins).map(([name, target]) => {
    if ((!/^[^/\\\0]+$/.test(name) || ['.', '..'].includes(name)) || typeof target !== 'string') throw Error(`invalid bin identity: ${manifest.name}`);
    const launcher = platform === 'win32' ? path.join(prefix, `${name}.cmd`) : path.join(prefix, 'bin', name);
    let real = null;
    try { real = fs.realpathSync(launcher); } catch { /* absent executable is unverified */ }
    const expected = path.resolve(location, target);
    if (!inside(location, expected)) throw Error(`escaping executable: ${manifest.name}`);
    return { name, launcher, real, expected, owned: real !== null && (inside(location, real) || (platform === 'win32' && fs.readFileSync(launcher, 'utf8').replaceAll('\\', '/').includes(path.relative(prefix, expected).replaceAll('\\', '/')))) };
  });
  return { name: manifest.name, version: manifest.version, location, prefix,
    manifestSha256: hash(fs.readFileSync(manifestFile)), realLocation, localSource, launchers };
}
export function discover(root = ROOT, prefix = PREFIX, scope = 'all') {
  if (![path.join(prefix, 'lib/node_modules'), path.join(prefix, 'node_modules')].includes(root)) throw Error('new prefix/root refused');
  const locations = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const child of fs.readdirSync(path.join(root, entry.name))) locations.push(path.join(root, entry.name, child));
    } else locations.push(path.join(root, entry.name));
  }
  return locations.filter(p => fs.lstatSync(p).isSymbolicLink() || exists(path.join(p, 'package.json'))).map(p => identity(p, prefix))
    .filter(p => FAMILY.test(p.name) || scope === 'all' && (p.localSource || p.launchers.length))
    .sort((a, b) => a.name === '@pacphi/agentic-kit' ? 1 : b.name === '@pacphi/agentic-kit' ? -1 : a.name.localeCompare(b.name));
}
function verifyPackage(before, expected, run) {
  const after = identity(before.location, before.prefix);
  if (after.name !== before.name || after.version !== expected || compare(after.version, before.version) < 0) throw Error(`installed identity/version not verified: ${before.name}`);
  for (const launcher of after.launchers) {
    if (!launcher.owned) throw Error(`launcher ownership lost: ${before.name}/${launcher.name}`);
    // MCP-only launchers may block on --version; they are verified through manifest/owned executable, not started.
    fs.accessSync(launcher.real, process.platform === 'win32' ? fs.constants.R_OK : fs.constants.X_OK);
  }
  if (['ruflo', '@pacphi/agentic-kit', '@openai/codex', '@anthropic-ai/claude-code', 'agent-browser'].includes(after.name)) {
    const main = after.launchers[0];
    if (!main) throw Error(`missing primary launcher: ${after.name}`);
    const versionOutput = process.platform === 'win32' && /\.(?:[cm]?js)$/.test(main.expected)
      ? run(process.execPath, [main.expected, '--version'], { timeout: 30_000 }) : run(main.launcher, ['--version'], { timeout: 30_000 });
    if (!versionOutput.includes(expected)) throw Error(`primary executable version unverified: ${after.name}`);
  }
  return after;
}
export function upgradePackage(before, tags, scripts = REVIEWED_INSTALL_SCRIPTS, { run = invokeText, dryRun = false, channel = 'latest', npm = NPM, preservePackages = [], published = null } = {}) {
  // Snapshot identity must still exist and own the original paths before any installer runs.
  if (before.localSource && before.rawLink !== undefined) {
    if (!fs.lstatSync(before.location).isSymbolicLink() || fs.readlinkSync(before.location) !== before.rawLink) throw Error(`source link changed before preservation: ${before.name}`);
    const live = identity(before.location, before.prefix);
    if (!live.localSource || live.name !== before.name || live.rawLink !== before.rawLink || live.linkTarget !== before.linkTarget) throw Error(`source link changed before preservation: ${before.name}`);
    return { name: before.name, state: 'local-source-preserved', reason: 'linked source currency unverified; target not opened', before, after: live };
  }
  const live = identity(before.location, before.prefix);
  if (live.name !== before.name || live.manifestSha256 !== before.manifestSha256) throw Error(`source changed before install: ${before.name}`);
  if (live.localSource) return { name: before.name, state: 'local-source-preserved', before, after: live };
  if (live.launchers.some(b => !b.real)) throw Error(`absent launcher: ${before.name}`);
  if (live.launchers.some(b => !b.owned)) return { name: before.name, state: 'shadowed-preserved', before, after: live };
  const target = selectTag(before.name, before.version, tags, channel, { published });
  if (preservePackages.includes(before.name)) return { name: before.name, state: 'local-modification-preserved', reason: 'preservedLocalModification', target, before, after: live };
  if (!target.upgrade || dryRun) return { name: before.name, state: target.upgrade ? 'update-available' : target.ahead ? 'ahead-preserved' : 'current', target, before, after: live };
  const spec = `${before.name}@${target.tag}`;
  run(npm, ['install', '-g', '--prefix', before.prefix, `--allow-scripts=${scripts.join(',')}`, spec]);
  return { name: before.name, state: 'updated', target, before, after: verifyPackage(before, target.version, run) };
}
export function pluginScopes(file, { unattended = false } = {}) {
  if (!exists(file)) return [];
  return Object.entries(read(file).plugins || {}).flatMap(([id, entries]) => entries.map(p => {
    if (!['user', 'project', 'local', 'managed'].includes(p.scope)) throw Error(`unknown plugin scope: ${id}`);
    if (['project', 'local'].includes(p.scope) && (!p.projectPath || !path.isAbsolute(p.projectPath) || !unattended && !exists(p.projectPath))) throw Error(`missing plugin project: ${id}`);
    return { id, scope: p.scope, projectPath: p.projectPath || null, installPath: p.installPath, version: p.version, gitCommitSha: p.gitCommitSha || null };
  }));
}
export function scopeKey(p) { return `${p.id}\0${p.scope}\0${p.projectPath || ''}`; }
function pluginFlags(scopes = [], home = HOME) {
  const files = [path.join(home, '.claude/settings.json'), path.join(home, '.claude/settings.local.json'), path.join(home, '.codex/config.toml')];
  for (const project of new Set(scopes.map(p => p.projectPath).filter(Boolean))) {
    files.push(path.join(project, '.claude/settings.json'), path.join(project, '.claude/settings.local.json'));
  }
  const values = {};
  for (const file of [...new Set(files)].filter(exists)) {
    const text = fs.readFileSync(file, 'utf8');
    values[file] = file.endsWith('.json') ? read(file).enabledPlugins || {} : text.split('\n').filter(l => /\[plugins\.|enabled\s*=/.test(l)).join('\n');
  }
  return values;
}
export function marketplaceRemoteCommit(owner, run) {
  if (owner?.source !== 'github' || typeof owner.repo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(owner.repo)) throw Error('unsupported marketplace GitHub owner');
  const declared = owner.ref ?? owner.branch ?? 'HEAD';
  if (typeof declared !== 'string' || !/^(?:HEAD|(?:refs\/heads\/)?[A-Za-z0-9][A-Za-z0-9._/-]*)$/.test(declared) || /\.\.|@\{|\/\/|\.lock(?:\/|$)|[/.]$/.test(declared)) throw Error('unsupported marketplace ref');
  if (declared.startsWith('refs/') && !declared.startsWith('refs/heads/')) throw Error('unsupported marketplace ref');
  const ref = declared === 'HEAD' || declared.startsWith('refs/heads/') ? declared : `refs/heads/${declared}`;
  const url = `https://github.com/${owner.repo}.git`;
  const output = run('git', ['ls-remote', '--exit-code', url, ref], { timeout: 30_000 }).trim();
  const lines = output.split('\n');
  const match = lines.length === 1 ? /^([a-f0-9]{40})\s+(\S+)$/i.exec(lines[0]) : null;
  if (!match || match[2] !== ref) throw Error('marketplace remote commit response is ambiguous or unverified');
  return { commit: match[1].toLowerCase(), url, ref };
}
export function resolvePluginTarget(plugin, { home = HOME, run = invokeText } = {}) {
  try {
    const marketplace = plugin.id.split('@').at(-1), name = plugin.id.slice(0, plugin.id.lastIndexOf('@'));
    const knownOwner = read(path.join(home, '.claude/plugins/known_marketplaces.json'))[marketplace];
    const location = knownOwner?.installLocation;
    if (!location || !path.isAbsolute(location)) throw Error('marketplace owner path absent');
    const directory = fs.statSync(location).isDirectory() ? location : path.dirname(location);
    const catalog = fs.statSync(location).isFile() ? location : [path.join(directory, '.claude-plugin/marketplace.json'), path.join(directory, 'marketplace.json')].find(exists);
    if (!catalog) throw Error('marketplace catalogue absent');
    const catalogSha256 = hash(fs.readFileSync(catalog));
    const entry = read(catalog).plugins?.find(p => p.name === name);
    if (!entry) throw Error('installed plugin absent from catalogue');
    let version = typeof entry.version === 'string' && entry.version !== 'unknown' ? entry.version : null;
    let commit = null, catalogCommit = null, remote = null, authority = 'version', proof = 'catalog-version';
    if (typeof entry.source === 'object' && entry.source !== null) {
      if (!['url', 'github'].includes(entry.source.source)) throw Error('unsupported remote plugin source');
      if (entry.source.sha !== undefined && !/^[a-f0-9]{40}$/i.test(entry.source.sha)) throw Error('malformed pinned plugin commit');
      if (/^[a-f0-9]{40}$/i.test(entry.source.sha || '')) {
        commit = entry.source.sha.toLowerCase(); authority = 'commit'; proof = 'catalog-pinned-commit';
      }
    } else if (typeof entry.source === 'string' && entry.source.startsWith('./')) {
      const source = path.resolve(directory, entry.source);
      if (source !== directory && !inside(directory, source)) throw Error('plugin source escapes marketplace');
      const manifest = path.join(source, '.claude-plugin/plugin.json');
      if (!version && exists(manifest)) { const declared = read(manifest).version; version = declared && declared !== 'unknown' ? declared : null; }
      try {
        const resolved = run('git', ['-C', directory, 'rev-parse', 'HEAD'], { timeout: 10_000 }).trim();
        if (/^[a-f0-9]{40}$/i.test(resolved)) catalogCommit = resolved.toLowerCase();
      } catch { /* a refreshed archive can lack Git metadata */ }
      let semanticVersion = false;
      try { semanticVersion = !!version && compare(version, version) === 0; } catch { /* hash versions use commit authority */ }
      if (semanticVersion) { authority = 'version'; proof = 'published-plugin-version'; }
      else {
        if (!catalogCommit && knownOwner?.source?.source === 'github') { remote = marketplaceRemoteCommit(knownOwner.source, run); catalogCommit = remote.commit; }
        commit = catalogCommit; authority = 'commit'; proof = remote ? 'known-marketplace-remote-commit' : 'refreshed-marketplace-commit';
      }
    } else throw Error('unsupported plugin source shape');
    if (!version && !commit) throw Error('opaque or unpinned plugin target');
    if (hash(fs.readFileSync(catalog)) !== catalogSha256) throw Error('marketplace catalogue changed during identity resolution');
    return { supported: true, version, commit, catalogCommit, authority, proof, remote, catalog, catalogSha256, source: entry.source };
  } catch (error) { return { supported: false, reason: error.message }; }
}
export function pluginTarget(plugin, home = HOME) { return resolvePluginTarget(plugin, { home }).version || null; }
export function pluginUpdateDecision(plugin, target) {
  if (!target.supported) return { state: 'UNSUPPORTED', reason: target.reason };
  if (target.version && plugin.version && plugin.version !== 'unknown' && target.version !== plugin.version) {
    try { if (compare(target.version, plugin.version) < 0) return { state: 'AHEAD', reason: 'published plugin version is older' }; }
    catch { if (!target.commit) return { state: 'UNSUPPORTED', reason: 'plugin version ordering is opaque' }; }
  }
  if (target.authority === 'commit' || target.commit) {
    return { state: plugin.gitCommitSha?.toLowerCase() === target.commit ? 'CURRENT' : 'UPDATE_AVAILABLE', proof: target.proof };
  }
  return { state: target.version === plugin.version ? 'CURRENT' : 'UPDATE_AVAILABLE', proof: target.proof,
    sourceCommitMatched: target.catalogCommit ? plugin.gitCommitSha?.toLowerCase() === target.catalogCommit : null };
}
// Codex refreshes a remote plugin catalog (56 MB, 38-40 s cold, 2026-10-30) inside its plugin commands; a killed refresh
// caches nothing, so a 30 s limit failed every later night the same way. Same bound as bin/install.mjs.
export const CODEX_COMMAND_TIMEOUT_MS = 180_000;
export async function synchronizePlugins(run, dryRun, notes, { home, prefix, scope, locate, unattended = false, artifactProvider = pinnedClaudeTarget }) {
  const installed = path.join(home, '.claude/plugins/installed_plugins.json');
  const inventoryOptions = { unattended };
  const all = pluginScopes(installed, inventoryOptions), before = all.filter(p => scope === 'all' || PLUGIN_MARKETPLACES.has(p.id.split('@').at(-1)));
  const writable = before.filter(p => p.scope !== 'managed' && !(unattended && ['project', 'local'].includes(p.scope))), flags = pluginFlags(writable, home);
  const provider = writable.length ? claudeProviderCommand(locate('claude'), { prefix, run }) : { command: locate('claude') };
  const claude = provider.command;
  // No Claude CLI on this PATH (desktop-app, VS Code, nvm or ~/.claude/local installs): nothing can update these plugins
  // here, so each is preserved and reported UNSUPPORTED instead of ending the night (AuditC #1).
  const noClaude = writable.length > 0 && !claude;
  const steps = [], artifactCache = new Map();
  const markets = noClaude ? [] : [...new Set(writable.map(p => p.id.split('@').at(-1)))];
  if (!dryRun) for (const name of markets) run(claude, ['plugin', 'marketplace', 'update', name]);
  for (const p of before) {
    if (!writable.includes(p) || noClaude) {
      const reason = noClaude && writable.includes(p) ? 'no existing Claude command on this PATH; installed plugin preserved'
        : p.scope === 'managed' ? 'managed scope belongs to its administrator' : 'unattended project settings unverified; original scope preserved';
      steps.push({ id: p.id, scope: p.scope, projectPath: p.projectPath, before: p, after: p, state: 'UNSUPPORTED', reason });
      notes.push(`plugin target unsupported; preserved: ${p.id} (${p.scope}): ${reason}`);
      continue;
    }
    const target = resolvePluginTarget(p, { home, run });
    let artifactTarget = null, artifactProof = null;
    if (target.supported && target.authority === 'commit' && target.proof === 'catalog-pinned-commit' && p.gitCommitSha?.toLowerCase() !== target.commit) {
      try {
        artifactTarget = await artifactProvider(target.source, target.commit, { cache: artifactCache });
        artifactProof = verifyClaudeArtifact(artifactTarget, p.installPath);
        target.version = artifactTarget.manifest.version || null;
      } catch (error) {
        // A rate-limited or oversized pinned-artifact proof leaves this plugin unproven, not the night failed (AuditC #16).
        const reason = `pinned artifact unproven: ${error.message}`;
        steps.push({ id: p.id, scope: p.scope, projectPath: p.projectPath, before: p, after: p, target, state: 'UNSUPPORTED', reason });
        notes.push(`plugin target unsupported; preserved: ${p.id}: ${reason}`);
        continue;
      }
    }
    let decision = p.scope === 'managed' ? { state: 'UNSUPPORTED', reason: 'managed scope belongs to its administrator' } : pluginUpdateDecision(artifactProof?.actualVersion ? { ...p, version: artifactProof.actualVersion } : p, target);
    if (artifactProof?.ok && decision.state !== 'AHEAD') decision = { state: 'CURRENT', proof: 'pinned-claude-artifact', sourceCommitMatched: false, actualClaudeSourceMatched: true, providerMetadataDiscrepancy: { recordedCommit: p.gitCommitSha, pinnedCommit: target.commit } };
    const step = { artifactProof, id: p.id, scope: p.scope, projectPath: p.projectPath, before: p, target, ...decision }; steps.push(step);
    if (decision.state === 'UNSUPPORTED') { notes.push(`plugin target unsupported; preserved: ${p.id}: ${decision.reason}`); continue; }
    if (decision.state === 'AHEAD') { notes.push(`ahead plugin preserved: ${p.id}`); continue; }
    if (dryRun || decision.state === 'CURRENT') { step.after = p; continue; }
    run(claude, ['plugin', 'update', p.id, '--scope', p.scope, '--json'], { cwd: p.projectPath || home });
    const live = pluginScopes(installed, inventoryOptions).find(item => scopeKey(item) === scopeKey(p));
    if (artifactTarget && live) { artifactProof = verifyClaudeArtifact(artifactTarget, live.installPath); step.artifactProof = artifactProof; }
    const exactCommit = target.commit && live?.gitCommitSha?.toLowerCase() === target.commit;
    if (!live || (target.commit ? !exactCommit && !artifactProof?.ok : live.version !== target.version)) throw Error(`plugin target not verified: ${p.id}`);
    if (target.commit && !exactCommit) Object.assign(step, { sourceCommitMatched: false, actualClaudeSourceMatched: true, providerMetadataDiscrepancy: { recordedCommit: live.gitCommitSha, pinnedCommit: target.commit } });
    Object.assign(step, { state: 'UPDATED', after: live });
  }
  const after = pluginScopes(installed, inventoryOptions).filter(p => before.some(b => scopeKey(b) === scopeKey(p)));
  if (JSON.stringify(all.map(scopeKey).sort()) !== JSON.stringify(pluginScopes(installed, inventoryOptions).map(scopeKey).sort())) throw Error('plugin install set changed');
  if (JSON.stringify(before.map(scopeKey).sort()) !== JSON.stringify(after.map(scopeKey).sort())) throw Error('plugin install scopes changed');
  for (const p of before.filter(p => !writable.includes(p))) if (JSON.stringify(p) !== JSON.stringify(after.find(a => scopeKey(a) === scopeKey(p)))) throw Error(`preserved plugin record changed: ${p.id}`);
  if (JSON.stringify(flags) !== JSON.stringify(pluginFlags(writable, home))) throw Error('plugin enablement changed');
  for (const p of after.filter(p => writable.some(b => scopeKey(b) === scopeKey(p)))) if (!exists(p.installPath)) throw Error(`plugin artifact missing: ${p.id}`);
  const codex = locate('codex');
  if (codex) {
    const result = JSON.parse(run(codex, ['plugin', 'marketplace', 'list', '--json'], { timeout: CODEX_COMMAND_TIMEOUT_MS }));
    const git = (result.marketplaces || []).filter(m => m.marketplaceSource?.sourceType === 'git' && (scope === 'all' || PLUGIN_MARKETPLACES.has(m.name)));
    if (!dryRun) for (const m of git) run(codex, ['plugin', 'marketplace', 'upgrade', m.name, '--json']);
    const help = run(codex, ['plugin', '--help'], { timeout: CODEX_COMMAND_TIMEOUT_MS });
    // Tripwire, reported not thrown: a new Codex command must not end the night before the knowledge is checked (AuditC #17).
    if (/^\s+update\s/m.test(help)) notes.push('Codex plugin update now exists and is unsupported until its scope-aware policy is reviewed; installed generations preserved');
    else notes.push('Codex has no plugin update command; configured Git catalogues refreshed, installed generations preserved');
  }
  if (JSON.stringify(flags) !== JSON.stringify(pluginFlags(writable, home))) throw Error('Codex plugin enablement changed');
  return { before, after, steps, provider };
}
// The bundle download may take its 90-minute deadline (kb/download-retry.mjs) plus the apply; host-update.mjs's own
// knowledge limit and the SessionStart TTL sit above this, so a kill never lands mid-transaction one level up.
export const INSTALL_UPDATE_TIMEOUT_MS = 135 * 60_000;
export const TRANSIENT_RETRY_DELAYS_MS = Object.freeze([15_000, 30_000]);
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const exitOf = result => typeof result === 'string' ? 0 : (result?.exitCode ?? result?.status ?? result?.code ?? null);
/** The lines of a child's output that say why it failed (the ✗/failed/incomplete ones, else its last lines), ANSI-free, <= 600 chars. */
export function outputReason(result) {
  if (!result || typeof result === 'string') return '';
  const lines = `${result.stderr || ''}\n${result.stdout || ''}`.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map(l => l.trim()).filter(Boolean);
  const telling = lines.filter(l => /✗|\berror\b|failed|incomplete|refused|timed out|ETIMEDOUT/i.test(l));
  return [...new Set((telling.length ? telling : lines).slice(-3))].join(' | ').slice(-600);
}
export const TRANSIENT_NETWORK = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ENETUNREACH|socket hang up|network|timed out|\bE5\d\d\b|\b50[234]\b/i;
/** Three tries of `attempt` (15 s, then 30 s apart) while `transient(error)` says the failure was the network's. */
export function withTransientRetry(attempt, { transient = () => true, sleep = sleepSync, delays = TRANSIENT_RETRY_DELAYS_MS } = {}) {
  for (let i = 0; ; i++) {
    try { return attempt(i); } catch (error) { if (i >= delays.length || !transient(error)) throw error; sleep(delays[i]); }
  }
}
export function knowledge(run, dryRun, runId, { brainHome, root, node, sleep = sleepSync, convergeRuntime = true }) {
  const kb = path.join(brainHome, 'kb'), updater = path.join(kb, 'forge-update.mjs');
  if (!exists(updater)) throw Error('existing Brain KB updater absent; fresh install refused');
  const file = path.join(brainHome, `nightly-suite-corpus-${runId}.json`);
  // Exit codes are forge-update's: 0 current, 10 newer, 2 network (retried), 5 incompatible with this runtime.
  let lastOutput = '';
  const exec = (args, options) => {
    if (!run.receipt) { run(node, args, options); return 0; }
    const result = run.receipt(node, args, options);
    lastOutput = outputReason(result);
    if (result?.error) throw Error(`${path.basename(args[0])} ${args[1]}: ${result.error}${lastOutput ? ` — ${lastOutput}` : ''}`);
    return exitOf(result);
  };
  function check() {
    const started = Date.now();
    const code = withTransientRetry(() => {
      const status = exec([updater, '--check', '--result-file', file], { timeout: 180_000, allowed: [0, 10, 2, 5] });
      if (status === 2) throw Object.assign(Error('corpus check could not reach the release (exit 2)'), { transient: true });
      return status;
    }, { transient: error => error.transient === true, sleep });
    if (code === 5) return { currencyVerdict: 'INCOMPATIBLE', exitCode: 5 };
    if (code !== 0 && code !== 10) throw Error(`corpus check exited ${code}${lastOutput ? `: ${lastOutput}` : ''}`);
    let receipt;
    try { receipt = read(file); } finally { fs.rmSync(file, { force: true }); }
    if (receipt.kind !== 'ruvnet-brain-check-result' || Date.parse(receipt.recordedAt) < started - 1000) throw Error('fresh corpus check receipt absent');
    return receipt;
  }
  const installer = path.join(root, 'ruvnet-brain/bin/install.mjs');
  const apply = () => {
    if (!exists(installer)) throw Error('existing Brain installer absent');
    // 12 is cleanup-pending: the knowledge was applied and the next run finishes the cleanup (shared exit contract).
    const code = exec([installer, '--update', '--no-nightly-prompt', '--no-stack'], { timeout: INSTALL_UPDATE_TIMEOUT_MS, allowed: [0, 12] });
    // The installer's own words ride along: "exited 1" alone hid a Codex timeout for three nights (2026-10-28..30).
    if (code !== 0 && code !== 12) throw Error(`Brain installer --update exited ${code}${lastOutput ? `: ${lastOutput}` : ''}`);
    return code;
  };
  const before = check();
  if (before.currencyVerdict === 'INCOMPATIBLE') {
    // A remembered rejection keyed to the KB's runtime stamp blocks every --check; only the installer re-stamps it. When the
    // installed package is a different version than the stamp, the installer is what clears it (AuditC #5).
    let installed = null, stamped = null;
    try { installed = read(path.join(root, 'ruvnet-brain/package.json')).version || null; } catch { /* no installed package */ }
    try { stamped = read(path.join(kb, 'RUNTIME-IDENTITY.json')).brainVersion || null; } catch { /* no stamp */ }
    if (!installed || installed === stamped) return { before, state: 'incompatible', installed, stamped };
    if (dryRun) return { before, state: 'update-available', reason: 'runtime stamp differs from the installed package', installed, stamped };
    const installerExit = apply(), after = check();
    if (!['CURRENT', 'REFUSED'].includes(after.currencyVerdict)) throw Error(`corpus update failed to converge after re-stamping ${stamped} -> ${installed}`);
    return { before, after, state: 'updated', installerExit, restamped: { from: stamped, to: installed } };
  }
  if (before.currencyVerdict === 'CURRENT' || before.currencyVerdict === 'REFUSED') {
    // A CURRENT corpus is not a converged machine: the package stage can install a newer ruvnet-brain on a night with no
    // new corpus, and only the installer's --update moves the runtime and hosts to it (a no-op on the corpus). Before
    // this, such a night reported "current" and left runtime + hosts on the old version until a corpus was published.
    const runtime = runtimeConvergence({ root, brainHome });
    const state = before.currencyVerdict === 'CURRENT' ? 'current' : 'ahead-preserved';
    if (runtime.converged) return { before, after: before, state, runtime };
    // The SessionStart self-heal (--knowledge-only) runs unattended without the nightly's identity, so an installer
    // run there would count as interactive (and could reload a shared Codex app-server): it reports, the nightly acts.
    if (!convergeRuntime) return { before, after: before, state, runtime, deferred: 'runtime convergence is left to the scheduled nightly' };
    if (dryRun) return { before, state: 'update-available', reason: runtime.reason, runtime };
    const installerExit = apply(), after = check(), converged = runtimeConvergence({ root, brainHome });
    if (!converged.converged) throw Error(`runtime did not converge: ${converged.reason}`);
    return { before, after, state: 'runtime-converged', installerExit, runtime: converged };
  }
  // UNKNOWN is what a tree installed from a code release reports (no corpus generation stamp): forge-update
  // documents it as apply-allowed, exactly like UPDATE_AVAILABLE, and the check after the apply must reach
  // CURRENT or REFUSED. Throwing here failed every scheduled night until someone ran --update by hand.
  if (before.currencyVerdict !== 'UPDATE_AVAILABLE' && before.currencyVerdict !== 'UNKNOWN') throw Error(`corpus currency unverified: ${before.currencyVerdict}`);
  if (dryRun) return { before, state: 'update-available' };
  const installerExit = apply();
  const after = check();
  if (!['CURRENT', 'REFUSED'].includes(after.currencyVerdict)) throw Error('corpus update failed to converge');
  // Positive confirmation: the corpus converged AND the runtime and hosts sit on the installed package.
  const runtime = runtimeConvergence({ root, brainHome });
  if (!runtime.converged) throw Error(`corpus updated but the runtime did not converge: ${runtime.reason}`);
  return { before, after, state: 'updated', installerExit, runtime };
}
/**
 * Does this machine RUN the installed ruvnet-brain package? The Stable Spine (active.json) and the host-convergence
 * receipt must name that version (or a newer one: ahead is not behind) and no host may be recorded failed. Evidence
 * that does not exist is not judged (an install without a spine has nothing to compare).
 */
export function runtimeConvergence({ root = ROOT, brainHome = CACHE } = {}) {
  const value = (file) => { try { return read(file); } catch { return null; } };
  // A linked source checkout's version is not a release the runtime can be converged to (it may be ahead of npm): its
  // versions are not compared, but a host recorded failed is still a host that did not converge.
  let linked = false;
  try { linked = fs.lstatSync(path.join(root, 'ruvnet-brain')).isSymbolicLink(); } catch { /* absent: judged below */ }
  const installed = linked ? null : value(path.join(root, 'ruvnet-brain/package.json'))?.version || null;
  const active = value(path.join(brainHome, 'active.json'));
  const receipt = value(path.join(brainHome, 'host-convergence.json'));
  const evidence = { installed, active: active?.version || null, desired: receipt?.desiredVersion || null };
  const behind = (version) => { try { return !version || compare(version, installed) < 0; } catch { return true; } };
  if (!installed && !linked) return { converged: true, ...evidence, reason: 'no installed ruvnet-brain package' };
  if (!linked && active && behind(active.version)) return { converged: false, ...evidence, reason: `runtime ${active.version || 'unknown'} is behind the installed package ${installed}` };
  if (!linked && receipt && behind(receipt.desiredVersion)) return { converged: false, ...evidence, reason: `hosts were last converged to ${receipt.desiredVersion || 'unknown'}, not the installed package ${installed}` };
  const failed = Object.entries(receipt?.hosts || {}).filter(([, host]) => !['ready', 'disabled', 'absent'].includes(host?.state));
  if (failed.length) return { converged: false, ...evidence, reason: `host ${failed.map(([name, host]) => `${name} ${host?.state || 'unknown'}${host?.error ? ` (${host.error})` : ''}`).join(', ')}` };
  if (linked) return { converged: true, ...evidence, reason: 'ruvnet-brain is a linked source checkout' };
  return { converged: true, ...evidence, reason: active || receipt ? `runtime and hosts on ${installed}` : 'no runtime evidence to compare' };
}
/** Corpus check results this coordinator left behind (a run killed between check and delete) older than 48 h. */
export function pruneCorpusResults(brainHome, now = Date.now()) {
  let removed = 0;
  for (const name of (() => { try { return fs.readdirSync(brainHome); } catch { return []; } })()) {
    if (!/^nightly-suite-corpus-[\w-]+\.json$/.test(name)) continue;
    const file = path.join(brainHome, name);
    try { if (fs.lstatSync(file).isFile() && now - fs.lstatSync(file).mtimeMs > 48 * 3_600_000) { fs.rmSync(file); removed++; } } catch { /* raced */ }
  }
  return removed;
}
export function developerUpdatePaths({ home = os.homedir(), brainHome = process.env.RUVNET_BRAIN_HOME || path.join(home, '.cache/ruvnet-brain') } = {}) {
  return { home, brainHome, config: path.join(brainHome, 'developer-update-config.json'),
    receipt: path.join(brainHome, 'nightly-suite-update.json'), scheduledReceipt: path.join(brainHome, 'scheduler/last-suite-attempt.json'), lock: path.join(brainHome, 'developer-update.lock') };
}
export function validateDeveloperUpdateConfig(value = {}) {
  const defaults = { schemaVersion: 1, channel: 'latest', scope: 'ruvnet', homebrew: false, uv: false, cargo: false, native: false, managedCallback: null, cleanup: false, preservePackages: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !Object.hasOwn(defaults, k))) throw Error('unknown developer update configuration');
  const config = { ...defaults, ...value };
  if (config.schemaVersion !== 1 || !['latest', 'alpha'].includes(config.channel) || !['ruvnet', 'all'].includes(config.scope)) throw Error('invalid developer update channel/scope');
  for (const key of ['homebrew', 'uv', 'cargo', 'native', 'cleanup']) if (typeof config[key] !== 'boolean') throw Error(`invalid ${key} flag`);
  if (!Array.isArray(config.preservePackages) || config.preservePackages.some(name => typeof name !== 'string' || !/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name))) throw Error('invalid preservePackages');
  if (config.managedCallback !== null && (typeof config.managedCallback !== 'string' || !path.isAbsolute(config.managedCallback))) throw Error('invalid maintenance callback');
  return config;
}
export function readDeveloperUpdateConfig(options = {}) {
  const paths = developerUpdatePaths(options);
  return validateDeveloperUpdateConfig(exists(paths.config) ? read(paths.config) : {});
}
export function writeDeveloperUpdateConfig(config, options = {}) {
  const value = validateDeveloperUpdateConfig(config);
  atomic(developerUpdatePaths(options).config, value);
  return value;
}
export function readDeveloperUpdateReceipt(options = {}) {
  const file = developerUpdatePaths(options).receipt;
  if (!exists(file)) return null;
  const value = read(file);
  if (value.schemaVersion !== 1 || value.kind !== 'nightly-suite-update') throw Error('invalid developer update receipt');
  return value;
}
export function locateExecutable(name, { env = process.env, platform = process.platform } = {}) {
  const suffixes = platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
  for (const directory of (env.PATH || '').split(path.delimiter).filter(Boolean)) for (const suffix of suffixes) {
    const file = path.resolve(directory, name + suffix);
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch { /* another installed owner */ }
  }
  return null;
}
// A failed scheduled knowledge stage is tried once more the same night, this long after the first attempt (a network or
// release-publication blip clears; a deterministic failure fails twice and pages with both reasons).
export const SCHEDULED_RETRY_DELAY_MS = 20 * 60_000;
/**
 * Page the owner about a scheduled night through the shipped scripts/notify.sh (ntfy). Topic: NTFY_TOPIC, else the
 * owner's `<brain home>/ntfy-topic` opt-in file; neither = paging off (recorded, not an error). Never throws, never
 * records the topic. `kind`: 'failed' (urgent) or 'recovered' (after a failed night).
 */
export function pageNight(receipt, kind, { root = ROOT, brainHome = CACHE, env = process.env, runner = invoke, platform = process.platform } = {}) {
  try {
    if (platform === 'win32') return { kind, state: 'unsupported', reason: 'scripts/notify.sh needs a POSIX shell' };
    const notify = path.join(root, 'ruvnet-brain/scripts/notify.sh');
    if (!exists(notify)) return { kind, state: 'unavailable', reason: 'the installed package has no scripts/notify.sh' };
    let topic = env.NTFY_TOPIC;
    if (topic === undefined) { try { topic = fs.readFileSync(path.join(brainHome, 'ntfy-topic'), 'utf8').trim(); } catch { topic = ''; } }
    if (!topic) return { kind, state: 'off', reason: 'no ntfy topic (NTFY_TOPIC or the brain home ntfy-topic file)' };
    const title = kind === 'failed' ? 'RuvNet Brain nightly update FAILED' : 'RuvNet Brain nightly update recovered';
    const body = `${kind === 'failed' ? receipt.error || receipt.state : `completed after a failed night (${receipt.state})`}\n\nrun ${receipt.runId}, started ${receipt.startedAt}\nreceipt: ${path.join(brainHome, 'scheduler', 'last-suite-attempt.json')}`;
    const r = runner('/bin/sh', [notify, title, body.slice(0, 1500), kind === 'failed' ? 'urgent' : 'default', kind === 'failed' ? 'rotating_light' : 'white_check_mark'],
      { capture: true, timeout: 30_000, env: { ...env, NTFY_TOPIC: topic } });
    const exitCode = r?.exitCode ?? null;
    return { kind, state: exitCode === 0 ? 'delivered' : exitCode === 2 ? 'off' : 'not-delivered', exitCode, at: new Date().toISOString() };
  } catch (error) { return { kind, state: 'not-delivered', reason: error.message }; }
}
export async function runDeveloperUpdate({ mode = 'check', home = os.homedir(), brainHome, config: override, runner = invoke, env = process.env, knowledgeOnly = false, sleep = sleepSync, retryDelayMs = SCHEDULED_RETRY_DELAY_MS } = {}) {
  if (!['check', 'apply'].includes(mode)) throw Error('mode must be check or apply');
  const paths = developerUpdatePaths({ home, brainHome });
  const config = validateDeveloperUpdateConfig(override || readDeveloperUpdateConfig(paths));
  const lock = acquireDeveloperLock({ brainHome: paths.brainHome, token: env.RUVNET_DEVELOPER_UPDATE_TOKEN });
  const childEnv = { ...env, HOME: home, USERPROFILE: home, RUVNET_BRAIN_HOME: paths.brainHome,
    RUVNET_DEVELOPER_UPDATE_TOKEN: lock.token, DISABLE_AUTOUPDATER: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1', HOMEBREW_NO_AUTO_UPDATE: '1' };
  const dispatch = (command, args, options = {}) => {
    if (process.platform === 'win32' && /npm\.cmd$/i.test(command)) {
      const cli = path.join(path.dirname(command), 'node_modules/npm/bin/npm-cli.js');
      if (!exists(cli)) throw Error('Windows npm CLI identity absent');
      return runner(process.execPath, [cli, ...args], { cwd: home, ...options, env: childEnv });
    }
    return runner(command, args, { cwd: home, ...options, env: childEnv });
  };
  const run = (command, args, options = {}) => {
    const result = dispatch(command, args, options);
    if (typeof result === 'string') return result; // existing read-only test adapters
    const exitCode = result?.exitCode ?? result?.status ?? result?.code;
    if (result?.error || !(options.allowed || [0]).includes(exitCode) || typeof result?.stdout !== 'string') throw Error(`command result unverified: ${command}`);
    return result.stdout;
  };
  run.receipt = (command, args, options = {}) => dispatch(command, args, { ...options, capture: true });
  const locate = name => locateExecutable(name, { env: childEnv });
  const receipt = { schemaVersion: 1, kind: 'nightly-suite-update', runId: crypto.randomUUID(), pid: process.pid,
    startedAt: new Date().toISOString(), mode, knowledgeOnly, scheduled: mode === 'apply' && env.RUVNET_NIGHTLY === '1' && !!env.RUVNET_NIGHTLY_IDENTITY, state: 'running', ok: false, config, steps: [], notes: [],
    sourceSha256: null, ownerToken: lock.token, ownerPid: lock.ownerPid, schedulerIdentity: env.RUVNET_NIGHTLY_IDENTITY || null };
  const scheduledAttempt = value => value?.mode === 'apply' && value.scheduled !== false && !!value.schedulerIdentity;
  const readAttempt = file => {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('scheduled receipt must be a regular file');
      return read(file);
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const persistReceipt = () => {
    // Write Activity first: if the second write fails, health still sees this newer failed attempt.
    atomic(paths.receipt, receipt);
    if (receipt.scheduled) {
      try { atomic(paths.scheduledReceipt, receipt); }
      catch (error) {
        receipt.state = 'failed'; receipt.ok = false; receipt.error = `Scheduled receipt persistence failed: ${error.message}`;
        atomic(paths.receipt, receipt);
        throw error;
      }
    }
  };
  let latestMayBeReplaced = receipt.scheduled;
  let previousScheduled = null;
  try { previousScheduled = receipt.scheduled ? readAttempt(paths.scheduledReceipt) : null; } catch { previousScheduled = null; }
  try {
    if (!receipt.scheduled) {
      const latest = readAttempt(paths.receipt), retained = readAttempt(paths.scheduledReceipt);
      const latestTime = Date.parse(latest?.startedAt || latest?.finishedAt || ''), retainedTime = Date.parse(retained?.startedAt || retained?.finishedAt || '');
      if (scheduledAttempt(latest) && (!retained || !Number.isFinite(latestTime) || !Number.isFinite(retainedTime) || latestTime >= retainedTime)) {
        // Preserve real legacy/failed evidence before a check or manual run replaces Activity.
        atomic(paths.scheduledReceipt, latest);
      }
      latestMayBeReplaced = true;
    }
    receipt.sourceSha256 = hash(fs.readFileSync(new URL(import.meta.url)));
    receipt.sourceSnapshot = Object.fromEntries(EXECUTION_MODULES.map(name => [name, hash(fs.readFileSync(new URL(name, import.meta.url)))]));
    persistReceipt();
    const npm = locate('npm');
    if (!npm) throw Error('existing npm owner absent; fresh install refused');
    const prefix = run(npm, ['prefix', '-g'], { timeout: 30_000 }).trim();
    const root = run(npm, ['root', '-g'], { timeout: 30_000 }).trim();
    if (!path.isAbsolute(prefix) || !path.isAbsolute(root)) throw Error('npm global identity unverified');
    // Bind every subsequent install to this exact prefix instead of inherited npm config.
    childEnv.npm_config_prefix = prefix;
    receipt.npmIdentity = { npm, prefix, root, node: process.execPath };
    // Each stage is isolated: a failure is recorded on its stage and the run goes on, so one npm view, one plugin or a missing
    // CLI can no longer cost the night its knowledge update (AuditC #1). Packages run before knowledge so a new code package's
    // installer applies its matching corpus; knowledge is always attempted when the KB exists.
    const failures = [];
    const stage = async (name, body, onError = () => {}) => {
      try { return await body(); } catch (error) { failures.push({ stage: name, error: error.message }); onError(error); persistReceipt(); return undefined; }
    };
    const viewRetry = attempt => withTransientRetry(attempt, { transient: error => TRANSIENT_NETWORK.test(error.message), sleep });
    if (!knowledgeOnly) {
      // An inventory failure is recorded in failures; no package is then touched, and knowledge still runs.
      receipt.before = (await stage('inventory', () => discover(root, prefix, config.scope))) ?? [];
      persistReceipt();
      for (const before of receipt.before) {
        await stage(`package ${before.name}`, () => {
          const tags = before.localSource ? {} : JSON.parse(viewRetry(() => run(npm, ['view', before.name, 'dist-tags', '--json'], { timeout: 90_000 })));
          // A tracked non-latest tag (alpha, Kit's next) needs publish times to tell a newer pre-release from an abandoned
          // one (developer-update-policy pickTargetTag); fetched only when that tag and latest name different versions. A
          // failed lookup is {} — required but unknown — so the pre-release is skipped, never installed blind.
          let published = null;
          if (!before.localSource) {
            let needed = false;
            try { needed = needsPublishTimes(normalizeNpmDistTags(tags), wantedTag(before.name, config.channel)); } catch { needed = false; }
            if (needed) {
              try { published = JSON.parse(viewRetry(() => run(npm, ['view', before.name, 'time', '--json'], { timeout: 90_000 }))); }
              catch { published = {}; }
            }
          }
          receipt.steps.push(upgradePackage(before, tags, REVIEWED_INSTALL_SCRIPTS, { run, dryRun: mode === 'check', channel: config.channel, npm, preservePackages: config.preservePackages, published }));
        }, error => receipt.steps.push({ name: before.name, state: 'failed', error: error.message, before }));
        persistReceipt();
      }
    }
    if (exists(path.join(paths.brainHome, 'kb/forge-update.mjs'))) {
      const knowledgeStage = () => stage('knowledge', () => knowledge(run, mode === 'check', receipt.runId, { brainHome: paths.brainHome, root, node: process.execPath, sleep, convergeRuntime: !knowledgeOnly }),
        error => { receipt.knowledge = { state: 'failed', error: error.message }; });
      receipt.knowledge = await knowledgeStage() ?? receipt.knowledge;
      // SELF-RETRY THE SAME NIGHT (2026-10-30): a scheduled night whose knowledge stage failed tries once more after
      // retryDelayMs. Only the second attempt's outcome counts; the first one's reason stays on the receipt.
      if (receipt.scheduled && mode === 'apply' && receipt.knowledge?.state === 'failed') {
        const firstAttemptError = receipt.knowledge.error;
        receipt.notes.push(`knowledge attempt 1 failed (${firstAttemptError}); retrying once in ${Math.round(retryDelayMs / 60_000)} min`);
        persistReceipt();
        sleep(retryDelayMs);
        const firstFailure = failures.findIndex(f => f.stage === 'knowledge');
        if (firstFailure >= 0) failures.splice(firstFailure, 1);
        receipt.knowledge = { ...(await knowledgeStage() ?? receipt.knowledge), attempts: 2, firstAttemptError };
      }
      pruneCorpusResults(paths.brainHome);
    } else receipt.notes.push('Brain corpus absent; fresh knowledge install excluded');
    persistReceipt();
    if (!knowledgeOnly) {
      receipt.plugins = await stage('plugins', () => synchronizePlugins(run, mode === 'check', receipt.notes, { home, prefix, scope: config.scope, locate, unattended: !!env.RUVNET_NIGHTLY_IDENTITY }));
      receipt.maintenance = await stage('maintenance', () => maintenance(config, run, mode === 'check', { home, brainHome: paths.brainHome, locate, node: process.execPath, progress: result => { receipt.maintenance = result; persistReceipt(); } }),
        error => { for (const item of receipt.maintenance?.stages || []) if (item.state === 'running') { item.state = 'failed'; item.error = error.message; } }) ?? receipt.maintenance;
      receipt.cleanup = await stage('cleanup', () => cleanupNpxDuplicates({ home, globalRoot: root, enabled: config.cleanup && mode === 'apply', run }));
      receipt.after = await stage('inventory-after', () => discover(root, prefix, config.scope));
    } else receipt.notes.push('knowledge-only run: packages, plugins and maintenance are left to the scheduled nightly');
    receipt.failures = failures; receipt.ok = failures.length === 0;
    receipt.state = failures.length ? 'completed-with-failures' : mode === 'check' ? 'checked' : 'completed';
    receipt.coverage = { scope: knowledgeOnly ? 'knowledge-only' : config.scope, excluded: receipt.steps.filter(s => /preserved$/.test(s.state)).map(s => ({ name: s.name, reason: s.state })),
      ahead: receipt.steps.filter(s => s.state === 'ahead-preserved').map(s => s.name),
      preservedLocalModification: receipt.steps.filter(s => s.reason === 'preservedLocalModification').map(s => s.name),
      unverified: [...new Set([...failures.map(f => `${f.stage}: ${f.error}`), ...receipt.notes.filter(note => /unverified|unsupported|no plugin update command/i.test(note)), ...(receipt.plugins?.steps || []).filter(step => step.state === 'UNSUPPORTED').map(step => `${step.id} (${step.scope}): ${step.reason}`)])], notes: [...receipt.notes, ...(receipt.maintenance?.exclusions || [])] };
    if (failures.length) {
      // Throw only after the receipt says which stages failed: the runner still exits 1 exactly as before.
      receipt.error = failures.map(f => `${f.stage}: ${f.error}`).join('; ');
      persistReceipt();
      throw Object.assign(Error(`developer update completed with failures: ${receipt.error}`), { completedWithFailures: true });
    }
    return receipt;
  } catch (error) {
    if (!error.completedWithFailures) {
      receipt.state = 'failed'; receipt.error = error.message;
      for (const item of receipt.maintenance?.stages || []) if (item.state === 'running') { item.state = 'failed'; item.error = error.message; }
      receipt.coverage = { scope: config.scope, unverified: [error.message], notes: receipt.notes };
      try { if (receipt.npmIdentity) receipt.after = discover(receipt.npmIdentity.root, receipt.npmIdentity.prefix, config.scope); } catch (e) { receipt.snapshotError = e.message; }
    }
    throw error;
  } finally {
    receipt.finishedAt = new Date().toISOString();
    // Every scheduled night ends with a word to the owner when it failed, and once more when it recovers.
    if (receipt.scheduled && mode === 'apply') {
      const previousFailed = previousScheduled && previousScheduled.ok !== true && previousScheduled.state !== 'running';
      if (receipt.ok !== true) receipt.page = pageNight(receipt, 'failed', { root: receipt.npmIdentity?.root, brainHome: paths.brainHome, env, runner });
      else if (previousFailed) receipt.page = pageNight(receipt, 'recovered', { root: receipt.npmIdentity?.root, brainHome: paths.brainHome, env, runner });
    }
    try { if (latestMayBeReplaced) persistReceipt(); } finally { lock.release(); }
  }
}
export async function developerUpdateCli(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: ruvnet-brain-update [--check|--apply] [--knowledge-only] [--channel latest|alpha] [--scope ruvnet|all]');
    return;
  }
  // --knowledge-only: npm identity plus the knowledge step under the same lock (the SessionStart self-heal); the full suite
  // runs only from the scheduled runner.
  let mode = 'apply', knowledgeOnly = false; const override = readDeveloperUpdateConfig();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--knowledge-only') knowledgeOnly = true;
    else if (args[i] === '--check' || args[i] === '--dry-run') mode = 'check';
    else if (args[i] === '--apply') mode = 'apply';
    else if (args[i] === '--channel') override.channel = args[++i];
    else if (args[i] === '--scope') override.scope = args[++i];
    else throw Error(`unsupported developer update argument: ${args[i]}`);
  }
  const result = await runDeveloperUpdate({ mode, config: override, knowledgeOnly });
  console.log(JSON.stringify(result));
  return result;
}
if (isDirectInvocation(import.meta.url)) developerUpdateCli().catch(error => { console.error(error.message); process.exitCode = 1; });
