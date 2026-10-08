import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { adoptedProject } from '../helpers/continuity-fixture.mjs';
import { planManagedTask } from '../../scripts/model-managed-workflow-service.mjs';
function fixture() {
  const p = adoptedProject(); const file = path.join(p.dir, 'context.md'); fs.writeFileSync(file, 'Bounded private source context');
  return { root: p.dir, input: { originalPrompt: 'Read the supplied source with all original constraints.', harness: 'codex',
    projectRoot: p.dir, allowedWorktrees: [p.dir], contextRefs: [{ path: file, digest: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }],
    nativeContext: {}, permissions: { write: false, apiBilling: false }, deadline: Date.now() + 30_000, maxAttempts: 6, maxConcurrent: 1 },
    cleanup: () => { fs.rmSync(p.dir, { recursive: true, force: true }); fs.rmSync(p.home, { recursive: true, force: true }); } };
}
const decision = { harness: 'codex', model: 'fixture', effort: 'medium', provider: 'openai' };
test('unreadable trusted Brain state blocks rather than granting a disabled exemption', async () => {
  assert.notEqual(process.getuid?.(), 0, 'Real permission-denial qualification requires an unprivileged POSIX runner');
  const f = fixture(), state = path.join(f.root, 'private-state'); let calls = 0, launches = 0;
  try {
    fs.mkdirSync(state); fs.chmodSync(state, 0);
    await assert.rejects(planManagedTask(f.input, { env: { ...process.env, RUVNET_BRAIN_STATE_DIR: state }, route: async () => decision,
      runPlanner: async () => { launches++; }, recallMemory: async () => { calls++; return { outcome: 'disabled' }; } }), /memory consent is unavailable/);
    assert.equal(calls, 0); assert.equal(launches, 0);
  } finally { fs.chmodSync(state, 0o700); f.cleanup(); }
});
