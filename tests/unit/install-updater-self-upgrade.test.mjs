/**
 * A stale updater inside a customer's installed KB must upgrade itself before it runs.
 *
 * The updater that runs on a customer is the forge-update.mjs inside their OWN installed KB, which
 * only changes when a bundle replaces it. Measured 2026-09-30: the owner's install carried a
 * 4.3.28-era updater while 4.3.37 was current, so every fix to the updater (the node_modules carry,
 * the coverage gate) never reached installs that already had one. The signed npm package now ships
 * kb/forge-update.mjs and its sibling modules, and the `--update` preflight places them.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
const install = await import(`${pathToFileURL(path.join(ROOT, 'bin', 'install.mjs')).href}?updater-self-upgrade=${Date.now()}`);
afterAll(() => { delete process.env.RUVNET_BRAIN_IMPORT_ONLY; });

let tmp;
afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = null; });
const scratch = () => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'updater-self-upgrade-'))); return tmp; };
const pkg = (name) => fs.readFileSync(path.join(ROOT, 'kb', name));

describe('the package carries the updater and the update preflight places it', () => {
  it('ships kb/forge-update.mjs in the npm package', () => {
    const files = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files;
    expect(files).toContain('kb/forge-update.mjs');
  });

  it('replaces a stale installed updater with the package copy, byte-identical', () => {
    const kb = path.join(scratch(), 'kb'); fs.mkdirSync(kb);
    fs.writeFileSync(path.join(kb, 'forge-update.mjs'), '// stale 4.3.28 updater\n');
    const result = install.ensureUpdaterPrerequisites(kb);
    expect(result.updater).toBe(true);
    expect(result.files['forge-update.mjs']).toBe('placed');
    expect(fs.readFileSync(path.join(kb, 'forge-update.mjs')).equals(pkg('forge-update.mjs'))).toBe(true);
    for (const name of Object.keys(result.files)) {
      expect(fs.readFileSync(path.join(kb, name)).equals(pkg(name))).toBe(true);
    }
  });

  it('is idempotent: a second preflight leaves every file unchanged', () => {
    const kb = path.join(scratch(), 'kb'); fs.mkdirSync(kb);
    fs.writeFileSync(path.join(kb, 'forge-update.mjs'), '// stale\n');
    install.ensureUpdaterPrerequisites(kb);
    const again = install.ensureUpdaterPrerequisites(kb);
    expect(Object.values(again.files).every((state) => state === 'unchanged')).toBe(true);
  });

  it('never writes through a symlink planted where the updater lives', () => {
    const kb = path.join(scratch(), 'kb'); fs.mkdirSync(kb);
    const victim = path.join(tmp, 'victim.txt'); fs.writeFileSync(victim, 'keep');
    fs.symlinkSync(victim, path.join(kb, 'forge-update.mjs'));
    install.ensureUpdaterPrerequisites(kb);
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep');
    expect(fs.lstatSync(path.join(kb, 'forge-update.mjs')).isSymbolicLink()).toBe(false);
  });

  it('does nothing where no updater exists to consume the files', () => {
    const kb = path.join(scratch(), 'kb'); fs.mkdirSync(kb);
    expect(install.ensureUpdaterPrerequisites(kb)).toEqual({ updater: false, validator: null });
    expect(fs.existsSync(path.join(kb, 'zip-extract.mjs'))).toBe(false);
  });

  it('fails loudly, not silently, when the package is missing an updater file', () => {
    const kb = path.join(scratch(), 'kb'); fs.mkdirSync(kb);
    const emptySource = path.join(tmp, 'empty-pkg'); fs.mkdirSync(emptySource);
    expect(() => install.placeUpdater(kb, { sourceDir: emptySource })).toThrow(/missing from this package/);
  });
});

describe('the updater carries the live node_modules into the candidate it validates', () => {
  const source = fs.readFileSync(path.join(ROOT, 'kb', 'forge-update.mjs'), 'utf8');
  it('copies the live node_modules beside the other installer-placed files before validation', () => {
    const carry = source.indexOf("path.join(liveDir, 'node_modules')");
    const validate = source.indexOf('validateCandidate: validateFinalTree');
    expect(carry).toBeGreaterThan(0);
    expect(carry).toBeLessThan(validate);
    expect(source).toMatch(/cpSync\(assertNoFollowPath\(liveDir, liveModules\)[\s\S]{0,200}verbatimSymlinks: true/);
  });
});
