import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ADR-068 — THE NIGHTLY CONFIG MUST NAME THINGS THAT EXIST.
 *
 * `dream.config.json` is the whole per-repo delta: the engine is rUv's, and everything specific to
 * this repository lives in this one file. That makes it exactly the kind of artifact this project
 * has been burned by — a set of names, written down once, drifting away from the code they point at.
 * `orgTotalApprox: 248` was that. Seven store-root expressions were that. A ship-command definition
 * in two files that disagreed on day one was that.
 *
 * So these tests do not check that the config is pretty. They check that every name in it still
 * resolves: the evaluators are real npm scripts, the ledger is where the config says, and the
 * compiled routine actually carries THIS repo's surfaces rather than the scaffold's generic ones.
 * A config whose evaluator entrypoint does not exist produces a night that silently measures
 * nothing — and a night that measures nothing still writes a ledger row, which is the worst
 * possible outcome: a durable record of a result nobody produced.
 */
// RUNNING `npx` ON WINDOWS TAKES TWO FIXES, AND THE FIRST ONE ALONE JUST MOVES THE ERROR.
//
// Both engine checks below were red on windows-unit, and fixing only the name changed
// `spawnSync npx ENOENT` into `spawnSync npx.cmd EINVAL` — still red, still not validating.
//   1. NAME: the binary is `npx.cmd`, and execFileSync does no PATHEXT resolution — it looks for a
//      file named exactly `npx`.
//   2. SHELL: since the CVE-2024-27980 hardening, Node refuses to execute a `.cmd`/`.bat` through
//      execFile without a shell, because argument escaping cannot be made safe otherwise.
// Until both were right, rUv's compiler and ledger verifier — per ADR-068 the only validation of
// dream.config.json that counts — were never actually invoked on that host.
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const NPX_OPTS = { encoding: 'utf8', shell: process.platform === 'win32' };
const externalEngineIt = process.env.DREAM_ENGINE_VERIFY === '1' ? it : it.skip;
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'dream.config.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

describe('the nightly config points at things that exist', () => {
  it('TEETH: every evaluator entrypoint is a REAL npm script (or an npx invocation)', () => {
    // The failure this prevents: a night that runs `npm run eval:gate`, gets "script not found",
    // records INCONCLUSIVE, and writes a ledger row that looks like a measured result.
    const missing = [];
    for (const [name, cmd] of Object.entries(cfg.evaluatorEntrypoints ?? {})) {
      const m = /^npm run ([\w:-]+)/.exec(cmd);
      if (!m) { if (!/^npx /.test(cmd)) missing.push(`${name}: ${cmd} (neither npm run nor npx)`); continue; }
      if (!pkg.scripts?.[m[1]]) missing.push(`${name}: npm script "${m[1]}" does not exist`);
    }
    expect(missing, 'a config naming a script that does not exist produces a night that measures '
      + 'nothing and still writes a ledger row').toEqual([]);
  });

  externalEngineIt('the ledger lives where the config says, and verifies structurally', () => {
    const ledger = path.join(ROOT, cfg.ledgerPath);
    expect(fs.existsSync(ledger), `${cfg.ledgerPath} is missing — the durable memory has no file`).toBe(true);
    const out = execFileSync(NPX, ['-y', 'dream-machine@0.1.1', 'ledger', 'verify', '--path', cfg.ledgerPath],
      { cwd: ROOT, ...NPX_OPTS, timeout: 180_000 });
    expect(out, 'rUv\'s own verifier must accept the ledger shape').toMatch(/ledger OK/);
  }, 200_000);

  it('TEETH: autoMerge is FALSE — evaluation is not promotion', () => {
    // rUv's own config sets this true for his repo. Ours is false and that is the DECISION, not an
    // inherited default: this repo already has a pre-push gate, a version-bump gate, a doc-currency
    // gate and a both-hosts conformance gate. A machine that merges past them makes all four a
    // formality. ADR-068 §Decision 3.
    expect(cfg.autoMerge).toBe(false);
  });

  it('the rotation surfaces are THIS repo\'s, not the scaffold\'s placeholders', () => {
    // `dream-machine init` scaffolds correctness/security/architecture/performance/
    // developer-experience. Shipping those would aim the nightly cycle at generic surfaces while
    // the places this repo actually broke went unwatched.
    const deep = (cfg.slots ?? []).map((s) => s.deep);
    for (const ours of ['cross-host-conformance', 'brain-currency', 'enforcement-integrity',
      'grounding-quality', 'memory-durability']) {
      expect(deep, `${ours} must be a rotation surface`).toContain(ours);
    }
    expect(deep, 'the scaffold default must not survive').not.toContain('developer-experience');
  });

  externalEngineIt('TEETH: the config still COMPILES with rUv\'s engine, and carries our surfaces through', () => {
    // The only validation that counts is the engine's own. A config this repo likes but the
    // compiler rejects is a nightly that dies at STEP B every night, forever.
    const out = path.join(ROOT, 'node_modules', '.cache', 'dream-tonight.md');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    execFileSync(NPX, ['-y', 'dream-machine@0.1.1', 'compile', 'dream.config.json', '--out', out],
      { cwd: ROOT, ...NPX_OPTS, timeout: 180_000 });
    const prompt = fs.readFileSync(out, 'utf8');
    expect(prompt.length, 'a compiled routine must be substantial').toBeGreaterThan(5000);
    for (const s of cfg.slots.map((x) => x.deep)) {
      expect(prompt, `${s} must survive compilation into the routine`).toContain(s);
    }
    expect(prompt, 'the promotion gate must reach the runner').toMatch(/[Nn]ever merge/);
    fs.rmSync(out, { force: true });
  }, 200_000);
});
