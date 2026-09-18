// console-session-surfacing-hook-check.test.mjs — the Memory-quality card's `sessionSurfacing`
// dimension claims "the global SessionStart hook surfaces project state at launch". That claim can
// only be true if the SPECIFIC recall hook (`~/.claude/hooks/agentdb-ensure.sh`) is present.
//
// THE GAP: `sessionHookExists()` (scripts/onboarding-console.mjs) OR'd in a second, much weaker
// check — `fs.existsSync('~/.claude/hooks')` — that is satisfied by ANY hooks directory, including
// one that holds only unrelated scripts. A machine with hooks configured for something else entirely
// (a different plugin, a stale directory left by an uninstalled tool) would score `sessionSurfacing:
// ok` and print a claim about project-state recall that this machine never wired up. Zero test
// coverage existed for this function before this file.
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
).status;

describe('sessionSurfacing must verify the SPECIFIC recall hook, not just any hooks directory', () => {
  it('a hooks dir holding only an unrelated script is NOT reported ok', () => {
    fs.mkdirSync(path.join(tmp, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'hooks', 'some-other-hook.sh'), '#!/bin/sh\necho hi\n');
    expect(probeSessionSurfacing()).not.toBe('ok');
  });

  it('no hooks directory at all is NOT reported ok', () => {
    expect(probeSessionSurfacing()).not.toBe('ok');
  });

  it('the real recall hook script present IS reported ok', () => {
    fs.mkdirSync(path.join(tmp, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'hooks', 'agentdb-ensure.sh'), '#!/bin/sh\necho hi\n');
    expect(probeSessionSurfacing()).toBe('ok');
  });
});
