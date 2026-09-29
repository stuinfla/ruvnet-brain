// console-session-surfacing-hook-check.test.mjs — the Memory-quality card's `sessionSurfacing`
// dimension claims a SessionStart hook surfaces project state at launch. That claim can only be
// true if a real recall mechanism is actually wired: either the legacy standalone
// `~/.claude/hooks/agentdb-ensure.sh`, or the `ruvnet-brain` plugin itself being enabled (which
// wires `project-progression-session-start.mjs` via `plugin/hooks/hooks.json`'s own SessionStart
// entry — this repo's current, documented, automatic path).
//
// THE GAP (fixed 2026-09-18): `sessionHookExists()` OR'd in a second, much weaker check —
// `fs.existsSync('~/.claude/hooks')` — satisfied by ANY hooks directory, including one holding only
// unrelated scripts. Fixed to check only the specific `agentdb-ensure.sh` file.
//
// THE SECOND GAP (fixed 2026-09-19): even after that fix, the check still recognized only the
// legacy global hook and never the plugin's own wired continuity path. A machine that installed
// `ruvnet-brain` the current, documented way (Claude Code's marketplace flow) and never separately
// placed the legacy shell hook scored `sessionSurfacing: warn` — a false negative — even though
// project-state recall was already running automatically via the plugin's SessionStart hook.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { scratch, makeRunner, IMPORT } from './helpers/console-child.mjs';

let tmp, run, runJSON;
beforeEach(() => {
  tmp = scratch('console-session-surfacing-');
  ({ run, runJSON } = makeRunner(tmp));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const probeSessionSurfacing = () => runJSON(
  `${IMPORT}\nconsole.log(JSON.stringify(m.probeMemory(process.env.HOME).sessionSurfacing));`,
);

function writeEnabledPlugins(entries) {
  fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: entries }));
}

describe('sessionSurfacing must verify the SPECIFIC recall hook, not just any hooks directory', () => {
  it('a hooks dir holding only an unrelated script is NOT reported ok', () => {
    fs.mkdirSync(path.join(tmp, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'hooks', 'some-other-hook.sh'), '#!/bin/sh\necho hi\n');
    expect(probeSessionSurfacing().status).not.toBe('ok');
  });

  it('no hooks directory at all is NOT reported ok', () => {
    expect(probeSessionSurfacing().status).not.toBe('ok');
  });

  it('the real recall hook script present IS reported ok', () => {
    fs.mkdirSync(path.join(tmp, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'hooks', 'agentdb-ensure.sh'), '#!/bin/sh\necho hi\n');
    const p = probeSessionSurfacing();
    expect(p.status).toBe('ok');
    expect(p.via).toBe('agentdb-ensure');
  });
});

describe('sessionSurfacing must also credit the ruvnet-brain plugin\'s own wired SessionStart hook', () => {
  it('ruvnet-brain enabled in ~/.claude/settings.json IS reported ok, even with no legacy hook file', () => {
    writeEnabledPlugins({ 'ruvnet-brain@ruvnet-brain': true });
    const p = probeSessionSurfacing();
    expect(p.status).toBe('ok');
    expect(p.via).toBe('ruvnet-brain-plugin');
  });

  it('a DIFFERENT plugin enabled (not ruvnet-brain) is NOT reported ok', () => {
    writeEnabledPlugins({ 'superpowers@claude-plugins-official': true });
    expect(probeSessionSurfacing().status).not.toBe('ok');
  });

  it('ruvnet-brain present but disabled (false) is NOT reported ok', () => {
    writeEnabledPlugins({ 'ruvnet-brain@ruvnet-brain': false });
    expect(probeSessionSurfacing().status).not.toBe('ok');
  });

  it('no settings file at all is NOT reported ok (same as before this fix)', () => {
    expect(probeSessionSurfacing().status).not.toBe('ok');
  });

  it('the legacy hook still wins reporting-wise when both are present', () => {
    fs.mkdirSync(path.join(tmp, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'hooks', 'agentdb-ensure.sh'), '#!/bin/sh\necho hi\n');
    writeEnabledPlugins({ 'ruvnet-brain@ruvnet-brain': true });
    const p = probeSessionSurfacing();
    expect(p.status).toBe('ok');
    expect(p.via).toBe('agentdb-ensure');
  });
});
