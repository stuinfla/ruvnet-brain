import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCardToFiles, insertSorted } from '../../scripts/card-from-source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let dir;
let file;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-insert-'));
  file = path.join(dir, 'capability-cards.md');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('card-from-source exact writes and honest accounting', () => {
  it('does not treat a repository-name dot as a RegExp wildcard', () => {
    fs.writeFileSync(file, '## ruvxio\nAn unrelated store.\n');
    expect(insertSorted(file, '## ruv.io\nThe real card.\n', 'ruv.io')).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('The real card.');
  });

  it('reports a destination write failure instead of counting it as success', () => {
    const insert = (target) => {
      if (target.endsWith('live.md')) throw new Error('read-only destination');
      return true;
    };
    const result = applyCardToFiles(
      [path.join(dir, 'repo.md'), path.join(dir, 'live.md')],
      '## alpha\ncard\n',
      'alpha',
      insert,
    );
    expect(result).toEqual({
      changed: 1,
      failures: [{ file: path.join(dir, 'live.md'), error: 'read-only destination' }],
    });
  });

  it('report-only mode leaves the live store byte-for-byte unchanged', () => {
    const kb = path.join(dir, 'kb');
    fs.mkdirSync(kb);
    fs.writeFileSync(path.join(kb, 'alpha.rvf'), 'rvf-bytes');
    fs.writeFileSync(path.join(kb, 'capability-cards.md'), '## beta\nExisting card.\n');
    const before = fs.readdirSync(kb).sort().map((name) => [name, fs.readFileSync(path.join(kb, name), 'hex')]);
    const output = execFileSync(process.execPath, [path.join(ROOT, 'scripts/card-from-source.mjs')], {
      cwd: ROOT,
      env: { ...process.env, RUVNET_BRAIN_KB: kb },
      encoding: 'utf8',
    });
    const after = fs.readdirSync(kb).sort().map((name) => [name, fs.readFileSync(path.join(kb, name), 'hex')]);
    expect(output).toMatch(/report only/i);
    expect(after).toEqual(before);
  });
});
