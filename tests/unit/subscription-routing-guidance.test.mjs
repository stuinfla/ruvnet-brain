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
    expect(ADR).toMatch(/updated:\s*2026-08-01/i);
    expect(ADR).toMatch(/plugin\/skills\/ruvnet-brain\/SKILL\.md/);
    expect(ADR).toMatch(/Ruflo.*coordination.*native.*subscription.*execution/is);
    expect(ADR).toMatch(/provider-backed execution.*explicit.*opt-in/is);
  });
});
