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
