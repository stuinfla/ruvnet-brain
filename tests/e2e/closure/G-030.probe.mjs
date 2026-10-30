// G-030: a promise that names its check is moved to the NON-completed state `evidenced` by an observed,
// post-change, passing check plus a matching claim and a stated gap; it is never `done`, never forced again,
// and --done still refuses. Real processes: the registered hook shim, a real git repo, a real ledger file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SHIM = path.join(ROOT, 'plugin/scripts/hook-shim.mjs');
const GATE = path.join(ROOT, 'plugin/scripts/continuation-gate.mjs');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g030-')));
try {
  const repo = path.join(root, 'project'); fs.mkdirSync(repo);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  const transcript = path.join(root, 'transcript.jsonl');
  const ledger = path.join(root, 'ledger.json');
  const env = { ...process.env, HOME: root, USERPROFILE: root, RUVNET_BRAIN_HOME: path.join(root, 'brain'), RUVNET_HOOK_HOST: 'claude',
    RUVNET_STOP_NUDGES: 'full', RUVNET_WORK_LEDGER: ledger, RUVNET_PROMISE_CAPTURE: 'on', RUVNET_PROMISE_MAX_FORCES: '50', RUVNET_CONTINUATION_COOLDOWN_MS: '1',
    RUVNET_TURN_CAPTURE: 'off', RUVNET_CONTINUITY_CAPTURE: 'off', RUVNET_OPEN_ISSUES_FILE: path.join(root, 'none'),
    RUVNET_CI_STATUS_FILE: path.join(root, 'none'), RUVNET_CAPABILITY_ROOTS: path.join(root, 'caps'), RUVNET_CAPABILITY_LIVE_EVIDENCE: path.join(root, 'none') };
  const write = (...steps) => fs.writeFileSync(transcript, [{ type: 'user', message: { role: 'user', content: 'task' } },
    ...steps.flatMap((s, i) => [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: s.name, input: s.input }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok PASS' }] } }])].map(JSON.stringify).join('\n'));
  const stop = (session, message) => { fs.rmSync(`${ledger}.cooldown`, { force: true });
    return spawnSync(process.execPath, [SHIM, 'continuation-gate'], { cwd: repo, env, encoding: 'utf8',
      input: JSON.stringify({ hook_event_name: 'Stop', cwd: repo, session_id: session, stop_hook_active: false, transcript_path: transcript, last_assistant_message: message }) }); };
  const item = () => JSON.parse(fs.readFileSync(ledger, 'utf8')).items[0];

  write();
  assert.match(stop('A', "I'll run `npm run hooks:check` for the hook wiring.").stdout, /you said you would/);
  assert.deepEqual(item().evidenceCommands, ['npm run hooks:check']);

  const answer = '"run for the hook wiring" is done.\nVerified: npm run hooks:check — PASS.\nNot verified: Codex.';
  const edit = { name: 'Edit', input: { file_path: '/repo/a.mjs' } };
  // Unobserved evidence: the check ran BEFORE the edit, then another session's claim -> stays active.
  write({ name: 'Bash', input: { command: 'npm run hooks:check' } }, edit);
  stop('A', answer); assert.equal(item().state, 'active');
  write(edit, { name: 'Bash', input: { command: 'npm run hooks:check' } });
  stop('B', answer); assert.equal(item().state, 'active');
  // A check whose exit status is not its own (pipe, fallback, sequence, env prefix) is never observed evidence.
  for (const command of ['npm run hooks:check | tail -3', 'npm run hooks:check || true', 'npm run hooks:check; echo done', 'SKIP_HOOKS=1 npm run hooks:check']) {
    write(edit, { name: 'Bash', input: { command } });
    stop('A', answer); assert.equal(item().state, 'active', `${command} must not bind`);
  }
  write(edit, { name: 'Bash', input: { command: 'npm run hooks:check' } });
  // Observed: same session, check after the edit, claim matches, gap stated.
  const r = stop('A', answer);
  assert.equal(r.status, 0); assert.equal(r.stdout, '');
  assert.equal(item().state, 'evidenced'); assert.equal(item().done, false);
  assert.equal(item().closureEvidence.authority, false);
  assert.equal(stop('A', 'Nothing more.').stdout, '');
  const done = spawnSync(process.execPath, [GATE, '--done', item().text], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(done.status, 2);
  assert.equal(item().done, false);
  console.log(JSON.stringify({ gap: 'G-030', evidenceClass: 'EXECUTED', evidenced: true, done: false, forcedAgain: false, doneRefused: true, otherSessionIgnored: true, staleIgnored: true, compoundCommandsIgnored: true }));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
