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
    const source = fs.readFileSync(SESSION_START, 'utf8');

    expect(fs.existsSync(HOST_UPDATE)).toBe(true);
    expect(source).toContain('host-update.mjs');
    expect(source).toContain("[path.join(hookDir, 'host-update.mjs'), '--check']");
    expect(source).not.toContain('raw.githubusercontent.com/stuinfla/ruvnet-brain/main');
    expect(source).not.toContain('command -v claude >/dev/null 2>&1');
    expect(source).not.toContain('claude plugin marketplace update ruvnet-brain');
  });
});
