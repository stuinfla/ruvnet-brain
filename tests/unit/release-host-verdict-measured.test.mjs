import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { liveReleaseProvider } from '../../scripts/release-transaction-provider.mjs';

/**
 * The host verdict must be MEASURED, not declared.
 *
 * liveReleaseProvider.finalize() accepted a host verifier and then ignored it — the parameter was
 * literally named `_hostVerifier` — while building `hosts = { verdict: 'PASS', … }` as a literal.
 * So every release asserted host convergence without any host being verified, and the injected
 * seam that could have caught it was inert in production. Meanwhile
 * tests/helpers/release-transaction-fixture.mjs:153 called it faithfully, so the fault-injection
 * suite certified wiring the real publisher never executed. Fable 5 and GPT-5.6-Sol independently
 * ranked this their #1 finding.
 *
 * These cases pin the contract at the production seam: whatever the verifier says, finalize says.
 */
const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

function stagedRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-host-verdict-'));
  dirs.push(root);
  const evidence = path.join(root, 'release-evidence');
  fs.mkdirSync(evidence, { recursive: true });
  // finalize() short-circuits the publication subprocess when the receipt already exists, so the
  // seam under test runs without touching the network or a real publish.
  fs.writeFileSync(path.join(evidence, 'publication.json'), `${JSON.stringify({
    installed: { claudeOnly: 'ok', codexOnly: 'ok', dual: 'ok' },
    postPublicationChecks: [{ name: 'published-surface-probe', status: 'completed', conclusion: 'success' }],
  })}\n`);
  fs.writeFileSync(path.join(evidence, 'candidate.json'), '{}\n');
  return root;
}

const IDENTITY = { version: '9.9.9', tag: 'v9.9.9', candidateSha: 'a'.repeat(40) };
const RECEIPT = { transactionId: 'tx-test', receiptDigest: 'd'.repeat(64) };

const providerFor = (root) => liveReleaseProvider({
  root,
  candidateReceipt: 'release-evidence/candidate.json',
  publicationReceipt: 'release-evidence/publication.json',
});

describe('release finalize — the host verdict is measured, not declared', () => {
  it('a FAILING host verifier FAILS the release', async () => {
    const root = stagedRoot();
    const calls = [];
    const failing = {
      verify: async (args) => { calls.push(args); return { verdict: 'FAIL', error: 'codex-only doctor exited 1' }; },
    };

    const result = await providerFor(root).finalize(IDENTITY, RECEIPT, failing);

    expect(calls.length, 'production must actually CALL the verifier it is handed').toBe(1);
    expect(calls[0].source).toBe('final');
    expect(result.verdict, 'a failed host install cannot converge the release').toBe('FAIL');
    expect(result.hosts.verdict).toBe('FAIL');
    expect(result.hosts.verifier.error).toMatch(/codex-only doctor exited 1/);
  });

  it('refuses to finalize at all when no verifier is supplied', async () => {
    const result = await providerFor(stagedRoot()).finalize(IDENTITY, RECEIPT, undefined);
    expect(result.verdict).toBe('FAIL');
    expect(result.hostVerifierError).toMatch(/no host verifier/i);
  });

  it('TEETH: a PASSING verifier is still asked, and its verdict is the one reported', async () => {
    const root = stagedRoot();
    const calls = [];
    const passing = {
      verify: async (args) => { calls.push(args); return { verdict: 'PASS', artifactSha256: 'c'.repeat(64), fixtures: [] }; },
    };

    const result = await providerFor(root).finalize(IDENTITY, RECEIPT, passing);

    // Without this control, "always FAIL" would satisfy the two cases above.
    expect(calls.length, 'the verifier must be consulted on the success path too').toBe(1);
    // A PASS does not short-circuit: finalize carries on into publication and sealing, which this
    // fixture deliberately does not stand up (they are real subprocesses). So the contract pinned
    // here is that a passing host verdict is NOT what stops the release — whatever fails later,
    // it is not the host gate, and the failure is never `hostVerifierError`.
    expect(result.hostVerifierError).toBeUndefined();
    expect(result.hosts?.verdict, 'a PASS must never be reported as a host failure').not.toBe('FAIL');
  });
});
