// RNBC QA 2026-10-01: when the nightly switch could not be turned on, the console printed the
// installer's coloured terminal text verbatim — "Save didn't complete — [31m✗ can't update:[0m …".
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyNightlyChoice } from '../../plugin/scripts/nightly-controller.mjs';

describe('nightly controller failure text is plain', () => {
  it('a refused enable reports its reason without ANSI escapes', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rnbc-nightly-')));
    try {
      const kb = path.join(home, '.cache', 'ruvnet-brain', 'kb');
      fs.mkdirSync(kb, { recursive: true });
      const env = { ...process.env, HOME: home, RUVNET_CONSOLE_ROOT: home, RUVNET_BRAIN_TEST: '1', RUVNET_BRAIN_SCHEDULER_TEST: '1', RUVNET_BRAIN_KB: kb, FORCE_COLOR: '1' };
      const r = applyNightlyChoice(true, { env });
      if (process.platform !== 'darwin') { expect(r.ok).toBe(false); return; }
      expect(r.ok).toBe(false);
      expect(r.log).toMatch(/forge-update/);
      expect(r.log).not.toMatch(/\u001b\[/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
