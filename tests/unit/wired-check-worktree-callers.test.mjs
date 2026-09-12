import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audit } from '../../scripts/wired-check.mjs';

/**
 * wired-check's CALLER_ROOTS include `.claude/` on purpose — `.claude/settings.json` is a real
 * invoker (version-bump-gate.sh was found there). But `walk()` descends into `.claude/worktrees/`,
 * and every agent worktree there is a FULL COPY of this repository. Measured 2026-09-11: with any
 * worktree present, `scripts/card-from-source.mjs` reported callers
 * `['.claude/worktrees/agent-…/package.json', 'package.json']` and classified `wired`; with none
 * present it reported `['package.json']` and classified `manual`. `scripts/handoff-asset.mjs`
 * (genuinely uninvoked) read `wired` all day for the same reason, and the whole MANUAL class (7
 * tools) read 0. A copy of the repo is not a caller of the repo.
 *
 * Fixture, never the real tree: a throwaway repo with one module, one worktree copy that "calls" it,
 * and a real `.claude/settings.json` caller for the positive case.
 */
let tmp;
afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

function repoWith({ worktreeCaller = false, settingsCaller = false, pkgScript = false } = {}) {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wired-wt-')));
  fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'scripts', 'lonely.mjs'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
    name: 'fixture', version: '0.0.0',
    scripts: pkgScript ? { lonely: 'node scripts/lonely.mjs' } : {},
  }));
  if (worktreeCaller) {
    const wt = path.join(tmp, '.claude', 'worktrees', 'agent-deadbeef');
    fs.mkdirSync(path.join(wt, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'package.json'), JSON.stringify({ scripts: { lonely: 'node scripts/lonely.mjs' } }));
    fs.writeFileSync(path.join(wt, 'scripts', 'runner.mjs'), "import './lonely.mjs';\n");
  }
  if (settingsCaller) {
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ command: 'node scripts/lonely.mjs' }] }] },
    }));
  }
  return tmp;
}

describe('wired-check: a repository copy under .claude/worktrees/ is not a caller', () => {
  it('a module referenced ONLY from a worktree copy is not wired by it', () => {
    const repo = repoWith({ worktreeCaller: true });
    const row = audit({ repo, standalone: [], held: {}, operationalExports: [] }).rows.find((r) => r.base === 'lonely');
    expect(row, 'fixture module must be inventoried').toBeTruthy();
    expect(row.callers.filter((c) => c.startsWith('.claude/worktrees/')),
      'worktree copies of the repo must never appear as callers').toEqual([]);
    expect(row.state).not.toBe('wired');
  });

  it('the worktree copy does not turn an npm-script-only tool from manual into wired', () => {
    const repo = repoWith({ worktreeCaller: true, pkgScript: true });
    const row = audit({ repo, standalone: [], held: {}, operationalExports: [] }).rows.find((r) => r.base === 'lonely');
    expect(row.callers).toEqual(['package.json']);
    expect(row.state).toBe('manual');
  });

  it('a real .claude/settings.json invoker still counts (the reason .claude/ is a caller root)', () => {
    const repo = repoWith({ settingsCaller: true });
    const row = audit({ repo, standalone: [], held: {}, operationalExports: [] }).rows.find((r) => r.base === 'lonely');
    expect(row.callers).toContain('.claude/settings.json');
    expect(row.state).toBe('wired');
  });
});
