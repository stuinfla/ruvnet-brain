// The one test environment of every version 5 test harness (helpers.mjs and wp4-helpers.mjs import it
// first). It points HOME, USERPROFILE, the XDG folders, CLAUDE_CONFIG_DIR, CODEX_HOME and the brain
// home of this process (and so of every program a test starts) at a fresh temporary folder, and sets the
// test marker RUVNET_BRAIN5_TEST=1, under which the host-registration code refuses to write anything
// under the real user's home folder (packages/plugin/install.mjs, refuseProtected). So no test can reach
// a real host setting (~/.claude, ~/.claude.json, ~/.codex) or a live brain home.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = os.userInfo().homedir;
export const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rb5-userhome-'));
for (const k of ['HOME', 'USERPROFILE']) process.env[k] = FAKE_HOME;
for (const k of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) process.env[k] = path.join(FAKE_HOME, k.toLowerCase());
process.env.CLAUDE_CONFIG_DIR = path.join(FAKE_HOME, '.claude');
process.env.CODEX_HOME = path.join(FAKE_HOME, '.codex');
process.env.RUVNET_BRAIN5_HOME = path.join(FAKE_HOME, '.cache', 'ruvnet-brain-5');
process.env.RUVNET_BRAIN5_TEST = '1';
process.on('exit', () => fs.rmSync(FAKE_HOME, { recursive: true, force: true }));
assert.notEqual(os.homedir(), realHome, 'the test HOME must not be the real one');
