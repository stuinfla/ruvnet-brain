import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectPublisherActions,
  findTrustRootDrift,
  findUnauthorizedPublishers,
} from '../../scripts/release-authority.mjs';
import { REQUIRED_CHECKS } from '../../scripts/release-proof.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('issue #77 — one protected publisher', () => {
  it('detects JavaScript GitHub and npm publication actions outside the canonical publisher', () => {
    const source = `
      execFileSync(GH, ['release', 'create', tag]);
      execFileSync('npm', ['publish', '--tag', 'latest']);
      execFileSync('npm', ['dist-tag', 'add', spec, 'latest']);
    `;
    expect(detectPublisherActions('scripts/self-update.mjs', source).map((item) => item.action))
      .toEqual(['github-release-create', 'npm-publish', 'npm-dist-tag']);
  });

  it('detects shell publication actions but ignores comments describing them', () => {
    const source = `
      # gh release create is forbidden here
      npm publish --tag candidate
      npm dist-tag add ruvnet-brain@1 candidate
    `;
    expect(detectPublisherActions('scripts/rogue.sh', source).map((item) => item.action))
      .toEqual(['npm-publish', 'npm-dist-tag']);
  });

  it('allows the same operations only in scripts/release.mjs', () => {
    const source = `runOrDie('npm publish', 'npm', ['publish', '--tag', 'candidate']);`;
    expect(detectPublisherActions('scripts/release.mjs', source)).toEqual([]);
  });

  it('the checked-in production tree has no second publisher', () => {
    expect(findUnauthorizedPublishers(ROOT)).toEqual([]);
  });

  it('scans workflow run blocks and package scripts for alternate publishers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-authority-'));
    try {
      fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
      fs.writeFileSync(path.join(root, '.github/workflows/rogue.yml'), `
name: rogue
jobs:
  publish:
    steps:
      - run: npm publish --tag latest
`);
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        scripts: {
          safe: 'node scripts/release.mjs --check',
          rogue: 'gh release create v9.9.9',
        },
      }));
      expect(findUnauthorizedPublishers(root)).toEqual([
        { file: '.github/workflows/rogue.yml', action: 'npm-publish' },
        { file: 'package.json#scripts.rogue', action: 'github-release-create' },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('the release seal names a real serialized exact-artifact CI job', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(REQUIRED_CHECKS).toContain('release-qe');
    expect(workflow).toMatch(/^  release-qe:\s*$/m);
    expect(workflow).toContain('node scripts/release-authority.mjs');
    expect(workflow).toContain('tests/qe/release/vitest.config.mjs');
    expect(workflow).toContain('--maxWorkers=1');
  });

  it('MUTANT: reintroducing one npm publisher into self-update is rejected', () => {
    const mutant = `execFileSync('npm', ['publish', '--tag', 'latest']);`;
    expect(detectPublisherActions('scripts/self-update.mjs', mutant)).toMatchObject([
      { file: 'scripts/self-update.mjs', action: 'npm-publish' },
    ]);
  });

  it('a URL on the same line can no longer delete the publish call from the scan', () => {
    // The stripper used to cut at the FIRST `//` on a line, so the `//` in an https URL erased
    // everything after it — including the call. One line was enough to walk past this gate.
    const hidden = `const registry = 'https://registry.npmjs.org'; execFileSync('npm', ['publish']);`;
    expect(detectPublisherActions('scripts/sneaky.mjs', hidden)).toMatchObject([
      { file: 'scripts/sneaky.mjs', action: 'npm-publish' },
    ]);
  });

  it('prose inside a heredoc is data, not a publisher', () => {
    // plugin/scripts/ground-ruvnet.sh writes an instruction block containing the words "npm
    // publish" via `cat <<EOF`. Rejecting a compliant file is as broken as accepting a rogue one.
    const source = ['cat <<EOF', 'NEVER: npm publish, push --force, or rotate secrets.', 'EOF'].join('\n');
    expect(detectPublisherActions('plugin/scripts/ground-ruvnet.sh', source)).toEqual([]);
  });
});

describe('the Ed25519 trust root is identical in every copy that ships', () => {
  // The key is embedded in bin/install.mjs and kb/forge-update.mjs on purpose (SEC-0010 #6): the
  // trust root must travel with the executable, or an attacker who swaps the bundle could swap the
  // key it is checked against. rUv's ADR-174 helper-signing bakes RUFLO_HELPERS_PUBKEY in for the
  // same reason. What was missing is the reconciliation kb/forge-update.mjs's own comment promised
  // — "the release gate checks that identity" — which nothing performed. Until this gate existed, a
  // PR swapping an embedded key for an attacker's, leaving keys/*.pem untouched, shipped to every
  // installer and self-updating client with no test objecting.
  const PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAgse9TAtehXUvUfTrJFY2CCHiCbmelR8yCgS//sen5/w=\n-----END PUBLIC KEY-----\n';
  const fixture = (embedded) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-root-'));
    fs.mkdirSync(path.join(root, 'keys'), { recursive: true });
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(root, 'kb'), { recursive: true });
    fs.writeFileSync(path.join(root, 'keys/ruvnet-brain-signing.pub.pem'), PEM);
    const embed = (pem) => `const SIGNING_PUBKEY_PEM = \`${pem.trim()}\`;\n`;
    fs.writeFileSync(path.join(root, 'bin/install.mjs'), embed(PEM));
    fs.writeFileSync(path.join(root, 'kb/forge-update.mjs'), embed(embedded ?? PEM));
    return root;
  };

  it('the checked-in tree carries one trust root, spelled identically everywhere', () => {
    expect(findTrustRootDrift(ROOT)).toEqual([]);
  });

  it('MUTANT: an embedded key swapped for an attacker-controlled one is rejected', () => {
    const attacker = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n-----END PUBLIC KEY-----';
    const root = fixture(attacker);
    try {
      expect(findTrustRootDrift(root)).toMatchObject([
        { file: 'kb/forge-update.mjs', reason: expect.stringContaining('differs from') },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('MUTANT: deleting the embedded key entirely is rejected, not treated as agreement', () => {
    const root = fixture();
    try {
      fs.writeFileSync(path.join(root, 'kb/forge-update.mjs'), '// key removed\n');
      expect(findTrustRootDrift(root)).toMatchObject([
        { file: 'kb/forge-update.mjs', reason: expect.stringContaining('not found') },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('every directory that ships executable code is scanned, not just the original four', () => {
    // plugin/ and kb/ were structurally invisible to this gate while both ship real executables —
    // kb/ holds one of the three trust-root copies.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-authority-scope-'));
    try {
      fs.mkdirSync(path.join(root, 'plugin/scripts'), { recursive: true });
      fs.mkdirSync(path.join(root, 'kb'), { recursive: true });
      fs.writeFileSync(path.join(root, 'plugin/scripts/rogue.mjs'), `execFileSync('npm', ['publish']);`);
      fs.writeFileSync(path.join(root, 'kb/rogue.mjs'), `execFileSync(GH, ['release', 'create', tag]);`);
      const found = findUnauthorizedPublishers(root);
      // Bounded by count so a duplicate or a missed file still fails, but not coupled to walk
      // order — an assertion frozen to today's directory ordering is its own kind of stale literal.
      expect(found).toHaveLength(2);
      expect(found).toEqual(expect.arrayContaining([
        { file: 'kb/rogue.mjs', action: 'github-release-create' },
        { file: 'plugin/scripts/rogue.mjs', action: 'npm-publish' },
      ]));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
