// tests/unit/version.test.mjs — durable-first tests for the version single-source-of-truth.
// Drafted by agentic-qe (`aqe test generate scripts/version.mjs`, 40 assertions); made runnable +
// contract-focused here (assert the observable contract, not the impl → survives a rewrite).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getVersion, getVersionTag, PLUGIN_JSON } from '../../scripts/version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const realVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8')).version;

describe('version.mjs — the single source of truth', () => {
  it('PLUGIN_JSON points at the real manifest that exists', () => {
    expect(PLUGIN_JSON).toMatch(/plugin\/\.claude-plugin\/plugin\.json$/);
    expect(fs.existsSync(PLUGIN_JSON)).toBe(true);
  });
  it('getVersion() returns the exact version from plugin.json', () => {
    expect(getVersion()).toBe(realVersion);
  });
  it('getVersion() is a non-empty semver-shaped string', () => {
    const v = getVersion();
    expect(typeof v).toBe('string');
    expect(v).toMatch(/^\d+\.\d+\.\d+(-\w+)?$/);
  });
  it('getVersionTag() === "v" + getVersion() (invariant)', () => {
    expect(getVersionTag()).toBe('v' + getVersion());
  });
  it('both are idempotent across calls', () => {
    expect(getVersion()).toBe(getVersion());
    expect(getVersionTag()).toBe(getVersionTag());
  });
});
