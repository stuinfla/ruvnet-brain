import { describe, expect, it } from 'vitest';
import { evaluatePublicationReceipt } from '../../scripts/release-proof.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

// Source versions identify candidates. Only verified publication receipts establish shipment.
describe('release identity — one number, and it means one thing', () => {
  it('every version surface agrees with the single source of truth', () => {
    const source = readJson('plugin/.claude-plugin/plugin.json').version;
    expect(source, 'plugin.json is the source of truth and must carry a version').toBeTruthy();
    for (const surface of ['package.json', 'kb/package.json', 'plugin/.codex-plugin/plugin.json']) {
      expect(readJson(surface).version, `${surface} disagrees with plugin.json`).toBe(source);
    }
  });

  it('a source version may identify an unpublished stable candidate', () => {
    const version = readJson('plugin/.claude-plugin/plugin.json').version;
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    // A clean version and even a release commit subject cannot replace publication evidence.
    expect(evaluatePublicationReceipt({ version }, null).verdict).toBe('FAIL');
  });


});
