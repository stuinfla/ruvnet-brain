// npm-pack-json.test.mjs — the shared `npm pack --json` reader accepts the shapes npm actually prints
// and refuses everything else. Fixtures are the real captures of this repo's `npm pack --dry-run --json`
// under npm 10.9.9, 11.21.1 and 12.2.1 (2026-10-25), with `files` cut to four records; every other key
// and the npm 12 name-keyed object are byte-for-byte what npm printed.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { packedPaths, parseNpmPack } from '../helpers/npm-pack-json.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const fixture = (major) => fs.readFileSync(path.join(ROOT, 'tests/fixtures/npm-pack', `npm${major}.json`), 'utf8');
const EXPECTED_PATHS = ['.claude-plugin/marketplace.json', 'LICENSE', 'bin/install.mjs', 'data/model-catalog.json'];

describe('parseNpmPack reads every captured npm shape to the same entry', () => {
  for (const major of [10, 11, 12]) {
    it(`npm ${major}`, () => {
      const entry = parseNpmPack(fixture(major), { expectName: 'ruvnet-brain' });
      expect(entry.filename).toBe('ruvnet-brain-4.7.20.tgz');
      expect(entry.version).toBe('4.7.20'); // sync-version-ignore: the captured real npm pack output of the 4.7.20 package, pinned as the fixture
      expect([...packedPaths(entry)]).toEqual(EXPECTED_PATHS);
    });
  }

  it('the npm 12 shape really is different (the fixture would catch a regression to [0])', () => {
    expect(JSON.parse(fixture(12))[0]).toBeUndefined();
    expect(Array.isArray(JSON.parse(fixture(10)))).toBe(true);
  });

  it('skips a preamble only up to a line that opens the document, never into the inner files array', () => {
    const entry = parseNpmPack(`> lifecycle banner [noise]\n${fixture(12)}`);
    expect(entry.filename).toBe('ruvnet-brain-4.7.20.tgz');
    // The old `out.slice(out.indexOf('['))` hack lands on the npm 12 inner files array and fails.
    const npm12 = fixture(12);
    expect(() => JSON.parse(npm12.slice(npm12.indexOf('[')))).toThrow(SyntaxError);
  });

  it('normalises Windows separators', () => {
    const doc = JSON.stringify([{ name: 'p', filename: 'p-1.0.0.tgz', files: [{ path: 'scripts\\selfcheck.mjs' }] }]);
    expect([...packedPaths(parseNpmPack(doc))]).toEqual(['scripts/selfcheck.mjs']);
  });
});

describe('parseNpmPack throws on anything it does not recognise (never an empty answer)', () => {
  const entry = JSON.parse(fixture(10))[0];
  const cases = {
    'a two-entry array (a workspace pack)': JSON.stringify([entry, { ...entry, name: 'other', filename: 'other-1.0.0.tgz' }]),
    'a two-key npm 12 object': JSON.stringify({ 'ruvnet-brain': entry, other: { ...entry, name: 'other' } }),
    'an empty array': '[]',
    'an empty object': '{}',
    'a bare entry object': JSON.stringify(entry),
    'an npm error document': JSON.stringify({ error: { code: 'E404', summary: 'not found' } }),
    'an object keyed by the wrong name': JSON.stringify({ wrong: entry }),
    'an entry without a filename': JSON.stringify([{ ...entry, filename: undefined }]),
    'a scalar': '"4.7.20"',
    'not JSON': 'npm ERR! something',
    'empty output': '',
  };
  for (const [name, doc] of Object.entries(cases)) {
    it(name, () => { expect(() => parseNpmPack(doc)).toThrow(/npm pack --json/); });
  }

  it('a name other than the expected package', () => {
    expect(() => parseNpmPack(fixture(12), { expectName: 'something-else' })).toThrow(/expected something-else/);
  });

  it('packedPaths refuses a missing or empty file list instead of reporting "nothing shipped"', () => {
    expect(() => packedPaths({ ...entry, files: undefined })).toThrow(/no files list/);
    expect(() => packedPaths({ ...entry, files: [] })).toThrow(/no files list/);
    expect(() => packedPaths({ ...entry, files: [{ size: 1 }] })).toThrow(/without a path/);
  });
});

describe('the npm on PATH right now', () => {
  it('prints a document this reader accepts, with the real file count', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000, shell: process.platform === 'win32',
    });
    const entry = parseNpmPack(out, { expectName: 'ruvnet-brain' });
    const paths = packedPaths(entry);
    expect(paths.size).toBe(entry.entryCount);
    expect(paths.size).toBeGreaterThan(300);
    expect(paths.has('bin/install.mjs')).toBe(true);
  }, 120_000);
});
