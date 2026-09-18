import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const SCRIPTS = path.join(REPO, 'plugin/scripts');

const CASES = [
  ['#44 literal bash payload', "bash -lc 'ruflo memory search -q x'"],
  ['#44 backtick substitution', 'x=`ruflo memory search -q x`'],
  ['#44 double-quoted substitution', 'printf \'%s\\n\' "$(ruflo memory search -q x)"'],
  ['#41 separator inside quotes', 'grep -E "foo|ruflo init" file.txt'],
  ['#12 prose mention', 'git commit -m "explained how ruflo memory search returns results"'],
  ['#13 embedded escaped quotes', 'git commit -m "fix \\"quoted\\" edge case in ruflo parsing"'],
  ['heredoc body', "cat <<'EOF'\nagentic-qe integration plan\nEOF"],
  ['single-quoted substitution', "printf '%s' '$(ruflo memory search -q x)'"],
  ['direct invocation', 'ruflo memory search -q x'],
  ['npx invocation', 'npx ruflo@latest memory search -q x'],
  ['pipeline invocation', 'echo hi | ruflo memory search -q x'],
  ['dynamic executable', '$TOOL memory search -q x'],
];

function fire(command, off, id = 'verify-interface', raw) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'igc-'));
  const frozen = path.join(home, 'frozen');
  const brain = path.join(home, 'brain');
  const active = path.join(brain, 'versions', 'fixture');
  const state = path.join(home, 'state');
  const markers = [path.join(home, 'frozen-executed'), path.join(home, 'active-executed')];
  try {
    for (const root of [frozen, active]) fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(state);
    if (off) fs.writeFileSync(path.join(state, 'brain-off'), 'off');
    for (const file of ['hook-shim.mjs', 'hook-shim-bash.mjs', 'development-maintenance.mjs']) {
      fs.copyFileSync(path.join(SCRIPTS, file), path.join(frozen, 'scripts', file));
    }
    for (const [index, root] of [frozen, active].entries()) {
      fs.writeFileSync(path.join(root, 'scripts/verify-interface.sh'),
        `#!/bin/bash\nprintf executed > "$RETIREMENT_SENTINEL_${index}"\nprintf resurrected >&2\nexit 2\n`);
    }
    fs.writeFileSync(path.join(brain, 'active.json'), JSON.stringify({ codeRoot: active, version: 'fixture', generation: 1 }));
    const result = spawnSync(process.execPath, [path.join(frozen, 'scripts/hook-shim.mjs'), id], {
      cwd: home,
      input: raw ?? JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      env: { ...process.env, HOME: home, USERPROFILE: home, RUVNET_BRAIN_HOME: brain,
        RUVNET_BRAIN_STATE_DIR: state, CLAUDE_PLUGIN_ROOT: frozen,
        RETIREMENT_SENTINEL_0: markers[0], RETIREMENT_SENTINEL_1: markers[1] },
      encoding: 'utf8', timeout: 5000,
    });
    return { ...result, bodyExecuted: markers.some(marker => fs.existsSync(marker)) };
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function expectRetired(result) {
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
  expect(result.bodyExecuted).toBe(false);
}

for (const off of [false, true]) {
  describe(`retired interface ID with Brain ${off ? 'OFF' : 'ON'}`, () => {
    it.each(CASES)('%s remains silent without executing either old body', (_label, command) => {
      expectRetired(fire(command, off));
    });
    it.each(['', '{malformed'])('ignores retired payload %j without a shell or parser', raw => {
      expectRetired(fire('', off, 'verify-interface', raw));
    });
  });
}

it('keeps an unrelated unknown ID diagnostic so silence cannot pass vacuously', () => {
  const result = fire('', false, 'unknown-retirement-control');
  expect(result.status).toBe(0);
  expect(result.stderr).toMatch(/unknown hook id/);
  expect(result.bodyExecuted).toBe(false);
});
