/**
 * `npx ruvnet-brain --update` — issue #106: it exited 0 while the corpus was unchanged.
 *
 * The updater itself was never the problem. It detected the failure, named it, and refused:
 *
 *     [forge-update] ERROR: [open-claude-code] UPDATE MISMATCH: SOURCE.json on disk is IDENTICAL
 *     to before the update … REFUSING to report success.
 *
 * and then exited non-zero — at which point `--update`'s fresh-install FALLBACK ran, succeeded at
 * re-installing the very same bytes, and ITS exit 0 became the exit code of the whole command. The
 * refusal survived only as a line in a log nobody reads; a scheduled job saw success.
 *
 * The fallback exists for one real case: an old bundle whose canonical manifest 404s, where a fresh
 * install genuinely rescues the user. "Nothing landed" is not that case. It is a true verdict about
 * an intact KB, and re-downloading cannot change it — so it is terminal, and it keeps its own exit
 * code so a caller can tell "nothing to do" apart from "something broke".
 *
 * The exit code crosses an artifact boundary: kb/forge-update.mjs ships inside the KB BUNDLE and
 * versions independently of bin/install.mjs, so the number cannot be imported and is written in
 * both. This file is what stops the two from drifting apart in silence.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let install; let forgeUpdate;

beforeAll(async () => {
  process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
  install = await import(`${pathToFileURL(path.join(ROOT, 'bin', 'install.mjs')).href}?notlanded=${Date.now()}`);
  forgeUpdate = await import(pathToFileURL(path.join(ROOT, 'kb', 'forge-update.mjs')).href);
});
afterAll(() => { delete process.env.RUVNET_BRAIN_IMPORT_ONLY; });

describe('the "nothing landed" exit code is one number in two artifacts', () => {
  it('bin/install.mjs and kb/forge-update.mjs agree on it', () => {
    // Both must be REAL numbers first: two undefineds are also "equal", and an agreement between
    // two absent constants is exactly the vacuous green this file exists to prevent.
    expect(typeof install.UPDATE_NOT_LANDED, 'bin/install.mjs must export it').toBe('number');
    expect(typeof forgeUpdate.EXIT_NOT_LANDED, 'kb/forge-update.mjs must export it').toBe('number');
    expect(install.UPDATE_NOT_LANDED).toBe(forgeUpdate.EXIT_NOT_LANDED);
  });

  it('is distinct from every other verdict the updater can return', () => {
    // 0 success · 1 generic error · 2 network · 3/4 signature · 10 --check says behind.
    expect(Number.isInteger(forgeUpdate.EXIT_NOT_LANDED)).toBe(true);
    expect([0, 1, 2, 3, 4, 10]).not.toContain(forgeUpdate.EXIT_NOT_LANDED);
  });

  it('is documented in forge-update.mjs itself, so the meaning travels with the bundle', () => {
    const src = fs.readFileSync(path.join(ROOT, 'kb', 'forge-update.mjs'), 'utf8');
    expect(src).toMatch(/EXIT CODES/);
    expect(src).toMatch(new RegExp(`\\s${forgeUpdate.EXIT_NOT_LANDED}\\s+--apply: the download completed but the bundle on disk did NOT change`));
  });
});

describe('classifyUpdaterExit (issue #106)', () => {
  it('does NOT fall back to a fresh install when the updater says nothing landed, and keeps the failure', () => {
    // The whole bug in one assertion: the fallback is what converted this verdict into exit 0.
    const r = install.classifyUpdaterExit(install.UPDATE_NOT_LANDED);

    expect(r.verdict).toBe('not-landed');
    expect(r.fallback, 're-downloading the same bundle cannot make it different').toBe(false);
    expect(r.exitCode, 'a scheduled job must read this as failure').not.toBe(0);
    expect(r.exitCode).toBe(install.UPDATE_NOT_LANDED);
  });

  it('still falls back for a genuinely broken updater — the 404 case the fallback was built for', () => {
    const r = install.classifyUpdaterExit(2);
    expect(r.verdict).toBe('failed');
    expect(r.fallback, 'a user stranded at a dead manifest URL must still be rescued').toBe(true);
  });

  it('honours the fallback opt-out without turning a failure into a success', () => {
    const r = install.classifyUpdaterExit(1, { fallbackAllowed: false });
    expect(r.fallback).toBe(false);
    expect(r.exitCode).toBe(1);
  });

  it('passes a real success through untouched', () => {
    expect(install.classifyUpdaterExit(0)).toEqual({ verdict: 'updated', fallback: false, exitCode: 0 });
  });

  it('never reports exit 0 for any non-zero updater status', () => {
    for (const status of [1, 2, 3, 4, 10, install.UPDATE_NOT_LANDED, 127]) {
      expect(install.classifyUpdaterExit(status, { fallbackAllowed: false }).exitCode, `status ${status}`).not.toBe(0);
    }
  });
});
