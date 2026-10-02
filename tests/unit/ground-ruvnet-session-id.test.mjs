// ground-ruvnet-session-id.test.mjs — a hostile or odd session id never escapes injected/ (review NIT).
//
// ground-ruvnet.sh turns the payload's session_id into a directory under <brain home>/injected/ for its
// once-per-session markers. The sanitiser kept '.', so a session id of '..' became injected/.. — the brain
// home itself — and '.' became injected/ itself: marker files landed beside the knowledge base.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOOK = path.resolve(import.meta.dirname, '../../plugin/scripts/ground-ruvnet.sh');
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

describe.skipIf(!hasBash || process.platform === 'win32')('ground-ruvnet session id sanitising', () => {
  for (const sid of ['..', '.', '../..', '../../etc']) {
    it(`session id ${JSON.stringify(sid)} writes its markers only inside a directory under injected/`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sid-'));
      try {
        const home = path.join(dir, 'home'); const cwd = path.join(dir, 'cwd');
        const brainHome = path.join(home, '.cache', 'ruvnet-brain');
        fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
        const payload = { hook_event_name: 'UserPromptSubmit', prompt: 'what is ruflo?', session_id: sid };
        const r = spawnSync('bash', [HOOK], { input: JSON.stringify(payload), cwd, encoding: 'utf8', timeout: 30_000,
          env: { PATH: process.env.PATH, HOME: home, RUVNET_BRAIN_HOME: brainHome } });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('[RuvNet Brain');
        const injected = path.join(brainHome, 'injected');
        // Nothing beside the injected/ directory, and no marker directly inside injected/ itself.
        expect(fs.readdirSync(brainHome).filter((n) => !['injected', 'token-ledger.jsonl'].includes(n) && !n.startsWith('.'))).toEqual([]);
        const direct = fs.readdirSync(injected).filter((n) => fs.statSync(path.join(injected, n)).isFile() && !n.startsWith('.'));
        expect(direct).toEqual([]);
        const sessions = fs.readdirSync(injected).filter((n) => fs.statSync(path.join(injected, n)).isDirectory());
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).not.toMatch(/^\.+$/);
        expect(fs.readdirSync(path.join(injected, sessions[0])).length).toBeGreaterThan(0);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  }
});
