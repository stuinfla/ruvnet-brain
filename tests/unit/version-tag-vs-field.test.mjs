// tests/unit/version-tag-vs-field.test.mjs — one number, two legitimate spellings.
//
//   Release TAG   "v1.14.1-dev"  → git tags, Release URLs, the human "Brain version:" stamp
//   version FIELD  "1.14.1-dev"  → package.json, kb/package.json, data/manifest.json.brainVersion
//
// sync-version.mjs owns the FIELDS and compares them bare. But brain-stamp.mjs and build-bundle.mjs
// both defaulted BRAIN_VERSION to getVersionTag() and wrote that TAG straight into
// `data/manifest.json.brainVersion`. So `npm run version:check` went red on a clean tree every time
// either script ran — two writers, two formats, a contradiction no amount of re-syncing could settle.
// It sat red at HEAD for at least a day.
//
// These tests pin the boundary: the tag may exist, but it must be stripped before it enters a field.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getVersion, getVersionTag, stripTag } from '../../scripts/version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('stripTag — the boundary between tag form and field form', () => {
  it('drops a leading v', () => expect(stripTag('v1.14.1-dev')).toBe('1.14.1-dev'));
  it('leaves an already-bare version alone', () => expect(stripTag('1.14.1-dev')).toBe('1.14.1-dev'));
  it('is idempotent — stripping twice is stripping once', () => {
    expect(stripTag(stripTag('v0.5.0-dev'))).toBe('0.5.0-dev');
  });
  it('only strips a LEADING v, never one inside the string', () => {
    expect(stripTag('1.0.0-preview')).toBe('1.0.0-preview');
  });
  it('round-trips against getVersionTag()', () => {
    expect(stripTag(getVersionTag())).toBe(getVersion());
    expect(getVersionTag()).toBe(`v${getVersion()}`);
  });
});

describe('the manifest field carries the BARE literal', () => {
  it('data/manifest.json brainVersion equals getVersion(), with no v', () => {
    const bv = JSON.parse(read('data/manifest.json')).brainVersion;
    expect(bv).toBe(getVersion());
    expect(bv.startsWith('v')).toBe(false);
  });
});

describe('both writers strip before writing — the regression guard', () => {
  // A source-level guard, deliberately. Running brain-stamp/build-bundle in a unit test would
  // shell out to git and rewrite real files; asserting on what they WRITE catches the revert
  // (`brainVersion: BRAIN_VERSION`) that caused this, at the moment someone types it.
  for (const f of ['scripts/brain-stamp.mjs', 'scripts/build-bundle.mjs']) {
    it(`${f} writes brainVersion via stripTag(), not the raw tag`, () => {
      const src = read(f);
      expect(src).toMatch(/brainVersion:\s*stripTag\(/);
      expect(src).not.toMatch(/brainVersion:\s*BRAIN_VERSION\s*,/);
    });
  }

  it('brain-stamp still uses the v-prefixed TAG for the human stamp line', () => {
    // The tag is not wrong — it is wrong only inside a field. Keep the display form.
    expect(read('scripts/brain-stamp.mjs')).toMatch(/Brain version: \$\{BRAIN_VERSION\}/);
  });

  it('build-bundle still takes --version as a Release TAG', () => {
    expect(read('scripts/build-bundle.mjs')).toMatch(/arg\('--version', getVersionTag\(\)\)/);
  });
});
