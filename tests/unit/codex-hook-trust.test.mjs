// codex-hook-trust.test.mjs — the offline answer to "which Brain hooks will Codex hold back after this
// update?" must be Codex's OWN answer. The fixture pair is real: codex-hooks-4.4.1.json was installed into
// an isolated CODEX_HOME (codex-cli 0.159.3, 2026-10-01, no credentials) and `hooks/list` returned the
// currentHash values in codex-0.159.3-currentHash.json. A hash function that drifts from Codex's fails here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexHookHash, codexHookIdentities, codexTrustChanges, codexUsesContentTrust, CODEX_TRUST_ACTION } from '../../scripts/codex-hook-trust.mjs';
import { codexHooksNeedingReview } from '../../bin/install.mjs';

const FIX = path.resolve(import.meta.dirname, '../fixtures/codex-trust');
const HOOKS = JSON.parse(fs.readFileSync(path.join(FIX, 'codex-hooks-4.4.1.json'), 'utf8'));
const REAL = JSON.parse(fs.readFileSync(path.join(FIX, 'codex-0.159.3-currentHash.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

describe('codex-hook-trust — Codex\'s own trust identity, offline', () => {
  it('reproduces the currentHash codex-cli 0.159.3 reported for every Brain hook, key for key', () => {
    const mine = Object.fromEntries(codexHookIdentities(HOOKS));
    expect(Object.keys(REAL).length).toBe(11);
    expect(mine).toEqual(REAL);
  });
  it('a changed command text is `modified` at exactly that key (measured: Codex said the same)', () => {
    const next = clone(HOOKS);
    next.hooks.UserPromptSubmit[0].hooks[0].command += ' ';
    expect(codexTrustChanges(HOOKS, next)).toEqual([{ key: 'ruvnet-brain@ruvnet-brain:hooks/codex-hooks.json:user_prompt_submit:0:0', status: 'modified' }]);
  });
  it('a changed timeout or matcher is `modified`; an added hook is `untrusted`; no change is no review', () => {
    expect(codexTrustChanges(HOOKS, clone(HOOKS))).toEqual([]);
    const t = clone(HOOKS); t.hooks.PreToolUse[0].hooks[0].timeout += 1;
    expect(codexTrustChanges(HOOKS, t).map((c) => c.status)).toEqual(['modified']);
    const m = clone(HOOKS); m.hooks.PreToolUse[0].matcher = '^(Write)$';
    expect(codexTrustChanges(HOOKS, m).map((c) => c.status)).toEqual(['modified']);
    const a = clone(HOOKS); a.hooks.SessionStart[0].hooks.push({ type: 'command', command: 'node x.mjs', timeout: 5 });
    expect(codexTrustChanges(HOOKS, a)).toEqual([{ key: 'ruvnet-brain@ruvnet-brain:hooks/codex-hooks.json:session_start:0:1', status: 'untrusted' }]);
  });
  it('Codex normalisation is mirrored: a Stop/UserPromptSubmit matcher is ignored; SessionEnd timeout clamps to 3s', () => {
    const s = clone(HOOKS); s.hooks.Stop[0].matcher = 'anything';
    expect(codexTrustChanges(HOOKS, s)).toEqual([]);
    const e = clone(HOOKS); e.hooks.SessionEnd[0].hooks[0].timeout = 9;   // registered 3; both normalise to 3
    expect(codexTrustChanges(HOOKS, e)).toEqual([]);
    expect(codexHookHash('NotAnEvent', {}, { type: 'command', command: 'x' })).toBeNull();
    expect(codexHookHash('Stop', {}, { type: 'command', command: '  ' })).toBeNull();
  });
  it('the installer reads both roots: fresh install = every hook untrusted; same files = nothing to review', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-trust-'));
    try {
      const root = (name, hooks) => { const r = path.join(dir, name); fs.mkdirSync(path.join(r, 'hooks'), { recursive: true }); fs.writeFileSync(path.join(r, 'hooks', 'codex-hooks.json'), JSON.stringify(hooks)); return r; };
      const a = root('a', HOOKS); const b = root('b', HOOKS);
      expect(codexHooksNeedingReview(a, b)).toEqual([]);
      expect(codexHooksNeedingReview(null, b).map((c) => c.status)).toEqual(Array(11).fill('untrusted'));
      const changed = clone(HOOKS); changed.hooks.SessionEnd[0].hooks[0].command = changed.hooks.SessionEnd[0].hooks[0].command.replace(/\d{3,5}/, '1234');
      expect(codexHooksNeedingReview(a, root('c', changed))).toEqual([{ key: 'ruvnet-brain@ruvnet-brain:hooks/codex-hooks.json:session_end:0:0', status: 'modified' }]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  // #492 (a). Codex 0.164 also pins the plugin's bytes (rust-v0.164.0 plugin_trust.rs matches_hash): measured
  // 2026-10-25 on codex-cli 0.164.0 in an isolated CODEX_HOME, a version-only update left all 13 approved Brain hooks
  // `modified` while this prediction said 0 — so with automatic trust off, the user was told nothing needed review.
  it('Codex 0.164+: changed plugin bytes hold back every hook, even with identical declarations', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-trust-'));
    try {
      const root = (name, extra) => {
        const r = path.join(dir, name); fs.mkdirSync(path.join(r, 'hooks'), { recursive: true }); fs.mkdirSync(path.join(r, 'scripts'));
        fs.writeFileSync(path.join(r, 'hooks', 'codex-hooks.json'), JSON.stringify(HOOKS));
        fs.writeFileSync(path.join(r, 'scripts', 'a.mjs'), `export const a = 1;${extra}\n`);
        return r;
      };
      const a = root('a', ''); const same = root('same', ''); const body = root('body', ' // 4.7.20');
      // Codex writes its own migrated skills into the INSTALLED copy; they are not a release change.
      fs.mkdirSync(path.join(a, '.codex-plugin', 'migrated-command-skills', 'source-command-x'), { recursive: true });
      fs.writeFileSync(path.join(a, '.codex-plugin', 'migrated-command-skills', 'source-command-x', 'SKILL.md'), 'generated');
      const all = codexHooksNeedingReview(a, body, { contentTrust: true });
      expect(all).toHaveLength(11);
      expect(all.every((c) => c.status === 'modified' && c.reason === 'plugin-content')).toBe(true);
      expect(codexHooksNeedingReview(a, same, { contentTrust: true })).toEqual([]);
      expect(codexHooksNeedingReview(a, body, { contentTrust: null })).toHaveLength(11); // unknown version: warn
      expect(codexHooksNeedingReview(a, body, { contentTrust: false })).toEqual([]);    // Codex <0.164 checks declarations only
      expect(codexUsesContentTrust('codex-cli 0.164.0')).toBe(true);
      expect(codexUsesContentTrust('codex-cli 0.163.2')).toBe(false);
      expect(codexUsesContentTrust('')).toBeNull();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('the action names Codex\'s real prompt and choice, not a paraphrase (codex-rs/tui/src/startup_hooks_review.rs)', () => {
    expect(CODEX_TRUST_ACTION).toContain('Hooks need review');
    expect(CODEX_TRUST_ACTION).toContain('Trust all and continue');
    expect(CODEX_TRUST_ACTION).toContain('/hooks');
  });
});
