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

  it('S2: treats a rollback-protection refusal as a clean, non-fallback exit 0 — never a reported failure', () => {
    // forge-update.mjs's currencyVerdict() REFUSED path (candidate corpus generation predates the
    // installed one) writes terminalVerdict:'refused' and exits 0. Misclassifying it as
    // 'invalid-result'/failed would turn the updater's own correct rollback-protection refusal into a
    // reported --update failure — the same shape issue #106 fixed for the noop case, one gate later.
    expect(install.classifyUpdaterExit(0, { requireResult: true, result: { terminalVerdict: 'refused' } }))
      .toEqual({ verdict: 'refused', fallback: false, exitCode: 0 });
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

  it('does NOT fall back to a fresh install when the updater refused because of retained full-KB copies', () => {
    // MEASURED 2026-09-30 (scripts/customer-state-matrix.mjs, leftovers=*): a 4.3.38 customer with two
    // prior-generation copies beside the brain. The updater refused "unresolved rollback state exists;
    // refusing to create another full-KB copy" — and the installer's fallback then ran a fresh install,
    // which re-downloaded the bundle and PRESERVED ANOTHER full copy (2 -> 3 copies, +1.3 GB), every run.
    const reason = 'unresolved rollback state exists; refusing to create another full-KB copy.\n  /x/kb.bak-1: PRESERVED_UNCLASSIFIED';
    expect(install.classifyUpdaterExit(1, { result: { terminalVerdict: 'failed', reason } }))
      .toEqual({ verdict: 'refused-retained-copies', fallback: false, exitCode: 1 });
    // Any other failure keeps the documented fallback.
    expect(install.classifyUpdaterExit(1, { result: { terminalVerdict: 'failed', reason: 'network failure' } }))
      .toEqual({ verdict: 'failed', fallback: true, exitCode: 1 });
  });

  it('does NOT reinstall over a TRANSIENT GitHub refusal (rate limit / 5xx / offline); a dead manifest URL still falls back', () => {
    // MEASURED 2026-09-30 (customer-state-matrix, network=manifest-rate-limited): the manifest answered 403
    // (GitHub's anonymous rate limit). The updater exited 2 "nothing changed" and the installer reinstalled
    // the whole brain from scratch, leaving a 1.3 GB preserved copy — every rate-limited run, until two such
    // copies trip the retained-copy refusal and updates stop for good.
    for (const reason of ['canonical manifest returned HTTP 403 for https://api.github.com/x — nothing changed.',
      'canonical manifest returned HTTP 429 for https://api.github.com/x — nothing changed.',
      'canonical manifest returned HTTP 503 for https://api.github.com/x — nothing changed.',
      'network failure fetching https://api.github.com/x\n  getaddrinfo ENOTFOUND — nothing changed locally.']) {
      expect(install.classifyUpdaterExit(2, { result: { terminalVerdict: 'failed', reason } }), reason)
        .toEqual({ verdict: 'transient-network', fallback: false, exitCode: 2 });
    }
    // The case the fallback exists for (an old bundle polling a dead URL) keeps it.
    expect(install.classifyUpdaterExit(2, { result: { terminalVerdict: 'failed',
      reason: 'canonical manifest returned HTTP 404 for https://raw.githubusercontent.com/x/main/kb/.last-built.json — nothing changed.' } }))
      .toEqual({ verdict: 'failed', fallback: true, exitCode: 2 });
  });

  it('never converts a non-zero updater status into success', () => {
    for (const status of [1, 2, 3, 4, 10, 12, 127]) {
      expect(install.classifyUpdaterExit(status, { fallbackAllowed: false }).exitCode).not.toBe(0);
    }
  });
});
