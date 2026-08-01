import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'scripts/nightly-wrapper.sh'), 'utf8');

function executableLines(source) {
  return source.split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

describe('issue #77 — scheduled rebuild cannot promote a release', () => {
  it('invokes self-update only as a rebuild/candidate preparer', () => {
    const executable = executableLines(SOURCE);
    expect(executable).toContain('scripts/self-update.mjs --apply --fresh-window 60');
    expect(executable).not.toContain('scripts/self-update.mjs --apply --publish');
  });

  it('a changed GitHub tag can never reclassify a nonzero child exit as success', () => {
    const runOnce = SOURCE.slice(SOURCE.indexOf('run_once()'), SOURCE.indexOf('\n}\n', SOURCE.indexOf('run_once()')) + 3);
    expect(runOnce).not.toContain('VERIFIED SUCCESS');
    expect(runOnce).not.toMatch(/after.*!=.*before/);
    expect(runOnce.indexOf('if [ "$rc" -ne 0 ]')).toBeGreaterThan(-1);
    expect(runOnce.indexOf('if [ "$rc" -ne 0 ]')).toBeLessThan(runOnce.indexOf('rm -f "$MARKER"'));
  });

  it('MUTANT: the former tag-changed success branch is recognized as forbidden', () => {
    const mutant = `if [ "$after" != "$before" ]; then echo "VERIFIED SUCCESS"; return 0; fi`;
    expect(mutant).toMatch(/after.*!=.*before/);
    expect(mutant).toContain('VERIFIED SUCCESS');
  });
});
