// The wall's Codex patch parser (review 3): an Add-File must be judged in linear time (the decision
// gate allows a write whose policy exceeds its 4000 ms budget, so a slow parser is a bypass), and a
// context mismatch caused only by CRLF or trailing whitespace must not flip a comment-only edit to refuse.
import { describe, it, expect } from 'vitest';
import { proposedChanges, substitutionVerdict } from '../../plugin/scripts/substitution-wall.mjs';

const judge = (patch, files = {}) => {
  const read = (f) => (Object.hasOwn(files, f) ? files[f] : null);
  const changes = proposedChanges({ tool_name: 'apply_patch', tool_input: { command: patch } }, read);
  return changes.map((c) => ({ file: c.file, v: substitutionVerdict({ path: c.file, content: c.after, before: c.before }) }));
};

describe('substitution-wall patch parsing is bounded and tolerant', () => {
  it('judges a 50,000-line Add-File that hides an outbox module in well under the gate budget', () => {
    const filler = Array.from({ length: 50_000 }, (_, i) => `+export const row${i} = ${i}; // filler line`);
    const outbox = [
      "+import fs from 'node:fs';",
      "+const OUTBOX = '.swarm/outbox.jsonl';",
      "+export function enqueue(r) { const fd = fs.openSync(OUTBOX, 'a'); fs.writeSync(fd, JSON.stringify(r) + '\\n'); fs.fsyncSync(fd); fs.closeSync(fd); }",
      "+export function replay(send) { for (const l of fs.readFileSync(OUTBOX, 'utf8').split('\\n')) if (l) send(JSON.parse(l)); }",
    ];
    const patch = ['*** Begin Patch', '*** Add File: plugin/scripts/big-outbox.mjs', ...filler, ...outbox, '*** End Patch'].join('\n');
    const started = Date.now();
    const [r] = judge(patch);
    const ms = Date.now() - started;
    expect(r.v.verdict, r.v.signals.join(',')).toBe('refuse');
    expect(ms, `parsed in ${ms} ms`).toBeLessThan(1500);
  });

  const script = ["import fs from 'node:fs';", '/**', ' * Writes a row and fsyncs it. A queue of one.', ' */',
    "export function write(fd, row) { fs.writeSync(fd, row); fs.fsyncSync(fd); }", ''];
  const patch = ['*** Begin Patch', '*** Update File: plugin/scripts/needs-comment.mjs', '@@', ' /**',
    '- * Writes a row and fsyncs it. A queue of one.', '+ * Writes a row and fsyncs it. A queue of exactly one.', '  */', '*** End Patch'].join('\n');
  it.each([['LF', '\n'], ['CRLF', '\r\n']])('a comment-only edit to a script that already fsyncs passes on a %s copy', (_, eol) => {
    const [r] = judge(patch, { 'plugin/scripts/needs-comment.mjs': script.join(eol) });
    expect(r.v.verdict, r.v.signals.join(',')).not.toBe('refuse');
  });
  it('trailing-whitespace drift in the file does not change that verdict', () => {
    const [r] = judge(patch, { 'plugin/scripts/needs-comment.mjs': script.map((l) => `${l}   `).join('\n') });
    expect(r.v.verdict, r.v.signals.join(',')).not.toBe('refuse');
  });
});
