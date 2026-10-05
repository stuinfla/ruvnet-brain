// tests/unit/model-router-update-convergence.test.mjs — issue #87's actual mechanism.
//
// mergeManagedCatalog() was already correct, and the managed template already carries the new Claude
// candidate. The reason a user still never acquired it: the merge's ONLY caller was
// offerRouterProfile(), which runs on the FRESH-INSTALL path. runUpdate() — `--update`, and therefore
// the Evergreen nightly job — never reached it. So the merge could only ever help someone who had no
// ~/.claude/model-router/catalog.json yet, i.e. precisely the population that was never behind. Every
// existing user, the only ones who can be missing a model, updated forever and converged on nothing.
//
// The regression test that matters is therefore NOT another unit test of the merge function. It is:
// run the REAL update entrypoint against an old user catalog and assert the file on disk changed.

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runtimeSnapshot } from '../../scripts/model-routing-launchers.mjs';
import { applyManagedCatalogUpdate } from '../../scripts/model-router-catalog.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const INSTALLER = path.join(ROOT, 'bin', 'install.mjs');
const MANAGED = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'config', 'model-router', 'catalog.template.json'), 'utf8',
));
// Never a model name from memory or from this test's own opinion: the candidates under test are the
// managed subscription rows the shipped template actually carries, whatever they are today.
const MANAGED_SUBSCRIPTION_IDS = MANAGED.candidates
  .filter((candidate) => (candidate.subscription || []).length > 0)
  .map((candidate) => candidate.id);
const temps = [];

function temporary(prefix) {
  const value = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(value);
  return value;
}

/** The staged plugin payload `--host-sync-only` converges onto, exactly as the Console runtime
 *  transaction suite builds it — without it the Stable Spine refuses and the update exits non-zero. */
function stagedPayload(home) {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const dir = path.join(home, '.claude', 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain', version);
  for (const relative of ['scripts', 'hooks', '.claude-plugin', 'commands']) {
    fs.mkdirSync(path.join(dir, relative), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'scripts', 'body.mjs'), `export default ${JSON.stringify(version)};\n`);
  fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), '{"hooks":{}}\n');
  fs.writeFileSync(path.join(dir, 'commands', 'rvbc.md'), '# console\n');
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }));
}

/** A user who installed before the new managed model existed, carrying a real override. */
function oldUserCatalog(routerDir) {
  fs.mkdirSync(routerDir, { recursive: true });
  const catalog = {
    updated: '2026-07-12 (local)',
    candidates: [
      { id: 'claude-opus-4-8', provider: 'anthropic', harness: [], subscription: [], tier: 'mid', disabled: true },
      { id: 'custom/local', provider: 'local', harness: ['claude-code'], subscription: [], tier: 'cheap' },
    ],
  };
  const file = path.join(routerDir, 'catalog.json');
  fs.writeFileSync(file, `${JSON.stringify(catalog, null, 2)}\n`);
  return { file, catalog };
}

