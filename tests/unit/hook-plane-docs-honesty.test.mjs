// The docs about the hook plane must say what the manifests do (audit 2026-10-21): CONTRIBUTING said "13 on each
// host" while Grok registers 9; hooks.json called decision-gate the only body that may exit 2 while
// unprompted-runtime.mjs exits 2 for an opted-in lesson block; hook-contracts.json never listed grok as a host.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { continuityRegistrations } from '../../plugin/scripts/continuity-hook-policy.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));
const handlers = (doc) => Object.values(doc.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks));
const idOf = (command) => /(?:hook-shim\.mjs"|adapter\.mjs"|codex-hook\.mjs")\s+(?:\d+\s+)?([a-z][\w-]*)/.exec(command)?.[1];

describe('the hook plane is described as it is registered', () => {
  const counts = { claude: handlers(json('plugin/hooks/hooks.json')).length, codex: handlers(json('plugin/hooks/codex-hooks.json')).length, grok: handlers(json('plugin/hooks/grok-hooks.json')).length };

  it('13 handlers on Claude and Codex, 9 on Grok — and CONTRIBUTING says exactly that', () => {
    expect(counts).toEqual({ claude: 13, codex: 13, grok: 9 });
    const contributing = read('CONTRIBUTING.md');
    expect(contributing).toContain('13 on Claude and on Codex, 9 on Grok');
    expect(contributing).not.toContain('13 on each host');
    expect(contributing).toContain('plugin/hooks/grok-hooks.json');
  });

  it('every id registered on Grok lists grok as a host in the policy, the owners and the contracts; no other id does', () => {
    const grokIds = new Set(handlers(json('plugin/hooks/grok-hooks.json')).map((h) => idOf(h.command)));
    expect([...grokIds].sort()).toEqual(['continuation-gate', 'decision-gate', 'grounding-stamp', 'grounding-turn-gate', 'grounding-turn-mark', 'session-snapshot']);
    const contracts = json('plugin/hooks/hook-contracts.json');
    for (const spec of continuityRegistrations()) expect(spec.hosts.includes('grok'), `${spec.event}:${spec.id} policy hosts`).toBe(grokIds.has(spec.id));
    for (const o of contracts._eventOwners) expect(o.hosts.includes('grok'), `${o.event}:${o.owner} owner hosts`).toBe(grokIds.has(o.owner));
    for (const c of contracts.contracts) expect(c.hosts.includes('grok'), `${c.event}:${c.id} contract hosts`).toBe(grokIds.has(c.id));
    expect(continuityRegistrations('grok')).toHaveLength(9);
  });

  it('the refuser sentence names both exit-2 paths, because unprompted-runtime really exits 2', () => {
    expect(read('plugin/scripts/unprompted-runtime.mjs')).toMatch(/process\.exit\(2\)/);
    expect(json('plugin/hooks/hooks.json').description).toMatch(/fails open except decision-gate \(refuses a write\) and unprompted-speech \(exit 2/);
    expect(read('CONTRIBUTING.md')).toMatch(/`unprompted-speech` is the\s+other exit-2 path/);
    // Grok does not register unprompted-speech, so there decision-gate IS the only refuser — the manifest says so, scoped.
    expect(json('plugin/hooks/grok-hooks.json').description).toContain('the only refuser registered on Grok');
  });
});
