// tests/unit/job-heartbeat-alerting.test.mjs — scripts/job-heartbeat.sh must actually PAGE on failure.
//
// THE BUG THIS ENCODES (found 2026-09-27, cause #5 of the consolidation effort): job-heartbeat.sh's
// notify() and nightly-watchdog.mjs's push() both resolve the ntfy topic as
// `$NTFY_TOPIC` env var, then `~/.cache/ruvnet-brain/ntfy-topic`. Neither launchd plist for
// com.ruvnet.issue-watch, com.ruvnet.nightly-watchdog, or com.ruvnet.npm-token-renew sets
// NTFY_TOPIC in its EnvironmentVariables, and the topic FILE did not exist on disk — so every
// "SCHEDULED JOB FAILED" alert for every wrapped job was silently swallowed (notify() returns 0,
// no error, no log) for as long as the file was missing. Three jobs failing loudly in their own
// receipts and logs, and paging NOBODY, is exactly "too much loaded, and failures go unnoticed."
//
// Fix: ~/.cache/ruvnet-brain/ntfy-topic now holds the same topic already configured in .env
// (the NTFY_TOPIC value — a secret, never written in this public repo) and confirmed live via a real ntfy.sh delivery during
// this fix (message id ivcb7EloTrlG, 2026-09-27T12:38:14Z).
//
// This test proves the WIRING, not the network: it stubs `curl` on PATH and points $HOME at a temp
// dir, so it never touches the real machine's topic file or fires a real push, but it asserts the
// exact condition that was broken — a failing wrapped job must attempt exactly one alert push, a
// successful one must attempt none, and with no topic configured (the pre-fix state) no push is
// attempted either, so the negative case can't be satisfied by a curl stub that always "works".
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const WRAPPER = path.join(ROOT, 'scripts', 'job-heartbeat.sh');

let workDir;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-heartbeat-test-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Build an isolated fake $HOME with a fake-`curl` bin directory ahead of PATH, so the wrapper's
 * alert call is captured to a log file instead of reaching the real network. */
