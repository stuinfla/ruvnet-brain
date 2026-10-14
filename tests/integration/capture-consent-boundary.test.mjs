// A persisted opt-out at the original path wins at every boundary that writes project memory: Stop
// (turn outcome), PreCompact and SessionEnd (checkpoint + distill). Nothing reaches ruflo and the
// project's .swarm is byte-for-byte unchanged.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { adoptedProject, cleanup, fakeRuflo } from '../helpers/continuity-fixture.mjs';
import { runLifecycleBoundary } from '../../plugin/scripts/session-snapshot-hook.mjs';

function fixture() {
  const f = adoptedProject(); const cli = fakeRuflo();
  const env = { ...f.env, RUFLO_BIN: cli.bin, RUVNET_BRAIN_HOME: `${f.home}/brain`, RUVNET_TURN_CAPTURE: 'on' };
  const origin = `${f.dir}/private`; fs.mkdirSync(origin);
  const policyFile = `${env.RUVNET_BRAIN_HOME}/turn-capture/policy.json`;
  fs.mkdirSync(`${env.RUVNET_BRAIN_HOME}/turn-capture`, { recursive: true });
  const policy = (setting) => fs.writeFileSync(policyFile, JSON.stringify({ schemaVersion: 1, projects: { [f.dir]: 'on' }, paths: { [origin]: setting } }));
  policy('on');
  return { ...f, cli, env, origin, policy };
}
afterEach(cleanup);

const LONG = `Decision: private result. ${'The outcome is long enough to be a real turn record. '.repeat(6)}`;

it.each(['Stop', 'PreCompact', 'SessionEnd'])('%s persists nothing at a currently opted-out original path', async (event) => {
  const f = fixture(); f.policy('off');
  const before = fs.readdirSync(`${f.dir}/.swarm`).sort();
  const result = await runLifecycleBoundary(event, { session_id: 'consent', hook_event_name: event, cwd: f.origin, last_assistant_message: LONG }, { env: f.env });
  expect(result.turn.skipped).toMatch(/opt-out/);
  if (event !== 'Stop') expect(result.checkpoint.skipped).toMatch(/opt-out/);
  expect(f.cli.calls().filter((c) => c.argv[1] === 'store')).toEqual([]);
  expect(fs.readdirSync(`${f.dir}/.swarm`).sort()).toEqual(before);
});

it.each(['Stop', 'PreCompact', 'SessionEnd'])('native %s launcher leaves opted-out storage untouched', (event) => {
  const f = fixture(); f.policy('off');
  const before = fs.readdirSync(`${f.dir}/.swarm`).sort();
  const script = fileURLToPath(new URL('../../plugin/scripts/session-snapshot-hook.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [script, event], { cwd: f.dir,
    env: { ...f.env, CLAUDE_PROJECT_DIR: f.dir, RUVNET_HOOK_HOST: 'claude' },
    input: JSON.stringify({ session_id: 'native-consent', hook_event_name: event, cwd: f.origin, last_assistant_message: LONG }),
    encoding: 'utf8', timeout: 6000 });
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0);
  expect(fs.readdirSync(`${f.dir}/.swarm`).sort()).toEqual(before);
  expect(f.cli.calls().filter((c) => c.argv[1] === 'store')).toEqual([]);
});

it.each(['PreCompact', 'SessionEnd'])('%s with consent on stores one checkpoint through ruflo and reads it back', async (event) => {
  const f = fixture();
  const result = await runLifecycleBoundary(event, { session_id: 'consent', hook_event_name: event, cwd: f.origin }, { env: f.env });
  expect(result.checkpoint.stored).toBe(true);
  expect(result.checkpoint.verified).toBe(true);
  const stores = f.cli.calls().filter((c) => c.argv[1] === 'store' && /^project-state-auto-\d+-[0-9a-f]{8}$/.test(c.key || ''));
  expect(stores.length).toBe(1);
});
