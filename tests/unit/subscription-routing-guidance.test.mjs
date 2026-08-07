import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKILL = fs.readFileSync(path.join(ROOT, 'plugin/skills/ruvnet-brain/SKILL.md'), 'utf8');
const ADR = fs.readFileSync(
  path.join(ROOT, 'docs/adr/0061-subscription-only-dual-host-deliberation.md'),
  'utf8',
);

function section(markdown, start, end) {
  const afterStart = markdown.split(start)[1];
  expect(afterStart, `missing section: ${start}`).toBeDefined();
  return end ? afterStart.split(end)[0] : afterStart;
}

describe('subscription-only swarm execution guidance', () => {
  it('makes Ruflo the coordinator and native subscription agents the default executors', () => {
    const orchestration = section(SKILL, '**2. On a yes', '**3. Take over');

    expect(orchestration).toMatch(/swarm_init.*agent_spawn.*coordinat/is);
    expect(orchestration).toMatch(/Claude Code(?:'s)? native Task/is);
    expect(orchestration).toMatch(/Codex(?:'s)? native collaboration agents/is);
    expect(orchestration).toMatch(/subscription-backed/is);
    expect(orchestration).not.toMatch(/agent_execute.*research|research.*agent_execute/is);
  });

  it('keeps provider-backed execution behind explicit user opt-in with no implicit fallback', () => {
    const routing = section(SKILL, '## Cost-optimal model routing', '## Reconfigure yourself');

    expect(routing).toMatch(/provider-backed execution.*explicit user opt-in/is);
    expect(routing).toMatch(/never.*implicit fallback/is);
    expect(routing).toMatch(/never ask.*API key.*normal swarm work/is);
    expect(routing).not.toMatch(/Apply both by default/is);
    expect(routing).not.toMatch(/Pure text[^\n]*OpenRouter/is);
  });

  it('keeps the living ADR aligned with the enforced skill boundary', () => {
    expect(ADR).toMatch(/status:\s*Proposed/i);
    // NOT a frozen date — the second instance of this exact trap (see the same fix in
    // tests/unit/fix-workstream-guidance.test.mjs for ADR-050). `scripts/doc-currency.mjs` BLOCKS a
    // push when an ADR's governed code moves and its `updated:` stamp does not follow. Freezing the
    // stamp here makes two of our own gates demand opposite things: currency says "move it", this
    // says "never move it", and correct maintenance of the ADR is then impossible. It fired for real
    // on 2026-08-07 — the Codex subscription probe changed, the ADR was re-read and re-stamped as
    // currency requires, and CI went red on the stamp it had just correctly updated.
    //
    // The invariant worth asserting is that this living plan carries a well-formed stamp that does
    // not predate its immutable creation date, not that it was stamped on one particular day.
    const created = ADR.match(/^date:\s*(\d{4}-\d{2}-\d{2})/mi)?.[1];
    const updated = ADR.match(/^updated:\s*(\d{4}-\d{2}-\d{2})/mi)?.[1];
    expect(updated, 'the living ADR must carry an `updated:` stamp doc-currency can verify').toBeTruthy();
    expect(created, 'and an immutable `date:` to measure it against').toBeTruthy();
    expect(updated >= created, `updated (${updated}) must not predate created (${created})`).toBe(true);
    expect(ADR).toMatch(/plugin\/skills\/ruvnet-brain\/SKILL\.md/);
    expect(ADR).toMatch(/Ruflo.*coordination.*native.*subscription.*execution/is);
    expect(ADR).toMatch(/provider-backed execution.*explicit.*opt-in/is);
  });
});
