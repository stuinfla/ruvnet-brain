import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTempRunArgs } from '../../bin/install.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('ephemeral npx/npm temp run mode (--mcp / --ask)', () => {
  it('parses --mcp, mcp, and --temp --mcp without requiring a query', () => {
    expect(parseTempRunArgs(['--mcp'])).toEqual({ mode: 'mcp' });
    expect(parseTempRunArgs(['mcp'])).toEqual({ mode: 'mcp' });
    expect(parseTempRunArgs(['--temp', '--mcp'])).toEqual({ mode: 'mcp' });
  });

  it('parses --ask and ask with optional --k, --repos, and --json', () => {
    expect(parseTempRunArgs(['--ask', 'how does RVF store vectors?', '--k', '4', '--repos', 'ruvector', '--json'])).toEqual({
      mode: 'ask',
      query: 'how does RVF store vectors?',
      k: '4',
      repos: 'ruvector',
      json: true,
    });
    expect(parseTempRunArgs(['ask', 'what', 'is', 'SONA'])).toEqual({
      mode: 'ask',
      query: 'what is SONA',
      k: null,
      repos: null,
      json: false,
    });
    expect(parseTempRunArgs(['--temp', '--ask', 'HNSW'])).toEqual({
      mode: 'ask',
      query: 'HNSW',
      k: null,
      repos: null,
      json: false,
    });
  });

  it('returns a clear error when --ask has no question', () => {
    const res = parseTempRunArgs(['--ask']);
    expect(res?.mode).toBe('ask');
    expect(res?.error).toContain('--ask requires a question');
  });

  it('returns null for normal installer flags', () => {
    expect(parseTempRunArgs(['--doctor'])).toBeNull();
    expect(parseTempRunArgs([])).toBeNull();
  });

  it('documents --mcp and --ask in --help output', () => {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'bin/install.mjs'), '--help'], { encoding: 'utf8' });
    expect(out).toContain('--mcp');
    expect(out).toContain('--ask');
  });
});
