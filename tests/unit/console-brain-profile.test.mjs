import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONSOLE = path.join(REPO, 'scripts', 'onboarding-console.mjs');
const APP = path.join(REPO, 'console', 'app.js');

let root;
let installed;
let source;
let settings;

function bundle(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SOURCE.json'), JSON.stringify({ stores: {
    ruvector: { kbName: 'ruvector' }, ruflo: { kbName: 'ruflo' },
  } }));
  fs.writeFileSync(path.join(dir, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: [] }));
  for (const name of ['ruvector.rvf', 'ruvector.big.rvf', 'ruflo.rvf', 'ruflo.big.rvf']) {
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(name.startsWith('ruvector') ? 32 : 64, 1));
  }
  fs.writeFileSync(path.join(dir, 'forge-mcp-all.mjs'), '// shared');
  fs.writeFileSync(path.join(dir, 'capability-cards.md'), '# Capability Cards\n\n## ruflo\nFlow.\n\n## ruvector\nVectors.\n');
  fs.writeFileSync(path.join(dir, 'RVF-GENERATIONS.json'), JSON.stringify({
    stores: { ruflo: {}, ruvector: {} },
  }));
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'console-profile-')));
  installed = path.join(root, 'installed');
  source = path.join(root, 'complete');
  settings = path.join(root, 'settings.json');
  bundle(source);
  fs.cpSync(source, installed, { recursive: true });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function runJSON(sourceCode) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', sourceCode], {
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      RUVNET_SETTINGS_FILE: settings,
      RUVNET_BRAIN_KB: installed,
      RUVNET_BRAIN_COMPLETE_SOURCE: source,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

const IMPORT = `const m = await import(${JSON.stringify(pathToFileURL(CONSOLE).href)});`;

describe('Complete Brain / RuVector Only console control', () => {
  it('refuses missing ownership without deleting files or persisting a false profile', () => {
    fs.unlinkSync(path.join(installed, 'SOURCE.json'));
    const before = fs.readFileSync(path.join(installed, 'ruflo.rvf'));
    const saved = runJSON(`${IMPORT} process.stdout.write(JSON.stringify(m.saveBrainProfile({ brainProfile: 'ruvector' })));`);
    expect(saved.ok).toBe(false);
    expect(fs.readFileSync(path.join(installed, 'ruflo.rvf'))).toEqual(before);
    expect(fs.existsSync(settings)).toBe(false);
  });
  it('derives the visible state and measured sizes from the installed RVFs', () => {
    const profile = runJSON(`${IMPORT} process.stdout.write(JSON.stringify(m.gatherBrainProfile()));`);
    expect(profile.values.brainProfile).toBe('complete');
    expect(profile.installed.stores).toEqual(['ruflo', 'ruvector']);
    expect(profile.choices.complete.storeCount).toBe(2);
    expect(profile.choices.ruvector.bytes).toBeGreaterThan(0);
  });

  it('switches the physical files to RuVector Only before persisting the mirror', () => {
    const result = runJSON(`${IMPORT}
      const saved = m.saveBrainProfile({ brainProfile: 'ruvector' });
      process.stdout.write(JSON.stringify({
        saved,
        profile: m.gatherBrainProfile(),
        files: (await import('node:fs')).readdirSync(${JSON.stringify(installed)}),
      }));
    `);
    expect(result.saved.ok).toBe(true);
    expect(result.saved.profile).toBe('ruvector');
    expect(result.profile.values.brainProfile).toBe('ruvector');
    expect(result.files).toContain('ruvector.big.rvf');
    expect(result.files).not.toContain('ruflo.big.rvf');
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).settings.brainProfile).toBe('ruvector');
  });

  it('restores Complete Brain from the full release source', () => {
    const result = runJSON(`${IMPORT}
      m.saveBrainProfile({ brainProfile: 'ruvector' });
      const saved = m.saveBrainProfile({ brainProfile: 'complete' });
      process.stdout.write(JSON.stringify({ saved, profile: m.gatherBrainProfile() }));
    `);
    expect(result.saved.ok).toBe(true);
    expect(result.profile.values.brainProfile).toBe('complete');
    expect(result.profile.installed.stores).toEqual(['ruflo', 'ruvector']);
  });

  it('falls back to one forced signed-updater restore when no full local source remains', () => {
    runJSON(`${IMPORT} process.stdout.write(JSON.stringify(m.saveBrainProfile({ brainProfile: 'ruvector' })));`);
    fs.rmSync(source, { recursive: true, force: true });
    fs.writeFileSync(path.join(installed, 'forge-update.mjs'), `
      import fs from 'node:fs';
      import path from 'node:path';
      if (!process.argv.includes('--apply') || !process.argv.includes('--restore-complete') || !process.argv.includes('ruvector')) process.exit(9);
      fs.writeFileSync(path.join(process.cwd(), 'ruflo.rvf'), Buffer.alloc(8));
      fs.writeFileSync(path.join(process.cwd(), 'ruflo.big.rvf'), Buffer.alloc(8));
    `);

    const result = runJSON(`${IMPORT}
      const saved = m.saveBrainProfile({ brainProfile: 'complete' });
      process.stdout.write(JSON.stringify({ saved, profile: m.gatherBrainProfile() }));
    `);
    expect(result.saved.ok).toBe(true);
    expect(result.profile.values.brainProfile).toBe('complete');
    expect(result.profile.installed.stores).toEqual(['ruflo', 'ruvector']);
  });

  it('renders exactly the two approved choices and posts to the real endpoint', () => {
    const app = fs.readFileSync(APP, 'utf8');
    expect(app).toContain("'Complete Brain'");
    expect(app).toContain("'RuVector Only'");
    expect(app).toContain("postJSON('/api/save-brain-profile'");
    expect(app).not.toContain('measured — shipping as smart-scope');
  });
});
