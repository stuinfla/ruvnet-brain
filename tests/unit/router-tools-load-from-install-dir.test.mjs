// tests/unit/router-tools-load-from-install-dir.test.mjs
//
// The router tools are COPIED out of the package into ~/.claude/model-router/bin/ (the npx dir
// vanishes after install), and SKILL.md runs them from there. Every relative import a copied tool
// makes must therefore resolve from THAT directory, not from scripts/ in a checkout, where
// everything is always present and every test passes.
//
// Three imports shipped broken this way, all invisible from a checkout:
//   - route-cheap.mjs -> ../plugin/scripts/runtime-preferences.mjs  (453ae58, 2026-07-31)
//     route-cheap is statically imported by model-router-engine, model-router-status,
//     dispatch-receipt and metaharness-receipts, so all five failed to load.
//   - dual-host-deliberation.mjs -> ./review-model-defaults.mjs      (8b8890d, 2026-09-26)
//     which also took down dual-host-suggest.mjs, the gate SKILL.md runs before hard tasks.
//   - model-router-engine.mjs -> import('./metaharness-router.mjs')  (dynamic, caught: the engine
//     falls back and says so, so it is not a load failure and this gate does not flag it)
//
// installer-sibling-imports-packaged.test.mjs could not see any of them: every one of those files
// IS in the tarball. It just never reached the directory the tools run from.
//
// So this gate does the real thing: install into a throwaway home, then load every installed .mjs
// in a child process from the install directory. Only module-resolution errors count: a tool that
// exits non-zero because the throwaway home has no profile is not what this gate is about.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROUTER_TOOLS, installRouterTools } from '../../bin/install.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MISSING_MODULE = /Cannot find module '[^']+'/;
const UNRESOLVED = /ERR_MODULE_NOT_FOUND/;

describe('router tools installed to ~/.claude/model-router/bin/ load from there', () => {
  it('every installed tool module resolves its whole import graph from the install directory', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-tools-'));
    try {
      const routerDir = path.join(home, '.claude', 'model-router');
      const copied = installRouterTools(ROOT, routerDir);
      // The gate must not pass vacuously: an empty install checks nothing.
      expect(copied, 'installRouterTools copied nothing; this gate is now blind').toBe(ROUTER_TOOLS.length);

      const bin = path.join(routerDir, 'bin');
      const modules = fs.readdirSync(bin).filter((f) => f.endsWith('.mjs')).sort();
      expect(modules.length).toBeGreaterThan(0);

      const unresolved = [];
      for (const f of modules) {
        const url = pathToFileURL(path.join(bin, f)).href;
        const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)});`], {
          cwd: home,
          env: { ...process.env, HOME: home, USERPROFILE: home, MODEL_ROUTER_DECISIONS: path.join(home, 'decisions.jsonl') },
          encoding: 'utf8',
          timeout: 30000,
          input: '',
        });
        const hit = `${r.stderr}`.match(MISSING_MODULE) || `${r.stderr}`.match(UNRESOLVED);
        if (hit) unresolved.push(`${f}: ${hit[0].split(fs.realpathSync(home)).join('~').split(home).join('~')}`);
      }
      expect(
        unresolved,
        `these router tools cannot load from ~/.claude/model-router/bin/ on a real install. ` +
          `Their imports resolve in scripts/ but were not copied next to them by installRouterTools().`,
      ).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 180000);
});
