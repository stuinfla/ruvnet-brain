import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOST_MODES, MODE_HOSTS, RECEIPT_MODE_NAMES, MODE_FROM_RECEIPT_NAME, VARIANTS, classifyDoctor,
} from '../../scripts/host-install-matrix.mjs';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * A DRIFT GATE, not a unit test.
 *
 * The release had two host harnesses doing one job. They disagreed about the mode names
 * (claude/codex/dual vs claudeOnly/codexOnly/dual), the installer flags, and the environment — so
 * "the hosts passed" meant two different things depending on which half of the release you asked,
 * and nothing could observe that they had drifted. Fixing the two copies is not enough; the third
 * copy is what this file exists to stop.
 *
 * These cases fail the moment someone re-adds a private loop, a private doctor rule, or a fourth
 * spelling of the same three fixtures.
 */
describe('host matrix — one definition, enforced', () => {
  it('names the three host shapes exactly once, and every mode is complete', () => {
    expect(HOST_MODES).toEqual(['claude', 'codex', 'dual']);
    for (const mode of HOST_MODES) {
      expect(MODE_HOSTS[mode], `${mode} must declare which CLIs it may see`).toBeInstanceOf(Array);
      expect(RECEIPT_MODE_NAMES[mode], `${mode} must map to a receipt name`).toBeTruthy();
      expect(MODE_FROM_RECEIPT_NAME[RECEIPT_MODE_NAMES[mode]]).toBe(mode);
    }
    // the two vocabularies must be a bijection — no mode reachable under only one spelling
    expect(Object.keys(MODE_FROM_RECEIPT_NAME).sort()).toEqual(Object.values(RECEIPT_MODE_NAMES).sort());
  });

  it('keeps staged-vs-published as a VARIANT, not a second implementation', () => {
    expect(Object.keys(VARIANTS).sort()).toEqual(['published', 'staged']);
    const staged = VARIANTS.staged.installerArgs('9.9.9');
    const published = VARIANTS.published.installerArgs('9.9.9');
    // the real difference, pinned: staged installs local bytes and skips selfcheck; published
    // resolves the version npm actually serves and installs strictly.
    expect(staged).toContain('--local');
    expect(staged).toContain('--no-selfcheck');
    expect(published).toContain('--version');
    expect(published).toContain('v9.9.9');
    expect(published).not.toContain('--local');
    expect(VARIANTS.published.env({ packageRoot: '/x' })).toMatchObject({ RUVNET_STRICT_INSTALL: '1' });
    expect(VARIANTS.staged.env({ packageRoot: '/x' })).toMatchObject({ RUVNET_CODEX_HOOK_TRUST_MODE: 'bypass' });
  });

  it('has ONE doctor rule: a clean exit passes, anything else fails', () => {
    expect(classifyDoctor({ status: 0, stdout: 'Healthy' })).toMatchObject({ accepted: true, status: 'PASS' });
    expect(classifyDoctor({ status: 1, stdout: 'boom' })).toMatchObject({ accepted: false, status: 'FAIL' });
    expect(classifyDoctor({ error: new Error('spawn'), status: 0 })).toMatchObject({ accepted: false });
  });

  it('TEETH: neither consumer carries a private copy of the loop or the rule', () => {
    const staged = read('scripts/staged-host-verifier.mjs');
    const publication = read('scripts/publication-receipt.mjs');

    // both must take the shared module, not restate it
    expect(staged).toMatch(/from '\.\/host-install-matrix\.mjs'/);
    expect(publication).toMatch(/from '\.\/host-install-matrix\.mjs'/);

    // and neither may re-declare the fixture list locally — that is how the two drifted apart
    for (const [name, src] of [['staged-host-verifier', staged], ['publication-receipt', publication]]) {
      expect(
        /\[\s*'claude'\s*,\s*'codex'\s*,\s*'dual'\s*\]/.test(src),
        `${name} re-declares the host modes locally — import HOST_MODES instead`,
      ).toBe(false);
      expect(
        /function classifyDoctor(Result)?\s*\(/.test(src),
        `${name} defines its own doctor rule — import classifyDoctor instead`,
      ).toBe(false);
    }
  });
});
