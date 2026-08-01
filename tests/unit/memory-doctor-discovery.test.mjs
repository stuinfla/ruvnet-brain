import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(import.meta.dirname, '../..');
const DOCTOR = path.join(REPO, 'scripts', 'memory-doctor.mjs');
const homes = [];

function isolatedHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-memory-discovery-'));
  homes.push(home);
  return home;
}

function store(home, relative) {
  const db = path.join(home, relative, '.swarm', 'memory.db');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  fs.writeFileSync(db, 'fixture');
  return fs.realpathSync(db);
}

function discover(home, explicitRoot) {
  const expression = explicitRoot === undefined
    ? 'm.findStores()'
    : `m.findStores(${JSON.stringify(explicitRoot)})`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', [
    `const m = await import(${JSON.stringify(pathToFileURL(DOCTOR).href)});`,
    `process.stdout.write(JSON.stringify(${expression}));`,
  ].join('\n')], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout);
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe('issue #81 — shared AgentDB fleet discovery', () => {
  it('finds common, configured, and known stores once when no root is supplied', () => {
    const home = isolatedHome();
    const expected = [
      store(home, 'source/hm/a'),
      store(home, 'work/b'),
      store(home, 'custom/c'),
      store(home, '.claude'),
      store(home, 'cognitum-trader'),
    ].sort();
    fs.mkdirSync(path.join(home, '.claude', 'ruvnet-brain'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'ruvnet-brain', 'config.json'), JSON.stringify({
      scanRoots: ['custom'],
    }));

    expect(discover(home)).toEqual(expected);
  });

  it('canonicalizes symlinked roots and store paths before de-duplicating', () => {
    const home = isolatedHome();
    const expected = store(home, 'source/hm/a');
    fs.symlinkSync(path.join(home, 'source'), path.join(home, 'work'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.mkdirSync(path.join(home, '.claude', 'ruvnet-brain'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'ruvnet-brain', 'config.json'), JSON.stringify({
      scanRoots: ['source', 'work'],
    }));

    expect(discover(home)).toEqual([expected]);
  });

  it('keeps an explicit root scoped and deterministic', () => {
    const home = isolatedHome();
    const sourceStore = store(home, 'source/hm/a');
    store(home, 'work/b');
    store(home, '.claude');
    store(home, 'cognitum-trader');

    expect(discover(home, path.join(home, 'source'))).toEqual([sourceStore]);
  });

  it('renders every home-owned store with one home-relative naming rule', () => {
    const home = isolatedHome();
    const codeStore = store(home, 'Code/a');
    const sourceStore = store(home, 'source/hm/b');
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', [
      `const m = await import(${JSON.stringify(pathToFileURL(DOCTOR).href)});`,
      `process.stdout.write(JSON.stringify([m.displayStoreName(${JSON.stringify(codeStore)}), m.displayStoreName(${JSON.stringify(sourceStore)})]));`,
    ].join('\n')], {
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });

    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(['~/Code/a', '~/source/hm/b']);
  });

  it('the standalone CLI does not report a false-zero fleet outside ~/Code', () => {
    const home = isolatedHome();
    store(home, 'source/hm/a');

    const run = spawnSync(process.execPath, [DOCTOR], {
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });

    expect(run.stdout).toContain('AgentDB fleet — 1 stores found');
  });
});
