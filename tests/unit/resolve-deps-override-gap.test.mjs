// tests/unit/resolve-deps-override-gap.test.mjs — closes a dead-branch gap left by
// tests/unit/resolve-deps.test.mjs. That file's "RVF_MODULE_PATH set to a dir lacking the SDK" and
// "XENOVA_PATH override branch" tests never actually reach loadRvf()/loadTransformers()'s env-override
// code (kb/resolve-deps.mjs:43-52, 76-87): both packages are real devDependencies installed in
// kb/node_modules, so the FIRST try-block (project node_modules, walked up from resolve-deps.mjs's own
// dir via createRequire) always succeeds regardless of what the env var is set to. Confirmed via raw
// coverage/lcov.info (DA:43,0 … DA:87,0 — zero hits) plus `find` showing both packages live under
// kb/node_modules, never the repo root. The existing tests pass, but not for the reason their names
// claim — a real regression in the override logic itself would go unnoticed.
//
// This file exercises those branches for real by mocking node:module's createRequire so the primary
// resolution genuinely fails, the same way it would on a machine where `cd kb && npm i` was never run.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createRequire: (specifier) => {
      const real = actual.createRequire(specifier);
      const stub = (id) => {
        if (id === '@ruvector/rvf' || id === '@xenova/transformers') {
          throw new Error(`Cannot find module '${id}' (mocked: simulating an env without kb/node_modules)`);
        }
        return real(id);
      };
      stub.resolve = (id, opts) => {
        if (id === '@xenova/transformers') {
          throw new Error(`Cannot find module '${id}' (mocked)`);
        }
        return real.resolve(id, opts);
      };
      return stub;
    },
  };
});

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-override-')); });
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.RVF_MODULE_PATH;
  delete process.env.XENOVA_PATH;
});

describe('loadRvf — RVF_MODULE_PATH override, with the primary resolution genuinely failing', () => {
  it.todo('no RVF_MODULE_PATH set: throws the "Cannot resolve @ruvector/rvf" error (lines 56-59)');

  it.todo('RVF_MODULE_PATH set to a dir that does NOT contain @ruvector/rvf: falls through both ' +
    'sub-attempts (lines 49-53) and throws the same clear error, not a raw require error');

  it.todo('RVF_MODULE_PATH set to a dir whose createRequire(noop.js)(\'@ruvector/rvf\') genuinely ' +
    'resolves: returns { mod, via: "RVF_MODULE_PATH (<path>)" } — the actual success path (line 50), ' +
    'never exercised by any existing test');

  it.todo('RVF_MODULE_PATH already ENDS with "@ruvector/rvf": uses envPath verbatim as `base` (line ' +
    '45-46) instead of joining — needs a fixture dir literally named @ruvector/rvf');
});

describe('loadTransformers — XENOVA_PATH override, with the primary resolution genuinely failing', () => {
  it.todo('no XENOVA_PATH set: throws the "Cannot resolve @xenova/transformers" error (lines 87-89)');

  it.todo('XENOVA_PATH starting with "file://": used verbatim as the import URL (line 78)');

  it.todo('XENOVA_PATH ending in ".js": resolved to file://<abs path> directly (line 79) — the ' +
    'existing test in resolve-deps.test.mjs sets this env var but (per the dead-branch finding above) ' +
    'never actually reaches this line, so it never proved the URL is built correctly, only that ' +
    'SOME error is eventually thrown');

  it.todo('XENOVA_PATH as a bare dir: resolved to file://<dir>/src/transformers.js (line 80)');
});

// Sanity check that the mock itself actually breaks the primary path (i.e. this file's premise is
// real, not a mock that silently no-ops). Kept as a real, passing assertion — everything above is
// .todo because writing the fixture directories in kb/node_modules/../<tmp> that make createRequire
// SUCCEED via the override path (rather than just fail differently) is the part worth a human sign-off
// on the fixture shape, not the mocking technique.
describe('mock sanity', () => {
  it('proves the primary require path can be made to fail from the test side alone', async () => {
    vi.resetModules();
    const { loadRvf } = await import('../../kb/resolve-deps.mjs');
    delete process.env.RVF_MODULE_PATH;
    expect(() => loadRvf()).toThrow(/@ruvector\/rvf/);
  });
});
