// continuity-brief-host-hint.test.mjs — the brief's MORE line names a door that exists on the host
// reading it (RNBC review 2026-10-01). `/ruvnet-brain:rnb-brief` is a Claude Code plugin command
// (plugin/commands/rnb-brief.md); Codex has no such command and no rnb-brief skill (plugin/skills/),
// so a Codex session must be handed the node command alone.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildBrief } from '../../plugin/scripts/continuity-brief.mjs';
import { adoptedProject, cleanup } from '../helpers/continuity-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
afterEach(cleanup);

const moreLine = (env, p) => buildBrief({ projectDir: p.dir, env, home: p.home, persistState: false })
  .context.split('\n').find((l) => l.startsWith('MORE: '));

describe('continuity brief: host-appropriate MORE hint', () => {
  it('Claude Code sessions get the plugin command, which exists', () => {
    const p = adoptedProject();
    expect(fs.existsSync(path.join(ROOT, 'plugin', 'commands', 'rnb-brief.md'))).toBe(true);
    const line = moreLine(p.env, p);
    expect(line).toContain('/ruvnet-brain:rnb-brief');
    expect(line).toMatch(/node ".*continuity-brief\.mjs" --full/);
  });

  it('Codex sessions (RUVNET_HOOK_HOST=codex) get only the node command — no Claude-only slash command', () => {
    const p = adoptedProject();
    expect(fs.readdirSync(path.join(ROOT, 'plugin', 'skills'))).not.toContain('rnb-brief');
    const line = moreLine({ ...p.env, RUVNET_HOOK_HOST: 'codex' }, p);
    expect(line).not.toContain('/ruvnet-brain:rnb-brief');
    expect(line).toMatch(/^MORE: node ".*continuity-brief\.mjs" --full/);
  });
});
