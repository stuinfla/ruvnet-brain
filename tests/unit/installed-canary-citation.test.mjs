import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resolveInstalledCanaryCitation } from '../../scripts/retrieval-canary.mjs';
import { digest, sha256File } from '../../scripts/coverage-integrity.mjs';
const roots = [];
afterEach(() => roots.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const kbDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'installed-citation-'))); roots.push(kbDir);
  const passage = { path: 'src/a.mjs', text: 'the exact installed passage' };
  const expected = { repo: 'sample', path: passage.path, passageSha256: digest(passage) };
  return { kbDir, passage, expected, matched: { repo: 'SAMPLE', path: passage.path, text: passage.text } };
}
it.each(['passages', 'big.passages'])('preserves exact record/file evidence for installed %s files', async (suffix) => {
  const f = fixture(); const file = path.join(f.kbDir, `sample.${suffix}.jsonl`);
  fs.writeFileSync(file, 'invalid json\n' + JSON.stringify(f.passage) + '\n');
  expect(await resolveInstalledCanaryCitation(f)).toEqual({ resolved: true,
    evidence: { passageSha256: digest(f.passage), passageFileSha256: sha256File(file), hitContentSha256: digest(f.matched.text) } });
});
it.each(['missing', 'passage-mutant', 'wrong-path', 'wrong-repo'])('preserves fail-closed %s semantics', async (mutant) => {
  const f = fixture();
  if (mutant !== 'missing') fs.writeFileSync(path.join(f.kbDir, 'sample.passages.jsonl'), JSON.stringify(f.passage));
  if (mutant === 'passage-mutant') f.expected.passageSha256 = '0'.repeat(64);
  if (mutant === 'wrong-path') f.matched.path = 'other';
  if (mutant === 'wrong-repo') f.matched.repo = 'other';
  expect(await resolveInstalledCanaryCitation(f)).toEqual({ resolved: false });
});
it('requires an explicit absolute installed context, never an ambient store', async () => {
  const f = fixture(); delete f.kbDir;
  await expect(resolveInstalledCanaryCitation(f)).rejects.toThrow(/must be absolute/);
});
it('rejects citation content absent from the actual returned hit', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.kbDir, 'sample.passages.jsonl'), JSON.stringify(f.passage));
  f.matched.text = 'a different result body';
  expect(await resolveInstalledCanaryCitation(f)).toEqual({ resolved: false });
});
it.each(['file', 'parent'])('rejects an external %s symlink instead of calling it installed evidence', async (kind) => {
  const f = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-citation-')); roots.push(outside);
  const file = path.join(outside, 'sample.passages.jsonl');
  fs.writeFileSync(file, JSON.stringify(f.passage));
  if (kind === 'file') fs.symlinkSync(file, path.join(f.kbDir, 'sample.passages.jsonl'));
  else { const linked = path.join(f.kbDir, 'linked'); fs.symlinkSync(outside, linked, 'junction'); f.kbDir = linked; }
  await expect(resolveInstalledCanaryCitation(f)).rejects.toThrow(/symlink|containment/);
});
it('the publication adapter delegates to the same resolver with its installed context and cache', () => {
  const source = fs.readFileSync('scripts/publication-receipt.mjs', 'utf8');
  expect(source).toContain('return resolveInstalledCanaryCitation({ kbDir: context.kb, matched, expected, passageFileDigests });');
  expect(source).not.toContain('readline.createInterface');
});
