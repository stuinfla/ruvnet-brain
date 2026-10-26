// #400 — installer help and progress text claimed "zero automatic registrations" / "installs no
// automatic lifecycle handlers" while the shipped manifests carried handlers. The text must be
// derived from the manifests, so it cannot drift from them again.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALLER = path.join(ROOT, 'bin', 'install.mjs');
const SRC = fs.readFileSync(INSTALLER, 'utf8');

function handlers(relative) {
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
  let n = 0;
  for (const groups of Object.values(doc.hooks)) for (const group of groups) n += group.hooks.length;
  return n;
}

const ZERO_CLAIMS = [
  /zero automatic registrations/i,
  /installs no automatic lifecycle handlers/i,
  /without automatic lifecycle hooks/i,
  /does not run on host lifecycle events/i,
  /No Brain hook message or tool-call refusal/i,
  /no longer injected into every turn/i,
];

describe('#400 installer hook text matches the shipped manifests', () => {
  const claude = handlers('plugin/hooks/hooks.json');
  const codex = handlers('plugin/hooks/codex-hooks.json');

  it('the shipped manifests really do register handlers (the premise of the claim being false)', () => {
    expect(claude).toBeGreaterThan(0);
    expect(codex).toBeGreaterThan(0);
  });

  it('--help never claims zero registrations and states the real per-host counts', () => {
    const r = spawnSync(process.execPath, [INSTALLER, '--help'], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(0);
    for (const claim of ZERO_CLAIMS) expect(r.stdout).not.toMatch(claim);
    const block = r.stdout.slice(r.stdout.indexOf('--doctor --hooks'), r.stdout.indexOf('--demo'));
    expect(block).toContain(`${claude} Claude Code, ${codex} Codex handlers`);
  });

  it('no installer progress/summary string claims zero automatic hooks', () => {
    for (const claim of ZERO_CLAIMS) expect(SRC).not.toMatch(claim);
  });

  it('shippedHookHandlerCounts counts from the manifests and reports unknown (null), never 0, when absent', async () => {
    const { shippedHookHandlerCounts } = await import('../../bin/install.mjs');
    expect(shippedHookHandlerCounts(ROOT)).toEqual({ claude, codex, grok: handlers('plugin/hooks/grok-hooks.json') });
    expect(shippedHookHandlerCounts(path.join(ROOT, 'does-not-exist'))).toEqual({ claude: null, codex: null, grok: null });
  });
});
