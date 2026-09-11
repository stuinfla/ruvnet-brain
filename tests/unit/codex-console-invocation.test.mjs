import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SESSION_START = path.join(ROOT, 'plugin', 'scripts', 'session-start-core.mjs');
const HOST_UPDATE = path.join(ROOT, 'plugin', 'scripts', 'host-update.mjs');
const RVBC_SKILL = path.join(ROOT, 'plugin', 'skills', 'rvbc', 'SKILL.md');

describe('Codex Console invocation contract', () => {
  it('teaches the native Codex skill mention instead of an unsupported custom slash command', () => {
    const source = fs.readFileSync(SESSION_START, 'utf8');

    expect(source).toContain('RUVNET_HOOK_HOST');
    expect(source).toContain('$ruvnet-brain:rvbc');
  });

  it('advertises one natural-language Console command in both hosts', () => {
    const skill = fs.readFileSync(RVBC_SKILL, 'utf8');
    expect(skill).toContain('Configure RuvNet Brain');
    expect(skill).toContain('Claude Code and Codex');
    expect(skill).toContain('/rvbc');
    expect(skill).toContain('$ruvnet-brain:rvbc');
  });

  it('routes automatic updates through one host-neutral Brain coordinator', () => {
    // 960c94c0 (2026-09-11) split session-start-core.mjs into sibling modules; the host-update
    // dispatch now lives in session-start-update-plane.mjs, which core imports and runs. The
    // contract is unchanged — one host-neutral coordinator, no raw-GitHub or host-CLI shortcuts —
    // so the assertions follow the code to its new file instead of pinning the old layout.
    const UPDATE_PLANE = path.join(ROOT, 'plugin', 'scripts', 'session-start-update-plane.mjs');
    const source = fs.readFileSync(SESSION_START, 'utf8');
    const plane = fs.readFileSync(UPDATE_PLANE, 'utf8');

    expect(fs.existsSync(HOST_UPDATE)).toBe(true);
    expect(source, 'session-start-core must dispatch the update plane').toContain('session-start-update-plane.mjs');
    expect(plane).toContain('host-update.mjs');
    expect(plane).toContain("[path.join(hookDir, 'host-update.mjs'), '--check']");
    for (const text of [source, plane]) {
      expect(text).not.toContain('raw.githubusercontent.com/stuinfla/ruvnet-brain/main');
      expect(text).not.toContain('command -v claude >/dev/null 2>&1');
      expect(text).not.toContain('claude plugin marketplace update ruvnet-brain');
    }
  });
});
