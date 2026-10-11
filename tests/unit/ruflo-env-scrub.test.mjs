import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { searchOnce } from '../../plugin/scripts/agentdb-recall-process.mjs';

// CLAUDE_FLOW_MEMORY_PATH=<.swarm> makes Ruflo create a second agentdb-memory.db beside the canonical store
// (measured, Ruflo 3.56.3). Every product spawn of Ruflo must hide it from the child (ADR-105 rule 2).
describe('Ruflo child environment', () => {
  it('never inherits CLAUDE_FLOW_MEMORY_PATH from the parent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-scrub-'));
    try {
      const env = { ...process.env, CLAUDE_FLOW_MEMORY_PATH: path.join(dir, '.swarm') };
      const result = await searchOnce({ store: { path: path.join(dir, 'memory.db') }, operation: 'native', deadline: Date.now() + 5000, env,
        scratch: () => dir,
        invocation: { executable: process.execPath, args: ['-e', "process.stdout.write(JSON.stringify({seen: process.env.CLAUDE_FLOW_MEMORY_PATH ?? null, autostart: process.env.RUFLO_DAEMON_AUTOSTART}))"] } });
      expect(result.state).toBe('ok');
      expect(JSON.parse(result.value)).toEqual({ seen: null, autostart: '0' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
