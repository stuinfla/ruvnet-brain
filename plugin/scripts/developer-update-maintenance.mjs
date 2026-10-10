// Explicitly enabled existing-owner stages. No cleanup, fresh installs or local-source conversion.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cmpVersion as compare } from './developer-update-policy.mjs';
const HOME = os.homedir();
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
function required(p) { fs.accessSync(p, fs.constants.X_OK); return p; }
export function cargoInventory(root = path.join(HOME, '.cargo')) {
  return Object.entries(read(path.join(root, '.crates2.json')).installs || {}).map(([key, value]) => {
    const m = /^(\S+) (\S+) \(([^)]+)\)$/.exec(key);
    if (!m) throw Error(`unattributable cargo install: ${key}`);
    return { name: m[1], version: m[2], source: m[3], ...value };
  });
}
export function uvInventory(root = path.join(HOME, '.local/share/uv/tools')) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(name => fs.existsSync(path.join(root, name, 'uv-receipt.toml'))).map(name => {
    const receipt = fs.readFileSync(path.join(root, name, 'uv-receipt.toml'), 'utf8');
    // Only plain unpinned registry requirements qualify; wheels, paths, git and pins stay unchanged.
    const registry = new RegExp(`requirements\\s*=\\s*\\[\\{\\s*name\\s*=\\s*"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*\\}\\]`).test(receipt);
    return { name, root: path.join(root, name), registry, receipt };
  });
}
export function verifyMaintenanceStage(commands, postconditions) {
  const failures = Object.entries(postconditions).filter(([, passed]) => passed !== true).map(([name]) => name);
  const commandFailures = commands.filter(command => command.exitCode !== 0 || command.error);
  return { ok: failures.length === 0 && commandFailures.length === 0, postconditions, commandFailures, failures };
}
function commandOutput(run, command, args, options, stage) {
  const result = run.receipt ? run.receipt(command, args, options) : run(command, args, options);
  const exitCode = result?.exitCode ?? result?.status ?? result?.code;
  const captured = { command, args, exitCode, error: result?.error || null, stdout: result?.stdout, stderr: result?.stderr || '' };
  stage?.commands.push(captured);
  if (!Number.isInteger(exitCode) || exitCode !== 0 || captured.error || typeof captured.stdout !== 'string') throw Error(`provider command failed or exit evidence absent: ${command} ${args[0]} (exit ${exitCode})`);
  return captured.stdout;
}
function settleStage(stage, after, postconditions, fields = {}) {
  const verification = verifyMaintenanceStage(stage.commands, postconditions);
  Object.assign(stage, { after, verification, ...fields, state: verification.ok ? 'completed' : 'failed' });
  if (!verification.ok) throw Error(`provider postconditions failed: ${stage.owner}: ${verification.failures.join(', ')}`);
}
export async function maintenance(config, run, dryRun, { home = HOME, brainHome, locate = () => null, node = process.execPath, progress = () => {} } = {}) {
  const result = { stages: [], exclusions: [] };
  progress(result);
  for (const [name, enabled] of Object.entries(config)) {
    if (!['schemaVersion', 'scope', 'channel', 'cleanup', 'preservePackages', 'homebrew', 'uv', 'cargo', 'native', 'managedCallback'].includes(name)) throw Error(`unknown maintenance flag: ${name}`);
    if (['homebrew', 'uv', 'cargo', 'native'].includes(name) && typeof enabled !== 'boolean') throw Error(`maintenance flag must be boolean: ${name}`);
  }
  const uvTools = config.uv ? uvInventory(path.join(home, '.local/share/uv/tools')) : [];
  const hasEntries = directory => { try { return fs.readdirSync(directory).length > 0; } catch { return false; } };
  if (config.homebrew && !locate('brew') && [path.join(home, '.linuxbrew/Cellar'), '/opt/homebrew/Cellar', '/usr/local/Cellar', '/home/linuxbrew/.linuxbrew/Cellar'].some(hasEntries)) throw Error('installed Homebrew formulas have no existing Homebrew manager');
  const cratesFile = path.join(home, '.cargo/.crates2.json');
  if (uvTools.length && !locate('uv')) throw Error('installed uv tools have no existing uv manager');
  if (config.cargo && fs.existsSync(cratesFile) && cargoInventory(path.dirname(cratesFile)).length && !locate('cargo')) throw Error('installed Cargo tools have no existing Cargo manager');
  if (config.native) {
    for (const [file, args] of [[path.join(home, '.bun/bin/bun'), ['upgrade']], [path.join(home, '.local/bin/uv'), ['self', 'update']],
      [path.join(home, '.cargo/bin/rustup'), ['self', 'update']], [path.join(home, '.local/bin/codex'), ['update']]]) {
      if (!fs.existsSync(file)) { result.exclusions.push(`native owner absent: ${file}`); continue; }
      const resolved = fs.realpathSync(file);
      if (resolved.split(path.sep).includes('node_modules')) { result.exclusions.push(`npm owns native alias: ${file}`); continue; }
      required(file);
      const owner = fs.realpathSync(file), stage = { owner: file, originalTarget: owner, state: 'running', commands: [] }; result.stages.push(stage);
      const before = commandOutput(run, file, ['--version'], { timeout: 30_000 }, stage); stage.before = before;
      if (!dryRun) commandOutput(run, file, args, { timeout: 900_000 }, stage);
      const after = commandOutput(run, file, ['--version'], { timeout: 30_000 }, stage);
      const version = text => text.match(/\b(\d+\.\d+\.\d+(?:-[\w.-]+)?)/)?.[1];
      const versionVerified = !!version(before) && !!version(after) && compare(version(after), version(before)) >= 0;
      // Native launchers may re-point to a newer version, but stay in the same established root.
      const afterOwner = fs.realpathSync(file);
      const ownerPreserved = !(owner === file && afterOwner !== file) && !afterOwner.split(path.sep).includes('node_modules');
      settleStage(stage, after, { versionVerified, ownerPreserved }, { currentTarget: afterOwner });
    }
    const rustup = path.join(home, '.cargo/bin/rustup');
    if (fs.existsSync(rustup)) {
    const stage = { owner: 'rust-toolchains', commands: [], state: 'running' }; result.stages.push(stage);
    const before = commandOutput(run, rustup, ['toolchain', 'list'], { timeout: 30_000 }, stage); stage.before = before;
    const channels = before.split('\n').map(l => l.split(/\s/)[0]).filter(n => /^(stable|nightly)(-|$)/.test(n));
    if (!dryRun) for (const channel of channels) commandOutput(run, rustup, ['update', channel, '--no-self-update'], { timeout: 1_800_000 }, stage);
    const after = commandOutput(run, rustup, ['toolchain', 'list'], { timeout: 30_000 }, stage);
    const names = text => text.split('\n').filter(Boolean).map(line => line.split(/\s/)[0]);
    settleStage(stage, after, { toolchainsPreserved: names(before).every(name => names(after).includes(name)) }, { channels });
    result.exclusions.push('Pinned Rust toolchains and all local-source builds preserved');
    }
  }
  if (config.homebrew && locate('brew')) {
    const brew = required(locate('brew'));
    const stage = { owner: 'homebrew-formulas', commands: [], state: 'running' }; result.stages.push(stage);
    const snapshot = () => JSON.parse(commandOutput(run, brew, ['info', '--json=v2', '--installed'], { timeout: 120_000 }, stage));
    const before = snapshot(); stage.before = before;
    if (!dryRun) {
      // HOMEBREW_NO_INSTALL_CLEANUP also set in coordinator child environment.
      commandOutput(run, brew, ['update'], { timeout: 600_000 }, stage);
      commandOutput(run, brew, ['upgrade', '--formula'], { timeout: 3_600_000 }, stage);
    }
    const after = snapshot();
    const names = x => x.formulae.map(f => f.full_name).sort();
    settleStage(stage, after, { formulaOwnersPreserved: names(before).every(name => names(after).includes(name)) });
    result.exclusions.push('Homebrew casks need their application-specific owner (VS Code is the managed callback)');
  }
  if (config.uv && locate('uv')) {
    const uv = required(locate('uv'));
    const before = uvInventory(path.join(home, '.local/share/uv/tools'));
    const stage = { owner: 'uv-registry-tools', before, state: 'running', commands: [] }; result.stages.push(stage);
    if (!dryRun) for (const tool of before) if (tool.registry) commandOutput(run, uv, ['tool', 'upgrade', tool.name], { timeout: 900_000 }, stage);
    const after = uvInventory(path.join(home, '.local/share/uv/tools'));
    if (JSON.stringify(before.map(t => t.name).sort()) !== JSON.stringify(after.map(t => t.name).sort())) throw Error('uv tool install set changed');
    for (const tool of before.filter(t => !t.registry)) {
      if (after.find(t => t.name === tool.name)?.receipt !== tool.receipt) throw Error(`uv source changed: ${tool.name}`);
      result.exclusions.push(`uv source/pin preserved: ${tool.name}`);
    }
    // Provider's --outdated result is captured rather than asserting public registry currency for local wheels.
    const currency = commandOutput(run, uv, ['tool', 'list', '--outdated'], { timeout: 180_000 }, stage);
    settleStage(stage, after, { toolSetPreserved: JSON.stringify(before.map(t => t.name).sort()) === JSON.stringify(after.map(t => t.name).sort()),
      sourceRequirementsPreserved: before.filter(t => !t.registry).every(t => after.find(a => a.name === t.name)?.receipt === t.receipt), currencyChecked: typeof currency === 'string' }, { currency });
  }
  if (config.cargo && fs.existsSync(path.join(home, '.cargo/.crates2.json')) && locate('cargo')) {
    const root = path.join(home, '.cargo'), cargo = required(locate('cargo'));
    const before = cargoInventory(root);
    const stage = { owner: 'cargo-registry-tools', before, state: 'running', commands: [], targets: [] }; result.stages.push(stage);
    for (const tool of before) {
      if (tool.source !== 'registry+https://github.com/rust-lang/crates.io-index' || tool.version_req) {
        result.exclusions.push(`Cargo source/pin preserved: ${tool.name}`); continue;
      }
      for (const bin of tool.bins) required(path.join(root, 'bin', bin));
      const response = await fetch(`https://crates.io/api/v1/crates/${encodeURIComponent(tool.name)}`, { signal: AbortSignal.timeout(45_000), headers: { 'User-Agent': 'ruvnet-brain/developer-update' } });
      if (!response.ok) throw Error(`Cargo registry HTTP ${response.status}`);
      const metadata = await response.json();
      const target = metadata.crate?.max_stable_version;
      if (!target) throw Error(`Cargo release unverified: ${tool.name}`);
      stage.targets.push({ name: tool.name, target, registryOk: response.ok });
      if (!dryRun && compare(target, tool.version) > 0) {
        const args = ['install', tool.name, '--force', '--root', root];
        if (tool.all_features) args.push('--all-features');
        if (tool.no_default_features) args.push('--no-default-features');
        if (tool.features?.length) args.push('--features', tool.features.join(','));
        if (tool.target) args.push('--target', tool.target);
        commandOutput(run, cargo, args, { timeout: 3_600_000 }, stage);
        const live = cargoInventory(root).find(t => t.name === tool.name);
        if (!live || compare(live.version, target) < 0 || compare(live.version, tool.version) < 0) throw Error(`Cargo update not verified: ${tool.name}`);
        for (const bin of tool.bins) required(path.join(root, 'bin', bin));
      }
    }
    const after = cargoInventory(root);
    for (const tool of before.filter(t => !t.source.startsWith('registry+'))) {
      const live = after.find(t => t.name === tool.name);
      if (!live || live.version !== tool.version || live.source !== tool.source) throw Error(`Cargo local source changed: ${tool.name}`);
    }
    settleStage(stage, after, { registryTargetsVerified: stage.targets.every(t => t.registryOk && (dryRun || compare(after.find(a => a.name === t.name)?.version || '', t.target) >= 0)),
      sourcesPreserved: before.filter(t => !t.source.startsWith('registry+')).every(t => after.some(a => a.name === t.name && a.version === t.version && a.source === t.source)),
      noDowngrade: before.every(t => after.some(a => a.name === t.name && compare(a.version, t.version) >= 0)) });
  }
  if (config.managedCallback) {
    const file = config.managedCallback;
    if (typeof file !== 'string' || !path.isAbsolute(file) || ![path.join(home, '.codex/scripts/'), path.join(brainHome || home, 'scripts/')].some(root => file.startsWith(root)) || !file.endsWith('.mjs')) throw Error('managed callback must be an existing Codex scripts .mjs owner');
    required(file);
    const stage = { owner: file, state: 'running', commands: [] }; result.stages.push(stage);
    const receipt = JSON.parse(commandOutput(run, node, [file, dryRun ? '--check' : '--apply'], { timeout: 3_600_000 }, stage));
    if (receipt.ok !== true || !receipt.before || !receipt.after) throw Error('managed callback did not prove success with source snapshots');
    stage.before = receipt.before;
    settleStage(stage, receipt.after, { callbackSnapshotsPresent: !!receipt.before && !!receipt.after, callbackVerified: receipt.ok === true }, { receipt });
  }
  for (const name of ['homebrew', 'uv', 'cargo']) if (config[name] && !result.stages.some(s => s.owner.startsWith(name === 'homebrew' ? 'homebrew' : name))) result.exclusions.push(`${name} has no existing attributable owner/tool inventory`);
  for (const name of ['homebrew', 'uv', 'cargo', 'native']) if (!config[name]) result.exclusions.push(`${name} maintenance disabled`);
  return result;
}