function makeHarness({ withTopic }) {
  const home = path.join(workDir, 'home');
  const cacheDir = path.join(home, '.cache', 'ruvnet-brain');
  fs.mkdirSync(cacheDir, { recursive: true });
  if (withTopic) fs.writeFileSync(path.join(cacheDir, 'ntfy-topic'), 'test-topic-xyz');

  const binDir = path.join(workDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const curlLog = path.join(workDir, 'curl-calls.log');
  const fakeCurl = path.join(binDir, 'curl');
  // Records every invocation (one line of JSON-ish args) instead of making a network call. Like real curl, an HTTP
  // error (CURL_HTTP_STATUS >= 400) is exit 22 ONLY when --fail was passed — so dropping --fail is caught (4.7.21).
  fs.writeFileSync(fakeCurl, `#!/bin/sh\necho "$@" >> "${curlLog}"\nfail=0; for a in "$@"; do [ "$a" = "--fail" ] && fail=1; done\n`
    + `[ "\${CURL_HTTP_STATUS:-200}" -ge 400 ] && [ "$fail" = 1 ] && exit 22\nexit 0\n`);
  fs.chmodSync(fakeCurl, 0o755);

  const hbDir = path.join(workDir, 'heartbeats');
  fs.mkdirSync(hbDir, { recursive: true });

  const script = (exitCode) => {
    const p = path.join(workDir, `child-${exitCode}.sh`);
    fs.writeFileSync(p, `#!/bin/sh\nexit ${exitCode}\n`);
    fs.chmodSync(p, 0o755);
    return p;
  };

  const run = (label, exitCode, extraEnv = {}) => spawnSync('/bin/sh', [WRAPPER, label, '--', script(exitCode)], {
    encoding: 'utf8',
    env: {
      ...extraEnv,
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: home,
      JOB_HEARTBEAT_DIR: hbDir,
      // Explicit unset opt-out (NTFY_TOPIC="") is job-heartbeat.sh's own test convention — leaving
      // it entirely absent from env here so resolution falls through to the topic FILE, which is
      // the exact path that was broken.
    },
  });

  const curlCalls = () => (fs.existsSync(curlLog) ? fs.readFileSync(curlLog, 'utf8').trim().split('\n').filter(Boolean) : []);
  const receipt = (label) => JSON.parse(fs.readFileSync(path.join(hbDir, `${label}.json`), 'utf8'));

  return { run, curlCalls, receipt };
}

describe('job-heartbeat.sh — a failing job must actually page, not just record a receipt', () => {
  it('with a topic configured, a FAILING job fires exactly one alert push', () => {
    const { run, curlCalls, receipt } = makeHarness({ withTopic: true });
    const res = run('com.test.failing-job', 17);

    expect(res.status).toBe(17); // wrapper propagates the child's real exit code to launchd
    expect(receipt('com.test.failing-job').state).toBe('failed');
    expect(receipt('com.test.failing-job').exit_code).toBe(17);

    const calls = curlCalls();
    expect(calls.length).toBe(1); // exactly one page — not zero (the bug), not a flood
    expect(calls[0]).toContain('test-topic-xyz'); // resolved via the topic FILE fallback
    expect(calls[0]).toContain('SCHEDULED JOB FAILED: com.test.failing-job');
  });

  it('with a topic configured, a SUCCESSFUL job fires no alert', () => {
    const { run, curlCalls, receipt } = makeHarness({ withTopic: true });
    const res = run('com.test.ok-job', 0);

    expect(res.status).toBe(0);
    expect(receipt('com.test.ok-job').state).toBe('ok');
    expect(curlCalls().length).toBe(0); // success must never page
  });

  it('a job that KEEPS failing pages once, stays quiet while it fails, and sends one low "recovered" note (2026-10-25)', () => {
    const { run, curlCalls, receipt } = makeHarness({ withTopic: true });
    run('com.test.flaky', 1);
    const since = receipt('com.test.flaky').failing_since;
    expect(since).toBeTruthy();
    run('com.test.flaky', 1); run('com.test.flaky', 2);
    expect(curlCalls().length).toBe(1); // one page for the whole failing streak, not one per run
    expect(receipt('com.test.flaky').failing_since).toBe(since); // the streak keeps its first failure time
    run('com.test.flaky', 0);
    const calls = curlCalls();
    expect(calls.length).toBe(2);
    expect(calls[1]).toContain('Recovered: com.test.flaky');
    expect(calls[1]).toContain('Priority: low');
    run('com.test.flaky', 0);
    expect(curlCalls().length).toBe(2); // staying green is silent
    run('com.test.flaky', 3);
    // A NEW streak within 6 h of the last page is damped (4.7.21): recorded, not paged.
    expect(curlCalls().length).toBe(2);
    expect(receipt('com.test.flaky').paged).toBe('suppressed');
  });

  it('flap damping: 4 fail/ok cycles produce at most 2 notifications (before: 8)', () => {
    const { run, curlCalls, receipt } = makeHarness({ withTopic: true });
    for (let i = 0; i < 4; i += 1) { run('com.test.flap', 1); run('com.test.flap', 0); }
    const calls = curlCalls();
    expect(calls).toHaveLength(2); // one failure page, one recovery note for that paged streak
    expect(calls[0]).toContain('SCHEDULED JOB FAILED: com.test.flap');
    expect(calls[1]).toContain('Recovered: com.test.flap');
    expect(typeof receipt('com.test.flap').last_page_epoch).toBe('number'); // carried through every receipt
  });

  it('a new failing streak more than 6 h after the last page pages again', () => {
    const { run, curlCalls, receipt } = makeHarness({ withTopic: true });
    const hbDir = path.join(workDir, 'heartbeats');
    const old = Math.floor(Date.now() / 1000) - 7 * 3600;
    fs.writeFileSync(path.join(hbDir, 'com.test.later.json'), JSON.stringify({ label: 'com.test.later', state: 'ok', exit_code: 0, run_id: 'old', last_page_epoch: old, last_page_at: '2026-10-25T00:00:00Z' }));
    run('com.test.later', 1);
    expect(curlCalls()).toHaveLength(1);
    expect(receipt('com.test.later').paged).toBe(true);
    expect(receipt('com.test.later').last_page_epoch).toBeGreaterThan(old);
  });

  it('a damped streak that is still failing after 6 h is paged then', () => {
    const { run, curlCalls } = makeHarness({ withTopic: true });
    const hbDir = path.join(workDir, 'heartbeats');
    const old = Math.floor(Date.now() / 1000) - 7 * 3600;
    fs.writeFileSync(path.join(hbDir, 'com.test.damped.json'), JSON.stringify({ label: 'com.test.damped', state: 'failed', exit_code: 1, run_id: 'old', failing_since: '2026-10-25T00:00:00Z', paged: 'suppressed', last_page_epoch: old }));
    run('com.test.damped', 1);
    expect(curlCalls()).toHaveLength(1);
  });

  it('NTFY_TOPIC="" records paged:"disabled", never paged:true, and sends nothing (before: paged:true)', () => {
    const { run, curlCalls, receipt } = makeHarness({ withTopic: true });
    run('com.test.optout', 1, { NTFY_TOPIC: '' });
    expect(curlCalls()).toHaveLength(0);
    expect(receipt('com.test.optout').paged).toBe('disabled');
    run('com.test.optout', 1, { NTFY_TOPIC: '' });
    expect(receipt('com.test.optout').paged).toBe('disabled');
  });

  it('an HTTP error from ntfy is an undelivered page (curl --fail): paged:false', () => {
    const { run, curlCalls, receipt } = makeHarness({ withTopic: true });
    run('com.test.http429', 1, { CURL_HTTP_STATUS: '429' });
    expect(curlCalls()).toHaveLength(1);
    expect(receipt('com.test.http429').paged).toBe(false);
  });

  it('no recovery note for a streak that was never paged', () => {
    const { run, curlCalls } = makeHarness({ withTopic: true });
    run('com.test.quietrec', 1, { NTFY_TOPIC: '' }); // opted out: not paged
    run('com.test.quietrec', 0);
    expect(curlCalls()).toHaveLength(0); // before: a "Recovered" note for a failure nobody was told about
  });

  it('a "running" receipt left by a killed run continues the failing streak instead of paging anew', () => {
    const { run, curlCalls, receipt } = makeHarness({ withTopic: true });
    const hbDir = path.join(workDir, 'heartbeats');
    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(path.join(hbDir, 'com.test.cont.json'), JSON.stringify({ label: 'com.test.cont', state: 'running', pid: 999999, run_id: 'killed', failing_since: '2026-10-25T00:00:00Z', paged: true, last_page_epoch: now - 600 }));
    run('com.test.cont', 1);
    expect(curlCalls()).toHaveLength(0);
    expect(receipt('com.test.cont').failing_since).toBe('2026-10-25T00:00:00Z');
    expect(receipt('com.test.cont').paged).toBe(true);
  });

  it('the running receipt carries the streak forward, so a SIGKILLed run cannot lose it', () => {
    makeHarness({ withTopic: false });
    const hbDir = path.join(workDir, 'heartbeats');
    fs.writeFileSync(path.join(hbDir, 'com.test.carry.json'), JSON.stringify({ label: 'com.test.carry', state: 'failed', exit_code: 1, run_id: 'x', failing_since: '2026-10-25T00:00:00Z', paged: true, last_page_epoch: 1792900000 }));
    const peek = path.join(workDir, 'peek-carry.sh');
    fs.writeFileSync(peek, `#!/bin/sh\ncp "${path.join(hbDir, 'com.test.carry.json')}" "${path.join(workDir, 'carry.json')}"\nexit 1\n`); fs.chmodSync(peek, 0o755);
    spawnSync('/bin/sh', [WRAPPER, 'com.test.carry', '--', peek], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: path.join(workDir, 'home'), JOB_HEARTBEAT_DIR: hbDir, NTFY_TOPIC: '' } });
    const running = JSON.parse(fs.readFileSync(path.join(workDir, 'carry.json'), 'utf8'));
    expect(running).toMatchObject({ state: 'running', failing_since: '2026-10-25T00:00:00Z', paged: true, last_page_epoch: 1792900000 });
  });

  it('a job that never exits is stopped at JOB_MAX_SECONDS and recorded as timed out (2026-10-25)', () => {
    const { curlCalls, receipt } = makeHarness({ withTopic: true });
    const hang = path.join(workDir, 'hang.sh');
    fs.writeFileSync(hang, '#!/bin/sh\nsleep 60\n'); fs.chmodSync(hang, 0o755);
    const t0 = Date.now();
    spawnSync('/bin/sh', [WRAPPER, 'com.test.hang', '--', hang], {
      encoding: 'utf8',
      env: { PATH: `${path.join(workDir, 'bin')}:/usr/bin:/bin`, HOME: path.join(workDir, 'home'), JOB_HEARTBEAT_DIR: path.join(workDir, 'heartbeats'), JOB_MAX_SECONDS: '1' },
    });
    expect(Date.now() - t0).toBeLessThan(20_000); // stopped near the limit, not after the job's 60 s
    const r = receipt('com.test.hang');
    expect(r.state).toBe('killed');
    expect(r.timed_out_after_sec).toBe(2) // the limit is never below 2 s;
    expect(curlCalls().length).toBe(1);
    expect(fs.readdirSync(path.join(workDir, 'heartbeats')).some((f) => f.includes('.timeout-'))).toBe(false);
  }, 30_000);

  it('a quick job leaves no timer behind and is not marked timed out', () => {
    const { run, receipt } = makeHarness({ withTopic: false });
    const t0 = Date.now();
    run('com.test.quick', 0);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(receipt('com.test.quick').timed_out_after_sec).toBeUndefined();
  });

  const runWith = (label, body, extraEnv = {}) => {
    const f = path.join(workDir, `${label}.sh`);
    fs.writeFileSync(f, `#!/bin/sh\n${body}\n`); fs.chmodSync(f, 0o755);
    // Started as its own process-group leader, exactly as launchd starts a job (perl is on macOS and every CI image).
    return spawnSync('/usr/bin/perl', ['-e', 'setpgrp(0,0); exec @ARGV', extraEnv.SHELL_BIN || '/bin/sh', WRAPPER, label, '--', f, 'line one\nline "two"'], {
      encoding: 'utf8',
      env: { PATH: `${path.join(workDir, 'bin')}:/usr/bin:/bin`, HOME: path.join(workDir, 'home'), JOB_HEARTBEAT_DIR: path.join(workDir, 'heartbeats'), NTFY_TOPIC: '', ...extraEnv },
    });
  };
  const hb = (label) => JSON.parse(fs.readFileSync(path.join(workDir, 'heartbeats', `${label}.json`), 'utf8'));

  it('a job that exits 0 when stopped for overrunning is still recorded as killed (review 2026-10-25)', () => {
    makeHarness({ withTopic: false });
    runWith('com.test.polite', "trap 'exit 0' TERM\nsleep 60 & wait", { JOB_MAX_SECONDS: '1' });
    expect(hb('com.test.polite').state).toBe('killed');
    expect(hb('com.test.polite').timed_out_after_sec).toBe(2) // the limit is never below 2 s;
  }, 30_000);

  it('a page that did not deliver is retried on the next failing run, then the streak goes quiet', () => {
    const { run, receipt } = makeHarness({ withTopic: true });
    const curl = path.join(workDir, 'bin', 'curl');
    const log = path.join(workDir, 'curl-calls.log');
    fs.writeFileSync(curl, `#!/bin/sh\necho "$@" >> "${log}"\nexit 22\n`); // ntfy down: HTTP error
    run('com.test.undelivered', 1);
    expect(receipt('com.test.undelivered').paged).toBe(false);
    fs.writeFileSync(curl, `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`);
    run('com.test.undelivered', 1);
    expect(receipt('com.test.undelivered').paged).toBe(true);
    run('com.test.undelivered', 1);
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2); // retried once, then quiet
  });

  it('an overrun stops the whole tree, including a grandchild that ignores TERM', () => {
    makeHarness({ withTopic: false });
    const marker = path.join(workDir, 'grandchild.pid');
    runWith('com.test.tree', `sh -c 'trap "" TERM; echo $$ > ${marker}; sleep 120' &\nwait`, { JOB_MAX_SECONDS: '1' });
    const gpid = Number(fs.readFileSync(marker, 'utf8'));
    let alive = true; try { process.kill(gpid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
    expect(hb('com.test.tree').state).toBe('killed');
  }, 40_000);

  it('a child started during TERM handling is stopped too (the job has its own process group)', () => {
    makeHarness({ withTopic: false });
    const marker = path.join(workDir, 'late.pid');
    runWith('com.test.late', `trap 'sh -c "trap \\"\\" TERM; echo \\$\\$ > ${marker}; sleep 120" & exit 0' TERM\nsleep 60 & wait`, { JOB_MAX_SECONDS: '1' });
    const lpid = Number(fs.readFileSync(marker, 'utf8'));
    let alive = true; try { process.kill(lpid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  }, 40_000);

  it('an overrunning job that exits 75 (the skip code) on TERM is still recorded as killed', () => {
    makeHarness({ withTopic: false });
    runWith('com.test.skipexit', "trap 'exit 75' TERM\nsleep 60 & wait", { JOB_MAX_SECONDS: '1' });
    expect(hb('com.test.skipexit').state).toBe('killed');
  }, 30_000);

  it('a failed receipt from before delivery tracking existed is paged once more, not muted', () => {
    const { run, curlCalls } = makeHarness({ withTopic: true });
    const hbDir = path.join(workDir, 'heartbeats');
    fs.writeFileSync(path.join(hbDir, 'com.test.legacy.json'), JSON.stringify({ label: 'com.test.legacy', state: 'failed', exit_code: 1, run_id: 'old', failing_since: '2026-10-01T00:00:00Z' }));
    run('com.test.legacy', 1);
    expect(curlCalls()).toHaveLength(1);
    run('com.test.legacy', 1);
    expect(curlCalls()).toHaveLength(1);
  });

  it('stopping the wrapper (launchd bootout) stops a job that ignores TERM, leaving nothing behind', () => {
    makeHarness({ withTopic: false });
    const marker = path.join(workDir, 'stubborn.pid');
    const f = path.join(workDir, 'stubborn.sh');
    fs.writeFileSync(f, `#!/bin/sh\ntrap '' TERM\necho $$ > ${marker}\nsleep 120 & wait\n`); fs.chmodSync(f, 0o755);
    const t0 = Date.now();
    const r = spawnSync('/bin/sh', ['-c', `/usr/bin/perl -e 'setpgrp(0,0); exec @ARGV' /bin/sh ${WRAPPER} com.test.bootout -- ${f} & W=$!; sleep 2; kill -TERM $W; wait $W; echo rc=$?`], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: path.join(workDir, 'home'), JOB_HEARTBEAT_DIR: path.join(workDir, 'heartbeats'), NTFY_TOPIC: '' } });
    expect(Date.now() - t0).toBeLessThan(25_000);
    expect(r.stdout).toContain('rc=143');
    const pid = Number(fs.readFileSync(marker, 'utf8'));
    let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
    expect(hb('com.test.bootout').state).toBe('killed');
  }, 40_000);

  it.runIf(fs.existsSync('/bin/dash'))('the overrun limit also works under dash (Ubuntu /bin/sh)', () => {
    makeHarness({ withTopic: false });
    const t0 = Date.now();
    runWith('com.test.dash', "trap '' TERM\nsleep 60 & wait", { JOB_MAX_SECONDS: '1', SHELL_BIN: '/bin/dash' });
    expect(Date.now() - t0).toBeLessThan(25_000);
    expect(hb('com.test.dash').state).toBe('killed');
  }, 40_000);

  it('run outside launchd (not a group leader), a TERM-proof grandchild that outlives its parent is still killed', () => {
    makeHarness({ withTopic: false });
    const marker = path.join(workDir, 'orphan.pid');
    const f = path.join(workDir, 'orphan.sh');
    fs.writeFileSync(f, `#!/bin/sh\nsh -c 'trap "" TERM; echo $$ > ${marker}; sleep 120' &\nsleep 60 & wait\n`); fs.chmodSync(f, 0o755);
    spawnSync('/bin/sh', [WRAPPER, 'com.test.orphan', '--', f], { encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: path.join(workDir, 'home'), JOB_HEARTBEAT_DIR: path.join(workDir, 'heartbeats'), NTFY_TOPIC: '', JOB_MAX_SECONDS: '2' } });
    const pid = Number(fs.readFileSync(marker, 'utf8'));
    let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  }, 40_000);

  it('the run-time timer never outlives the wrapper', () => {
    makeHarness({ withTopic: false });
    runWith('com.test.short', 'exit 0', { JOB_MAX_SECONDS: '7321' });
    const left = spawnSync('/usr/bin/pgrep', ['-f', 'sleep 7321'], { encoding: 'utf8' }).stdout.trim();
    expect(left).toBe('');
  });

  it('the running receipt stays valid JSON when the command has quotes and newlines', () => {
    makeHarness({ withTopic: false });
    const label = 'com.test.json';
    const f = path.join(workDir, 'peek.sh');
    // While running, copy the receipt aside so the test can parse the "running" record itself.
    fs.writeFileSync(f, `#!/bin/sh\ncp "${path.join(workDir, 'heartbeats', label + '.json')}" "${path.join(workDir, 'running.json')}"\n`); fs.chmodSync(f, 0o755);
    spawnSync('/bin/sh', [WRAPPER, label, '--', f, 'a\n"b"\\c'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: path.join(workDir, 'home'), JOB_HEARTBEAT_DIR: path.join(workDir, 'heartbeats'), NTFY_TOPIC: '' } });
    const running = JSON.parse(fs.readFileSync(path.join(workDir, 'running.json'), 'utf8'));
    expect(running.state).toBe('running');
    expect(running.command).not.toMatch(/"b"/);
  });

  it('REGRESSION GUARD: with NO topic configured (the pre-fix state on this machine), a failing '
    + 'job still records the failure but CANNOT page — proving the missing topic file, not a code '
    + 'bug, was the entire reason three jobs failed silently', () => {
    const { run, curlCalls, receipt } = makeHarness({ withTopic: false });
    const res = run('com.test.unpageable-failure', 3);

    expect(res.status).toBe(3);
    expect(receipt('com.test.unpageable-failure').state).toBe('failed'); // the evidence exists...
    expect(curlCalls().length).toBe(0); // ...but nothing was ever going to tell anyone
  });
});