afterEach(() => {
  for (const value of temps.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe('issue #87 — managed additions reach an existing user', () => {
  it('adds the managed candidate, preserves overrides, and never auto-enables a metered row', () => {
    const routerDir = path.join(temporary('brain-issue87-merge-'), '.claude', 'model-router');
    const { file, catalog } = oldUserCatalog(routerDir);

    const receipt = applyManagedCatalogUpdate({ routerDir, packageRoot: ROOT });
    expect(receipt.action).toBe('merged');

    const merged = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Every managed subscription row the template ships is now reachable — including the Claude
    // model this user's pre-existing catalog predated, which is the whole of #87.
    const ids = merged.candidates.map((c) => c.id);
    for (const id of MANAGED_SUBSCRIPTION_IDS) expect(ids).toContain(id);
    // The user's overlay wins byte-for-byte, disablement and re-tiering included.
    expect(merged.candidates.find((c) => c.id === 'claude-opus-4-8')).toEqual(catalog.candidates[0]);
    expect(merged.candidates).toContainEqual(catalog.candidates[1]);
    // Managed updates may never quietly widen spend authority.
    expect(merged.candidates.filter((c) => c.provider === 'openrouter')).toEqual([]);
    // The pre-merge file is kept, so a surprised user can always get their original back.
    expect(JSON.parse(fs.readFileSync(`${file}.pre-managed-merge`, 'utf8'))).toEqual(catalog);
  });

  it('is idempotent and leaves no staging debris', () => {
    const routerDir = path.join(temporary('brain-issue87-idempotent-'), '.claude', 'model-router');
    const { file } = oldUserCatalog(routerDir);
    applyManagedCatalogUpdate({ routerDir, packageRoot: ROOT });
    const once = fs.readFileSync(file);

    expect(applyManagedCatalogUpdate({ routerDir, packageRoot: ROOT }).action).toBe('unchanged');
    expect(fs.readFileSync(file)).toEqual(once);
    expect(fs.readdirSync(routerDir).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('THE REAL PATH: `--update` converges an existing user catalog, not just a fresh install', () => {
    const home = temporary('brain-issue87-update-');
    const kb = path.join(home, '.cache', 'ruvnet-brain', 'kb');
    fs.mkdirSync(path.join(kb, '.console-runtime', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(kb, '.console-runtime', 'scripts', 'onboarding-console.mjs'), '// PRIOR\n');
    stagedPayload(home);
    const routerDir = path.join(home, '.claude', 'model-router');
    const { file, catalog } = oldUserCatalog(routerDir);

    const run = spawnSync(process.execPath, [INSTALLER, '--update', '--host-sync-only'], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: path.join(home, '.codex'),
        RUVNET_BRAIN_HOME: path.join(home, '.cache', 'ruvnet-brain'),
        RUVNET_BRAIN_KB: kb,
        RUVNET_BRAIN_TEST: '1',
      },
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);

    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ids = after.candidates.map((c) => c.id);
    for (const id of MANAGED_SUBSCRIPTION_IDS) expect(ids, `${id} never reached the user's catalog`).toContain(id);
    expect(after.candidates.find((c) => c.id === 'claude-opus-4-8')).toEqual(catalog.candidates[0]);
    expect(after.candidates).toContainEqual(catalog.candidates[1]);
    expect(after.candidates.filter((c) => c.provider === 'openrouter')).toEqual([]);
  }, 120_000);
});

function runRouterUpdate(home) {
  const kb = path.join(home,'.cache','ruvnet-brain','kb');
  fs.mkdirSync(path.join(kb,'.console-runtime','scripts'),{recursive:true});
  fs.writeFileSync(path.join(kb,'.console-runtime','scripts','onboarding-console.mjs'),'// PRIOR\n');
  stagedPayload(home);
  const result=spawnSync(process.execPath,[INSTALLER,'--update','--host-sync-only'],{
    env:{...process.env,HOME:home,USERPROFILE:home,CODEX_HOME:path.join(home,'.codex'),RUVNET_BRAIN_HOME:path.join(home,'.cache','ruvnet-brain'),RUVNET_BRAIN_KB:kb,RUVNET_BRAIN_TEST:'1'},
    encoding:'utf8',timeout:120000,
  });
  expect(result.status,`${result.stdout}\n${result.stderr}`).toBe(0);
}

describe('managed router default reaches the real installer update entry',()=>{
  it('upgrades a legacy default with exact backup, preserves all user overrides, and repeats idempotently',()=>{
    const home=temporary('router-default-upgrade-');const dir=path.join(home,'.claude','model-router');
    fs.mkdirSync(dir,{recursive:true});
    const legacy="// personal legacy source\nexport function choose(){return {model:'fixture',taskClass:'medium',effort:'medium'}}\n";
    fs.writeFileSync(path.join(dir,'policy.default.mjs'),legacy);
    const overrides={'policy.mjs':'// CUSTOM OVERRIDE\n','profile.json':'{"custom":"profile"}\n','routing-policy.json':'{"custom":"allocation"}\n'};
    for(const [name,value] of Object.entries(overrides))fs.writeFileSync(path.join(dir,name),value);
    runRouterUpdate(home);
    const shipped=fs.readFileSync(path.join(ROOT,'config','model-router','policy.default.mjs'),'utf8');
    expect(fs.readFileSync(path.join(dir,'policy.default.mjs'),'utf8')).toBe(shipped);
    const backups=fs.readdirSync(dir).filter(name=>name.startsWith('policy.default.mjs.pre-managed-upgrade-'));
    expect(backups).toHaveLength(1);expect(fs.readFileSync(path.join(dir,backups[0]),'utf8')).toBe(legacy);
    for(const [name,value] of Object.entries(overrides))expect(fs.readFileSync(path.join(dir,name),'utf8')).toBe(value);
    const first=fs.statSync(path.join(dir,'policy.default.mjs')).mtimeMs;
    runRouterUpdate(home);
    expect(fs.statSync(path.join(dir,'policy.default.mjs')).mtimeMs).toBe(first);
    expect(fs.readdirSync(dir).filter(name=>name.startsWith('policy.default.mjs.pre-managed-upgrade-'))).toEqual(backups);
    expect(fs.readdirSync(dir).filter(name=>name.includes('.tmp-'))).toEqual([]);
  },120000);
  it('creates the missing default on the actual fresh-router entry and its strict classifier works',()=>{
    const home=temporary('router-default-fresh-');const dir=path.join(home,'.claude','model-router');
    runRouterUpdate(home);
    expect(fs.readFileSync(path.join(dir,'policy.default.mjs'),'utf8')).toBe(fs.readFileSync(path.join(ROOT,'config','model-router','policy.default.mjs'),'utf8'));
    expect(fs.readdirSync(dir).some(name=>name.includes('pre-managed-upgrade'))).toBe(false);
    const bin=path.join(dir,'bin');fs.mkdirSync(bin,{recursive:true});
    fs.mkdirSync(path.join(dir,'plugin','scripts'),{recursive:true});
    const install=spawnSync(process.execPath,['--input-type=module','-e',
      `import { syncManagedRouterTools } from ${JSON.stringify(INSTALLER)}; syncManagedRouterTools({routerDir:${JSON.stringify(dir)},packageRoot:${JSON.stringify(ROOT)}});`],
      {encoding:'utf8',env:{...process.env,RUVNET_BRAIN_IMPORT_ONLY:'1'},timeout:15000});
    expect(install.status,install.stderr).toBe(0);
    fs.writeFileSync(path.join(dir,'profile.json'),JSON.stringify({harnesses:{codex:{available:true,subscription:true}}}));
    const now=new Date().toISOString();
    fs.writeFileSync(path.join(dir,'routing-policy.json'),JSON.stringify({schemaVersion:1,reviewedAt:now,routes:{codex:{medium:{model:'sol-fixture',effort:'medium'},substantial:{model:'sol-fixture',effort:'high'}}}}));
    fs.writeFileSync(path.join(dir,'catalog.json'),JSON.stringify({candidates:[{id:'sol-fixture',provider:'openai',harness:['codex'],subscription:['codex']}]}));
    const selected=spawnSync(process.execPath,[fs.realpathSync(path.join(bin,'model-router-engine.mjs')),'--harness','codex','--policy-only','--json'],{
      input:'substantial implementation across modules',encoding:'utf8',env:{...process.env,MODEL_ROUTER_CONFIG_DIR:dir,MODEL_ROUTER_CATALOG:path.join(dir,'catalog.json'),MODEL_ROUTER_PROFILE:path.join(dir,'profile.json'),MODEL_ROUTER_SELECTION:path.join(dir,'routing-policy.json'),MODEL_ROUTER_DECISIONS:path.join(dir,'decisions.jsonl')},
    });
    expect(selected.status,selected.stderr).toBe(0);
    expect(JSON.parse(selected.stdout)).toMatchObject({model:'sol-fixture',taskClass:'substantial',effort:'high'});
    runRouterUpdate(home);
    expect(fs.readdirSync(dir).some(name=>name.includes('pre-managed-upgrade'))).toBe(false);
  },120000);
});


it('ships every relative module dependency into a fresh managed router installation', () => {
  const routerDir = temporary('router-dependency-closure-');
  const script = `import { syncManagedRouterTools } from ${JSON.stringify(INSTALLER)};
    syncManagedRouterTools({ routerDir: ${JSON.stringify(routerDir)}, packageRoot: ${JSON.stringify(ROOT)} });`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, RUVNET_BRAIN_IMPORT_ONLY: '1' }, encoding: 'utf8', timeout: 15000,
  });
  expect(result.status, result.stderr).toBe(0);
  const bin = path.join(routerDir, 'bin');
  for (const file of fs.readdirSync(bin).filter((name) => name.endsWith('.mjs'))) {
    const text = fs.readFileSync(path.join(bin, file), 'utf8');
    for (const match of text.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+\.mjs)['"]/g)) {
      expect(fs.existsSync(path.resolve(bin, match[1])), `${file} needs ${match[1]}`).toBe(true);
    }
  }
});

 it('allows fresh installer dependencies to import without terminal-only WebSocket packages', () => {
  const root = temporary('rnb-installer-no-terminal-dependency-');
  for (const [file, bytes] of runtimeSnapshot(ROOT).files) {
    if (file.startsWith('node_modules/')) continue;
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
  }
  const entry = path.join(root, 'scripts/model-terminal-launchers.mjs');
  const run = spawnSync(process.execPath, ['--input-type=module', '-e',
    'await import(process.argv[2]); console.log("INSTALLER_IMPORT_OK")', 'import-only', entry],
    { encoding: 'utf8', timeout: 5000 });
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout.trim()).toBe('INSTALLER_IMPORT_OK');
});
