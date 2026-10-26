// #301 — Grok CLI: the installer and --doctor never mentioned Grok, and the search-first line
// that makes Grok ground itself (Grok discards prompt-time hook context) could only be added by hand.
// Grok is now REPORTED honestly, and the AGENTS.md line is opt-in, add-only-if-absent, removable.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addGrokAgentsLine, grokStatus, grokStatusLine, GROK_AGENTS_BLOCK } from '../../scripts/grok-host.mjs';
import { completeBrain } from '../helpers/doctor-brain-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALLER = path.join(ROOT, 'bin', 'install.mjs');
let home;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-host-')); });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const withGrok = () => {
  fs.mkdirSync(path.join(home, '.grok', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.grok', 'bin', 'grok'), '#!/bin/sh\n');
};
const agents = () => path.join(home, '.grok', 'AGENTS.md');

describe('#301 grokStatus / grokStatusLine', () => {
  it('no Grok → no line at all', () => {
    expect(grokStatusLine(grokStatus({ home, pluginInstalled: true, hookCount: 9 }))).toBeNull();
  });

  it('Grok + plugin: names search, skills, the hook count, and whether the grounding line is present', () => {
    withGrok();
    const absent = grokStatusLine(grokStatus({ home, pluginInstalled: true, hookCount: 9 }));
    expect(absent).toMatch(/search_ruvnet, the Brain skills and 9 lifecycle hooks/);
    expect(absent).toMatch(/absent \(opt in: npx ruvnet-brain --grok-agents-md\)/);
    fs.writeFileSync(agents(), 'Call search_ruvnet first.\n');
    expect(grokStatusLine(grokStatus({ home, pluginInstalled: true, hookCount: 9 }))).toMatch(/AGENTS\.md: present\./);
  });

  it('Grok without the Claude plugin says the Brain cannot reach it', () => {
    withGrok();
    expect(grokStatusLine(grokStatus({ home, pluginInstalled: false }))).toMatch(/not installed here/);
  });
});

describe('#301 addGrokAgentsLine — opt-in, only if absent', () => {
  it('does nothing without Grok', () => {
    expect(addGrokAgentsLine({ home })).toBe('no-grok');
    expect(fs.existsSync(agents())).toBe(false);
  });

  it('appends the marked line once, keeps the user content, backs the file up', () => {
    withGrok();
    fs.writeFileSync(agents(), '# my rules\nBe brief.\n');
    expect(addGrokAgentsLine({ home })).toBe('added');
    const text = fs.readFileSync(agents(), 'utf8');
    expect(text.startsWith('# my rules\nBe brief.\n')).toBe(true);
    expect(text).toContain(GROK_AGENTS_BLOCK);
    expect(fs.readdirSync(path.dirname(agents())).some((f) => f.startsWith('AGENTS.md.bak-'))).toBe(true);
    expect(addGrokAgentsLine({ home })).toBe('present');
    expect(fs.readFileSync(agents(), 'utf8')).toBe(text);
  });

  it("an existing hand-written search_ruvnet line (the reporter's) is left alone", () => {
    withGrok();
    const own = 'Call the `search_ruvnet` MCP tool first for RuvNet questions.\n';
    fs.writeFileSync(agents(), own);
    expect(addGrokAgentsLine({ home })).toBe('present');
    expect(fs.readFileSync(agents(), 'utf8')).toBe(own);
  });
});

describe('#301 the installer surfaces', () => {
  const run = (args) => spawnSync(process.execPath, [INSTALLER, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, RUVNET_BRAIN_HOME: path.join(home, '.cache', 'ruvnet-brain'), RUVNET_NO_TELEMETRY: '1' },
    encoding: 'utf8', timeout: 60_000,
  });

  it('--grok-agents-md is a standalone, explicit action (and a no-op without Grok)', () => {
    const none = run(['--grok-agents-md']);
    expect(none.status).toBe(0);
    expect(none.stdout).toMatch(/Grok CLI not detected/);
    expect(fs.existsSync(agents())).toBe(false);
    withGrok();
    expect(run(['--grok-agents-md']).stdout).toMatch(/added the search-first line/);
    expect(fs.readFileSync(agents(), 'utf8')).toContain(GROK_AGENTS_BLOCK);
  });

  it('--help documents the opt-in flag', () => {
    expect(run(['--help']).stdout).toMatch(/--grok-agents-md\s+Grok CLI only, opt-in/);
  });

  it('--doctor reports Grok when it is installed, and says nothing about it when it is not', () => {
    const brain = completeBrain();
    try {
      const without = JSON.parse(brain.doctor(['--json']).stdout);
      expect(without.lines.some((l) => l.id === 'grok')).toBe(false);
      fs.mkdirSync(path.join(brain.home, '.grok', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(brain.home, '.grok', 'bin', 'grok'), '#!/bin/sh\n');
      const withG = JSON.parse(brain.doctor(['--json']).stdout);
      const line = withG.lines.find((l) => l.id === 'grok');
      expect(line, 'a Grok line').toBeTruthy();
      expect(line.detail).toMatch(/Grok CLI detected/);
    } finally { brain.cleanup(); }
  }, 240_000);
});
