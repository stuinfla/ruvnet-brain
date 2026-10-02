import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyRufloOperationalHealth, locateRuflo, probeRufloOperationalHealth, rufloCheckLine } from '../../bin/install.mjs';

describe('Ruflo operational health is derived from the configured execution mode', () => {
  it('accepts zero-daemon direct mode without trusting daemon-owned summaries', () => {
    expect(classifyRufloOperationalHealth({
      status: 'RuFlo V3 [STOPPED]\nBackend | none\nEntries | 0\nSwarm not running',
      memory: 'Total Entries | 1,504\nBackend | sql.js + HNSW',
      metrics: 'Total Patterns | 0\nTotal Routes | 0\nTotal Executed | 0',
    })).toMatchObject({
      healthy: true,
      directMode: true,
      stopped: true,
      memoryContradiction: true,
      zeroLearning: true,
      memoryEntries: 1504,
    });
  });

  it('accepts only agreeing active and nonzero operational signals', () => {
    expect(classifyRufloOperationalHealth({
      status: 'RuFlo V3 [RUNNING]\nBackend | hybrid\nEntries | 12',
      memory: 'Total Entries | 12',
      metrics: 'Total Patterns | 3\nTotal Routes | 8\nTotal Executed | 5',
    }).healthy).toBe(true);
  });

  // CI Linux run 36915686695: `ruflo status memory` / `hooks metrics` initialize an uninitialized directory,
  // so a probe that ran them changed its own next answer. They must not run there, and the line is n/a.
  it('an uninitialized directory: only `ruflo status` runs, and the line is n/a (not a failure), every time', () => {
    const calls = [];
    const run = (args) => { calls.push(args.join(' ')); return args[0] === 'status' && args.length === 1 ? '[ERROR] RuFlo is not initialized in this directory' : '| Total Patterns | 0 |'; };
    const first = probeRufloOperationalHealth({ run });
    const second = probeRufloOperationalHealth({ run });
    expect(calls).toEqual(['status', 'status']);
    expect(first).toEqual(second);
    expect(rufloCheckLine(first)).toMatchObject({ id: 'ruflo', state: 'unknown', fix: null });
  });
  it('an initialized directory is judged as before: stopped = direct mode ok, running with zero learning = fail', () => {
    const stopped = probeRufloOperationalHealth({ run: (a) => (a.length === 1 ? 'RuFlo V3 [STOPPED]' : 'Total Patterns | 0\nTotal Routes | 0\nTotal Executed | 0') });
    expect(rufloCheckLine(stopped)).toMatchObject({ state: 'ok', detail: expect.stringMatching(/direct mode/) });
    const zero = probeRufloOperationalHealth({ run: (a) => (a.length === 1 ? 'RuFlo V3 [RUNNING]' : 'Total Patterns | 0\nTotal Routes | 0\nTotal Executed | 0') });
    expect(rufloCheckLine(zero)).toMatchObject({ state: 'fail', fix: 'ruflo doctor --fix' });
  });

  // CI run 36919727923: ruflo installed beside node leaked into a fixture that kept node's directory on PATH.
  // The locator reads ONLY env.PATH and HOME's settings.json, so a caller controls every route.
  it('locateRuflo sees exactly what env.PATH and HOME give it: a CLI, a settings-only wiring, or nothing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruflo-locate-'));
    try {
      const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
      const bare = { PATH: ['/usr/bin', '/bin'].join(path.delimiter) };
      expect(locateRuflo({ env: bare, home })).toEqual({ cli: null, configured: false });
      fs.writeFileSync(path.join(bin, 'ruflo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      expect(locateRuflo({ env: { PATH: [bin, '/usr/bin', '/bin'].join(path.delimiter) }, home })).toEqual({ cli: path.join(bin, 'ruflo'), configured: false });
      fs.mkdirSync(path.join(home, '.claude'));
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ mcpServers: { 'claude-flow': { command: 'npx' } } }));
      expect(locateRuflo({ env: bare, home })).toEqual({ cli: null, configured: true });
      // Configured but no CLI: reported, never probed, never "operational".
      expect(rufloCheckLine({ configuredOnly: true })).toMatchObject({ state: 'unknown', detail: expect.stringMatching(/not probed/) });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  // Re-review NIT: a ruflo that cannot be started, or whose `status` times out, printed nothing — and empty
  // output classified as healthy, then `status memory` ran anyway. REAL spawns, through the real probe.
  it.skipIf(process.platform === 'win32')('a CLI that cannot start or does not answer `status` is not healthy, and nothing else is run', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruflo-unanswered-'));
    try {
      const log = path.join(dir, 'calls.log');
      const hang = path.join(dir, 'ruflo');
      fs.writeFileSync(hang, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');\nsetTimeout(() => {}, 10_000);\n`, { mode: 0o755 });
      for (const cli of [path.join(dir, 'missing-ruflo'), hang]) {
        const health = probeRufloOperationalHealth({ cli, timeoutMs: 300 });
        expect(health, cli).toMatchObject({ healthy: false, unanswered: true });
        expect(rufloCheckLine(health)).toMatchObject({ state: 'fail', detail: expect.stringMatching(/did not answer/) });
      }
      expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual(['status']); // never `status memory`
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
