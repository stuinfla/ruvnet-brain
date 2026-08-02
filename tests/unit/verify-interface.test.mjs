import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GATE = path.resolve(import.meta.dirname, '../../plugin/scripts/verify-interface.sh');
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

function run(command, { optedIn = true, home = null, profileContent = '{}' } = {}) {
  const h = home || fs.mkdtempSync(path.join(os.tmpdir(), 'vi-'));
  if (optedIn) {
    fs.mkdirSync(path.join(h, '.claude/model-router'), { recursive: true });
    fs.writeFileSync(path.join(h, '.claude/model-router/profile.json'), profileContent);
  }
  const result = spawnSync('bash', [GATE], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    env: { ...process.env, HOME: h },
    encoding: 'utf8',
  });
  return { ...result, home: h };
}

describe.skipIf(!hasBash || process.platform === 'win32')(
  'verify-interface.sh — raw shell is advisory-only',
  () => {
    it.each([
      ['direct managed CLI', 'ruflo memory search -q test'],
      ['npx wrapper', 'npx ruflo@latest memory search -q test'],
      ['literal bash payload', "bash -lc 'ruflo memory search -q x'"],
      ['backtick substitution', 'x=`ruflo memory search -q x`'],
      ['double-quoted substitution', 'printf \'%s\\n\' "$(ruflo memory search -q x)"'],
      ['quoted prose', 'git commit -m "explained how ruflo memory search works"'],
      ['quoted separator', 'grep -E "foo|ruflo init" file.txt'],
      ['heredoc body', "cat <<'EOF'\nagentic-qe integration plan\nEOF"],
      ['dynamic executable', '$TOOL memory search -q x'],
      ['malformed-looking shell', 'ruflo "unterminated'],
    ])('never blocks %s', (_label, command) => {
      const result = run(command);
      expect(result.status).toBe(0);
      expect(result.stderr).not.toMatch(/BLOCKED/);
    });

    it.each([
      ['newline-terminated profile', '{}\n'],
      ['profile without a final newline', '{}'],
    ])('emits migration guidance with a %s', (_label, profileContent) => {
      const result = run('ruflo memory search -q test', { profileContent });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('ruvnet_cli_help');
      expect(result.stdout).toContain('ruvnet_cli_run');
      expect(result.stdout).toContain('advisory');
    });

    it('stays silent for unrelated shell commands, no opt-in, and assumed-only profiles', () => {
      expect(run('git status').stdout).toBe('');
      expect(run('ruflo memory search -q test', { optedIn: false }).stdout).toBe('');
      expect(run('ruflo memory search -q test', {
        profileContent: '{"basis":"assumed:detected"}',
      }).stdout).toBe('');
    });

    it('fails open on malformed JSON', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-'));
      fs.mkdirSync(path.join(home, '.claude/model-router'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude/model-router/profile.json'), '{}');
      const result = spawnSync('bash', [GATE], {
        input: '{"tool_name":"Bash","tool_input":{"command":"ruflo memory search',
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });
  },
);

describe('verify-interface.sh — blocking-policy ratchet', () => {
  it('does not import or invoke shell-structure reconstruction', () => {
    const source = fs.readFileSync(GATE, 'utf8');
    expect(source).not.toMatch(/\binvocations\b/);
    expect(source).not.toMatch(/\bcommandNodes\b/);
    expect(source).not.toMatch(/\bfindInvocations\b/);
    expect(source).not.toMatch(/\bcommandOf\b/);
  });

  it('contains no blocking exit or blocking receipt path', () => {
    const source = fs.readFileSync(GATE, 'utf8');
    expect(source).not.toMatch(/\bexit\s+2\b/);
    expect(source).not.toContain('gate-receipt.sh');
    expect(source).not.toContain('BLOCKED');
  });
});
