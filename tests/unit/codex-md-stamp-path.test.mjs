import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ADAPTER = path.join(ROOT, 'plugin/scripts/codex-hook-adapter.mjs');
let project;
beforeEach(() => { project = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-stamp-path-')); });
afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

function put(name, text) {
  const file = path.join(project, name);
  fs.writeFileSync(file, text);
  fs.utimesSync(file, new Date('2026-09-05T18:00:00Z'), new Date('2026-09-05T18:00:00Z'));
  return file;
}
function run({ tool = 'apply_patch', patch, response, event = 'PostToolUse' }) {
  // The actual adapter, actual shim and actual stamp body. A separate launch cwd exercises the
  // same boundary used when the host wrapper's cwd differs from the tool's declared project.
  const result = spawnSync(process.execPath, [ADAPTER, 'md-stamp'], {
    cwd: os.tmpdir(), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PLUGIN_ROOT: path.join(ROOT, 'plugin'),
      RUVNET_BRAIN_HOME: path.join(project, 'brain'), RUVNET_BRAIN_STATE_DIR: path.join(project, 'state'),
      RUVNET_MD_STAMP: 'ensure', RUVNET_CODEX_BUDGET_MS: '9000' },
    input: JSON.stringify({ tool_name: tool, tool_input: patch, tool_response: response,
      hook_event_name: event, cwd: project, session_id: 'fixture' }),
  });
  expect(result.status, result.stderr).toBe(0);
}
const read = (name) => fs.readFileSync(path.join(project, name), 'utf8');

describe('Codex apply_patch → real shim → managed Markdown body', () => {
  for (const tool of ['apply_patch', 'functions.apply_patch', 'functions__apply_patch']) {
    it(`handles raw freeform input and every add/update/move destination through ${tool}`, () => {
      put('updated.md', '# Updated body\nCreated: 2020-01-01\n');
      put('added.md', '# Added\n');
      const old = put('before.md', '# Moved body\nCreated: 2019-01-01\n');
      fs.renameSync(old, path.join(project, 'after.md'));
      const patch = '*** Begin Patch\n*** Update File: updated.md\n@@\n-old\n+new\n'
        + '*** Add File: added.md\n+# Added\n*** Update File: before.md\n*** Move to: after.md\n@@\n-old\n+new\n*** End Patch';
      run({ tool, patch, response: 'Success. Updated the following files:\nM updated.md\nA added.md\nM after.md\n' });
      for (const file of ['updated.md', 'added.md', 'after.md']) expect(read(file)).toContain('Updated: 2026-09-05T18:00:00.000Z');
      expect(read('added.md')).toContain('Created: 2026-09-05T18:00:00.000Z');
      expect(read('updated.md')).toContain('Created: 2020-01-01');
      expect(read('after.md')).toContain('Created: 2019-01-01');
      expect(fs.existsSync(path.join(project, 'before.md'))).toBe(false);
      const before = fs.statSync(path.join(project, 'added.md'));
      run({ tool, patch, response: 'Success. Updated the following files:\nM updated.md\nA added.md\nM after.md\n' });
      expect(fs.statSync(path.join(project, 'added.md')).ctimeMs).toBe(before.ctimeMs);
    });
  }
  it('retains object-command compatibility without inventing creation provenance for updates', () => {
    put('legacy.md', '# Legacy\n');
    run({ patch: { command: '*** Begin Patch\n*** Update File: legacy.md\n@@\n-old\n+new\n*** End Patch' },
      response: 'Success. Updated the following files:\nM legacy.md\n' });
    expect(read('legacy.md')).toContain('Created: unknown (not recorded)');
    expect(read('legacy.md')).toContain('Updated: 2026-09-05T18:00:00.000Z');
  });
  for (const response of ['Error: apply_patch verification failed', { isError: true }, 'No files were modified.']) {
    it(`does not mutate documents for a failed or unconfirmed patch: ${JSON.stringify(response)}`, () => {
      put('failed.md', '# Untouched\n');
      run({ patch: '*** Begin Patch\n*** Add File: failed.md\n+# Untouched\n*** End Patch', response });
      expect(read('failed.md')).toBe('# Untouched\n');
    });
  }
  it('does not stamp deleted paths or pre-tool events', () => {
    put('deleted.md', '# A later independent file at a deleted path\n');
    run({ patch: '*** Begin Patch\n*** Delete File: deleted.md\n*** End Patch',
      response: 'Success. Updated the following files:\nD deleted.md\n' });
    expect(read('deleted.md')).toBe('# A later independent file at a deleted path\n');
    run({ patch: '*** Begin Patch\n*** Add File: deleted.md\n+# Other\n*** End Patch', event: 'PreToolUse' });
    expect(read('deleted.md')).toBe('# A later independent file at a deleted path\n');
  });
  it('requires a matching successful Add result before supplying creation provenance', () => {
    put('claimed.md', '# Existing bytes\n');
    const patch = '*** Begin Patch\n*** Add File: claimed.md\n+# Existing bytes\n*** End Patch';
    run({ patch, response: 'Success. Updated the following files:\nA another.md\n' });
    expect(read('claimed.md')).toBe('# Existing bytes\n');
    run({ patch, response: 'Success. Updated the following files:\r\nM claimed.md\r\n' });
    expect(read('claimed.md')).toContain('Created: unknown (not recorded)');
  });
});
