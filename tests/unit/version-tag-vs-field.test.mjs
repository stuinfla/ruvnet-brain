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
  it('scripts/brain-stamp.mjs writes brainVersion via stripTag(), not the raw tag', () => {
    const src = read('scripts/brain-stamp.mjs');
    expect(src).toMatch(/brainVersion:\s*stripTag\(/);
    expect(src).not.toMatch(/brainVersion:\s*BRAIN_VERSION\s*,/);
  });

  // Step 5 (2026-09-13): build-bundle.mjs no longer carries a single global BRAIN_VERSION constant
  // written inline at every `brainVersion:` call site. assembleBundle strips the tag EXACTLY ONCE,
  // into `version`, and every `brainVersion:` field (SOURCE.json, the generation ledger, manifest.json)
  // reuses that same already-stripped value — a stronger guarantee than repeating stripTag() at every
  // site (there is only one place the tag could ever leak a 'v' from), so the guard here checks the
  // single stripping point exists and that no `brainVersion:` field ever assigns the raw tag form.
  it('scripts/build-bundle.mjs strips the tag exactly once, then reuses the bare literal everywhere', () => {
    const src = read('scripts/build-bundle.mjs');
    expect(src).toMatch(/const\s+version\s*=\s*stripTag\(/);
    expect(src).toMatch(/brainVersion:\s*version\b/);
    expect(src).not.toMatch(/brainVersion:\s*(identity\.version|versionTag|getVersionTag\(\))\s*[,}]/);
  });

  it('brain-stamp still uses the v-prefixed TAG for the human stamp line', () => {
    // The tag is not wrong — it is wrong only inside a field. Keep the display form.
    expect(read('scripts/brain-stamp.mjs')).toMatch(/Brain version: \$\{BRAIN_VERSION\}/);
  });

  it('build-bundle still takes --version as a Release TAG', () => {
    expect(read('scripts/build-bundle.mjs')).toMatch(/arg\('--version', getVersionTag\(\)\)/);
  });

  // Step 5 (2026-09-13): SOURCE.json is no longer copied from the checkout and then rebound after
  // the fact (`doc.brainVersion = getVersion()`) — projectStoreViews generates it already bound to
  // the exact current generation identity, in one place, at construction time. Assert the identity
  // fields are bound from the SAME `version` the rest of the assembly uses, not a second, independent
  // getVersion()/getVersionTag() call that could drift from it.
  it('build-bundle binds SOURCE.json identity fields to the exact current generation at construction, never by rebinding a copy', () => {
    const src = read('scripts/build-bundle.mjs');
    expect(src).not.toMatch(/cp\('SOURCE\.json'/);
    expect(src).not.toMatch(/doc\.brainVersion\s*=\s*getVersion\(\)/);
    const projectStoreViews = src.slice(src.indexOf('export function projectStoreViews'), src.indexOf('export async function assembleBundle'));
    expect(projectStoreViews).toMatch(/brainVersion:\s*version\b/);
    expect(projectStoreViews).toMatch(/releaseTag:\s*`v\$\{version\}`/);
  });
});
