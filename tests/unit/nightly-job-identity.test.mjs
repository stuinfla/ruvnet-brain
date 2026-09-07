// tests/unit/nightly-job-identity.test.mjs — issue #113.
//
// THE FAILURE THIS PINS. Two files in one release disagreed about the name of one launchd job with
// nothing to notice. bin/install.mjs loads a LaunchAgent labelled `com.ruvnet.brain-update`;
// capability-registry.mjs looked for jobs matching /^com\.ruvnet\.[\w.-]*(nightly|refresh)/ — which
// `brain-update` does not match — so the console reported "no nightly refresh job is loaded" about a
// job that was loaded, scheduled for 03:47 daily, and running. A detector blind to its own
// installer, and the under-counting twin of the over-counting bug the same detector had already been
// fixed for.
//
// TWO GUARDS, because the defect had two halves. The behavioural one drives the shipped detector
// against a fake `launchctl` so the real code path is exercised, including the case that must STAY
// absent. The identity one asserts the installer's literal still equals the exported constant, since
// the installer keeps its own copy — a second representation with an alarm on it, rather than a
// second representation with none.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NIGHTLY_LABEL, nightlyArtifact } from '../../scripts/nightly-controller.mjs';
import { installNightlyRunner, launchdPlist } from '../../plugin/scripts/nightly-scheduler.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY = path.join(REPO, 'scripts', 'capability-registry.mjs');

/**
 * Run the shipped nightly-refresh detector against a launchd table we control, by putting a fake
 * `launchctl` first on PATH. The detector shells out to the real one, so this is the only way to
 * assert on a specific machine state without mutating the developer's own launchd domain.
 */
function detectWithJobs(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-nightly-launchctl-'));
  try {
    const home = path.join(dir, 'home');
    const brainHome = path.join(home, '.cache', 'ruvnet-brain');
    const kbDir = path.join(brainHome, 'kb');
    fs.mkdirSync(kbDir, { recursive: true });
    const source = path.join(dir, 'runner.mjs');
    fs.writeFileSync(source, 'process.exitCode = 0;\n');
    const registration = installNightlyRunner({ brainHome, source, nodePath: process.execPath });
    const scheduled = rows.find((row) => row[2] === NIGHTLY_LABEL);
    if (scheduled) {
      const plist = nightlyArtifact({ env: { HOME: home }, platform: 'darwin' }).path;
      fs.mkdirSync(path.dirname(plist), { recursive: true });
      fs.writeFileSync(plist, launchdPlist(registration, {
        kbDir, logPath: path.join(kbDir, 'update.log'), pathValue: dir,
      }));
    }
    const fake = path.join(dir, 'launchctl');
    fs.writeFileSync(fake, scheduled
      ? `#!/bin/sh\nprintf -- "last exit code = ${scheduled[1]}\\n"\n`
      : '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const out = execFileSync(process.execPath, [
      '-e',
      `import(${JSON.stringify(REGISTRY)}).then((m) => {
         const c = m.CAPABILITIES.find((x) => x.key === 'nightly-refresh');
         process.stdout.write(JSON.stringify(c.detect({ project: process.cwd() })));
       });`,
    ], { encoding: 'utf8', env: { ...process.env, HOME: home, RUVNET_BRAIN_HOME: brainHome,
      RUVNET_BRAIN_KB: kbDir, PATH: `${dir}${path.delimiter}${process.env.PATH}` } });
    return JSON.parse(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// launchd is macOS-only and the detector says so honestly on every other platform, so there is no
// machine state to assert about elsewhere. The identity guard below runs everywhere.
describe.skipIf(process.platform !== 'darwin')('issue #113 — the detector can see the job the installer loads', () => {
  it('reports the installer\'s own nightly job as installed and running', () => {
    const r = detectWithJobs([['-', '0', NIGHTLY_LABEL]]);
    expect(r.state).toBe('on');
    expect(r.evidence).toMatch(/runner digest verified/);
    expect(r.evidence).not.toMatch(/no nightly refresh job is loaded/);
  });

  it('carries its exit status through instead of calling a failing job absent', () => {
    const r = detectWithJobs([['-', '1', NIGHTLY_LABEL]]);
    expect(r.state).toBe('on');
    expect(r.evidence).toMatch(/last exited 1/);
  });

  // The opposite failure, which this detector has already shipped once: counting every job whose
  // label merely starts com.ruvnet as evidence for a capability none of them implements. Widening
  // the match must not reopen it.
  it('still says absent when the RuvNet jobs loaded are all something else', () => {
    const r = detectWithJobs([
      ['-', '0', 'com.ruvnet.issue-fix'],
      ['-', '0', 'com.ruvnet.npm-token-renew'],
      ['-', '0', 'com.ruvnet.nightly-watchdog'],
    ]);
    expect(r.state).toBe('absent');
    expect(r.evidence).toMatch(/No LaunchAgent plist/);
  });
});

describe('issue #113 — one name for the nightly job, and an alarm on the copy', () => {
  it('has one owner and the installer imports that owner', () => {
    const installer = fs.readFileSync(path.join(REPO, 'bin', 'install.mjs'), 'utf8');
    expect(installer).toMatch(/import\s*\{[\s\S]*NIGHTLY_LABEL[\s\S]*\}\s*from '\.\.\/plugin\/scripts\/nightly-scheduler\.mjs'/);
    expect(installer).not.toMatch(/NIGHTLY_LABEL\s*=\s*['"]/);
  });

  it('is the label the console turns the job on and off by', () => {
    const artifact = nightlyArtifact({ env: { HOME: '/tmp/does-not-matter' }, platform: 'darwin' });
    expect(artifact.label).toBe(NIGHTLY_LABEL);
    expect(artifact.path.endsWith(`${NIGHTLY_LABEL}.plist`)).toBe(true);
  });
});
