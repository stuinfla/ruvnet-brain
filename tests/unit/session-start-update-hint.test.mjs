// tests/unit/session-start-update-hint.test.mjs — every "a newer bundle exists" hint must send the user
// through the door that upgrades the updater first.
//
// MEASURED 2026-09-30 (scripts/customer-state-matrix.mjs, door=installed-updater + runtime=N-11): a real 4.3.28
// install running its OWN installed updater (`cd ~/.cache/ruvnet-brain/kb && node forge-update.mjs --apply`,
// exactly what this hint told users) against the published 4.3.39 bundle fails every time: that updater predates
// carrying node_modules into the candidate, so forge-guard cannot load the embedder ("forge-guard failed …
// --name 2bottalk"). The same install through `npx ruvnet-brain@latest --update` applies, because the installer
// places the current updater before running it (bin/install.mjs ensureUpdaterPrerequisites).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { heartbeat } from '../../plugin/scripts/session-start-update-plane.mjs';

const DOOR = 'npx ruvnet-brain@latest --update';
const temps = [];
afterEach(() => { while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true }); });

describe('session-start update hint', () => {
  it('a BEHIND bundle is announced with the self-upgrading npx door, never the installed updater', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-update-hint-'));
    temps.push(home);
    const stateDir = path.join(home, '.cache', 'ruvnet-brain');
    const kbDir = path.join(stateDir, 'kb');
    fs.mkdirSync(kbDir, { recursive: true });
    fs.writeFileSync(path.join(kbDir, 'forge-update.mjs'), '// installed updater\n');
    fs.writeFileSync(path.join(stateDir, '.auto-update-pref'), 'yes\n');
    fs.writeFileSync(path.join(stateDir, '.last-kb-check.log'), '[ruvector] BEHIND\n');
    // An empty hookDir has no detach.mjs, so the heartbeat's background dispatches are inert here.
    const hookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-update-hint-hooks-'));
    temps.push(hookDir);
    const emitted = [];
    heartbeat({ env: { HOME: home }, hookDir, stateDir, home, running: null, seedDispatched: false,
      stamp: path.join(stateDir, '.last-update-check'), emit: (line) => emitted.push(line), now: Date.now() });
    const hint = emitted.find((line) => /newer knowledge bundle is available/.test(line));
    expect(hint, emitted.join('\n')).toBeTruthy();
    expect(hint).toContain(`To update: ${DOOR}`);
    expect(hint).not.toMatch(/forge-update\.mjs/);
  });
});
