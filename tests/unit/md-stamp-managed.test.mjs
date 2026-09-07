import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeManagedStamp, writeStampIfUnchanged } from '../../plugin/scripts/md-stamp.mjs';

const HOOK = path.resolve(import.meta.dirname, '../../plugin/scripts/md-stamp.mjs');
let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-md-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function write(rel, content, at = '2026-09-05T14:20:30Z') {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.utimesSync(file, new Date(at), new Date(at));
  return file;
}
function fire(file, { created = false, env = {}, nodeArgs = [], ...extra } = {}) {
  const result = spawnSync(process.execPath, [...nodeArgs, HOOK], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, RUVNET_MD_STAMP: 'ensure', ...env },
    input: JSON.stringify({ hook_event_name: 'PostToolUse', cwd: root, tool_name: 'Write',
      tool_input: { file_path: file }, tool_response: { type: created ? 'create' : 'update' }, ...extra }),
  });
  expect(result.status, result.stderr).toBe(0);
  return fs.readFileSync(path.resolve(root, file), 'utf8');
}

describe('managed Markdown stamping through the actual hook body', () => {
  it('creates both precise stamps from an observed creation, and repeated delivery does not write', () => {
    const file = write('new.md', '# New\n\nBody\n');
    const result = fire(file, { created: true });
    expect(result).toContain('Updated: 2026-09-05T14:20:30.000Z');
    expect(result).toContain('Created: 2026-09-05T14:20:30.000Z');
    const stat = fs.statSync(file);
    expect(fire(file, { created: true })).toBe(result);
    expect(fs.statSync(file).mtimeMs).toBe(stat.mtimeMs);
    expect(fs.statSync(file).ctimeMs).toBe(stat.ctimeMs);
  });
  it('refreshes the actual time on a second same-day edit, retaining Created and version', () => {
    const file = write('edited.md', '# Doc\nUpdated: 2026-09-05 01:02:03 EDT | Version 1.0.0\nCreated: 2020-01-01\nBody\n');
    const first = fire(file);
    expect(first).toContain('Updated: 2026-09-05T14:20:30.000Z | Version 1.0.0');
    write('edited.md', first.replace('Body', 'Changed body'), '2026-09-05T15:21:31Z');
    const second = fire(file);
    expect(second).toContain('Updated: 2026-09-05T15:21:31.000Z');
    expect(second).toContain('Created: 2020-01-01');
    expect(second).not.toContain('01:02:03 EDT');
  });
  it('preserves YAML date keys and adds precise metadata inside frontmatter', () => {
    const file = write('adr.md', '---\nid: ADR-999\n---\n# Decision\n');
    const result = fire(file, { created: true });
    expect(result).toMatch(/^---\nid: ADR-999\n/);
    expect(result).toContain('date: 2026-09-05\n');
    expect(result).toContain('updated: 2026-09-05\n');
    expect(result).toContain('created_at: 2026-09-05T14:20:30.000Z\n');
    expect(result).toContain('updated_at: 2026-09-05T14:20:30.000Z\n');
  });
  it('does not rewrite pinned historical frontmatter', () => {
    const source = '---\nupdated: 2020-01-01\nupdated_pinned: true\n---\n# History\n';
    const file = write('history.md', source);
    expect(fire(file)).toBe(source);
  });
  it('preserves existing frontmatter creation evidence and is stable across repeated delivery', () => {
    const file = write('existing-adr.md', '---\nid: ADR-999\ndate: 2020-01-01\ncreated_at: 2020-01-01T09:00:00.000Z\nupdated: 2020-01-01\n---\n# Decision\n');
    const first = fire(file);
    expect(first).toContain('date: 2020-01-01\n');
    expect(first).toContain('created_at: 2020-01-01T09:00:00.000Z\n');
    const before = fs.statSync(file);
    expect(fire(file)).toBe(first);
    expect(fs.statSync(file).ctimeMs).toBe(before.ctimeMs);
  });
  it('skips content that changed after observation instead of clobbering another writer', () => {
    const file = write('concurrent.md', '# Original\n');
    const original = fs.readFileSync(file, 'utf8');
    const observed = fs.statSync(file);
    const stamped = computeManagedStamp(original, { updated: observed.mtime.toISOString() });
    fs.writeFileSync(file, '# Concurrent edit\n');
    expect(writeStampIfUnchanged(file, original, stamped, observed)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('# Concurrent edit\n');
  });
  it('does not need timestamp restoration to remain idempotent after its own write', () => {
    const file = write('mtime.md', '# Timestamp\n');
    const prior = fs.statSync(file).mtimeMs;
    const first = fire(file, { created: true });
    expect(fs.statSync(file).mtimeMs).not.toBe(prior);
    const current = fs.statSync(file);
    expect(fire(file)).toBe(first);
    expect(fs.statSync(file).ctimeMs).toBe(current.ctimeMs);
  });
  it('does not invent creation history for an existing unstamped file', () => {
    const file = write('old.md', '# Existing\n');
    const result = fire(file);
    expect(result).toContain('Created: unknown (not recorded)');
    expect(result).toContain('Updated: 2026-09-05T14:20:30.000Z');
  });
  it('resolves relative paths within the project', () => {
    write('docs/relative.md', '# Relative\n');
    expect(fire('docs/relative.md', { created: true })).toContain('Created: 2026-09-05T14:20:30.000Z');
  });
  it('does not stamp failed operations', () => {
    const source = '# Failed\n';
    const file = write('failed.md', source);
    expect(fire(file, { tool_response: { isError: true } })).toBe(source);
  });
  it('does not stamp excluded generated or vendored files, or symlinks outside the project', () => {
    for (const rel of ['node_modules/pkg/doc.md', 'kb/generated.md', 'dist/doc.md', 'clones/repo/doc.md']) {
      const file = write(rel, '# Excluded\n');
      expect(fire(file, { created: true })).toBe('# Excluded\n');
    }
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-md-'));
    try {
      const file = path.join(outside, 'foreign.md');
      fs.writeFileSync(file, 'Updated: 2020-01-01\n');
      fs.symlinkSync(file, path.join(root, 'linked.md'));
      expect(fire('linked.md')).toBe('Updated: 2020-01-01\n');
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
  it('honors the existing off control in managed mode', () => {
    const file = write('off.md', '# Off\n');
    expect(fire(file, { created: true, env: { RUVNET_MD_STAMP: 'off' } })).toBe('# Off\n');
  });
  it('honors the shared maintenance helper when the installed generation provides it', () => {
    const loader = path.join(root, 'maintenance-loader.mjs');
    fs.writeFileSync(loader, `export function resolve(specifier, context, next) {
      if (specifier.endsWith('/development-maintenance.mjs')) return {
        url: 'data:text/javascript,export function developmentHooksSuspended() { return true; }', shortCircuit: true,
      };
      return next(specifier, context);
    }`);
    const file = write('maintenance.md', '# Suspended\n');
    expect(fire(file, { created: true, nodeArgs: ['--no-warnings', '--experimental-loader', loader] })).toBe('# Suspended\n');
  });
  it('remains idempotent when an existing stamp sits at the edge of the header window', () => {
    const file = write('long-head.md', '# Title\n' + '\n'.repeat(8) + 'Updated: 2020-01-01\nCreated: 2019-01-01\nBody\n');
    const first = fire(file);
    expect(first.match(/Created:/g)).toHaveLength(1);
    expect(fire(file)).toBe(first);
  });
  it('handles a stamp without a trailing newline and restores accidentally removed metadata', () => {
    const file = write('short.md', 'Updated: 2020-01-01');
    const first = fire(file);
    expect(first).toContain('Created: unknown (not recorded)');
    expect(fire(file)).toBe(first);
    write('short.md', first.replace(/^Created:[^\n]*\n/m, ''));
    const repaired = fire(file);
    expect(repaired).toContain('Created: unknown (not recorded)');
    expect(fire(file)).toBe(repaired);
  });
});
