// console-honest-cards.test.mjs — every card on the onboarding console must render what is measured
// on THIS machine, or say plainly that it was not measured. Each describe below was written RED
// against a card that rendered a number contradicting disk (console audit, 2026-09-11).
//
// Console gather functions read their roots from the environment AT MODULE LOAD (CONSOLE_ROOT,
// INSTALLED_KB, COMPLETE_BRAIN_SOURCE, SYSTEM_HOME), so — same as console-advocacy-dial.test.mjs —
// every gather call runs in a CHILD with HOME / RUVNET_CONSOLE_ROOT / RUVNET_BRAIN_KB pointed into a
// throwaway directory. This suite can never read or write the developer's real ~/.cache or ~/.config.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { measureBrainProfile } from '../../kb/brain-profile.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONSOLE_MJS = path.join(REPO, 'scripts/onboarding-console.mjs');
const APP_JS = path.join(REPO, 'console/app.js');
const IMPORT = `const m = await import(${JSON.stringify(pathToFileURL(CONSOLE_MJS).href)});`;

let tmp;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'console-honest-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function run(src, extraEnv = {}) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], {
    env: {
      ...process.env,
      HOME: tmp, USERPROFILE: tmp,
      RUVNET_CONSOLE_ROOT: tmp,
      RUVNET_SETTINGS_FILE: path.join(tmp, 'settings.json'),
      RUVNET_BRAIN_KB: path.join(tmp, 'kb'),
      RUVNET_BRAIN_COMPLETE_SOURCE: path.join(tmp, 'no-such-bundle'),
      ...extraEnv,
    },
    encoding: 'utf8', timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`child exited ${r.status}\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`);
  return r.stdout;
}
const runJSON = (src, env) => JSON.parse(run(src, env));

// A two-store bundle (ruvector + ruflo) = the "complete" profile, per kb/brain-profile.mjs.
function writeBundle(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SOURCE.json'), JSON.stringify({ stores: { ruvector: { kbName: 'ruvector' }, ruflo: { kbName: 'ruflo' } } }));
  fs.writeFileSync(path.join(dir, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: [] }));
  for (const [name, size] of Object.entries({
    'ruvector.rvf': 50, 'ruvector.big.rvf': 100, 'ruvector.idmap.json': 10,
    'ruflo.rvf': 70, 'ruflo.big.rvf': 140, 'ruflo.idmap.json': 10,
  })) fs.writeFileSync(path.join(dir, name), Buffer.alloc(size, 1));
  fs.writeFileSync(path.join(dir, 'ruvector-primer.md'), 'ruvector primer');
  fs.writeFileSync(path.join(dir, 'ruflo-primer.md'), 'ruflo primer');
  fs.writeFileSync(path.join(dir, 'forge-mcp-all.mjs'), '// shared reader');
  fs.writeFileSync(path.join(dir, 'capability-cards.md'), '# Capability Cards\n\n## ruflo\nOrchestration.\n\n## ruvector\nVector search.\n');
  fs.writeFileSync(path.join(dir, 'RVF-GENERATIONS.json'), JSON.stringify({ brainVersion: '1.0.0', stores: { ruflo: { release: 'x' }, ruvector: { release: 'x' } } }));
}

describe('Fix 1 — Complete Brain card measures the INSTALLED brain, not a dev-only restore path', () => {
  // The lie: the card rendered "— stores · 0 MB" for a 184-store, 979 MB installed brain because it
  // measured COMPLETE_BRAIN_SOURCE (<runtime>/dist/ruvnet-brain — a dev checkout path that never
  // exists after install) and discarded the `installed` measurement computed two lines above.
  it('reports the installed store count and bytes, and says no local bundle exists', () => {
    const kb = path.join(tmp, 'kb');
    writeBundle(kb);
    const expected = measureBrainProfile(kb);
    const out = runJSON(`${IMPORT} process.stdout.write(JSON.stringify(m.gatherBrainProfile()));`);
    expect(out.values.brainProfile).toBe('complete');
    expect(out.choices.complete.storeCount).toBe(expected.storeCount);
    expect(out.choices.complete.bytes).toBe(expected.bytes);
    expect(out.choices.complete.restoreBundle.present).toBe(false);
    // No bundle AND no updater ⇒ Apply→complete cannot succeed here, and the card must not pretend.
    expect(out.choices.complete.available).toBe(false);
    expect(out.choices.complete.restoreVia).toBe(null);
  });

  it('with forge-update.mjs present, Apply is possible via signed download — and the card names that path', () => {
    const kb = path.join(tmp, 'kb');
    writeBundle(kb);
    fs.writeFileSync(path.join(kb, 'forge-update.mjs'), '// signed updater');
    const expected = measureBrainProfile(kb);
    const out = runJSON(`${IMPORT} process.stdout.write(JSON.stringify(m.gatherBrainProfile()));`);
    expect(out.choices.complete.available).toBe(true);
    expect(out.choices.complete.restoreVia).toBe('signed-download');
    expect(out.choices.complete.storeCount).toBe(expected.storeCount); // still the INSTALLED measurement
    expect(out.choices.complete.restoreBundle.present).toBe(false);
  });

  it('the page renders the restore mechanism and never turns a measured count into a dash', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    expect(src).toContain('restoreVia');
    expect(src).not.toContain("choice.storeCount || (option.value === 'ruvector' ? 1 : '—')");
  });
});
