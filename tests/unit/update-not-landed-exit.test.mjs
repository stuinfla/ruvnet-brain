/**
 * The legacy exit-11 protocol was replaced by a typed updater result receipt. Exit 0 is only
 * acceptable when the caller can distinguish an applied transaction from a byte-exact no-op;
 * missing or contradictory result evidence fails closed for the nightly path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let install;

beforeAll(async () => {
  process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
  install = await import(`${pathToFileURL(path.join(ROOT, 'bin', 'install.mjs')).href}?typed-result=${Date.now()}`);
});
afterAll(() => { delete process.env.RUVNET_BRAIN_IMPORT_ONLY; });

describe('classifyUpdaterExit typed result boundary', () => {
  it.each(['applied', 'noop'])('accepts exit 0 only with a typed %s receipt', (terminalVerdict) => {
    expect(install.classifyUpdaterExit(0, { requireResult: true, result: { terminalVerdict } }))
      .toEqual({ verdict: terminalVerdict, fallback: false, exitCode: 0 });
  });

  it('fails closed when a nightly updater exits 0 without a typed result receipt', () => {
    expect(install.classifyUpdaterExit(0, { requireResult: true, result: null }))
      .toEqual({ verdict: 'invalid-result', fallback: false, exitCode: 1 });
  });

  it('keeps explicit legacy success only for callers that did not require a result receipt', () => {
    expect(install.classifyUpdaterExit(0))
      .toEqual({ verdict: 'legacy-success', fallback: false, exitCode: 0 });
  });

  it('preserves cleanup-pending as a typed non-success terminal state', () => {
    expect(install.classifyUpdaterExit(12, { result: { terminalVerdict: 'cleanup-pending' } }))
      .toEqual({ verdict: 'cleanup-pending', fallback: false, exitCode: 12 });
  });

  it('still permits the fresh-install fallback for an untyped broken updater when requested', () => {
    expect(install.classifyUpdaterExit(2))
      .toEqual({ verdict: 'failed', fallback: true, exitCode: 2 });
    expect(install.classifyUpdaterExit(2, { fallbackAllowed: false }))
      .toEqual({ verdict: 'failed', fallback: false, exitCode: 2 });
  });

  it('never converts a non-zero updater status into success', () => {
    for (const status of [1, 2, 3, 4, 10, 12, 127]) {
      expect(install.classifyUpdaterExit(status, { fallbackAllowed: false }).exitCode).not.toBe(0);
    }
  });
});
