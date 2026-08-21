import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function numberedFiles(relativeDir) {
  return fs.readdirSync(path.join(root, relativeDir))
    .filter((name) => /^\d{4}-.*\.md$/.test(name));
}

describe('living architecture identifiers', () => {
  it.each([
    ['ADR', 'docs/adr'],
    ['DDD', 'docs/ddd'],
  ])('%s file prefixes are unique', (_kind, relativeDir) => {
    const ids = numberedFiles(relativeDir).map((name) => name.slice(0, 4));
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect([...new Set(duplicates)]).toEqual([]);
  });
});
