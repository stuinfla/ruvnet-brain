// Cross-vendor review B (4.7.21): the entry-point sweep made developer-update.mjs import ./entrypoint.mjs, but the
// nightly scheduler stages the coordinator into a content-addressed update-modules-<digest>/ directory holding ONLY
// the files of its module closure. A sibling import missing from that closure fails at 03:30 with
// ERR_MODULE_NOT_FOUND. This stages the modules exactly as the scheduler does, then imports every staged module
// from the staged directory, in a separate process (the real door: bin/nightly-refresh.mjs imports them by path).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { installNightlyRunner, readNightlyRegistration } from '../../plugin/scripts/nightly-scheduler.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const roots = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

const LOCAL_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.\/[^'"]+)['"]/g;
const code = (file) => fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('the staged nightly module closure is self-contained', () => {
  it.each([['developer suite', true], ['legacy', false]])('%s: every staged module imports from the staged directory alone', (_, developerSuite) => {
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nsc-'))); roots.push(home);
    const brainHome = path.join(home, '.cache', 'ruvnet-brain');
    const record = installNightlyRunner({ brainHome, source: path.join(ROOT, 'bin', 'nightly-refresh.mjs'), nodePath: process.execPath,
      env: { HOME: home, PATH: process.env.PATH }, developerSuite });
    const staged = Object.values(record.updateModules).map((m) => m.path);
    const names = new Set(fs.readdirSync(path.dirname(staged[0])));
    // Static closure: every relative sibling a staged module names (outside comments) is staged too.
    for (const file of staged) {
      for (const [, spec] of code(file).matchAll(LOCAL_IMPORT)) {
        // ruvnet-gate1-pattern's hook-input import is optional and try-guarded (it predates this review).
        if (spec === './hook-input.mjs' && path.basename(file) === 'ruvnet-gate1-pattern.mjs') continue;
        expect(names.has(path.basename(spec)), `${path.basename(file)} imports ${spec}, which is not staged`).toBe(true);
      }
    }
    // Dynamic proof: import every staged module from its staged copy, as the runner does.
    const urls = JSON.stringify(staged.map((f) => pathToFileURL(f).href));
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `for (const f of ${urls}) await import(f); console.log('ok');`],
      { cwd: home, encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: home, RUVNET_BRAIN_HOME: brainHome } });
    expect(r.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(r.stdout.trim()).toBe('ok');
  });

  /** A registration as 4.7.20 wrote it: no entrypoint.mjs staged, coordinator not importing it (or, broken, importing it). */
  function olderRegistration({ coordinatorImportsEntrypoint }) {
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nsc-old-'))); roots.push(home);
    const brainHome = path.join(home, '.cache', 'ruvnet-brain');
    const record = installNightlyRunner({ brainHome, source: path.join(ROOT, 'bin', 'nightly-refresh.mjs'), nodePath: process.execPath, env: { HOME: home, PATH: process.env.PATH } });
    const coordinator = record.updateModules['developer-update.mjs'];
    if (!coordinatorImportsEntrypoint) {
      const bytes = fs.readFileSync(coordinator.path, 'utf8').replace("import { isDirectInvocation } from './entrypoint.mjs';", 'const isDirectInvocation = () => false;');
      fs.writeFileSync(coordinator.path, bytes); coordinator.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    }
    fs.rmSync(record.updateModules['entrypoint.mjs'].path); delete record.updateModules['entrypoint.mjs'];
    const { recordPath, ...stored } = record;
    fs.writeFileSync(recordPath, JSON.stringify(stored));
    return brainHome;
  }
  it('a 4.7.20 registration (no entrypoint.mjs, coordinator without the import) is still a valid closure', () => {
    expect(readNightlyRegistration({ brainHome: olderRegistration({ coordinatorImportsEntrypoint: false }) })).toMatchObject({ ok: true });
  });
  it('a registration whose coordinator imports entrypoint.mjs without staging it is refused', () => {
    expect(readNightlyRegistration({ brainHome: olderRegistration({ coordinatorImportsEntrypoint: true }) })).toMatchObject({ ok: false, why: expect.stringMatching(/missing entrypoint\.mjs/) });
  });
});
