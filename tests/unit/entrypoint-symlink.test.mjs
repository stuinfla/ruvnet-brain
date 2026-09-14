// tests/unit/entrypoint-symlink.test.mjs
//
// Guards the main-entry check in kb/forge-ask.mjs and kb/forge-ask-all.mjs.
//
// REPRODUCED LIVE 2026-07-27, by accident, while building a benchmark harness out of symlinks:
// invoking forge-ask-all.mjs through a symlink printed ZERO BYTES, wrote nothing to stderr, and
// EXITED 0. The brain looked like it had searched and found nothing.
//
// Cause: the guard was
//     path.resolve(process.argv[1]) === path.resolve(__filename)
// `path.resolve` normalizes a path but does NOT follow symlinks, while `import.meta.url` IS
// symlink-resolved by Node. Through a symlink the two sides disagree, so main() never runs — and
// because nothing throws, the process exits 0. Silent success is the worst failure mode this repo
// has: every caller downstream reads exit 0 as "searched, found nothing", and a user reports "the
// brain doesn't work" with no error to go on. Real invocation paths that are symlinks: npm bin
// shims, wrapper scripts, a symlinked KB directory, and Homebrew-style installs.
//
// The same defect class was independently found the same day in plugin/scripts/hook-input.mjs's
// isMain by the D9 hook audit, where it makes every write-gate FAIL OPEN. One root cause, two
// places, both silent — which is why this is pinned by a test rather than just fixed.
//
// The assertion is deliberately weak on CONTENT and strong on SILENCE: run with no arguments the
// entry point may legitimately print usage or an error, and either is fine. What is never fine is
// producing nothing at all, because that is indistinguishable from a successful empty search.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KB = path.join(ROOT, 'kb');

// Both files that carry the guard. If a third entry point grows one, add it here.
const ENTRY_POINTS = ['forge-ask.mjs', 'forge-ask-all.mjs'];

// The corpus-seed pipeline carries the SAME guard, and the same defect was measured there on
// 2026-09-14 by the step-8 rehearsal harness: run through a symlinked working directory,
// build-bundle.mjs and corpus-candidate.mjs no-opped, and prepareCorpusCandidate reported SUCCESS
// with no archive and no receipt on disk — because corpus-reconcile.mjs's checked() inspects only
// the exit status. On macOS EVERY os.tmpdir() path is symlinked (/var/folders/... ->
// /private/var/folders/...), so any tool staging work in a temp dir hits this.
//
// These run with no arguments on purpose: the assertion is the same one above — it must SAY
// something. Several will exit non-zero complaining about missing required flags, which is fine
// and is exactly the point. Silence is the failure.
// DELIBERATELY EXCLUDED: build-concepts.mjs and rebuild-gists-from-receipts.mjs. Both carry the same
// guard and were fixed in the same commit, but invoked with NO ARGUMENTS they do real work and REWRITE
// tracked files in the live checkout — build-concepts.mjs spends ~40s rewriting kb/concepts.sources.json
// and kb/ruv-gists.sources.json; rebuild-gists-from-receipts.mjs rewrites kb/ruv-gists.sources.json.
// Measured the hard way: each one dirtied the working tree on every run of this suite. A test that
// mutates tracked source is the very defect P1-a exists to prevent, so their guards are covered by the
// mechanism test below rather than by execution. Verified individually: the four kept here leave
// `git status --porcelain -- kb/` empty.
const PIPELINE_ENTRY_POINTS = [
  'build-bundle.mjs',
  'release-projection.mjs',
  'host-registry.mjs',
  'adr-072-completion.mjs',
  'product-integrity-contract.mjs',
];

describe('KB entry points run when invoked through a symlink', () => {
  for (const entry of ENTRY_POINTS) {
    it(`${entry}: a symlinked invocation runs main() instead of silently exiting 0`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-symlink-'));
      const link = path.join(dir, entry);
      try {
        // A symlink pointing at the REAL file. Its sibling imports (./forge-hybrid.mjs etc.)
        // resolve against the link's realpath, so the module graph still loads normally — the
        // ONLY thing that changes is what process.argv[1] looks like.
        fs.symlinkSync(path.join(KB, entry), link);

        const r = spawnSync(process.execPath, [link], {
          encoding: 'utf8',
          timeout: 60000,
          // No query on purpose: this test is about whether main() RAN, not about search quality.
          env: { ...process.env, RUVNET_BRAIN_TEST: '1' },
        });

        expect(r.error, `spawn failed: ${r.error && r.error.message}`).toBeUndefined();
        const out = `${r.stdout || ''}${r.stderr || ''}`;
        // THE ASSERTION: it must SAY something. Before the realpath fix this was 0 bytes + exit 0.
        expect(
          out.trim().length,
          `${entry} produced NOTHING through a symlink (exit ${r.status}) — main() did not run, ` +
            'and a silent exit 0 is indistinguishable from "searched, found nothing"',
        ).toBeGreaterThan(0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  for (const entry of PIPELINE_ENTRY_POINTS) {
    it(`scripts/${entry}: a symlinked invocation runs main() instead of silently exiting 0`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-symlink-pipeline-'));
      const link = path.join(dir, entry);
      try {
        fs.symlinkSync(path.join(ROOT, 'scripts', entry), link);
        const r = spawnSync(process.execPath, [link], {
          encoding: 'utf8',
          timeout: 120000,
          env: { ...process.env, RUVNET_BRAIN_TEST: '1' },
        });
        expect(r.error, `spawn failed: ${r.error && r.error.message}`).toBeUndefined();
        const out = `${r.stdout || ''}${r.stderr || ''}`;
        expect(
          out.trim().length,
          `scripts/${entry} produced NOTHING through a symlink (exit ${r.status}) — main() did not ` +
            'run. A silent exit 0 is the failure mode that let prepareCorpusCandidate report ' +
            'SUCCESS with no archive on disk.',
        ).toBeGreaterThan(0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('the guard resolves symlinks on BOTH sides — path.resolve() alone is not enough', () => {
    // Pins the mechanism, not just the symptom: a future refactor that "simplifies" this back to
    // path.resolve() must fail here, in isolation, without needing the whole KB to load.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-guard-'));
    try {
      const real = path.join(dir, 'real.mjs');
      fs.writeFileSync(
        real,
        [
          "import fs from 'node:fs';",
          "import path from 'node:path';",
          "import { fileURLToPath } from 'node:url';",
          'const __filename = fileURLToPath(import.meta.url);',
          'const realOrSelf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };',
          "if (process.argv[1] && realOrSelf(process.argv[1]) === realOrSelf(__filename)) console.log('RAN');",
          '',
        ].join('\n'),
      );
      const link = path.join(dir, 'link.mjs');
      fs.symlinkSync(real, link);

      const direct = spawnSync(process.execPath, [real], { encoding: 'utf8', timeout: 20000 });
      const viaLink = spawnSync(process.execPath, [link], { encoding: 'utf8', timeout: 20000 });

      expect(direct.stdout.trim()).toBe('RAN');
      expect(viaLink.stdout.trim(), 'a symlinked entry point must still run main()').toBe('RAN');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
